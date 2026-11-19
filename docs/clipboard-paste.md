# Focused-pane clipboard PNG dialog

## Current scope

**Ctrl+V** (default in inherited valid tmux/pane context) or `/tmux-image paste`
opens a visible **Reading clipboard** dialog with a do-not-type instruction.
Only while that owned dialog is visibly focused does clipboard assembly own
ordinary input. It uses Pi's existing TUI loop, not an editor replacement,
second terminal loop, host patch or keyboard-mode change. After a valid read,
the dialog is removed/flushed and one standard PNG is added to the pending list
for the next interactive user prompt. Copy and paste one image at a time. Nothing
is submitted automatically.

This supersedes the nonmodal best-effort implementation in `2493197`, following
explicit owner approval of modal input capture. It does **not** solve tmux
origin routing or upstream Pi framing. Stay in the same focused tmux pane,
terminal client and Pi runtime, including during Ghostty permission prompts.
There is no claim of protection after pane/client/process/runtime changes.

## Why a modal is necessary on the tested path

The first real nonmodal trial returned printable OSC 5522 OK/DATA/DONE records
in the draft and reported a timeout, not successful import. The observation
establishes failure on that actual path; it did not by itself prove network
fragment timing or installation/cache behavior.

Read-only source inspection and synthetic private tmux **3.8** reproduction
found the missing input transformation:

- With `extended-keys=on`, Pi's normal `CSI >4;2m` modifyOtherKeys fallback and
  `extended-keys-format=csi-u`, tmux turns `ESC ]` into `ESC [ 93 ; 3 u` (Alt+])
  and ESC + backslash (ST) into `ESC [ 92 ; 3 u` (Alt+backslash).
- The xterm extended-key format produces `ESC [ 27 ; 3 ; 93 ~` and
  `ESC [ 27 ; 3 ; 92 ~` respectively.
- This happens even for **one coalesced complete reply with no timing gaps**.
  The public key parser recognizes both forms, but the earlier literal-OSC-only
  observer did not. Pi's editor ignores those Alt keys and inserts the printable
  protocol body; the reader then times out.
- The earlier SDK capture-terminal test bypassed tmux inbound key reencoding.
  Adding OSC 5522 to Pi's protected-reply list alone would not fix delimiters
  already turned into key events by tmux.

Tagged Ghostty **v1.4.0** source (`clipboard_response.zig`,
`stream_handler.zig`, `Surface.zig`) encodes `ESC ] 5522` and propagates the request
terminator through `ReadSuccess`. Our request uses ESC + backslash (ST), so BEL/C1 or delayed
permission must not be asserted as the observed root cause. The assembler accepts
literal, encoded and split delimiters within its explicit modal ownership.
[Original feasibility diagnostics](clipboard-paste-feasibility.md) remain evidence
of upstream limitations, not general-safe transport acceptance.

## Visible ownership and keys

Ctrl+V or `/tmux-image paste` is the explicit request: there is **no extension-level
first-use confirmation**. Capability preflight runs before the owned read dialog
is installed/flushed and the single request is emitted. Startup/session events
never initiate a read. Ghostty's own `clipboard-read=ask` permission prompt remains
intact; there is no permission/settings change, automatic authorization or retry.
Success reports when PNGs are ready for the next prompt. The widget shows the
pending count and clear command. Unsafe-exit/failure warnings and double-Ctrl+Q
confirmation remain; handoff/storage details stay in this reference rather than
routine UI.

| Key/action | Meaning |
| --- | --- |
| Ordinary typing/text paste while dialog owns focus | Captured deliberately; not inserted or replayed into the editor. **Do not type.** |
| **Ctrl+C** | Cancel image import locally, drop image bytes, keep the visible dialog draining. |
| **Ctrl+Q**, once | Cancel locally and show the explicit late-reply/leave-anyway warning. |
| **Ctrl+Q**, again | Knowingly close the dialog; restore normal editing, retain unresolved request quarantine. Late replies may enter the draft. |
| Escape | Does **not** leave the dialog; raw ESC may be part of a split reply delimiter. Use the documented control keys. |
| `/tmux-image paste cancel` (programmatic command invocation) | Same local cancellation/draining semantics; not cancellation of Ghostty permission. |
| `/tmux-image paste clear` | Remove all staged PNGs, not an outstanding terminal read. |

