# Viewer mouse gestures — 0.4.0

## Authorization and behavior

The owner approved **wheel zoom and click-drag panning**, following a feasibility
review of the current viewer and installed Pi 1.0.3 public mouse APIs. This
supersedes the earlier ignore-wheel/undecided viewer mouse policy, not the
inline transcript click/selection contracts. No budgeting or configuration change
is authorized. Core 0.3.0 viewer human acceptance remains historical evidence;
the owner also generally accepted these new gestures after implementation at
`fcf465f` / 0.4.0 (see the scoped confirmation below).

- **Fullscreen only:** wheel up zooms in; wheel down zooms out. Use the existing
  1.25× fit-relative step, 25% minimum and dynamic 297×297 full-canvas maximum.
- Zoom anchors the source point under the pointer, subject to whole-cell
  addressing, aspect-fit padding and unavoidable edge/full-visible-axis clamping.
  Keyboard `+/-` continue to preserve the viewed source center.
- Wheel acts within the inner usable image area only after a ready surface has
  been rendered. Pi's `wheelDelta` is accelerated transcript lines, not a notch
  count: only its sign is used. A synchronous input burst retains one latest
  direction/point and applies one step in one microtask, not a step per line.
  Loading/error rows, picker, chrome and tiny-pane fallback consume wheel without
  zooming; reports arriving while a new viewport is preparing are ignored.
- **Left-drag grabs occupied image cells:** the image follows the pointer in both
  axes, one displayed cell per pointer cell. Centered blank margins and other
  buttons do not start a grab. Public capture permits continuing outside the
  image rectangle within Pi; it is not an OS grab and cannot force reports from
  another tmux pane or terminal window. Motion is incremental; edge clamps do not
  accumulate hidden movement, so reversing at an edge responds immediately. Release applies any
  final pointer displacement and ends the grab.
- Keyboard input, wheel input, pane/cell/canvas changes, close and public focus
  loss cancel the grab. A new open starts fit/recentered without gesture state.
- The full-pane overlay continues to consume unrelated mouse input without
  requesting focus again. Existing modal admission and close-on-focus-loss remain
  mandatory. With the overlay closed, inline ready-cell clicks and Pi-owned
  transcript drag selection, links and wheel scrolling are unchanged.
- Regular mode remains keyboard-only: Pi owns no normalized mouse routing there;
  the terminal owns its scrollback. No mouse-mode/configuration workaround is used.

## Implementation and public API evidence

`src/viewport.mjs` adds pure `zoomViewportAt(input, direction, point)`;
`point={column,row}` is continuous cell space relative to the usable image area.
The controller supplies the center of the reported cell (`+0.5`). The helper
reconstructs the current source point from committed window offsets, origin,
padding and uniform effective scale, solves the next center using new geometry,
then clamps and quantizes through `computeViewport`. Min/max repeated zoom is a
no-op, without artificial center reconstruction drift. Existing keyboard math
is unchanged.

`src/viewer.mjs` records a rendered ready key/layout for mouse admission. It owns
one latest queued wheel job and one microtask, one incremental grab record, and
the existing single pending/latest prepare runner. Captured host bounds are
last-frame state: live pane/cell/canvas changes invalidate a grab before motion
is interpreted. Captured/stale component callbacks check the current lease and
policy and cannot affect a subsequent viewer. Closing synchronously clears all
gesture work before deferred owned removal and scoped native retirement.

Installed Pi 1.0.3 primary evidence:

- Complete `docs/tui.md` and `docs/extensions.md`, shipped
  `examples/extensions/overlay-qa-tests.ts` and public pi-tui `dist/tui.d.ts`.
- Public `Component.handleMouse(TuiMouseEvent)` receives local zero-based `x/y`,
  `press/drag/release/wheel` types, buttons, modifiers and optional `wheelDelta`.
  Returning `{handled:true,capture:true,render:false}` on primary press captures
  subsequent drag/release without changing keyboard focus.
- Read-only inspection of installed fullscreen routing confirms wheel magnitude
  includes acceleration and Alt multiplication; capture dispatch retains the
  press target and clears it on release. No private modules are imported and no
  host input loop or stdout method is patched.

