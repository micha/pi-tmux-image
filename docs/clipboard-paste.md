# Experimental focused-pane clipboard PNG import

## Scope and explicit compromise

`/tmux-image-paste` is an **experimental, explicit-user-request-only** command.
The owner accepted a focused-pane-only workflow and best-effort fragmented-reply
detection after possible prompt contamination. This supersedes the earlier
hard-gate implementation decision in [clipboard-paste-feasibility.md](clipboard-paste-feasibility.md),
not its evidence. Neither the tmux routing defect nor Pi 1.5.2 framing behavior
was fixed. There is no claim of a universally safe terminal-input transport.

Only Ghostty with **numeric client XTVersion evidence >=1.4** is accepted in v1.
Name-only Ghostty, Ghostty 1.3, Kitty, unknown/multiplexer clients, multiple
clients, linked windows, inactive panes/windows, tmux copy mode, nonfocused,
read-only/control/suspended clients, missing/disabled passthrough and non-TUI
paths fail closed. A spoofed/customized intermediary or unreported terminal
focus is not universally detectable. Identity/visibility checks are observations,
not a transport ACK or a lock on future focus.

No default shortcut, paste-event mode, clipboard write, remembered permission
password, configuration change, Mac helper, background clipboard read, automatic
retry, prompt erasure, message injection or automatic user submission is added.
Normal Cmd+V text paste and Pi's native Ctrl+V remain unchanged.

## Public seams and separation

- `src/clipboard.mjs`: registers the command and session/input lifecycle using
  public Pi extension methods. Uses the existing widget-injected presentation
  terminal for transport, `ctx.ui.onTerminalInput` for input, and a separate
  namespaced text widget for state. It neither replaces the editor nor owns
  another stdin loop.
- `src/clipboard-capabilities.mjs`: clipboard-specific, uncached, read-only
  PATH-resolved tmux queries using the existing bounded exec helper. Checks
  `pane_id`, session, window/pane activity, linked/copy/dead state, inherited
  passthrough and exactly one session client's identity/control/focus flags.
  Rechecks topology before staging and compares client/pane identity. It never
  reads Pi graphics preferences, truecolor or `images.blockImages`.
- `src/clipboard-protocol.mjs`: host-import-free protocol reader and fragment
  observer, injected clock/timer for tests. One active request and a bounded
  same-runtime issued-ID identity range.
- `src/clipboard-png.mjs`: bounded PNG container/CRC/dimension/DEFLATE/scanline
  validation, including palette indices. No file access or external decoder.

The declared `extensions/tmux-image.ts` entry had `../../src` imports left from
its former nested entry location. The feature corrects those five imports to
`../src`, as required for fresh-source loading in a copied checkout. The manifest
and existing package-test expectations are not otherwise changed. No native,
viewer, PDF, transport encoder or pacing implementation is modified.

Inspected Pi **1.5.2** complete `docs/extensions.md`, `docs/tui.md`, `docs/sdk.md`,
shipped input-transform/streaming and widget examples, and public declarations
plus the existing renderer/capability contracts. Tests import public installed
package entry points, not private host modules. Pi 1.0.3 clipboard compatibility
is not claimed by older graphics acceptance records.

## Request lifetime and bounded resources

The first command in each session runtime opens an explicit consent dialog
**before emitting any clipboard request**. It explains the experimental input
risk and that the user must remain in the same focused pane/client/Pi runtime,
including during Ghostty's permission prompt. Ghostty's own default permission
prompt remains intact; the extension does not bypass it.

A single OSC 5522 `type=read` requests only `image/png`, with a random runtime
prefix and canonical issued sequence ID. One tmux DCS wrapper is used. No paste
mode or unowned capability-response interception is needed: numeric Ghostty
version identification is capability evidence, not proof of successful reads.

Limits:

| Resource | Limit |
| --- | --- |
| Read deadline | 30 seconds |
| Encoded packet | 8192 characters |
| Metadata | 512 characters |
| DATA decoded chunk | 4096 bytes |
| Read packets | 4096 before import rejection |
| PNG bytes / staged images | 8 MiB / one |
| Pixels / inflated scanlines | 16,777,216 / 64 MiB |
| PNG chunks | 2048 |
| Issued sequence | 1 through 999,999,999, exact canonical decimal |
| Fragment observer | one metadata prefix, <=8192 observed characters, 1 second inter-event gap |
| tmux query | 300 ms, 4096-byte stdout/stderr bounds, at most three sequential queries per probe |