Timeout (30 seconds), cancellation, rejected/malformed data or transport loss
**does not cancel the terminal permission prompt/read**. Accumulated image bytes
are dropped; the default is a visible **unresolved/waiting/draining** dialog.
There is no automatic unsafe modal dismissal, automatic quarantine expiry or
silent retry. Resolve any terminal prompt before leaving the pane. If the terminal
never responds, the user may explicitly leave the dialog with the warned double
Ctrl+Q, but another read remains refused until a clean owned completion/error.

The dialog is mounted and `renderNow()` flushed **before request emission**.
It refuses existing overlays/viewers/search and does not hide or focus somebody
else's UI. Public focus loss synchronously revokes image import without hiding
or reclaiming the dialog. If another dialog takes focus, a warning explains that
other UI may receive replies; normal input to that UI is not stolen. On returning,
the clipboard dialog remains a drain obligation. This is not universal search,
mouse, terminal focus or external-overlay isolation.

Clean owned completion removes only this overlay handle and flushes the removal
frame before staging. A failed hide retains the owned handle and usable cleanup
controls: Ctrl+Q retries that exact handle, never a global overlay pop. This also
applies if initial rendering and its cleanup both fail; no read is emitted from
an unconfirmed initial frame. A failed removal frame invalidates that import's
staging even if later cleanup succeeds. If shutdown cannot hide the dialog, its
remaining component is cleanup-only (Ctrl+Q/Ctrl+C retry removal), never an old
runtime parser/importer. Session shutdown
warns if a terminal read remains outstanding, drops pending/image/frame data,
unsubscribes and removes the owned overlay while the old public TUI exists.
It cannot preserve protection after the runtime/client/process is replaced.
Branch/transport changes stop import but do not pretend the terminal read ended.
No native image placements, shared PNG resources, viewer controls, PDF behavior
or pacing policy are changed.

## Default shortcut and per-process preferences

The owner explicitly approved removing the opt-in requirement after confirming
the optional shortcut worked. Factory registration now defaults to **Ctrl+V**
only when inherited `TMUX` is present and `TMUX_PANE` matches `%` plus digits,
the same context predicate used by runtime activation. There is no topology probe
just to decide registration. Actual read eligibility still uses the unchanged
capability checks after explicit invocation. Outside that context **no shortcut
is registered**, even with an override; native paste is unchanged.

Optional preferences on a fresh launch:

```sh
PI_TMUX_IMAGE_PASTE_SHORTCUT=off pi
PI_TMUX_IMAGE_PASTE_SHORTCUT=ctrl+shift+v pi
```

Exactly `ctrl+v`, `ctrl+shift+v`, `ctrl+alt+v` and `off` are accepted (lowercase,
no spaces). Unset/empty uses the tmux default; `off` disables registration.
Invalid values register none and give a short warning without breaking the
command. Valid configuration has **no startup toast**. This is a one-process
environment prefix, not a persistent export, Pi setting, CLI flag or terminal
key-mode change. No background read occurs.

The value is sampled during the extension factory, when public
`pi.registerShortcut` participates in host discovery. `pi.getFlag()` yields its
default there, so an unresolved CLI flag cannot correctly select factory-time
registration. Late `session_start` registration is not used. There is no always-
registered disabled handler and no cross-extension dispatcher/global key listener.
The shortcut directly invokes the **same paste handler** with no action;
explicit invocation, topology, modal ownership, bounds, timeout/drain, exit, PNG validation,
pending/clear and interactive handoff are unchanged. Existing draft text and
attachments are neither erased nor submitted. The registered key is PNG-dialog-only:
rejection/cancel never automatically falls back to native clipboard or text paste.
Cmd+V/ordinary terminal text paste is not remapped;
the dialog still deliberately captures typing/paste while focused.

Inspected installed Pi **1.5.2** public extension/keybinding docs and preset example,
then verified actual public `CustomEditor`/runner dispatch: the extension handler
runs before native paste. **`app.clipboard.pasteImage` is nonreserved**; default
Ctrl+V therefore causes a host conflict warning identifying the native action and
saying `Using` the extension, not `Skipping`. This intentional replacement is
supported without a config edit. Reserved actions—including user remaps of those
actions onto the chosen key—remain host-skipped. Other extension collisions follow
Pi's normal conflict rules; this package does not reorder or bypass them.

