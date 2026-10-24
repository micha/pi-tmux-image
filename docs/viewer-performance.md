# Viewer performance follow-up — 0.4.1

## Owner report and scope

After generally confirming 0.4.0 wheel zoom/grab-to-pan worked, the owner reported
that **“zooming and panning is quite slow and somewhat janky.”** That is a real
responsiveness issue, not contradicted by the earlier functional acceptance or
passing correctness tests. The 0.4.1 patch addresses avoidable package hot-path
work; improved live appearance/responsiveness remains human-pending.

No terminal/Pi settings, capability TTLs, native ownership, model-image policy,
placement slot count, PDF behavior or budgeting policy are changed. The supported
surface remains a Pi-managed overlay in the current pane. No owner's active
package activation/reload was performed during investigation or implementation.

## Measured contributors

Read-only profiling used the production controller/native code and public Pi
1.0.3 components against an in-memory capture terminal. Times are exploratory
local JavaScript/capture measurements, not outer-terminal pixels, GPU latency,
SSH throughput or guaranteed FPS. Generated fixtures/scripts/logs stayed in
`/tmp`, outside Git. No provider or real terminal graphics were used.

- On a successful `allow-passthrough=on` preparation, the existing pre/post gates
  run two fresh three-query tmux inspections. A production-detector fake showed
  exactly six queries, even for pan preparations with **zero transport**. Actual
  read-only uncached three-query inspections measured about **7.9 ms median**;
  doubling that is an estimate, not a measured owner's on-path gesture latency.
  `all` paths normally use their existing cache; do not claim six subprocesses
  for every owner gesture or every raw input report.
- With an injected **15 ms delay per capability check**, 21 wheel reports yielded
  one zoom and an empty image during preparation. Thirty drag reports at 5 ms
  intervals yielded no committed pan during the burst, 29 blank samples, then one
  settled commit. This reproduces abort/restart starvation and dropped busy-phase
  wheel input under controlled delay, not a measurement of the owner's device.
- Placeholder rows were being passed through public width truncation on every
  render despite already having a validated width. Unchanged viewer rendering
  measured approximately **5.1 ms at 100×40** and **15.5 ms at 200×60**; unnecessary
  placeholder truncation closely tracked those costs.
- Pi's own Unicode width/compositing work remains material: a simplified changed
  public fullscreen capture frame measured about **19 ms at 100×40** and **63 ms
  at 200×60**. That profile omitted production viewer truncation and background
  transcript work. It is not additive end-to-end latency or human FPS evidence.

## Implemented changes

### Proven rows-only pan

`native.reuseViewer({lease,canvas,window},{epoch,signal})` is synchronous and
read-only. It returns a zero-upload prepared shape only when the native owner can
prove a live exact lease, same current epoch, successfully committed resident
image/private placement, identical canvas including cell pixels, bounded window,
and no pending viewer replacement/private replay/retirement or uncertain trust.
A miss does not create/change an epoch, normalize pixels, allocate IDs, take a
write reservation or account transport. Rows are encoded once, not twice.

The controller uses reuse only within the same live pane/layout/cell stamp.
Same-canvas pan therefore changes addressed text without asynchronous capability
queries or graphics writes. Current synchronous ready-policy still gates reuse
and render. **Every actual preparation/upload, replay, resize or recovery still
uses the existing pre/post capability checks and fresh `on` visibility policy.**
No cache/force shortcut weakens those gates.

### Last resident frame during zoom

Ready records now keep their own view/origin, native residency proof and layout,
separate from desired geometry. A same-layout guarded zoom keeps that frame and
its truthful displayed percentage while showing **“Updating viewport…”** below
the border. It never inserts old rows at the desired new origin/canvas. Changed
pane/cell layout, policy loss, close, uncertain write or failed preparation drops
retained readiness; initial/loading/error/tiny fallback still does not invent an
image surface. Live width/height/cells are resampled after the final async gate,
even if Pi has not yet rendered the resize.

Wheel input stores **one latest sign/point** during a live replacement or after
commit but before its first new frame. Consumption waits for that new resident
frame's rendered receipt and anchors to its actual mapping. This is not accumulated
desired zoom or a report backlog; first loading/picker/chrome remain non-admitting.
Keyboard/reset/press, layout/cell changes, failure, focus loss and close cancel
queued gestures. Superseded jobs still cannot commit obsolete geometry.

### Trust revocation before writes

Prepared results expose `isResident()` independently of their short-lived write
reservation `isCurrent()`. The presentation seam invokes optional
`onUploadStarted()` **after final guards, immediately before a nonempty synchronous
write**. The native owner revokes affected residency before possibly partial bytes;
success restores trust before guarded accounting. Failure cannot keep old geometry
trusted. A first attempted private tuple with no successful prototype is retained
as one bounded cleanup obligation and retired on close/retry, never replayed as
successful history. Stale callbacks cannot affect later epochs/leases/commits.
No global/pixel deletion or additional placement slot is introduced.

