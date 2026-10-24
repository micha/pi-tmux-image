# Handoff: latest-state viewer pacing and catch-up investigation

## 1. Status, authority and baseline

**This is a documentation-only handoff requested by the owner.** It authorizes
writing/reviewing this plan, not implementation, active installation/reload,
settings changes, a Pi fork or an upstream patch. Obtain an explicit proceed
before implementing the proposed phases. Numerical cadence/expiry examples below
are experiment candidates, not selected product defaults or performance promises.
No package version bump is part of this planning checkpoint.

Current implementation baseline: **`1f00268` / 0.4.1**. Functional mouse viewer
baseline: **`fcf465f` / 0.4.0**, generally owner-accepted; acceptance record
`0e0e832`. Earlier core viewer acceptance is separate. Read `AGENTS.md` and:

- [viewer-performance.md](viewer-performance.md): 0.4.1 implementation, matched
  profiles, proof/write-attempt contracts and automated evidence.
- [viewer-mouse.md](viewer-mouse.md): controls, pointer anchoring and scoped
  functional acceptance.
- [viewer-seam.md](viewer-seam.md), [viewer-lifetime.md](viewer-lifetime.md),
  [viewer-crop.md](viewer-crop.md): public raw-overlay lifetime, fixed-slot native
  ownership and independently addressed bounded canvas.
- [implementation-plan.md](implementation-plan.md),
  [capabilities.md](capabilities.md), [graphics-memory.md](graphics-memory.md):
  existing authorization, replay, accounting and no-eviction contracts.

After 0.4.1 delivery, the owner reported:

> it's better now, but still laggy. it gets bogged down and slows, then races
> forward to catch up. perhaps we need to drop frames more aggressively? or is
> there more profiling and code optimization to do?

Record this as **partial observed improvement with an unresolved responsiveness
problem**, not full performance acceptance. No numerical latency, device,
case-by-case matrix or new configuration details were reported. The previously
recorded setup is Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3 with automatic Pi images and
model-image blocking; do not infer a newly verified setup from this report.

Baseline automated evidence, not rerun pixel evidence: portable **181 passed / 32
optional skips**, host-enabled **213/213**, production viewer SDK **17/17**, existing
SDK **12/12**. Passing bounded-controller tests do not prove bounded terminal
output backlog or acceptable human latency.

## 2. Recommended direction and evidence limits

**Prioritize latest-state sampling and pacing of changed viewer frames, accompanied
by input/output profiling.** Do not spend the next phase merely shaving viewport
math. Drop obsolete *presentations* before row generation/transport, not necessary
input semantics, and never replay a trail of intermediate viewport poses.

### What is already established

- 0.4.1 removed async upload preparation from proven same-layout resident pan,
  retained an own-geometry ready frame during zoom and removed redundant viewer
  placeholder truncation. Keep these improvements.
- Package component render at 100×40 measured **6.976 → 0.041 ms median** in a
  matched capture profile. That excludes input-handler row encoding and full Pi
  rendering. It is not end-to-end display latency.
- The separate unchanged public-host changed-frame benchmark remained about
  **20.5 ms at 100×40** and **68.4 ms at 200×60**, before real terminal/tmux/transport
  work. Large frames remain costly despite the package-local improvement.
- A read-only observation of the coordinator pane during the follow-up question
  was **292×61**. `viewerArea` permits an inner area up to **288×55** there;
  actual occupied image cells depend on aspect/zoom. This is a sampled pane,
  not a permanent setting, verified viewer occupancy or universal owner geometry.
- Current drag handling reaches `panViewport` → `applyState` → `intent` on each
  accepted movement. When the representable window changes, `native.reuseViewer`
  encodes/publishes it per report even if Pi later merges repaint requests.
  Clamped/no-op windows can already skip encoding, but collection/math and repaint
  work are not paced as a latest-state presentation policy.
- Installed Pi 1.0.3 `TuiBase.requestRender` coalesces requests with a 16 ms
  minimum interval measured from render start. A longer synchronous frame can
  leave the next requested frame immediately eligible; 16 ms is not a 60 fps
  guarantee or a substantial idle allowance after expensive work. Keyboard
  dispatch may request an immediate host frame independently of the extension.