Optionally merge one of these **manually** into your agent directory's
`keybindings.json` (`~/.pi/agent/keybindings.json` by default), retaining your other
entries:

```json
{ "app.clipboard.pasteImage": "alt+v" }
```

This preserves native paste on an otherwise unused alternative key. Or set its
value to `[]` to unbind it and silence the native overlap warning. Neither is
required for the shortcut. Check `/hotkeys` and host conflict
warnings if the key cannot activate. Modified keys depend on terminal reporting;
no key protocol/config changes or native-protection workaround are made here.

Changing registration/preferences requires a **fresh Pi process/restart-resume**,
not merely `/reload` with already-loaded transitive modules. Never replace a live
runtime with an unresolved terminal read. `off` restores native dispatch; omitting
an override restores the tmux default. Restore any native binding you manually
edited separately. No real user file is changed by the extension. Never emulate
this with a terminal macro typing the command and Enter into an existing draft.
The optional shortcut and subsequent default/concise UI have narrow owner
confirmation below. The newer no-extension-confirmation UX remains human-pending;
none of these observations expands the accepted matrix.

## Separate modules and public seams

- `src/clipboard.mjs`: shared paste handler, session lifecycle, input-transform
  handoff and visible pending state. Uses the existing widget-injected TUI transport.
- `src/clipboard-modal.mjs`: owned public `TUI.showOverlay` handle and passive
  width-fitted component; modal-only bounded frame assembler. Public `parseKey`
  and `matchesKey` normalize raw/CSI-u/xterm Alt markers. No private listener
  reorder, editor access, async key replay, stdout/stdin patch or second owner.
- `src/clipboard-protocol.mjs`: exact issued-ID, status/order/base64/MIME/PNG
  checks, read deadline/quarantine and bounded non-holding outside-modal late
  observer. The late observer also recognizes parsed extended Alt markers, but
  does not capture ordinary printable protocol keys outside the dialog.
- `src/clipboard-capabilities.mjs`: independent, uncached read-only actual-pane
  and client checks; no graphics truecolor/showImages/model-blocking gates.
- `src/clipboard-png.mjs`: bounded PNG container/CRC/dimension/DEFLATE/scanline and
  palette-index validation, without source paths or external converters.

Inspected installed Pi **1.5.2** complete extension/TUI/SDK docs, input and widget
examples/public declarations, plus repository renderer/viewer ownership records.
Only public installed package entry points are imported by tests. Prior Pi 1.0.3
viewer acceptance does not establish clipboard API/behavior acceptance.

## Capability, protocol and bounds

V1 requires actual numeric Ghostty client version evidence **>=1.4**, one attached
focused non-control/non-read-only/non-suspended client, one tmux layer, an active
visible pane/window not in copy mode, no linked window, and enabled inherited
passthrough. Name-only/old/unknown/Kitty/nested/multiple-client/non-TUI paths fail
closed. Identity/visibility checks before reading and before staging are bounded
observations, not delivery ACKs or focus locks. Customized hidden intermediaries
and unreported client/focus changes are not universally detectable.

A single explicitly invoked OSC 5522 `type=read` requests `image/png` through one tmux DCS
wrapper. Prefix is runtime-random; only canonical **actually issued** sequence
IDs are owned. Old IDs remain recognizable with one high-water mark, not an
unbounded tombstone list. No clipboard write, paste-event mode,
OS helper or automatic configuration change is introduced; only the explicitly invoked
registered shortcut replaces its chosen key.

| Resource | Bound |
| --- | --- |
| Deadline / active requests | 30 seconds / one |
| Encoded frame / metadata / decoded DATA chunk | 8192 chars / 512 chars / 4096 bytes |
| Read packet count | 4096 before rejecting import |
| PNG / staged images | 8 MiB per image / 4 PNGs and 16 MiB total PNG bytes |
| Pixels / inflated scanlines / PNG chunks | 16,777,216 / 64 MiB / 2048 |
| Issued sequence | Canonical decimal 1 through 999,999,999 |
| Outside-modal observer | One bounded prefix/frame count; 1-second inter-event gap |
| tmux query | 300 ms / 4096 bytes; at most three sequential queries per probe |