### Known-width row assembly

Native placeholder windows have exactly their validated column count. The viewer
uses that count for padding and assigns already-fitting border/image rows directly,
without redundant `visibleWidth`/`truncateToWidth` scans. Arbitrary labels, hints,
errors and other chrome still use public width helpers. ID-color cells are not
restyled; pure/protocol and actual-host width/ID tests remain mandatory. Pi still
performs its own layout/composition work; no host utilities are patched and no
second renderer/input loop is added.

### Matched final profile

A second, matched profile used the same measurement procedures against the
Git-exported 0.4.0 baseline and final 0.4.1 production sources. Its readiness
helper waits for a stable current frame, not merely placeholder presence (which
would return early on deliberately retained rows).

| Pane | Viewer component render median before | After |
| --- | ---: | ---: |
| 40×16 | 0.701 ms | 0.044 ms |
| 100×40 | 6.976 ms | 0.041 ms |
| 200×60 | 17.349 ms | 0.040 ms |

These component-only timings exclude row encoding in the input handler and Pi's
full frame/terminal processing. Native synchronous reuse measured about 0.136 ms
for a 96×34 window. At larger windows allocation/GC variance can dominate; the
structural benefit is removal of probes, reservation and async restart churn,
not a promise that every encoding benchmark improves.

Under the matched injected-delay scenario, 30 timed drag reports now produce
**zero async preparations, zero capability checks and zero blank samples**, with
29 synchronous motion updates and one release update. Twenty-one wheel reports
produce two zooms (first plus latest busy event) rather than one, without a
preparation blank or accumulated backlog.

The unchanged simplified host benchmark still measured roughly **20.5 ms at
100×40** and **68.4 ms at 200×60**. This separate Pi Unicode/compositing cost is not
credited to the package fix and can still limit large-pane responsiveness.

## Verification

Final automated checks on **0.4.1**, installed Pi **1.0.3**:

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Portable `npm test` | 181 | 0 | 32 optional host tests |
| Host-enabled `npm test` | 213 | 0 | 0 |
| Existing standalone SDK `test/host-integration.mjs` | 12 | 0 | 0 |
| Production standalone SDK `test/host-viewer-integration.mjs` | 17 | 0 | 0 |
| Production standalone without host root | 0 | 0 | 1 optional parent |

The coordinator reran both SDK suites and portable/full host suites. The production
SDK verifies isolated local installation/discovery/resource loading without
activating the owner's package. Independent xhigh review also passed the
host-enabled focused suite **78/78**, full host suite **213/213** and SDK matrices,
with no remaining actionable blocker. Three independent controller races were
found, fixed and persisted: wheel between commit and render, live resize/cell
change before the next render, and a failed wheel surviving a resize round trip.
No acceptance assertions were weakened.

Production SHA-256 prefixes: native `c03cb3332eaa`, presentation `12265f6f05c2`,
viewer `56091474f578`; acceptance harness `c0672fb9d152`. Detector and extension
gate wiring are unchanged.

Tests establish 10,000 native/controller rows-only reuses with bounded state and
no normalization/allocation/reservation/transport/accounting; first-attempt and
replacement uncertainty, stale callbacks, inline replay and retirement/retry;
known-width row bounds/ID preservation; own-view continuity through delayed pre
and post gates, one latest pending/unrendered-frame wheel, and unchanged exact
messages/attachments/model conversion/editor/transcript/source/PDF activity.
The production option-`on` case has **40 separately rendered pans with zero
additional fake tmux queries or graphics writes**. Its two zooms still require
exactly **12 fresh queries**, two resident prototype replacements and zero PNG
uploads. Actual captured changed-row output witnesses the intermediate ready
mapping before follow-up wheel transport; independent half-new-cell source-anchor
assertions and an old-vs-new mapping negative control are retained.

The 40-pan integration elapsed diagnostic includes decoding/assertions/timers,
not just production rendering: do not turn it into a latency/FPS claim. All
results above are automated math/stream/component/capture evidence.

The one-slot terminal protocol still cannot promise atomic pixels: a replacement
can briefly reinterpret previously displayed cells before the next text frame.
Removing application blanking and unnecessary work is not a Kitty ACK, memory
bound or universal smooth-render guarantee. Large pane host compositing and real
terminal/transport costs remain outside the measured package-only improvement.

## Coordinated live follow-up

After the owner chooses to reload, compare wheel zoom and two-axis drag on the same
image and pane size used for the reported issue. Check that the image no longer
vanishes during zoom, a continuous drag progresses rather than waiting until
release, and a wheel report while updating is handled without a long backlog.
Also check reset/Escape, inline history and resize/cell changes. Record device and
pane dimensions if further jank remains; do not change settings or shrink the
agreed viewer surface as an undisclosed performance workaround.

Prior 0.4.0 **functional** acceptance remains recorded in `viewer-mouse.md`; it is
not human acceptance of this performance patch. No numerical responsiveness or
outer-terminal frame-rate claim is made before that follow-up.