- Public `Terminal.write(data): void` exposes no drain/backpressure/display ACK.
  Installed `ProcessTerminal.write` calls `process.stdout.write` without exposing
  its return value through this interface. A component-render receipt is not
  evidence that Ghostty displayed the frame. Already emitted bytes cannot be
  retracted safely by this extension.

### What is not yet established

Catch-up can originate in queued terminal input, excessive per-report CPU work,
Pi frame scheduling, stdout/PTY/tmux/SSH output, outer-terminal image reconstruction
or a combination. The current extension already has one pending/latest prepare
and one wheel slot; do **not** diagnose a historical controller frame FIFO solely
from the symptom. Nor does that local bound rule out backlog elsewhere.

The previous capture terminal stored writes immediately. It did not model a slow
FIFO output consumer. The first gate must distinguish processing cost from
production cadence and downstream consumption, not call the 0.04 ms figure a
complete solution.

## 3. Non-negotiable boundaries

1. Keep one Pi-managed raw overlay and owned handle, public focus-loss cancellation,
   modal/search admission refusal and the existing widget/TUI connection. No
   second terminal renderer/input loop, raw stdin flushing or input-listener
   reordering. Closing/search must not wait behind the pacing budget.
2. Keep standard immutable attachment snapshots, active-branch/page identity,
   two-page PDF default and existing commands/tools. Gestures produce no messages,
   attachments, source/PDF work, settings writes or model turns. Pi alone owns
   `images.blockImages`; storage remains distinct from model blocking.
3. Preserve current policy checks on input/reuse/render and actual preparation's
   pre/post async capability checks, fresh `on` visibility, live layout resampling
   before commit and reservation release on rejection. No TTL/force shortcut.
4. Keep one private placement slot and shared native residency. Preserve
   `isResident`, `isCurrent`, `onUploadStarted` revocation, first-attempt cleanup,
   successful-write accounting, all-inline-prototype replay and scoped retirement.
   Pacing must not add historical placement IDs, delayed prepared reservations,
   global deletion or graphics-memory budgeting/eviction.
5. Keep `U=1` independently addressed placeholders with foreground/underline ID
   colors and 0..296 marks. No cursor/pixel escapes in component rows, ignored
   virtual source crop, protocol inheritance shortcuts or downsampled replacement
   snapshots as an undisclosed performance workaround.
6. Keep fullscreen mouse / regular keyboard fallback, 1.25× sign-only wheel steps,
   center-based keyboard zoom, 25% minimum, dynamic 297×297 canvas maximum,
   four-cell keyboard pan and fit/reset. Any sensitivity/expiry/default cadence
   change needs explicit review before delivery.

## 4. Target architecture: state first, presentation later

Names/interfaces in this section are proposals, **not existing exported APIs**.
Prefer a small host-import-free pacing helper such as `src/viewer-pacing.mjs`,
with injected monotonic clock and one-shot schedule/cancel functions for tests.
The existing Pi TUI remains the only renderer; the helper controls when this
component adopts a new image state and requests that renderer. A small
controller-local helper is also acceptable: do not force a generic scheduler
abstraction or new module solely to match these proposed names.

### State separation and bounds

Keep explicit distinctions:

| State | Meaning / bound |
| --- | --- |
| Canonical desired viewport | Latest accepted interaction result; one small zoom/center/layout record |
| Latest raw pointer | One point plus last-input point/gesture generation; not an event list |
| Pending wheel | One replaceable sign/point/received-at/layout stamp; not notch accumulation |
| Sampled intent | One immutable eligible target/revision sent to reuse/prepare |
| Native candidate | Existing single pending/latest prepare runner; no new queue |
| Ready frame | One proven native frame with its own view, rows and base |
| Component-render receipt | Last produced ready key/revision/base; explicitly not screen ACK |
| Pacing work | At most one timer and one scheduled drain continuation per lease |

There must be no array/map of pending mouse reports, historical viewport frames,
per-report promises or repeating interval ticks. Counters/histograms for profiling
must also have a fixed bound; do not introduce persistent per-gesture telemetry.

### Collection

- Mouse handlers continue synchronous current/policy/layout/admission checks.
  They update cheap state, never normalize/encode rows or prepare native transport
  merely because another raw movement arrived.
