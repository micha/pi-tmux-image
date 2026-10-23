# Production viewer verification

## Scope and current status

The owner-authorized implementation starts at feasibility gate `e92b1cd`.
`test/host-viewer-integration.mjs` is a **standalone optional production acceptance
harness**, separate from the portable `npm test` discovery and from the earlier
Step 1 feasibility components. It loads the current package through an isolated
local `pi install` and installed Pi public SDK/InteractiveMode APIs. It does not
replace production behavior with a protocol simulator or a test viewer.

**Automated production integration passed: 15/15, no skips.** Tested with Pi
**1.0.3**, native/crop commit `5898185` and the coordinator's production UI
worktree (extension SHA-256 prefix `55a3e7dee3be`, viewer `afd2a7ec9f4e`). The
standalone harness contains 14 leaf cases plus its parent test. At that automated
checkpoint the coordinator owned the final combined UI commit/package activation;
this verification worker made no production edits or commits. The final package
and subsequent general owner acceptance are recorded below.

Initial actual-host runs caught two production UI defects: installed Pi does not
recognize `matchesKey('+', '+')`, and long PDF labels truncated the required zoom
suffix. Both were reported to and fixed by the UI owner before the passing full
run. Separate private-glyph and required zoom-title checks were retained, not
weakened. Harness issues (awaiting command completion before Escape, query title
expectations, and Pi's select-before-custom-entry tree semantics) were corrected
against public host behavior without changing production.

Step 1 evidence remains separately recorded in [viewer-seam.md](viewer-seam.md),
[viewer-crop.md](viewer-crop.md) and [viewer-lifetime.md](viewer-lifetime.md): public
owned overlays, conservative admission/focus loss, bounded independently addressed
whole-image canvas subsets. Earlier feasibility tests do not prove the new
production controller. Existing owner-observed **inline** PNG/PDF checks in
[verification.md](verification.md) do not establish viewer pixels. Separate general
owner acceptance of the production viewer is recorded below.

## Reproduce the optional integration

```sh
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-monorepo \
  node --test test/host-viewer-integration.mjs
```

The installed root must expose `dist/index.js`, its public package manifest/CLI,
and the host-supplied `@earendil-works/pi-tui` dependency. Without the root the
standalone test skips; no host dependency is installed in this repository.
Node and an existing PATH-resolved Poppler `pdftoppm` are prerequisites. The
harness never installs OS packages or npm dependencies.

Safety boundaries:

- Capture terminal only: `InteractiveMode` receives a terminal implementation
  whose `write` stores bytes, never stdout/the real tty. All input enters that
  terminal's actual installed input callback.
- Public exports only: SDK services/runtime/session, resource loader,
  `InteractiveMode`, and exported TUI components/diagnostics. No private host
  imports, patched methods, extra input loop or forced native image capability.
- Local installation writes only a temporary `PI_CODING_AGENT_DIR`. Discovery
  loads the installed local package and a small public observer extension that
  obtains the current context/TUI through its own zero-row widget. The observer
  does not replace viewer handlers/renderers or expose production internals.
- Selection tests disable automatic clipboard copying through the exported
  `TuiAltScreen.setCopyOnSelect(false)` and isolated preference; clipboard
  executables are harmless PATH stubs and DISPLAY/Wayland are cleared/restored.
  No stdout patch is used. During triage a settings-only attempt still permitted
  host OSC 52 output into the redirected child log; the explicit public setter
  fixes that capture-fixture boundary. Diagnostics must be read with control
  sequences sanitized, never displayed as terminal escapes.
- The temporary PATH `tmux` executable accepts only `display-message`,
  `show-options`, `list-clients`; those capability probes never query or configure
  the active tmux server. A temporary `pdftoppm` wrapper logs arguments and calls
  the already available real executable using argument arrays.
- No provider client exists. The model-runtime boundary fails on an unexpected
  request. A specifically authorized **offline fake background stream** can
  produce one controlled request to test interaction during streaming; that is
  not network/provider/model vision work.
- Generated PNGs/PDFs, scratch files, installed settings and subprocess logs live
  under temporary directories and are removed. Environment and public host
  capability/cell settings are restored. No active settings/package replacement,
  real terminal reload, graphics, license choice, commit or push occurs.

## Passed automated production matrix

| Case | Observable acceptance |
|---|---|
| Both `images.blockImages` states; regular/fullscreen | Production picker, controls and close operate locally with unchanged exact SDK conversion, standard attachment snapshots, messages and entries. |
| Real PNG and two-page PDF | Source commands produce one PNG + two immutable Poppler snapshots; source files and every recorded PDF scratch directory are removed before viewer operations. No further rasterizer calls occur. Ready viewing after removal proves no functional source dependency; it is not a syscall-level audit of attempted reads. |
| Shared payload/private placement | Resident opening uploads no PNG, private placement differs from inline; zoom reuses the private pair; 10,000 public terminal pan intents emit no PNG/prototype transport; sequential page/PNG opens reuse that fixed numeric placement slot. |
| Close | Captured deletion is lowercase `d=i` with both the proven image and private placement IDs; no uppercase pixel/global deletion; inline cells remain ready; editor focus/draft and fullscreen transcript position survive. |
| Production fullscreen mouse path | Real SGR press/release reaches the actual page grid; page-two click selects that stored snapshot, checked against the exact decoded PNG transfer/image ID, not label alone; label, padding, selection drag and wheel do not open it. |
| Modal admission/focus loss | Real pre-existing fullscreen search refuses opening without graphics; reserved Ctrl+Shift+F exposes new host search and removes viewer-only cells; upper custom/builtin dialogs retain focus and completion while owned viewer cleanup runs. |
| Async cancellation | Delayed read-only capability probes exercise Escape after mounting while selected-snapshot preparation is pending; the command completion is awaited, with unchanged storage/conversion/model counts. Detailed native reservation/partial-write races are covered separately in the host-enabled suite. |
| Resize/cells/policy | Actual host compositor handles 80x40 → 30x16 → 12x6 → 80x40 and changed public cell pixels without overflow, lost Escape ownership or resident PNG retransmission; synchronous ready-policy disable hides cells with no probe/graphics. |
| Lifecycle | SDK refresh/reload, owning widget removal, public tree navigation and new-session replacement close the viewer. Refresh must not replay the inactive private prototype; sources remain absent. |
| Regular keyboard fallback | Regular SGR reports do not open transcript images. Editor Enter → public `getUserInput()` → `session.prompt('/tmux-image-view')` opens the actual viewer with no model work. |
| Offline background stream | One deliberate mocked stream remains the sole request; viewer input creates no additional messages, attachments or requests. |
| Denied paths/non-TUI | Unsupported passthrough/client identities and print/JSON/RPC command modes produce no graphics/widget/model work. |

Observable fixed IDs/zero controller pan transport do **not** prove an internal
heap bound. A supplementary test in the same file directly calls the production
native owner APIs, using public Pi PNG conversion and the actual injected capture
terminal. It performs 10,000 pan windows and 10,000 acquire/prepare/release/retire
shapes, compares exposed allocator/accounting bounds, and forces new owner epochs
to check same-ID PNG retransmission restoring both retained inline geometry
versions plus only the live viewer. This exercises production code, not a protocol
simulator, but is explicitly **not** the UI controller route. The native and
presentation owners' tests still supply detailed reservation/partial-write and
cache-bound coverage; passing the supplementary path cannot excuse a failing
actual controller integration.

Preserved old command/tool names, sequential execution and required `path`
parameters are checked at actual resource loading. The existing
`test/host-integration.mjs` remains responsible for actual sequential tool-call /
result / `triggerTurn: false` ordering; this harness does not edit it.

## Automated results

Final post-fix commands/results, reported separately:

| Command | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `npm test` (portable) | 150 | 0 | 31 |
| Host-enabled `npm test` with both host variables from `AGENTS.md` | 181 | 0 | 0 |
| Existing standalone `test/host-integration.mjs` | 12 | 0 | 0 |
| New standalone `test/host-viewer-integration.mjs` | 15 | 0 | 0 |
| New standalone harness without `PI_TEST_HOST_ROOT` | 0 | 0 | 1 |

The full production integration completed in approximately 74 seconds on this
host; that is test-suite elapsed time, not a viewer latency benchmark. Its actual
isolated `pi install`/resource discovery passed and preserved old tool names,
sequential execution and required `path` parameters. The existing SDK integration
also passed its sequential tool-call/result/`triggerTurn: false` and actual
blocked/unblocked mock-request checks. `git diff --check` for the owned new files
passed. Earlier failed/cancelled triage runs are not counted as acceptance.

Evidence distinctions:

- Both blocking states compare the **entire exact SDK model conversion**, messages,
  entries and standard attachment data before/after interaction, not counts alone.
  Storage retains all three snapshots even while model-image conversion blocks
  them. Capture-wire PNG reconstruction maps picker/page selection to exact bytes.
- The four regular/fullscreen + blocking combinations each send 10,000 pan intents
  through the real terminal input callback. Shared resident PNGs are not uploaded
  again, pan emits no prototype transport, zoom only replaces the private pair,
  min/reset/dynamic limit and sequential snapshot opens/retirement pass.
- The explicitly separate production-native owner path performs 10,000 pan windows
  plus 10,000 acquire/shape/release/retire cycles with unchanged exposed allocator
  size, two retained inline geometry prototypes and one shared resident payload.
  New epochs restore both inline versions plus exactly the live private prototype,
  and never resurrect it after release/retirement. This is not a terminal simulator,
  but it is not the UI controller route either.
- The single background model request is a deliberate **offline fake stream**;
  no provider/client/network/real image request occurs. Viewer interaction adds
  zero requests/messages/entries/attachments to that run.

### Physical removal/retirement ordering and retry review

The final totals above are a fresh rerun **after** the UI owner's frame-order and
connection-retry fixes. The standalone integration drives `renderNow()` during
readiness/close checks; its earlier green result did **not** prove that production
itself flushes physical removal before retiring a prototype with fully cached
capability guards. Do not attribute that missing proof to this harness.

That proof comes from the UI-owned actual-host regressions in
`test/host-viewer-seam.test.mjs`, named `production close ... cached guards flush
HOST-FRAME before private delete, preserving upper dialog`, in both fullscreen and
regular modes. They await production close with **no caller renderNow before
assertions**, and check a captured underlying/upper-host frame precedes lowercase
scoped deletion. The final host-enabled 181/181 run includes both tests. Production
`retirePending()` forces the public frame for a real nonempty retirement before
its final guard/commit, including recovery retries; no-op retirement need not
force a frame.

The independent read-only runtime reviewer separately re-ran the same production
native/presentation/controller path through actual exported public renderers:
removal frame index **0**, private-delete index **1** in both modes, reversing the
unsafe pre-fix order. Its held-cleanup/concurrent-refresh reproduction also passed
in both modes: `retryRetirement()` reacquires the current connection/context after
awaiting close, then one outer retry sends exactly one fresh-epoch scoped delete
and clears the preserved obligation. The stale old close warns without writing
an obsolete delete. These four independent scenarios are reviewer evidence,
separate from this worker's 15-case integration and the persisted UI tests.

Automated pixel/appearance acceptance remains deliberately absent. A passing
stream/component assertion is not a Kitty ACK, terminal memory measurement or
human-observed image. Closed-overlay OSC 8 link precedence and clipped-page routing
are additionally exercised through public host components in the earlier seam
suite; this standalone production case tests actual page-two grid selection,
label/padding/drag/wheel and does not manufacture links inside native image cells.

## General owner acceptance and remaining manual cases

After final package **0.3.0**, commit **`210d524`**, the owner confirmed
**“all is working!”** after being asked to reload and try
**click-open/zoom/pan/reset/Esc** (click the piggy PNG or a PDF page, then
`+`/`-`, `0`, `h`/`j`/`k`/`l`, Escape). This records general human acceptance of
the new in-pane viewer on the existing **Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3**
setup with **`terminal.images: auto` / `images.blockImages: true`**.

The owner did **not** provide a separate case-by-case report or specify whether
both PDF pages, keyboard picker/regular mode, other terminals, modal/search,
bounds, reconnect, source-deletion or failure races were manually exercised.
Do not turn the general confirmation into individual matrix passes. No agent/camera
pixel inspection or latency measurement was made. Prior inline PNG/two-page PDF,
scrolling, tmux zoom/window, refresh and reload observations remain as recorded in
[verification.md](verification.md); they do not fill these viewer-specific gaps.
Automated totals and source hashes above are unchanged.

Narrower unreported cases remain automated-only or human-pending, as applicable.
For detailed manual coverage, check each PNG/PDF page by click and keyboard,
100% Fit on each fresh open, 1.25x zoom steps, 25% minimum, honest dynamic 297-cell
cap, four-cell pan, all four edges, reset, unchanged inline history after close,
and source-deleted replay. Use an asymmetric labelled image to distinguish genuine
row/column offsets.

Check narrow/short panes, border clipping, pane position, width/height drag and
cell-size changes, tmux zoom/unzoom/window switching, new output while open,
selection/wheel/link behavior while closed, new host search/dialog closing the
viewer, pending close races and documented lifecycle recovery. Regular terminal
scrollback is terminal-owned and has no public Pi viewport query/restore API;
capture-stream/editor/content checks cannot establish its visual preservation.
No universal reconnect detection, arbitrary virtual source cropping, terminal
memory/GPU budget or resource ACK is claimed. Budgeting/eviction remains disabled.
