# Standalone tmux capability detector (Phase 3)

`src/capabilities.mjs` provides a conservative, bounded, cached **authorization
check**, not a terminal graphics transport. Phase 3 integrates it in
`extensions/tmux-image/index.ts` after the committed Phase 1/2 renderer work. No Pi
capabilities, settings, tmux configuration or parent process environment are
mutated. This is implementation/reference documentation; installation/usage
belongs in README when integrated.

## Requirements and API

Requires Node's standard modules and a PATH-resolved tmux with the queried
formats and inherited-option support. Verified read-only against tmux **3.6a**.
Older versions with an absent `allow-passthrough`, missing `client_termtype`, or
unknown visibility fields fail closed unless they still provide enough
recognized information. Empty output is never interpreted as enabled
passthrough. No automatic package installation or configuration change occurs.

```js
import { TmuxCapabilityDetector, resolvePiDisplayPolicy } from './src/capabilities.mjs';
// Public Pi peer package only; no private module/settings-manager import.
import { getCapabilities } from '@earendil-works/pi-tui';

const detector = new TmuxCapabilityDetector();
// Call from a live command/tool/session handler, with the factory's public pi
// object and the current ctx. Not during extension factory initialization.
async function inspectFromHandler(pi, ctx) {
  const policy = resolvePiDisplayPolicy(pi.getSettings(), process.env);
  return detector.probe({
    mode: ctx.mode,
    env: process.env,
    hostCapabilities: getCapabilities(),
    ...policy,                       // imagePolicy + showImages
    enabled: true,                   // local caller-owned off switch, not Pi model policy
    nested: false,                   // true if caller knows another tmux layer
  });
}
const result = await inspectFromHandler(pi, ctx);
if (!result.supported) {
  // Show result.message as ordinary readable text; write NO graphics bytes.
}
// On known reconnect/client/config change or manual refresh:
detector.invalidate();
// Re-inspect with fresh public settings/capabilities, then explicitly retry the
// failed presentation state and request a repaint through the supported seam.
```

Installed Pi 1.0.3 public `ExtensionAPI.getSettings()` returns a copy of effective
merged global/project settings with runtime overrides. **`ctx` has no settings
accessor**: capture `pi` from the extension factory and use `pi.getSettings()`
from a live handler. `ctx.mode` is the public run-mode gate; it does not expose
image settings. Read settings again on refresh/reload rather than freezing their
startup values. The API may not be initialized during factory registration.

`resolvePiDisplayPolicy(settings, env?)` is a pure exported adapter for that public
settings snapshot. It returns frozen `{ imagePolicy, showImages }`:

- Concrete `terminal.images: false|kitty|iterm2` overrides environment.
- `terminal.images: auto`/unset leaves Pi's `PI_IMAGE_PROTOCOL` fallback active:
  kitty/iterm2 selects that protocol; none (and installed Pi's legacy 0 alias)
  disables it; auto/unset/unknown leaves auto detection. This follows the actual
  installed Pi capability override implementation rather than assuming explicit
  auto suppresses environment.
- `showImages` comes from `terminal.showImages ?? true`, Pi's public default.
- `enabled` is **not a host setting or ctx property**. It is an optional
  caller-owned package off switch; keep true when no such switch is implemented.
- `images.blockImages` is not read. It controls model requests, never local display.

`getCapabilities()` supplies effective `images`, `trueColor`, `hyperlinks`, but
its `images: null` **cannot distinguish auto detection inside tmux from explicit
image disablement**. The settings/env adapter retains that missing provenance.
Callers that only supply capabilities and omit real policy are using the
helper's auto default, **not** demonstrating respect for Pi's explicit disabled
preference. If a future host lacks public `getSettings()`, report that policy
access blocker; do not reach into private ctx/runtime properties or settings
files, and do not claim host-policy compatibility.

Constructor injection/options:

- `run(file, args, options)` defaults to `runTmuxQuery`, an async `execFile`
  wrapper. Always resolves tmux through PATH and uses argument arrays, shell
  disabled, bounded stdout/stderr buffers, timeout/AbortSignal and SIGKILL on
  timeout/abort. The injected interface returns `{ stdout, stderr }` or rejects.
- `now()` defaults to `Date.now` for deterministic cache tests.
- `timeoutMs`: 300 per subprocess; at most **three sequential queries** for a
  successful uncached inspection. A watchdog also aborts and rejects an injected
  runner that never settles. Actual killing requires the injected runner to
  honor its supplied signal; the production runner does.
- `successTtlMs`: 5000, `failureTtlMs`: 250. Failure cache deliberately expires
  much sooner, avoiding permanent rejection after transient problems. Zero TTL
  is supported. TTLs measure from query completion.
- `maxEntries`: 32, bounds cache entries and simultaneous outstanding probes,
  including probes invalidated while still completing. Capacity returns
  `probe-busy`, not another unbounded subprocess burst.

`checkDisplayPolicy(context)` is a pure synchronous preflight returning a frozen
rejection or `undefined` when asynchronous terminal inspection may proceed.
Both `probe()` and the extension's ready-row renderer use it, so current public
local-image disablement/native-protocol/truecolor policy is applied even to
previously prepared rows. This does not asynchronously validate the client during
a render frame.

`probe(context, { refresh?, checkVisibility? }?)` returns a deeply frozen result.
`checkVisibility: true` bypasses a cached supported `on` result and re-inspects the
pane/effective option/client without invalidating other concurrent probes;
`all` paths retain their ordinary TTL. The extension enables this option before
source access and before/after native preparation. Ready unchanged rendering
performs no query. All results contain:

```js
{ supported: boolean, code: string, message: string }
```

A supported result additionally contains:

```js
{
  pane: '%42', session: '$7', passthrough: 'on' /* or 'all' */,
  terminal: {
    supported: true, family: 'ghostty' /* or 'kitty' */,
    source: 'client_termtype' /* or 'client_termname' */,
    version: '1.3.1' /* or null */, versionVerified: true /* or false */,
  },
  warnings: [], requiresVisiblePane: true /* false for 'all' */,
}
```

`versionVerified` means an acceptable numeric version was present in the
reported identity, **not** active protocol negotiation. Name-only recognition
has `versionVerified: false` and a warning about the minimum assumed version.
Reject results can include safe structured `pane`, `passthrough` or `terminal`
diagnostics where applicable. Raw stderr, command errors, socket paths and
client names are not interpolated into messages. Invalid/control-bearing or
oversized stdout fails closed. The helper never emits terminal bytes itself.

## Actual pane, inherited values and attached-client identity

Inspection uses only read-only commands:

1. `tmux display-message -p -t %pane FORMAT`: requires the returned `pane_id` to
   equal the requested global pane ID, resolves `session_id`, active window,
   zoom/pane activity and cross-session links.
2. `tmux show-options -A -p -v -t %pane allow-passthrough`: `-p` selects pane
   scope, `-A` includes inherited values (pane -> window -> global window),
   `-v` emits only the effective value. Accepts exactly `on` or `all`; `off`
   gives an actionable rejection without changing it. Does not silently accept
   an unknown-option error from an old tmux.
3. `tmux list-clients -t $session -F FORMAT`: requires exactly one attached
   non-control client in that pane's session and obtains **that client's**
   `client_termtype` and `client_termname`, not the pane's TERM and not tmux's
   arbitrary default/current client. No client's escape response is requested.

`on` permits forwarding **only when the pane is visible**. An inactive target
window or a zoom-hidden target pane gives `pane-not-visible`. `all` accepts
hidden panes. A supported `on` result includes `requiresVisiblePane: true`. The extension
uses `checkVisibility: true` to resample cached `on` paths before tools read sources
and before/after native preparation. This avoids blindly trusting a recently
visible pane after switching windows. The observation is still not a delivery
acknowledgement or atomic guarantee about subsequent bytes. The transport
integration must avoid knowingly declaring a hidden/dropped upload resident;
capability detection cannot establish end-to-end delivery.

Multiple clients are rejected even if both names are recognized; a single
selected identity cannot prove the entire display path and clients may differ
in visibility/size. Cross-session-linked windows are rejected because inspecting
one resolved session does not establish all receiving clients. These are
explicit conservative support boundaries, not claims that tmux cannot support
those arrangements.

## Terminal allowlist and nested boundary

`identifyPlaceholderTerminal(termtype, termname)` is also exported for pure
classification tests. Recognition is exact/bounded, not substring matching:

- Reported `ghostty` or `ghostty X.Y.Z` (case insensitive): numeric versions
  must be >=1.0.0. Ghostty's tagged **1.0.0** and **1.3.1** primary source
  explicitly implements U+10EEEE, Unicode placements and virtual prototypes.
- Reported `kitty`, `kitty X.Y.Z`, or actual Kitty XTVersion
  **`kitty(X.Y.Z)`**: versions must be >=0.28.0, when Kitty introduced Unicode
  placeholders. Kitty graphics generally existed earlier; that alone is not
  enough. Numeric prerelease/build suffixes are permitted after the version.
- If `client_termtype` is **empty**, exact `xterm-ghostty` or `xterm-kitty`
  `client_termname` is a fallback. A nonempty unknown/old type is authoritative
  and is **not** overridden by a misleading recognized TERM string.
- Name-only identities assume current family support; they do not prove version,
  configured image-memory allowance or actual end-to-end display. A reported
  old version is always rejected. Unknown terminals, including WezTerm, Warp,
  iTerm2 and generic xterm, are not inferred to support placeholders from some
  other image protocol or Kitty-graphics support.

The pane's TERM, inherited TERM_PROGRAM, KITTY_WINDOW_ID and
GHOSTTY_RESOURCES_DIR are not outer-client evidence and are not consulted.

Only **one tmux layer** is supported. A reported `tmux`/`screen` client or
multiplexer-shaped client TERM rejects as `nested-multiplexer`, and callers can
set `nested: true` for a known nested arrangement. This is not universal nested
session detection: an inner tmux client's customized/spoofed identity, SSH
proxy or other hidden intermediary may not advertise its presence. One DCS
wrapper is not claimed to bypass multiple layers. No nested passthrough override
or auto configuration is provided.

## Pi policy, precedence and forced-native clearing risk

The detector receives policy through the public settings adapter, rather than
duplicating Pi's configuration loader or reading files. Pi's concrete **settings
take precedence over environment overrides**; `auto`/unset preserves the
environment/auto-detection fallback. `resolvePiDisplayPolicy` only preserves that
public preference provenance, not a competing package configuration source.

Order of gates before any subprocess:

1. Interactive mode, valid tmux pane and known nested boundary.
2. `enabled: false`, `showImages: false`, `imagePolicy: false`/`none` ->
   `images-disabled`. This is a local display policy, **not** model image policy.
3. Explicit `iterm2` preference, invalid preference or missing public host
   capabilities -> rejection.
4. Pi effective `images: 'kitty'` **or** explicit `imagePolicy: 'kitty'` ->
   `host-native-conflict`. The installed Pi 1.0.3 fullscreen redraw can globally
   delete extension-owned images when native Kitty mode is selected, without
   notifying the extension. The actual-host seam test demonstrates orphaned
   placeholders on a height redraw. This detector rejects that state in **both**
   modes conservatively; it does not assume a regular-mode exception is safe.
5. Pi effective iTerm2 or `trueColor: false` -> rejection. Twenty-four-bit IDs
   need truecolor; do not change Pi's truecolor preference to force support.
6. Only then inspect passthrough and the real attached client.

**No package-level force override is needed/provided** for the known
Ghostty/tmux path. Force-Kitty cannot bypass disabled passthrough, unknown
terminal, non-TUI mode or host ownership conflicts. To support Pi-native Kitty
in future requires a reviewed reset/ownership seam, not a configuration trick.

`images.blockImages` is never inspected or changed. It controls model requests,
not this local-display authorization. Standard image attachment/session storage
policy remains Pi-owned.

## Cache and re-evaluation boundaries

Success/failure inspections cache by **tmux server identity (TMUX) and actual pane
ID**. Subprocesses inherit the requested TMUX value in their child environment;
this does not mutate the parent environment. Policy/host gates run on every call,
so disabling images or a newly forced native mode cannot be overridden by a
cached success. Same-key simultaneous calls deduplicate. Cache eviction is
bounded oldest-insertion eviction, not image-memory budgeting.

`invalidate()` and `{ refresh: true }` clear caches and discard in-flight results
from older generations. Late successful completion returns `invalidated` and
cannot repopulate the cache. Previously running subprocesses still finish within
the query bound; repeated refresh cannot bypass the outstanding-query bound.

No automatic reconnect event is invented. The caller must invalidate when it
knows the client/connection/settings changed and offer explicit refresh for
unobservable reconnects. Until TTL expiry, an unannounced client change may leave
a stale capability result. Before uploading into a path with uncertain recent
history, use refresh. Do not persist detection success or treat it as residency.

**Detector TTL expiry does not invalidate a renderer's cached failure.** A
presentation that stopped preparing after `pane-not-visible`, a timeout or a
reconnect will remain failed until integration explicitly retries it. Recovery
must (1) invalidate/refresh detection with current public policy, (2) clear or
version the affected presentation failure and graphics-residency epoch as
appropriate, (3) prepare/uploads again, then (4) request a supported repaint.
Provide an explicit refresh command for failures where no public lifecycle event
can establish recovery. Do not endlessly retry every render frame or claim TTL
alone makes already-failed transcript components recover. These integration
steps are requirements, not effects implemented by this standalone helper.

## Extension integration and recovery

The factory creates only runtime helper objects. `session_start` captures the
live public `ctx`, clears detection decisions and attaches the zero-row transport
widget only in interactive tmux. `session_shutdown` invalidates decisions,
disconnects/cancels preparation and clears the captured context. No global image
deletion occurs.

Viewer tools await detection before `createReadTool` or Poppler accesses source
files. Every message preparation (new native, legacy snapshot, reload/resume,
resize or refresh) awaits capability before native work and again before handing
its prepared transport to the presentation seam. A denied/cancelled post-check
calls `onUploadFailed` to release the native shared-payload reservation. A policy
change during a subprocess is rechecked through fresh public settings before
allowing completion; runtime generations reject superseded query completion.

Synchronous render checks current public policy before returning already-ready
rows, without decoding/subprocesses. A known capability rejection hides rows in
a readable fallback. Correcting that failure requires explicit refresh rather
than querying/retrying every frame. Name-only recognition warnings are sanitized
and shown once per session/refresh, not inserted into model-facing content.

`/tmux-image-refresh` first checks interactive tmux, invalidates detector/runtime
decisions and calls presentation refresh to replace residency epoch and clear
failed/ready records, then probes fresh. This reset occurs **even if the fresh
probe still rejects**. Every ensuing preparation independently gates transport;
failed refresh cannot expose the old ready cells. Success/denial notifications
are sanitized plain text. No source reread, duplicate attachments/session
messages or model turn is produced.

These extension-specific recovery steps are implemented and exercised in the
actual SDK harness; the standalone detector by itself still cannot recover a
presentation or observe every reconnect.

## Primary evidence and verification

Consulted on 2026-10-23; no upstream implementation was copied:

- [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1): pane-option
  inheritance; `show-options -A -p -v`; `allow-passthrough on|off|all`;
  `list-clients -t target-session`; documented client/pane/window formats.
- [tmux input parser](https://github.com/tmux/tmux/blob/master/input.c): effective
  option lookup and `all` versus visible-pane forwarding. Read-only local CLI
  confirmed pane-targeted inherited `all` and Ghostty 1.3.1 identity in tmux 3.6a.
- [Kitty Unicode-placeholder specification](https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders):
  support added in 0.28.0; graphics alone is not sufficient.
- [Kitty primary XTVersion implementation](https://github.com/kovidgoyal/kitty/blob/master/kitty/screen.c):
  `screen_xtversion` reports `kitty(version)`, rather than assuming a space form.
- [Ghostty features](https://ghostty.org/docs/features): Kitty graphics support;
  specific Unicode-placeholder evidence comes from tagged source, not this
  general feature claim.
- [Ghostty 1.0.0 Unicode placement implementation](https://github.com/ghostty-org/ghostty/blob/v1.0.0/src/terminal/kitty/graphics_unicode.zig)
  and [Ghostty 1.3.1 implementation](https://github.com/ghostty-org/ghostty/blob/v1.3.1/src/terminal/kitty/graphics_unicode.zig).
- Installed Pi 1.0.3 `docs/terminal-setup.md`, `docs/settings.md`,
  `docs/environment-variables.md`, `docs/configuration.md`, `docs/tui.md`,
  `docs/extensions.md`, public `ExtensionAPI.getSettings()` declaration, public
  `Settings.terminal` shape and `@earendil-works/pi-tui` capability exports;
  local host seam test
  `test/host-seam.test.mjs` for fullscreen native-ownership conflict.

`test/capabilities.test.mjs` covers recognized/unknown/old clients, actual Kitty
identity syntax, identity precedence/fallback, effective inherited option query
arguments, visibility/zoom behavior, disabled/unknown/absent option, nested,
linked/multiple/control clients, public-settings adapter precedence and disabled
provenance (including ignoring model blocking), Pi precedence gates, no subprocess
in unsupported invocations, explicit public-policy sync checks, fresh `on`
visibility resampling, transient failure expiry, success TTL/refresh, bounded cache and
parallel deduplication, late invalidated completions, timeout/abort, missing
executable, malformed/oversized/control-bearing output, and real execFile timeout
and output limits. A read-only live probe returned supported Ghostty 1.3.1 through
an inherited `all` setting with Pi public capabilities `{ images: null,
trueColor: true }`—without forced native image mode.

These are automated/read-only checks, **not human-observed graphics tests**.
The Phase 3 actual SDK harness also tests both model-blocking states, missing-file
pre-source rejection for off/unknown/timeout paths, explicit false/auto environment
policy precedence, false truecolor/native conflicts, zero probes for policy
rejection, ready-row disablement and denied-to-supported refresh/repaint with
unchanged messages, attachments and model calls. Its mutable fake tmux executable
is temporary and PATH-resolved; there are no package runtime test flags and no
query/configuration changes to the active tmux server.

No active package reload, physical-terminal upload, real provider request,
configuration edit, installation of dependencies or project license choice was
performed. Isolated SDK installation/configuration is test-only. Actual known
Ghostty rendering and interactive unsupported-path/pane/window leakage checks
remain coordinated manual verification work.