- **Initially preserve drag semantics with cheap per-event viewport math.** Apply
  each accepted delta from the last input point to canonical center, clamp and
  advance that input point, but defer `intent`/encoding/publication. Profile the
  math under floods independently before trying to remove it.
- Simply storing the final endpoint relative to the original grab is NOT generally
  equivalent: a path can hit an edge and reverse, and sequential clamping is
  path-dependent. Do not discard that semantic information by summing deltas or
  assuming an absolute-from-open anchor. A more compact endpoint/envelope algorithm
  is optional only after an independent equivalence proof and tests.
- Wheel remains one latest sign/point. Do not sum Pi's accelerated `wheelDelta`,
  accumulate a zoom exponent for every queued report or replay old notches after
  a stall. Wheel cancels a grab but does not erase accepted canonical pan movement.
  If that pose is not yet presented, settle it first and retain at most one wheel
  intent meanwhile. Consume wheel only when canonical geometry, resident ready
  geometry and that ready frame's component receipt agree on base/mapping key,
  at an eligible opportunity. Anchor from the ready mapping; preserve canonical
  subcell/nominal-fit metadata when geometry keys are equivalent instead of losing
  accepted state changes. Test these alias cases explicitly.
- A new primary grab likewise requires canonical/ready/rendered mapping agreement
  and occupied ready cells. Otherwise consume press without capture. Press may
  cancel wheel but cannot silently discard an owed canonical pan pose.
- Distinguish the cheap canonical view used for subsequent pan/key math from
  the ready view used for pointer hit testing, truthful chrome and wheel anchoring.
  A cached last shown view cannot silently replace canonical clamped pan state.

### Eligibility and sampling

A one-shot due callback selects the **latest** canonical revision. It checks lease,
connection epoch, live pane/component area/cells, current policy and readiness,
then calls existing native reuse or the guarded prepare path once for that sample.
A cheap dirty key should suppress no-op/clamped image work; nominal zoom/chrome
changes that do not change quantized geometry still need truthful presentation.

Request Pi rendering only when the component has an eligible changed frame/status
or a required lifecycle removal. Do not create a separate write/render loop or
call `renderNow` on each gesture. Existing close/retirement removal-frame flushes
are not part of the throttled hot path and must remain.

**Crucial integration change:** current `render()` calls `intent()` eagerly. In the
paced design, incidental/background/keyboard host renders must not bypass the
budget by sampling unscheduled desired state. `render()` should validate policy,
proof/layout and return the current sampled ready/status frame; it may signal a
layout/lifetime invalidation, but must not encode a newer unsampled pan target.
Similarly, current `queueWheel()` consumption from every ready render must gain
an eligibility check instead of immediately starting another zoom whenever Pi
happens to render. A chrome-only repaint is not permission for a new image pose.
Neither `render()` nor a receipt callback may call unpaced `intent`, `reuseViewer`,
`prepareViewer`, `applyState` or consume wheel. They may synchronously revoke
stale trust and arrange at most one future eligible wake. Receiving a matching
receipt only unlocks scheduling; it does not bypass the selected cooldown.

### Deadlines and headroom

- Start with fixed conservative trial cadences in the benchmark, then select a
  production candidate from measured full-host cost and text volume. Examples:
  50/100/150 ms intervals, **not approved defaults**. A universal 60 fps target is
  contradicted by the existing large-frame profile.
- Use monotonic time and one deadline. If late, sample once from latest state,
  then schedule the next opportunity from current/completion time. Never execute
  missed ticks or send a burst to catch up with an old deadline.
- Leave headroom after expensive work instead of merely copying Pi's 16 ms
  start-to-start rule. Any adaptive estimate must include appropriate host cost;
  the component's 0.04 ms timing is not a usable full-frame cost estimate.
- Public Pi has no after-display callback. An observation from render entry to a
  deferred continuation can include surrounding host/event-loop work, but is
  neither an exact isolated frame time nor an ACK. Validate any proxy in the
  capture harness and label it honestly. If a reliable adaptive estimator is
  unavailable, prefer a profiled fixed policy over a false adaptive claim.
