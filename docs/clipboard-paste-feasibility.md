# Remote clipboard image paste: routing/framing evidence

## Current implementation status

`/tmux-image-paste` now uses an explicitly accepted **visible
input-owning dialog** in the focused pane. It normalizes tmux CSI-u/xterm Alt-key
markers and assembles bounded replies only while that dialog owns input. This
supersedes the nonmodal implementation in `2493197`, whose first real trial
reported timeout and printable protocol text in the draft.

The follow-up private tmux 3.8 reproduction found complete OSC replies are
key-reencoded under Pi's normal modifyOtherKeys mode plus extended keys—even
without timing gaps. That path was absent from the earlier fake-terminal SDK
fixture. The new regression traverses real private tmux inbound encoding and
public ProcessTerminal/TUI/Editor. See [clipboard-paste.md](clipboard-paste.md)
for current keys, limits, lifecycle and evidence. Outside-modal late contamination
and focus-independent routing remain unsafe; none of the upstream observations
below is claimed fixed. No tmux/Pi patch, key-mode/config change, pane focus lock,
key replay, draft repair or permission bypass is used.

## Earlier conservative decision (superseded for experimental v1)

The owner explicitly approved a **focused-pane-only** workflow: paste only into
the focused pane and do not change panes before completion. General safe routing
is still blocked, but tmux origin-ID routing is **not** a prerequisite for that
narrower approved workflow. The original routing evidence below remains valid;
focus checks do not remove its hazard.

A second investigation found a separate blocker in the installed **Pi 1.5.2**
input seam: delayed fragments of OSC 5522 are converted into legacy Alt-key and
printable-text events before extensions receive them. No supported design was
found that both bounds owned-response handling and preserves ordinary key
semantics through the available public seams, even with no pane switch. See **Focused-pane host-input gate** below. `/tmux-image-paste` is
was not implemented at that investigation stage. Ghostty 1.4 protocol support
and the focused-pane agreement do not fix this separate host-input gate. The
owner subsequently accepted experimental detection **after possible draft
contamination**, rather than requiring prevention through public seams; the
current implementation therefore proceeds without claiming that gate solved.

## Original routing evidence (still applies outside the approved workflow)

A clipboard permission prompt can remain open while the user changes tmux
windows. A synthetic isolated experiment with **tmux 3.8** delivered the complete
OSC 5522 response, including its base64 payload and original request ID, to the
**newly active window**, not the requesting window. A Pi extension in the old
pane cannot consume input delivered to another process. That process could
interpret or log the clipboard payload as user input. Rechecking pane visibility
before sending, allowing only one attached client, or checking an ID inside Pi
cannot close this race.

The original feasibility investigation changed no production code, command,
shortcut, image staging, clipboard read, paste mode, active configuration or
package activation. Its observations were synthetic. Current experimental
implementation is documented separately; no real clipboard probe or active
package operation is authorized by either record.

## Primary protocol evidence

Sources consulted:

- [Kitty clipboard specification](https://sw.kovidgoyal.net/kitty/clipboard/).
- [Ghostty 1.4 release notes](https://ghostty.org/docs/install/release-notes/1-4-0),
  also retrieved through Context7 `/ghostty-org/website`.
- [tmux passthrough FAQ](https://github.com/tmux/tmux/wiki/FAQ), also retrieved
  through Context7 `/tmux/tmux`.
- tmux [`tty-keys.c` at 3.6a](https://github.com/tmux/tmux/blob/3.6a/tty-keys.c)
  and [upstream master](https://github.com/tmux/tmux/blob/master/tty-keys.c):
  inspected clipboard handling recognizes OSC 52; no OSC 5522 routing was found.
  The source inspection is not a runtime test of 3.6a. The master reference is
  moving; rerun the isolated experiment against any candidate newer release.

This is **not** the Kitty graphics protocol. Its framing is:

```text
ESC ] 5522 ; metadata [ ; payload ] ESC \
```

Metadata is colon-separated `key=value` pairs. A PNG-only read could send:

```text
ESC ] 5522 ; type=read:id=REQUEST_ID ; aW1hZ2UvcG5n ESC \
```

The payload is standard padded base64 of `image/png`. Reading `Lg==` instead
lists MIME types (`.`); the spec recommends allowing enumeration without a
permission prompt. Replies echo `id` on **every** packet and follow:

```text
ESC ] 5522 ; type=read:status=OK:id=REQUEST_ID ESC \
ESC ] 5522 ; type=read:status=DATA:id=REQUEST_ID:mime=aW1hZ2UvcG5n ; BASE64 ESC \
... zero or more further DATA packets ...
ESC ] 5522 ; type=read:status=DONE:id=REQUEST_ID ESC \
```

Each DATA packet is independently padded base64, with recommended chunks no
larger than 4096 decoded bytes. These are **per-packet** sizes, not a total-image
bound. A future implementation must enforce its own decoded-byte, packet-count,
metadata and time limits and validate base64 strictly (not Node's permissive
base64 decoding alone). It must not mistake absent PNG data for a valid image.

An error replaces the opening OK: `EPERM` (denied), `ENOSYS` (unavailable clipboard
selection), or `EBUSY` (temporary contention). The specification has no read
cancellation packet. An application timeout cannot prevent a later terminal
permission decision from producing a reply.

`id` permits only `[a-zA-Z0-9-_+.]`; terminals echo it to enable multiplexer
routing. The specification explicitly assigns response routing and arbitration
to multiplexers. The tmux DCS wrapper only bypasses the **outbound** parser; it
does not register a destination for the eventual response.

`CSI ? 5522 $ p` queries paste-mode support; replies are
`CSI ? 5522 ; Ps $ y`, with 0/4 unsupported. Enabling paste-event mode
(`CSI ? 5522 h`) changes normal terminal paste behavior and is **not** needed or
approved for this explicit-command feature. No such mode is enabled by the probe.

Ghostty 1.4 implements arbitrary-MIME reads and permission prompts; 1.3 only
parsed the protocol. Its default `clipboard-read=ask` must remain intact. No
password/name remembering, configuration changes, or permission bypass is needed.
Graphics support, truecolor, `terminal.showImages` and placeholder support do not
establish clipboard capability.

## Original public Pi staging assessment (current integration recorded separately)

Inspected installed **Pi 1.5.2** complete `docs/extensions.md`,
`docs/tui.md`, shipped `examples/extensions/input-transform.ts`, public extension
types and terminal/input implementation. Existing repository renderer evidence
in `renderer-seam.md` covers **Pi 1.0.3**, not this new clipboard feature.

- `ctx.ui.onTerminalInput(handler)` publicly supports consuming or replacing
  input and returns an unsubscribe function. It only sees input routed to Pi.
- A namespaced `setWidget` factory provides the public TUI/terminal write seam;
  no stdout patch or second stdin owner should be introduced.
- `input` events contain `text`, `images`, `source` and `streamingBehavior`.
  `{ action: "transform", text, images }` can merge a pending image with existing
  attachments on a later **interactive** user submission. It need not submit a
  prompt itself. Extension commands bypass the input event.
- The inspected UI API offers editor text methods, not a native draft-image
  attachment setter. A separate visible pending indicator/cancel action would
  be required; native attachment chips are not promised. Input transforms can
  chain and another extension can handle submission, so pending-state commit
  semantics need explicit testing rather than claiming a submission ACK.
- Lifecycle cancellation and late replies require further design even after
  routing is fixed: session changes/reload must not cause payloads to enter a
  replacement editor or a different pending request.

At the original investigation stage no staging prototype was connected. Standard submitted
images must retain Pi's normal `images.blockImages` behavior and session storage:
blocking model access does **not** prevent submitted images from being stored.

## Focused-pane host-input gate

`test/host-clipboard-input.mjs` uses only **public pi-tui 1.5.2 exports**:
`StdinBuffer`, `TuiMainScreen`, `addInputListener`, and a fake terminal/focused
component. It never starts a real terminal or sends clipboard requests. These
are the buffer and TUI listener that underlie `ctx.ui.onTerminalInput`.

Observed cases:

1. A complete synthetic OSC 5522 DATA packet reaches the public listener as one
   event: straightforward exact-ID consumption would be possible here.
2. The same packet, split **after the owned ID and part of the synthetic base64**,
   with a 100 ms gap, reaches both the public input listener and focused
   component as `ESC ]` followed by individual printable metadata/payload keys.
   No pane/client/session change is involved.
3. An ordinary standalone Alt+] also produces the same `ESC ]` listener event.
4. Plain typing and bracketed text paste remain ordinary input in the fixture.

The installed `StdinBuffer` has a 50 ms default sequence timeout. Its protected
terminal-reply header list covers color/program-status/XTVersion/graphics
replies, but **not OSC 5522**. On timeout an unrecognized OSC is intentionally
recovered as Alt+] plus reparsed keystrokes. This is a **gap inside a packet**,
not a delay waiting for Ghostty permission before any response starts.

An extension cannot decide ownership on the initial Alt+] event. Passing it and
subsequent header bytes through leaks protocol text; retaining it until an ID
appears can hold a real Alt+] indefinitely. A bounded timer would need a way to
replay that key through the original host input pipeline, but the public
`onTerminalInput` callback only synchronously returns consume/replacement data.
There is no public asynchronous raw-key replay method. `pasteToEditor` and
`setEditorText` insert text; they do not replay original key/shortcut semantics.
Reaching into the current editor or terminal input internals, replacing the
editor, or adding another stdin owner is outside the approved design.

The same ambiguity applies to an owned **late** reply after a request timeout.
A runtime-random ID prefix plus issued-sequence high-water mark could identify
old requests in bounded space, but only **after intact framing reaches the
extension**. It cannot make the initial Alt+] event safely attributable.