A PNG must have valid signature/chunk lengths/CRCs, legal dimensions/depth/color,
contiguous IDAT, one terminal IEND, valid bounded zlib stream and scanline filter
bytes. PNG palette indices are reconstructed/checked. Interlaced PNG and APNG
are rejected in v1. Base64 is strict, padded and canonical; MIME must decode
exactly to `image/png`. Import occurs only after OK + data + successful DONE.
No partial image is staged. Errors/diagnostics are static sanitized text, never
clipboard bytes, encoded payloads or protocol snippets.

**Timeout, local cancel, malformed/oversized data and detected fragmentation do
not cancel the terminal's read/permission prompt.** They discard accumulated
image bytes but retain a small unresolved request identity/state. The visible
widget says **UNRESOLVED**; further reads are refused until a clean owned DONE or
terminal error arrives. Completion/error packets must have only type/status/id
metadata and no payload, including in discard and fragmented-recovery paths;
malformed terminal-looking packets cannot release quarantine. There is no automatic quarantine expiry or unsafe
"forget and retry" action. If the terminal never responds, import remains
unavailable in that runtime. The user must resolve any outstanding terminal
prompt before leaving; terminating/replacing Pi is outside protected handling
and is not a way to cancel the terminal request safely.

Exact issued IDs remain identifiable without an unbounded tombstone list: a
random runtime prefix plus issued-sequence high-water mark. Intact late owned
packets are consumed without staging. A future/unissued sequence, zero,
leading-zero alias, arbitrary prefix match, different runtime ID, or non-read
response is not owned. One session-local input subscription is removed on
shutdown; pending image bytes and attempt/reader timers are released. Branch
navigation clears pending and locally cancels a read, while preserving its
same-runtime unresolved ownership.

## Pi fragmentation and draft contamination

Pi 1.5.2 may recover an incomplete OSC after a 50 ms input gap as Alt+] plus
individual printable protocol/base64 keys. The observer **does not withhold or
replay Alt+] or other ambiguous ordinary keys**. It watches bounded sequences
and rejects/warns only after enough protocol metadata establishes an exact
issued request ID. Prefix characters have already passed through. To avoid
swallowing normal typing that is indistinguishable from base64, it does **not**
consume individual printable payload keystrokes either. Thus **more than the
initial prefix, potentially the whole payload, can contaminate the draft**.

Only intact owned packets and an identifiable reconstructed frame terminator
are consumed. A recognized fragmented import is rejected, not reconstructed
into a valid staged image. The user is warned to inspect/edit the draft
manually; no attempt is made to clear, restore or silently repair it. Detection
is best effort, not complete: unknown/malformed fragments, gaps, observation
bounds, bracketed paste, changed focus/session/process, and missing responses
can defeat recognition or leave an unresolved timeout of unknown cause.

The same-runtime observer also handles recognizable late fragments, but cannot
protect another pane/process/client or a replacement session/runtime. The tmux
synthetic diagnostic still proves those unsupported routing hazards. Do not
interpret before/after focus checks as preventing misrouted bytes.

## Pending attachment handoff, privacy and other extensions

A valid PNG remains runtime-only until the next **interactive input event**.
The widget shows one pending image and `/tmux-image-paste clear` removes it.
`/tmux-image-paste cancel` cancels an import locally; it is not the pending-image
remove action and does not cancel terminal permissions. Commands bypass input
transforms; RPC and extension-authored input do not consume the pending image.

The transform returns the **unchanged text**, a new array preserving all existing
attachments in order, then the pending standard Pi image. It consumes pending
state **at this one handoff**, not at host persistence or a model-turn ACK:

- An earlier handler returning `handled` prevents this transform from running;
  the image remains pending.
- A later handler returning `handled` or replacing the images can prevent final
  use. The image is **not** automatically restored or retried into another prompt.
  The tested Pi runner catches a later handler's thrown error and continues with
  the previous transform; a thrown handler error alone is not a submission ACK
  or an automatic rollback.