- A text-volume allowance, if investigated, is rate control, not GPU/resource
  eviction. Estimated image-row bytes omit some Pi/transcript output and cannot
  establish a global stream bound. No new user setting or diagnostic command is
  selected by this plan.

### Native preparation and commit

**Proposed initial validity rule:** canonical input revision and admitted sample
revision are separate. A due opportunity admits one immutable target. Subsequent
input may update cheap canonical state without spawning a waiter or repeatedly
aborting that admitted job. Immediately before candidate commit/publication
(including zero-upload rows and especially nonempty writes), recompute the latest
canonical presentation key (live base, canvas and window) and require it
to match the admitted candidate, in addition to lease/epoch/policy guards. A newer
revision with the same representable key is a no-op/coalescing case, not a reason
to churn; preserve its latest canonical center/fit metadata without reinterpreting
rows. A changed key rejects/releases the candidate, keeps only the latest desired
target and reconciles it at a later eligible opportunity. It never commits an old
pose just because the job was admitted before input changed.

Busy wheel does not update canonical zoom until consumption, so merely receiving
more wheel reports cannot starve the admitted wheel zoom. Continuous keyboard
changes or a pan reuse miss can still invalidate slow guarded work: measure that
case and stop if it starves. A geometry-only commit followed by regeneration of
the newest proven subset is an optional later optimization requiring independent
review of keys, ordering and proof validity, not permission to publish stale
candidate rows or a presumed new native API.

Admit a zoom/layout sample **before** taking a native reservation. Do not prepare
an upload early and park its shared write reservation until a pacing timer fires.
After preparation/post-checks, perform final guards and commit/publication or
failure/release immediately; never await cadence, receipt or a text allowance
while holding that prepared reservation. Normal predecessor serialization and
required bounded post-checks remain legitimate. Test that an unrelated inline
successor can drain while the viewer waits for a pacing opportunity.
Keep final desired/sample-generation, epoch, policy and fresh live-layout checks;
release obsolete candidates, with the existing trust/cleanup rules, rather than
committing them merely to make progress.

After a valid nonempty same-slot commit, install its own ready frame synchronously
and request prompt host repaint. **Do not delay its text publication behind the
next ordinary pacing interval**: the prototype may already reinterpret physical
old cells. Pacing limits the next mutation/admission, not upload-before-cells
ordering or removal-before-retirement. One-slot pixel atomicity remains unproven.

Track one admitted changed sample awaiting its **own** component-render receipt.
Do not admit another image mutation while that receipt is outstanding, even if
the admission-start deadline has elapsed during slow preparation. After its first
valid receipt, a deferred continuation can establish the next eligible deadline
from current time and the selected idle allowance; record that boundary as an
application timing proxy, not actual display completion. Repeated receipts of
unchanged retained rows or chrome/background-only frames must not restart this
cooldown, unlock a new image opportunity, or starve dirty state indefinitely.
Initial/loading, failed jobs and canceled layout/lease generations need explicit
non-receipt reconciliation rather than a repeating timeout/retry loop.

If preparation completes after the nominal deadline, publish its valid result
promptly under the ordering above, then apply receipt/cooldown gating for the next
mutation. Never admit two results back-to-back merely because their request start
times were far apart. A canonical key change still rejects a stale candidate at
the final pre-write guard; pacing cannot override that safety decision.

### Release, immediate actions and expiry

- A release applies its final displacement to canonical state and ends capture
  immediately. Its one latest final target remains dirty until a matching
  current-layout local ready frame/receipt satisfies it, a later accepted canonical
  action supersedes it, or lifetime/policy failure cancels it. Release does not
  clear dirty state. If a timer fires while busy, or a candidate is rejected,
  runner settlement or the matching receipt must arrange exactly one future wake;
  no further pointer input is required. Never expire that final pan target or
  replay preceding poses. Resize cancels old-layout work/gesture but retains and
  recomputes canonical fit factor/source center under the existing resize policy.
- `Escape`, focus loss, refresh/reload/session/branch change, owning widget disposal,
  failure and policy loss synchronously revoke timers/continuations/gestures as
  appropriate. Deferred callbacks check a generation in addition to object/epoch
  identity. Cancel armed timers and invalidate already queued continuations;
  a queued microtask is guarded, not magically removed from the JS queue. New open
  is fitted and inherits no dirty or timed work. Cancellation is immediate when
  observed, not preemption of blocking JS or already emitted bytes.
