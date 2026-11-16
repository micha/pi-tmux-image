# Remote clipboard image paste: blocked at tmux response routing

## Decision

Do **not** add `/tmux-image-paste` or a shortcut yet. Ghostty 1.4 implements the
required clipboard protocol, and public Pi APIs offer a possible pending-image
submission seam, but the tested tmux transport does not safely return responses
to their requesting pane. Outbound passthrough alone is insufficient.

A clipboard permission prompt can remain open while the user changes tmux
windows. A synthetic isolated experiment with **tmux 3.8** delivered the complete
OSC 5522 response, including its base64 payload and original request ID, to the
**newly active window**, not the requesting window. A Pi extension in the old
pane cannot consume input delivered to another process. That process could
interpret or log the clipboard payload as user input. Rechecking pane visibility
before sending, allowing only one attached client, or checking an ID inside Pi
cannot close this race.

No production code, command, shortcut, image staging, clipboard read, paste mode,
active configuration or package activation was changed. Existing text paste,
image/viewer/PDF behavior, settings and model policy are unchanged.

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

## Public Pi seam: possible, not implemented or integration-verified

Inspected installed **Pi 1.5.2** `docs/extensions.md` input/custom-UI sections,
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

No staging prototype was connected to the unsafe transport. Standard submitted
images must retain Pi's normal `images.blockImages` behavior and session storage:
blocking model access does **not** prevent submitted images from being stored.

## Reproduce without reading any clipboard

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

Success reproduces the **blocker**, not clipboard functionality. Changed behavior
makes the probe fail for investigation; it is not a universal feature detector.
This is synthetic automated transport evidence, **not** human Ghostty/macOS/SSH
round-trip acceptance. No real clipboard probe is authorized by this record.

## Checkout validation

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
model-policy integration: those features remain unimplemented behind the
transport blocker.

## Unblocking and future acceptance

First obtain a transport with explicit request ownership, routing, bounded
handling and late-response disposal across focus changes and pane destruction.
That likely requires tmux OSC 5522 support (or a separately approved alternative
transport). Merely asking users not to switch panes is not a privacy guarantee.
Do not lock user input, switch windows back, mutate tmux/Ghostty settings, add a
Mac helper or patch Pi internals to work around this.

After that prerequisite, implement clipboard handling as a separate bounded
subsystem, reusing topology checks without graphics-only policy gates. Require
explicit requests, conservative concurrency, strict owned-ID parsing, safe
cancellation/timeouts/denial/oversize/malformed handling, no spontaneous reads or
submissions, pending-image merge/cancel and lifecycle cleanup. Test fragmented
replies mixed with ordinary typing and bracketed text paste, existing
attachments, both model-blocking settings, and no payload/protocol logging.
Only then coordinate a real Ghostty 1.4/macOS → SSH → tmux → Pi permission/deny,
success and delayed-reply window-switch check with the owner, without activating
an active package or reading the clipboard implicitly.
