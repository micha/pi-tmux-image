# Experimental focused-pane clipboard PNG dialog

## Current scope

`/tmux-image-paste` opens a visible **Reading clipboard—do not type** dialog.
Only while that owned dialog is visibly focused does clipboard assembly own
ordinary input. It uses Pi's existing TUI loop, not an editor replacement,
second terminal loop, host patch or keyboard-mode change. After a valid read,
the dialog is removed/flushed and one standard PNG is staged for the next
interactive user prompt. Nothing is submitted automatically.

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

The first command per runtime asks for explicit consent before any read is sent.
It explains modal input capture, staying focused, Ghostty permissions, cancellation,
warned exit and standard storage. Ghostty's own `clipboard-read=ask` permission
prompt remains intact; there is no password, automatic authorization or retry.

| Key/action | Meaning |
| --- | --- |
| Ordinary typing/text paste while dialog owns focus | Captured deliberately; not inserted or replayed into the editor. **Do not type.** |
| **Ctrl+C** | Cancel image import locally, drop image bytes, keep the visible dialog draining. |
| **Ctrl+Q**, once | Cancel locally and show the explicit late-reply/leave-anyway warning. |
| **Ctrl+Q**, again | Knowingly close the dialog; restore normal editing, retain unresolved request quarantine. Late replies may enter the draft. |
| Escape | Does **not** leave the dialog; raw ESC may be part of a split reply delimiter. Use the documented control keys. |
| `/tmux-image-paste cancel` (programmatic command invocation) | Same local cancellation/draining semantics; not cancellation of Ghostty permission. |
| `/tmux-image-paste clear` | Remove a pending image, not an outstanding terminal read. |

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

## Separate modules and public seams

- `src/clipboard.mjs`: public command, session lifecycle, input-transform handoff
  and visible pending state. Uses the existing widget-injected TUI transport.
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

A single explicit OSC 5522 `type=read` requests `image/png` through one tmux DCS
wrapper. Prefix is runtime-random; only canonical **actually issued** sequence
IDs are owned. Old IDs remain recognizable with one high-water mark, not an
unbounded tombstone list. No clipboard write, paste-event mode, shortcut override,
OS helper or configuration change is introduced.

| Resource | Bound |
| --- | --- |
| Deadline / active requests | 30 seconds / one |
| Encoded frame / metadata / decoded DATA chunk | 8192 chars / 512 chars / 4096 bytes |
| Read packet count | 4096 before rejecting import |
| PNG / staged images | 8 MiB / one |
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

One pending PNG is visible in a separate widget. Commands, RPC and extension-
authored input do not consume it. The next **interactive** input transform returns
unchanged text plus existing attachments in order, followed by the standard PNG.
It consumes pending state **at handoff, not a host storage/model-turn ACK**:

- An earlier handler's `handled` prevents our handoff and retains the pending image.
- A later handler's `handled` or replacement images may discard it; it is not
  restored/retried into another prompt. The tested Pi runner catches a later
  handler's thrown error and continues with the previous transform.
- Host preflight/auth/submission failure after handoff likewise does not restore it.

There is no native draft-image setter/chip promise and no renderer-only custom
message substitute. No automatic submit/run is triggered. Normal Pi normalization,
`images.blockImages` and session storage apply upon intentional submission.
**Model blocking does not prevent storage.** Clearing drops the extension's reference,
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

Automated results on Pi/pi-tui **1.5.2**, private tmux **3.8**:

| Gate | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Focused portable clipboard tests | 17 | 0 | 0 |
| Public SDK/TUI clipboard integration | 9 | 0 | 0 |
| Private real-tmux + actual ProcessTerminal/TUI/Editor/extension | 4 | 0 | 0 |
| Historical public input-framing diagnostic | 4 | 0 | 0 |
| `npm test` | 266 | 2 | 35 |
| Existing optional `test/host-integration.mjs` | 9 | 3 | 0 |

The two portable failures remain unchanged package-test expectations for
`extensions/tmux-image/index.ts`, while the manifest declares the flat entry.
They were previously reproduced against archived accepted `0124bd6`; no unrelated
manifest/test fix is included. The optional existing integration's two PDF/model-
policy subcases plus parent fail because **pdfinfo is absent on PATH**, not because
of a clipboard assertion. No Poppler installation/PDF fix was attempted.

The private transport cases are **CSI-u and xterm**, each with a coalesced single
reply write (no timing gap) and split/delayed writes. They assert exact format-
specific encoded markers, not merely generic parsed Alt keys. The existing
private routing diagnostic still reproduces wrong-window delivery; the historical
Pi framing diagnostic still reproduces raw-control recovery. No upstream fix is
claimed.

Isolated temporary HOME/`PI_CODING_AGENT_DIR`: `pi install <checkout>`, `pi list`,
`pi --help` and public resource discovery pass (one extension, zero errors, six
commands). Fresh copied-checkout loading is also exercised by both new host
fixtures. Diff checks pass. No runtime host dependencies were installed in this
checkout, no active user-server/config/package operation occurred, and these
automated gates performed no real clipboard/provider access or push. Full older host-seam suites that
assume another entry/package layout were not silently adapted.

## Coordinated human verification: narrow smoke test passed

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
pending clear and a clean editor** on that one path. The workflow requested no
intentional model submission and stopped at clear. It does not establish image
handoff, storage acknowledgement, model receipt or independent no-network/turn
instrumentation. It does not undo the first nonmodal failed-trial history above.

Remaining human-pending cases include attachment handoff/submission, denial,
Ctrl+C/drain, timeout, warned exit/late replies, cleanup failures, other PNG
variants/sizes, and broader terminal/layout/input cases. Automated coverage remains
separate evidence, not a full human matrix pass. Cross-pane/client/focus-switch
routing is still unsupported, not accepted by this success. Do not deliberately
switch panes or force fragmentation with real clipboard data; unresolved requests
still require resolving the terminal prompt before leaving. This record authorizes
no further read, installation, active-package operation or host/config change.