The modal assembler holds at most one bounded frame, ignores unframed typing and
unowned complete responses, and never displays reply contents. It handles complete
raw packets, coalesced records, encoded markers and split raw headers/terminators.
Malformed/oversized recognizable owned frames reject import; unknown frames do
not establish ownership. Timeout/cancel clears assembler/image data while keeping
small unresolved identity state. Only clean type/status/id-only DONE/error packets
with no MIME/payload release quarantine, including discard paths.

PNG validation requires legal bounded still noninterlaced PNG, chunk integrity,
contiguous IDAT, terminal IEND, bounded valid zlib/scanlines/filter bytes and valid
palette indices. APNG/interlaced PNG are rejected. Base64 must be padded/canonical;
MIME must be exactly `image/png`. Only OK + valid data + clean DONE stages an image.
Errors, logs, UI and session text never contain protocol/payload bytes.

Outside the dialog, ordinary Alt+], typing and bracketed paste are not held or
replayed. After explicit exit/lost focus, late printable protocol text can still
contaminate another UI/draft before best-effort ownership detection; nothing is
automatically erased. Filtering cannot protect another pane or a fresh runtime.

## Pending handoff and privacy

A separate widget shows how many PNGs are staged. Each successful paste appends
one PNG; a failed or cancelled paste does not discard earlier PNGs. If the count
or byte cap is already reached, no read is sent. If a valid new PNG won't fit
in the remaining budget, it is rejected after the read ends; a smaller one can
still fit. The byte cap counts PNG data before base64 encoding and applies only to
staged images, not to the in-flight read or to existing Pi attachments. `clear`
only drops already-staged PNGs; a read that is still in progress can later stage
its own PNG.

Commands, RPC and extension-authored input do not consume the list. The next
**interactive** input transform returns unchanged text plus existing attachments
in order, followed by the currently staged PNGs in paste order. It consumes the
list **at handoff, not a host storage/model-turn ACK**:

- An earlier handler's `handled` prevents our handoff and retains the pending PNGs.
- A later handler's `handled` or replacement images may discard it; it is not
  restored/retried into another prompt. The tested Pi runner catches a later
  handler's thrown error and continues with the previous transform.
- Host preflight/auth/submission failure after handoff likewise does not restore it.

There is no native draft-image setter/chip promise and no renderer-only custom
message substitute. No automatic submit/run is triggered. Normal Pi normalization,
`images.blockImages` and session storage apply upon intentional submission.
**Model blocking does not prevent storage.** Clearing drops the extension's references,
not a secure-erasure guarantee, and cannot rewrite already-submitted session data.

## Automated verification

```sh
node --test test/clipboard.test.mjs
npm test
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent \
  node --test test/host-clipboard-integration.mjs test/host-clipboard-tmux.mjs
PI_TEST_TUI_ROOT=/path/to/installed/pi-tui node --test test/host-clipboard-input.mjs
python3 scripts/probe-clipboard-routing.py
```

The **new transport regression** creates only a private temporary tmux server and
fake outer PTY. It sets that private server's extended-key formats, runs real
public `ProcessTerminal` keyboard negotiation, `StdinBuffer`, TUI, actual Editor,
SDK and a fresh copied extension. Synthetic OK/DATA/DONE replies traverse **real
tmux inbound key reencoding**, both CSI-u and xterm, coalesced and delayed/split.
Assertions observe encoded markers, a valid pending image, exact unchanged real
editor draft, zero editor protocol/modal-typing keys and zero model turns.
After the dialog closes, the same real PTY path also verifies ordinary typing,
native Alt+] and bracketed text paste against the actual editor. Only capability identity evidence is a fake PATH tmux; the graphics/input transport
uses the real absolute tmux executable/private socket. No physical terminal,
Ghostty clipboard or active server is touched. Tests require existing Python 3,
tmux and installed public Pi packages; they install no dependencies.

The SDK fixture separately verifies both model-blocking settings, handoff/other
handlers, clear/reload/branch, drain/explicit exit, ordinary input outside modal,
existing/covering overlays and malformed completion quarantine. Pure tests inject
timeout clocks and verify limits/PNG/IDs/fragmentation/ownership. Historical
framing/routing diagnostics still intentionally reproduce upstream hazards.