- Host preflight/auth/submission failure after input processing likewise does
  not restore the pending image. Handoff is not a storage acknowledgement.

The staging notification makes this behavior explicit. There is no public native
draft-attachment setter; these are not promised as native attachment chips.
No protocol text/details/custom renderer-only message replaces the attachment.

Once intentionally submitted, standard Pi image normalization, model policy and
session storage apply. **`images.blockImages` controls model access, not session
storage.** No setting is read or changed to bypass that policy. Clearing before
handoff drops the extension's reference, not a secure-erasure guarantee; after
handoff, the extension cannot delete the image from session history or another
extension's memory.

## Automated verification and coordinated human check

Portable focused tests:

```sh
node --test test/clipboard.test.mjs
npm test
```

Public installed-host integration, using a host-supplied root:

```sh
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent \
  node --test test/host-clipboard-integration.mjs
PI_TEST_TUI_ROOT=/path/to/installed/pi-tui node --test test/host-clipboard-input.mjs
python3 scripts/probe-clipboard-routing.py
```

The integration uses a **copied checkout with a fresh absolute extension path**,
a private workspace/agent settings, fake PATH-resolved tmux, public SDK session
and TUI input buffering, and an offline model-runtime stub. It proves full
intact request/reply/staging/user-submission behavior and actual model filtering
with blocking on/off, plus the permitted degraded fragment path. Neither
synthetic diagnostic is relabeled as successful general safety.

Automated results against Pi/pi-tui **1.5.2**, with no real clipboard read:

- Focused portable tests: **13 passed, 0 failed**, including malformed terminal
  completions in intact/fragmented and normal/discard paths.
- New public SDK/TUI clipboard integration: **6 passed, 0 failed, 0 skipped**
  (four parent cases plus the two model-policy subcases).
- Existing public-host input-framing diagnostic: **4 passed**, still reproducing
  the degradation. Existing private tmux **3.8** routing probe still reproduces
  wrong-window delivery and ordinary-typing preservation.
- `npm test`: **262 passed, 35 skipped, 2 failed** (299 total). The same unchanged
  `test/package.test.mjs` expectations still reference
  `extensions/tmux-image/index.ts` instead of the declared flat entry. Accepted
  baseline `0124bd6` was separately archived/tested during the earlier follow-up
  and produced 249/35/2; this feature adds 13 passing portable cases without
  correcting that unrelated test/manifest disagreement.
- Existing `test/host-integration.mjs`: **9 passed, 3 failed** (two PDF/model-policy
  subcases and their parent). Both subcases stop because **pdfinfo is absent on
  PATH**; no Poppler install or unrelated PDF fix was attempted. Remaining
  non-TUI/policy/pre-source/refresh cases pass. Do not claim full existing PDF
  integration acceptance from the new clipboard tests.
- Isolated temporary HOME/`PI_CODING_AGENT_DIR`: `pi install <checkout>`, `pi list`,
  `pi --help` and public resource discovery passed: one extension, zero load
  errors, six commands including the new command and all five preserved ones.
  Fresh copied-checkout loading is also covered by the new SDK test.
- `git diff --check`: passed. No host dependencies installed in this repository,
  no global installation, active configuration/package operation, push or real
  provider request. Older host-seam suites still assume a different package
  layout/entry path; they were not silently adapted. The new test resolves the
  host-supplied public pi-tui entry with `createRequire`, including sibling layouts.

No real clipboard/physical Ghostty/macOS/SSH round trip or active-package
activation is authorized by these tests.

After independent review, coordinate an explicit harmless-image human test:
use an isolated/fresh Pi process with this checkout only by owner agreement;
copy a nonsensitive small PNG on the Mac; remain in the same focused pane;
invoke the command, read/accept both experimental consent and Ghostty permission,
check the pending widget and unchanged draft, then deliberately submit a simple
prompt (or clear instead). Confirm no automatic turn and normal text paste.
Exercise denial separately. Do not deliberately switch panes with real data or
manufacture fragmentation on a real clipboard; keep those checks synthetic.
Any unresolved state means resolve the terminal prompt before leaving, not
blindly retry/reload/disconnect. Record automated evidence separately from the
owner's observed outcomes.