- `0` overrides old desired/sampled mouse work; recognized keyboard controls cancel
  pending mouse gestures and act from the canonical state according to existing
  math. Preserve every discrete keyboard action's state effect even if intermediate
  images are not shown. Immediate host keyboard frames may still render stable rows;
  the extension cannot claim to throttle all host frames.
- Consider expiring **locally deferred wheel intent**, with a received-at monotonic
  stamp, to avoid a stale trailing zoom after a long prepare stall. If selected,
  expiry applies only to the unconsumed wheel slot: recheck age at eligible
  consumption, after waiting for mapping/deadline; replacement refreshes receipt
  time. Proposed boundary is `age >= selectedLimit` for a positive selected limit,
  with exact-before/at/after tests; neither value nor product policy is approved.
  An expired slot changes no canonical zoom and produces no prepare/write.
  Once a fresh wheel is consumed into an admitted zoom, its own guard/preparation
  duration does not silently expire it; normal stale/layout/policy rules apply.
  Any pre-write expiry of admitted work needs a separate reviewed policy. Expiry
  never clears an owed final pan. SGR events contain no client timestamp, so local
  receipt age cannot identify upstream-stale reports; never claim otherwise.

## 5. Phase A — distinguish CPU, scheduling and FIFO output

Deliver a repeatable baseline benchmark before selecting cadence or changing
production. Use a fixed generated labelled/asymmetric PNG, zoomed to genuinely
occupy both viewport axes; include portrait/landscape and each PDF snapshot.
Keep generated inputs/results under temporary directories. Rebuild fixtures
rather than relying on previous `/tmp` artifacts.

### Measurements

Measure separately, with revision/dimensions/cell pixels/sample counts recorded:

1. Input reception/handler count, cheap state math, row encoding/reuse count,
   actual async prepares/checks, coalesced/no-op/expired intents.
2. Canonical, sampled, native-committed and component-rendered revisions and their
   local ages. Do not name any of them physical display completion.
3. Full public-host render wall time around actual `TuiAltScreen`/`TuiMainScreen`
   invocations in an isolated capture harness, not just component `render()`.
4. Exact changed-frame text bytes/write calls and graphics/prototype/PNG bytes,
   separately. Existing `/tmux-image-stats` excludes normal Pi text output;
   do not relabel text frames as native transport or alter its accounting contract.
5. Event-loop lateness and time from final accepted input/release to latest local
   frame production. Report p50/p95/max and sample methodology, not just averages.
6. Source/session/model/normalization/ID counts, to detect regressions masquerading
   as a performance improvement.

Test 40×16, 100×40, 200×60, **292×61**, and boundary layouts up to a genuinely
occupied 297×297 window where valid. Use real public cell pixels in host runs and
fractional/changed cell pixels in pure tests. Report actual occupied cells and
encoded bytes, not just terminal dimensions.

### Reproducible inputs and output model

- Exercise sustained drags, wheel bursts and separate-turn reports at several
  offered rates (for example 60/125/250/1000 reports/s), plus batched stdin SGR
  input. Include long holds, short bursts, reversal, release and stop/idle tails.
- Use actual installed terminal input callbacks for host evidence, not only direct
  controller calls. Preserve primary capture and closed-transcript behavior.
- Add a slow FIFO capture sink with declared **service capacity** (bytes/s and
  bounded service delays/jitter). Specify **storage limit** and run horizon
  separately if finite buffering is modeled. `write(): void` must retain every
  emitted byte/partial progress in order, or an equivalent exact byte ledger;
  never discard/replace old output or make this API awaitable. Reaching the
  model's storage limit is an explicit overload failure, not implicit dropping
  or a fictitious public backpressure signal. Include all host writes in its load.
- Record emitted/drained/pending byte conservation, peak/ending pending bytes,
  oldest age, partial progress and idle-tail drain time. Simulated drain completion
  is separate from component receipt and is not a real Terminal ACK. Temporary
  queue growth during a declared jitter stall is expected; assess sustained
  trends across progressively longer matched runs, not pointwise emptiness.