Single-image feature results on Pi/pi-tui **1.5.2**, private tmux **3.8** (historical):

| Gate | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Focused portable clipboard tests | 19 | 0 | 0 |
| Public SDK/TUI clipboard integration | 19 | 0 | 0 |
| Private real-tmux + actual ProcessTerminal/TUI/Editor/extension | 4 | 0 | 0 |
| Historical public input-framing diagnostic | 4 | 0 | 0 |
| `npm test` | 268 | 2 | 35 |
| Existing optional `test/host-integration.mjs` (prior gate) | 9 | 3 | 0 |

The two portable failures remain unchanged package-test expectations for
`extensions/tmux-image/index.ts`, while the manifest declares the flat entry.
They were previously reproduced against archived accepted `0124bd6`; no unrelated
manifest/test fix is included. The optional existing integration's two PDF/model-
policy subcases plus parent fail because **pdfinfo is absent on PATH**, not because
of a clipboard assertion. That optional PDF suite was not rerun for the current
clipboard-UX follow-ups; no Poppler installation/PDF fix was attempted.

Shortcut regression coverage uses fresh public loading plus the actual exported
`CustomEditor` and real extension-runner conflict handling. Public TUI keybinding
managers use documented native-paste/interrupt definitions and read only temporary
`keybindings.json` fixtures; this is not a claim of exercising the entire CLI
settings loader. Tests prove off/native dispatch, default/override native conflict
warning/override, optional unbind/remap, both custom keys, reserved user collisions,
invalid override, no extra confirmation, modal render before emission, exact draft/attachment preservation,
clear/handoff and repeat/overlay/cancel/unresolved guards, with no model turn.
Native paste callbacks are counters, never physical clipboard helpers. Current
coverage also verifies default and empty-override registration only in valid tmux
context; `off`, outside context and invalid pane preserve native dispatch (even
with a custom override). Valid startup has no informational toast, invalid values
still warn, confirmation stubs throw if called, and concise success retains the
pending clear affordance. Failed topology/overlay checks remain no-read; native
terminal denial (EPERM) coverage is retained.

The private transport cases activate the **default** shortcut by sending **Ctrl+V
from the fake outer PTY**, not programmatically submitting a slash command. The
shortcut override is explicitly unset; their temporary native binding is unbound
and factory loading is fresh. They assert exactly
one activating editor event, no Enter/submission/native clipboard callback, and
retain all prior protocol/draft/pending/outside-input assertions.

The private transport cases are **CSI-u and xterm**, each with a coalesced single
reply write (no timing gap) and split/delayed writes. They assert exact format-
specific encoded markers, not merely generic parsed Alt keys. The existing
private routing diagnostic still reproduces wrong-window delivery; the historical
Pi framing diagnostic still reproduces raw-control recovery. No upstream fix is
claimed.

The earlier modal gate passed isolated temporary HOME/`PI_CODING_AGENT_DIR`
`pi install <checkout>`, `pi list`, `pi --help` and public discovery (one extension,
zero errors, six commands). The shortcut gate instead uses public resource-loader
package discovery from a fresh copied manifest/source checkout and **temporary**
agent package settings: default/empty/custom in valid tmux discover one shortcut;
`off`, invalid value, outside tmux and invalid pane discover none. Each case loads
one extension/zero errors/six commands.
No new package installation or activation is performed for the shortcut task.
Fresh copied-checkout loading is also exercised by both host fixtures. Diff checks
pass. No runtime host dependencies were installed in this checkout, no active
user-server/config/package operation occurred, and these automated gates performed
no real clipboard/provider access or push. Full older host-seam suites that assume
another entry/package layout were not silently adapted.

## Successive pastes: automated verification

Portable coverage exercises the exact aggregate PNG-byte limit, the count limit,
clear/lifecycle cleanup, and retention after cancel. The offline Pi 1.5.2 SDK
fixture exercises repeated shortcuts in the actual editor and verifies attachment
order after submission with model blocking both on and off. Private tmux 3.8
transport regressions still exercise one read at a time. All 21 focused portable,
19 SDK and 4 private tmux checks passed. `npm test`: 270 passed, 35 skipped, and the
same two package entry-path failures reproduced on the unchanged baseline.
Isolated Pi installation and public discovery passed.