No source rereads, decoding per gesture, PDF rerasterization, attachment/session
messages, model turns, settings writes or new placement identities are introduced.
Native/presentation/metrics/protocol owners are unchanged. Pan only changes
addressed text cells; zoom replaces the shared owner's single private prototype
without resident PNG retransmission. Resource retirement remains scoped and
requires a public removal frame.

## Verification and remaining manual acceptance

Final automated checks on package **0.4.0**, installed Pi **1.0.3**:

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Portable `npm test` | 162 | 0 | 32 optional host tests |
| Host-enabled `npm test` | 194 | 0 | 0 |
| Existing standalone `test/host-integration.mjs` | 12 | 0 | 0 |
| Production standalone `test/host-viewer-integration.mjs` | 16 | 0 | 0 |
| Production standalone without a host root | 0 | 0 | 1 optional parent |

The coordinator reran portable, full host-enabled, existing SDK and production
SDK suites on the final production/test sources. The production SDK harness
verified local `pi install` and resource loading under a temporary isolated agent
directory. Independent read-only review found no actionable correctness/safety
defects; its three additional ready-before-render, queued-wheel cancellation and
held-prepare 10,000-drag regressions were persisted in `test/viewer.test.mjs` and
included in the final totals. Focused controller and viewport suites contain
19 and 15 tests respectively.

Production-source SHA-256 prefixes: viewer `2f8a1a468588`, viewport
`3f80c1e9fde2`, unchanged extension `5525d531cc6c`; production acceptance harness
`c2900103a741`. No active package install/reload, real terminal graphics, settings,
tmux changes or provider requests occurred. The existing controlled offline
background-stream case remains a fake request, not a network/model call.

Tests cover independent nearest-achievable source-point reconstruction, padding,
clamping, limit no-ops and fractional cells; controller admission/cancellation and
held async races; production SGR wheel sign/Alt-acceleration, synchronous 10,001
wheel coalescing, 10,000 captured pan reports with zero PNG/prototype transport,
inside/outside release and edge reversal, resize/cell/tiny-pane cancellation,
modal/Escape close/reopen, exact unchanged messages/entries/model conversion and
editor/transcript state. Unclamped actual-host anchor assertions use half a new
cell plus floating tolerance, with an independent centered-zoom negative control.
Regular input remains a no-op for mouse while keyboard controls still work.

The initial host-enabled run caught a PDF page-row regression; production restored
its dedicated page row rather than weakening the existing assertion. All final
runs pass. These checks are math/stream/component evidence, not outer-terminal
pixels, Kitty acknowledgments, measured heap/GPU bounds or a latency benchmark.

## General owner acceptance and unreported manual cases

After the 0.4.0 implementation commit **`fcf465f`**, the owner confirmed
**“it works!”** in response to the handoff asking them to reload, open a PNG or PDF
page, and try wheel zoom and dragging. This records general human acceptance of
the new mouse interactions on the existing setup; it is separate from automated
evidence and prior 0.3.0 acceptance.

The owner did not identify the image/page, input device, reload step or individual
edge/resize/modal cases exercised. Do not infer both PDF pages, trackpad testing,
precise pointer anchoring, all edge/release cases or a latency measurement from
that confirmation. No agent/camera pixel inspection was performed. The previously
recorded setup is Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3 with
`terminal.images: auto` / `images.blockImages: true`; no new configuration details
were reported.

The following narrower manual checks remain unreported, not a reason to label the
core gestures unaccepted:


1. Open a PNG and each PDF page; wheel over an off-center feature in both
   directions. The feature should stay near the pointer until an edge or fully
   visible axis makes anchoring impossible. Check fit/minimum/maximum/reset.
2. Left-drag in both axes, reach each edge, reverse, release outside the image,
   and drag again. Check cell-stepped motion and actual responsiveness with both
   wheel and trackpad input. Other buttons/chrome must not pan.
3. Resize or tmux zoom during a grab, release and start a fresh grab. Open host
   search/dialog or Escape mid-grab; reopen fitted with inline history intact.
4. Close the viewer; transcript selection, links and wheel scrolling must behave
   as before. Keyboard controls must still work in regular mode.

Do not reload/activate the owner's package without coordination. No human results
for these gestures are inferred from prior 0.3.0 viewer acceptance.