- Compare feasible declared service models with deliberately impossible ones.
  A locally bounded pacer cannot bound output for arbitrary unknown sinks. A
  predictable byte-rate-deficit negative control must show overload rather than
  hide it. If it remains limiting, report the upstream/API requirement or seek
  approval for a lower-rate/byte-volume trade-off. Already emitted old frames may
  still drain after release even when local historical replay has stopped.

Do not patch stdout, inspect/private-mutate host renderer fields, change tmux or
add runtime test flags. `PI_TUI_WRITE_LOG` is a documented option, but captures
text/pixels/ANSI and performs synchronous file I/O: **do not enable owner logging
automatically**. Any real-path trace needs coordination, temporary private storage,
cleanup and an overhead/privacy caveat. Avoid copying raw traces into reports.

**Gate A:** identify which costs/queues are measured, reproduce a catch-up-like
local/simulated symptom on the 0.4.1 baseline under a declared workload/model,
and choose a proposed sampling policy with explicit limits. Owner-path attribution
remains unmeasured unless separately authorized; label unresolved mechanisms.

## 6. Phase B — pure scheduler and semantics tests

Suggested owned files: new `src/viewer-pacing.mjs`,
`test/viewer-pacing.test.mjs`; additive pure viewport tests only if needed.
Do not yet change native ownership or Pi APIs.

Required fake-clock tests:

- One timer/continuation, latest-revision replacement, no missed-tick replay,
  deterministic idle wake-up and cost/cadence bounds under 10,000 reports.
- Exact cheap per-event pan/clamp equivalence, including reaching/overshooting
  each edge then reversing before a presentation; zero-net endpoint paths whose
  sequential clamped result is NOT the original pose.
- Final release includes its own displacement, leaves one final target and
  settles without more input after a busy/rejected sample. Test release while a
  wake is armed or post-check held, resize before final publication, key/reset
  after release and deadline cancellation. Zero-motion/clamped reports do not
  generate heavy frame work.
- Wheel latest sign/point, separate turns, busy/unrendered receipt, optional local
  expiry and no magnitude/exponent accumulation; expiry never deletes final pan.
  Test pan→release→wheel and a new press before final-pose presentation, clamp-edge
  pan followed by wheel, canonical metadata aliases, wheel replacement resetting
  age, exact expiry boundary, and a fresh admitted zoom with slow own guards.
- Held post-check while canonical state changes without a new sample: reject old
  geometry and rearm latest dirty state. Also test returning to the same quantized
  key, nominal/subcell changes without new geometry, and busy wheel not aborting
  the admitted zoom.
- Preparation longer than the interval, commit before receipt, retained old vs new
  receipt, long host frame, incidental repeated receipts and late multi-interval
  wake: no early image admission, no parked native reservation or retry burst.
- Keyboard action state effects, reset precedence and gesture cancellation.
- Timer firing concurrently with close/focus/layout/epoch/policy/failure changes;
  stale callbacks cannot encode, request render, upload or alter a later viewer.
  Include an observed resize away/back before the wake; do not promise detection
  of a dimension round trip never observed through public render/input/guard paths.

**Gate B:** scheduler space stays constant and semantic tests pass against an
independent reference. Write down canonical/sample validity, receipt/cooldown,
pan/wheel/press precedence, dirty-final rearming and expiry scope before concurrent
UI/helper integration. Cadence/expiry candidates require review, not guessed defaults.
Constructor clock/scheduler injection is normal testability, not a package/runtime
or environment test switch.

## 7. Phase C — controller integration without weakening safety

Suggested ownership: `src/viewer.mjs`, `test/viewer.test.mjs` by one implementation
worker; pacing helper by a disjoint worker after agreeing interfaces. Leave
`src/native.mjs`, `src/presentation.mjs`, detector, protocol and extension wiring
unchanged unless an independently reviewed blocker requires a narrow addition.

Split current `applyState` responsibilities into cheap desired-state reduction,
eligible sample/admission and publication. Remove per-report row generation and
unpaced `render()`/`queueWheel()` drains. Keep last-ready own-view continuity,
truthful percentage/status, native residency proofs and current policy gates on
all stable-frame returns, including any new frame cache.