## Coordinated human verification: owner-confirmed image paste

Against code commit **`52e9ece`**, the owner completed one harmless-image smoke
test on **Ghostty 1.4.0/macOS → SSH/Linux → tmux 3.8 → Pi 1.5.2**. This was a
fresh isolated Pi process, not `/reload` or a package installation: the temporary
launcher explicitly loaded local `extensions/tmux-image.ts`, disabled discovery,
other extensions and tools, used an in-memory session and `PI_OFFLINE=1`, and kept
agent settings temporary (`cacheWarming` off, `images.blockImages=true`,
`terminal.showImages=false`). The owner copied the harmless Mac image and manually
invoked `/tmux-image-paste`, handling consent/permissions as needed. We did not
request or log the clipboard content.

The owner reported the exact success notice:

> PNG staged for your next interactive prompt; clear with /tmux-image-paste clear. Consumed at input handoff, not a storage acknowledgement; later extensions may discard it.

After being asked whether `/tmux-image-paste clear` removed pending state, the
editor stayed free of protocol/base64 and there was no automatic response, the
owner replied verbatim:

> yes, dissapeared and editor stayed clean

This supports a **real read through strict PNG validation to pending staging,
pending clear and a clean editor** on that one path. That isolated workflow
requested no intentional model submission and stopped at clear; by itself it
establishes neither image handoff/model receipt nor independent no-network/turn
instrumentation.

Subsequently, the owner sent an actual standard image attachment in the coordinator
conversation and asked whether the assistant could see it. The coordinator reported
receiving and accurately visually recognizing the image. The owner then explicitly
confirmed:

> so the image paste works!

This extends the human evidence to **owner-confirmed successful image paste with
actual assistant-visible image receipt/recognition**, beyond read/stage/clear.
No image content or payload is retained in this record. It is not a trace of exact
process identity or handler ordering, a host persistence/storage acknowledgement,
or an inspection of session-disk contents. Neither observation undoes the first
nonmodal failed-trial history above.

### Optional shortcut follow-up

Against **`3e12752`**, the owner tested the then-optional Ctrl+V shortcut and
reported verbatim:

> it works! i think we can remove the warnings and disclaimers now

This records owner-confirmed optional-shortcut success, not every modifier,
collision or cancellation case. The subsequent request to remove the opt-in
requirement authorized the new tmux-context default and concise routine copy;
it did not waive unresolved-read/focus hazards. No new image receipt, persistence
acknowledgement or handler-ordering trace is inferred from this shortcut report.

### Default shortcut and concise UI follow-up

After the default-shortcut/concise-UI changes (`2f5c0d8` and wording follow-up
`3bb690d`), the owner reported verbatim:

> works! make a commit and push

This is narrow owner confirmation that the default shortcut and concise UI worked,
not a full modifier/collision/cancel matrix or a storage acknowledgement. It does
not establish exact process/handler ordering. The owner then explicitly requested
removing the extension's extra first-use confirmation; **that newer no-confirmation
UX remains human-pending**, with automated actual-editor/private-tmux coverage.
Native Ghostty permission prompts and unsafe-exit confirmation are unchanged.

### Successive paste follow-up

After the successive-paste change (`173fa4a`), the owner sent two distinct image
attachments in one message. The assistant saw and distinguished both screenshots,
and the owner confirmed **“great! it works!”**. This confirms two-image receipt
in one prompt on the owner's setup, not the exact runtime configuration, storage,
or the full limits and cancellation matrix. No screenshots or payloads are stored
in this record.

Remaining human-pending cases include broader attachment-handoff/submission cases, denial,
Ctrl+C/drain, timeout, warned exit/late replies, cleanup failures, other PNG
variants/sizes, and broader terminal/layout/input cases. Automated coverage remains
separate evidence, not a full human matrix pass. Cross-pane/client/focus-switch
routing is still unsupported, not accepted by this success. Do not deliberately
switch panes or force fragmentation with real clipboard data; unresolved requests
still require resolving the terminal prompt before leaving. This record authorizes
no further read, installation, active-package operation or host/config change.