The smallest host prerequisite is proper OSC 5522 response framing before the
legacy-Alt recovery path, with bounded buffering/recovery and a supported way
for extensions to consume owned responses (for example a public bounded
terminal-response registration/parser seam). Merely increasing timeouts,
assuming every packet arrives in one chunk, or swallowing all Alt+] is not
safe. Native OSC 5522 recognition would address the demonstrated long-packet
fragment case; header fragmentation and malformed/unterminated packet bounds
would still need explicit tests. No host patch is made or activated here.

Run explicitly against a host-supplied **pi-tui package root** (which may be a
sibling of coding-agent in a packaged distribution):

```sh
PI_TEST_TUI_ROOT=/path/to/installed/pi-tui node --test test/host-clipboard-input.mjs
```

Result on pi-tui 1.5.2: **4 passed, 0 failed, 0 skipped**. These passing assertions
reproduce the limitation, not a working paste feature. A host with corrected
framing should fail the limitation assertions and be reevaluated. The diagnostic
is outside the default `*.test.mjs` suite and skips explicitly without a host
root; it imports no private host modules or physical dependencies into this repo.

## Reproduce tmux routing without reading any clipboard

```sh
python3 scripts/probe-clipboard-routing.py
```

Requirements: POSIX PTYs, Python 3 standard library, PATH-resolved tmux. This is
an explicit diagnostic, not a runtime dependency or part of `npm test`.

The probe creates a private temporary tmux socket/server with `/dev/null` config,
a fake outer terminal PTY, and two controlled receiver windows. It enables
passthrough **only on that private server**. Nothing from the fake terminal is
written to the invoking terminal. It observes a DCS-wrapped read request, injects
synthetic OK/DATA/DONE responses, then issues a second request and changes windows
before injecting its response. It also injects ordinary text typing while each
window is active and checks that those bytes arrive unchanged before the reply.
This verifies the fake transport preserves normal typing, not Pi editor or
native clipboard integration. The payload is a fixed synthetic marker, not an
image or clipboard data. All processes/files are cleaned up on normal completion
or handled errors. Like other processes, an uncatchable kill can leave temporary
resources. It does not contact Ghostty, SSH, Pi, a provider, or the active tmux
server; no user configuration is changed.

Observed output on tmux 3.8:

```json
{
  "tmux": "tmux 3.8",
  "outbound_passthrough_observed": true,
  "normal_typing_preserved_in_both_windows": true,
  "same_active_pane_received_exact_reply": true,
  "different_active_pane_received_origin_reply": true,
  "real_clipboard_accessed": false
}
```

Success reproduces the **unsupported focus-change hazard**, not clipboard
functionality. Changed behavior makes the probe fail for investigation; it is
not a universal feature detector.
This is synthetic automated transport evidence, **not** human Ghostty/macOS/SSH
round-trip acceptance. No real clipboard probe is authorized by this record.

## Historical evidence-only checkout validation

For this documentation/diagnostic-only change:

- `python3 scripts/probe-clipboard-routing.py`: reproduced both same-active-pane
  delivery and wrong-window delivery on tmux 3.8, with ordinary typing preserved
  byte-for-byte in both fake receivers.
- `python3 -m py_compile scripts/probe-clipboard-routing.py`: passed; generated
  bytecode removed from the checkout.
- `npm test`: **249 passed, 35 skipped, 2 failed**. Both failures are an existing
  package-test path mismatch: `test/package.test.mjs` expects
  `./extensions/tmux-image/index.ts`, while the unchanged package manifest and
  actual entry point use `./extensions/tmux-image.ts`; the second failure is
  ENOENT for that expected path. No runtime/test-path correction was folded into
  this feasibility change.
- Isolated temporary `PI_CODING_AGENT_DIR` / HOME: `pi install <checkout>`,
  `pi list`, `pi --help` passed. Public Pi 1.5.2 `DefaultResourceLoader.reload()`
  discovered one extension, zero loading errors and exactly the existing five
  commands; no model/provider request or active package change.
- Full optional host integration was not run: its documented package-root
  `node_modules/@earendil-works/pi-tui` layout is absent in this installed Pi
  distribution (pi-tui is a sibling package). No host dependencies or harness
  compatibility changes were introduced to broaden this task.
- `git diff --check`: passed. No real clipboard or physical-terminal test ran.

The existing suite results do not verify clipboard staging, parsing, bounds or
model-policy integration: those features remain unimplemented. The focused-pane
follow-up's separate public-host diagnostic is recorded above; a clean archive
of accepted baseline `0124bd6` was independently tested with `npm test` and
reproduced **249 passed, 35 skipped, 2 failed**, with the same two entry-path
failures. No unrelated manifest/test fix is included.

## Requirements for stronger guarantees (not experimental v1 prerequisites)

For **focused-pane-only** support without the accepted draft-contamination
compromise, first resolve the Pi host-input framing gate.
Then require explicit first-use consent to remain in the same focused pane,
client and Pi session/process until completion, including terminal permission
prompts. Timeout/cancel does **not** cancel that prompt or guarantee no late
response. Leaving, disconnecting or switching during an outstanding request is
unsupported; focus checks may warn/reject but cannot prevent misrouting.

For **general focus-independent** support, additionally obtain explicit tmux
OSC 5522 origin-ID routing and late-response ownership across focus changes and
pane destruction (or a separately approved alternative transport). The focused
workflow agreement is not a general privacy guarantee.

Do not lock user input, switch windows back, mutate tmux/Ghostty settings, add a
Mac helper or patch Pi internals to work around either gate.

After the applicable prerequisite, implement clipboard handling as a separate
bounded subsystem, reusing topology checks without graphics-only policy gates.
Require explicit requests, conservative concurrency, strict owned-ID parsing, safe
cancellation/timeouts/denial/oversize/malformed handling, no spontaneous reads or
submissions, pending-image merge/cancel and lifecycle cleanup. Test fragmented
replies mixed with ordinary typing and bracketed text paste, existing
attachments, both model-blocking settings, and no payload/protocol logging.
Only then coordinate real Ghostty 1.4/macOS → SSH → tmux → Pi permission/denial
and success checks with the owner, without activating an active package or
reading the clipboard implicitly. Focus-change leakage remains a synthetic-only
unsupported-path check until general routing is fixed.