Do not cache styled chrome indefinitely: theme invalidation must clear/rebuild
cached styling without recoloring ID cells. Retain at most one frame per active
layout/proof and avoid historical-origin caches. First input can be responsive
when idle; later sampling must not become a debounce that waits forever until
continuous movement stops.

**Gate C:** encode/reuse/sample counts scale with eligible changed presentations,
not raw report count; resident pan still produces zero prepares/probes/graphics;
incidental host renders cannot advance the image outside policy; all previous
proof, layout, failure, first-attempt cleanup and retirement regressions pass.

## 8. Phase D — actual-host, slow-output and failure acceptance

Use installed Pi public APIs, isolated SDK settings/installation and a capture
terminal. Suggested ownership: `test/host-viewer-integration.mjs` and a standalone
performance harness/profile script by a separate worker. Keep expensive cell
oracle/decoding/assertion time outside pure-render benchmark timing.

| Scenario | Required observable acceptance |
| --- | --- |
| Sustained/high-rate drag | Canonical math remains correct; sampled revisions jump forward, never replay historical poses; encoding/work bounded by opportunities |
| Edge and release | Every edge/reversal path matches reference; final release pose settles once without a catch-up trail |
| Busy wheel and reversal | One latest sign/point, no accumulated old steps; sample anchors to a current rendered resident mapping within cell/clamp tolerance |
| Late timer/blocked event loop | One fresh sample, no burst of overdue ticks; meaningful headroom for input and close |
| Background/keyboard renders | Stable valid viewer rows returned; no unscheduled image adoption or wheel drain |
| Slow FIFO output | Already emitted bytes preserved; reduced emission/backlog/age measured under declared capacities; impossible capacities explicitly fail feasibility, not get hidden |
| Zoom and policy gates | Existing pre/post fresh checks and upload-before-new-cells; no reservation parked behind cadence; superseded/live-layout changes write zero obsolete bytes |
| Partial/first write failure | Old proof revoked before bytes; no candidate cells/accounting; attempted tuple retained and scoped cleanup/recovery preserved |
| Layout/cells/tiny fallback | Cancel/reconcile stale sampled/timed input before publication; preserve keyboard ownership and fresh fit/center policy |
| Close/modal/reopen | Immediate logical cancellation; owned removal frame before retirement; zero stale timers/replay; unrelated modal intact; next open fits |
| Source/model/storage | Source-deleted snapshots still work; exact messages/entries/attachments/conversion and model-request counts unchanged in both blocking states |
| Identity/accounting | One private slot, resident PNG shared, no per-frame allocator/cache growth, zero text-only transport accounting, complete inline replay intact |

Do not weaken readiness helpers to accept old retained cells as the new target.
Observe transient intermediate ready mappings through captured public frame writes
when necessary, as the 0.4.1 harness already does. A sink's simulated drained frame
is a separate receipt from the application's current ready/rendered key.

Performance criteria must declare workload, service model, storage/run horizon
and cadence: constant local queues; no overdue burst; no continued historical
**local production** after stop/release; fewer obsolete encodings/emitted bytes
under overload. Name timestamps for final accepted canonical action, outstanding
runner drain, next eligibility, guards/preparation, ready publication and component
receipt; report final local receipt latency and each measured contribution rather
than granting unlimited 'guard time'. Simulated drain and human settling have
separate timestamps. Cancellation is synchronous when observed, not preemption
inside blocking JS or removal of buffered bytes.

For each claimed feasible service model, require no sustained positive backlog
trend across progressively longer matched runs after transient stalls, plus idle
tail drain under continuing declared service. Report peak/ending bytes, oldest
age, p95/latest-state age and byte conservation. This is a conditional synthetic
envelope, not a global real-output bound. Fewer frames alone is not a pass if
final movement is lost, anchors regress or input stalls.

## 9. Phase E — profile, decisions and coordinated delivery

Rerun matched baseline/candidate profiles at identical layout/zoom/cells and
input traces, including full-host and slow-sink results. Separate application
state bounds, model FIFO drain, real-path observations and unmeasured GPU costs.
Then review one of these outcomes explicitly:

1. **Latest-state pacing sufficient:** propose the measured internal cadence and
   wheel-expiry policy, obtain proceed/UX approval, run all gates and deliver.
2. **Host Unicode/compositing still dominant:** investigate an upstream public
   known-width/placeholder slicing optimization or rendering/backpressure seam in
   a separately authorized Pi task. Do not edit the installed read-only package,
   monkeypatch host methods or bundle a private host fork in this extension.
3. **Real output path dominates:** document missing public drain/ACK information;
   ask about an upstream API or explicitly approved lower emission policy. No
   universal queue-bound claim without an observable capacity contract.
4. **Smaller viewport/quality trade-off needed:** present the measured option to
   the owner separately. Do not silently shrink the fullscreen image area,
   rerasterize/crop snapshots or change fit/zoom semantics to win a benchmark.

Run before implementation commits:

```sh
npm test
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  PI_IMAGE_HOST_MODULE=/path/to/installed/pi-package/dist/index.js npm test
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  node --test test/host-integration.mjs
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  node --test test/host-viewer-integration.mjs
```

Also run the new scheduler/performance suites, inspect isolated `pi install` and
resource loading, `git diff --check` and clean Git state. Host root must provide
its public `dist/index.js` and host-supplied pi-tui; never install physical host
dependencies into this repo. No real provider requests. Explicitly report optional
skips, revisions, fixture dimensions, clock/capacity assumptions and actual tests.

After isolated gates, coordinate owner reload. Ask for the same problematic pane
and image: sustained drag, wheel/trackpad start-stop and reversal, immediate Escape,
reset/reopen, resize and ordinary transcript selection/scroll when closed. Record
whether it still bogs down or races after input stops, approximate duration,
device/pane size and any requested trade-off. Do not turn a general “better” into
full performance acceptance, precise FPS or a case-by-case matrix pass.

## 10. Delegation, deliverables and rollback

Use current workspace named workmux tabs, never window indexes. Model policy:
`us.openai.gpt-6.1-sol`; planning/review **xhigh**, implementation **medium**. Read
and inspect exact properly spaced prompts before dispatch. Assign disjoint files,
agree reducer/pacer interfaces before concurrent edits and thank workers when
safe to close. Suggested order:

1. Planning/profile worker: baseline/reproduction and scheduling/API evidence.
2. Pure scheduler implementation worker: helper + fake-clock/semantic tests.
3. Controller implementation worker: viewer + controller tests, after interfaces.
4. Host verification worker: SDK/performance harnesses, after behavior is specified.
5. Independent xhigh reviewer: semantic overload, proof/lifetime and measurement
   attribution review; coordinator combines results and owns final commits/docs.

Persist the design decisions, benchmark methodology and reproducible harness in
the repository, not just ephemeral `/tmp` scripts. Keep raw output/logs/pixels,
sessions, credentials and machine-local fixtures out of Git. Final report should
identify actual selected policy, commits, remaining limits and human evidence.

Rollback reference for this investigation is **`1f00268` / 0.4.1**: known partially
improved but still unsatisfactory performance, not a fully accepted latency target.
Keep `fcf465f` / 0.4.0 as the functional mouse baseline; do not confuse its general
acceptance with performance. Revert only the new pacing implementation commits,
retain diagnostic/design evidence where useful, run tests and coordinate reload.
Do not revert unrelated work or reset the whole checkout. No pushes, license
choice, machine/EBS checkpoint or configuration changes are authorized. Rollback
cannot reclaim arbitrary old terminal allocations or bytes already emitted.

**First next-session action:** verify clean baseline and read this handoff, inspect
installed public APIs, agree implementation authorization, then execute Phase A.
Do not start by adding an arbitrary FPS limiter or claiming the terminal queue has
been bounded because the controller has one pending record.

## 11. Planning-checkpoint verification

Independent read-only xhigh review accepted the revised handoff after resolving
canonical/sample validity, receipt/cooldown timing, pan/wheel/press precedence,
final-target rearming, expiry scope, reservation timing and conditional FIFO
acceptance wording. This is design/source-contract review, not implementation or
performance acceptance.

The coordinator ran `npm test` for this documentation-only change: **181 passed,
32 optional host skips, 213 total, zero failures**. `git diff --check` passed.
Production code, tests, package version, active installation, settings and tmux
configuration are unchanged. No host/slow-sink experiment or human pixel/FPS
validation is claimed for the proposed pacing design by this checkpoint.
