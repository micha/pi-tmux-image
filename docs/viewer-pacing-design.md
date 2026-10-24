# Viewer pacing integration design

## Authorization and policy review

The owner authorized implementation and worker delegation after the documentation-only handoff at `94fafaf`. Following the Phase A baseline profile, the owner explicitly approved an initial production candidate of **150 ms idle headroom after the deferred first own component receipt**, with **wheel expiry disabled**. This is approval to implement and compare that candidate, not active installation/reload or human performance acceptance. See [viewer-pacing-profile.md](viewer-pacing-profile.md) for measured costs and conditional synthetic FIFO evidence. The helper remains policy-free; deterministic tests use explicit trial values.

Status: source-specific integration design, independently reviewed before controller integration; the scheduling-only API was accepted by the coordinator. This document records the agreed design, not proof that every gate or manual case has passed. Baseline review: `94fafaf` (production 0.4.1), viewer, viewport, native and presentation sources, controller tests, handoff and safety contracts.

## Exact proposed Phase B API

New host-import-free `src/viewer-pacing.mjs` exports:

```js
createViewerPacer({
  now,                 // () => monotonic milliseconds
  schedule,            // (callback, delayMs) => timerHandle; one-shot, never inline
  cancelScheduled,     // (timerHandle) => void
  defer,               // (callback) => void; never inline, e.g. queueMicrotask
  idleMs,              // REQUIRED finite positive experiment parameter; no default
  onEligible,          // (ticket) => void; synchronous controller entry, no helper await
  onError,             // optional (error) => void; see exception contract below
}) => ({
  request(),           // demand=true; coalesced; schedules only if unblocked
  published(ticket),   // admitted -> awaiting its own first component receipt
  rendered(ticket),    // awaiting receipt -> one guarded deferred cooldown continuation
  settled(ticket, { retry = false } = {}),
                       // admitted -> no-receipt completion; due=now()+idleMs
  blocked(ticket),     // admitted -> idle, clears demand; wait for external unblock
  cancel(),            // permanently revoke this instance/generation, cancel timer
  inspect(),           // copied O(1) diagnostic state for deterministic tests
})

isWheelExpired(receivedAt, now, limitMs) => boolean
// limitMs === null means disabled; positive finite value means age >= limitMs.
// No omitted/default limit, no admitted-work expiry.
```

Ticket is an opaque frozen object with instance/generation identity and scalar sequence. Controller attaches it to exactly one immutable sample; helper never stores viewport/pixels/rows or native reservations. `inspect()` exposes only `{cancelled, demanded, timerArmed, continuationQueued, phase, sequence, nextDue}`; phase is `idle|admitted|awaiting-receipt|cooldown-pending`. No history or per-report promise.

### Precise scheduler semantics

- Initial `nextDue=now()`. `request()` always defers first opportunity through the one-shot scheduler (including delay zero), preserving synchronous wheel-burst replacement. It does not execute controller work inline. When due and demanded, clear demand and allocate one ticket in `admitted` phase before calling `onEligible(ticket)`.
- Requests while admitted/awaiting-receipt/cooldown-pending set one demand bit only. They cannot arm admission timers, abort the admitted job or create waiters.
- `published(ticket)` marks one eligible changed frame as awaiting receipt. It is called synchronously after successful commit and ready publication, before requestRender. There is no deadline timeout which permits another image mutation while awaiting receipt.
- `rendered(ticket)` accepts only the first matching awaiting receipt; sets phase `cooldown-pending` synchronously and queues exactly one `defer` continuation. The continuation checks instance cancellation/ticket identity, clears active ticket and sets `nextDue=now()+idleMs`, then arms one demand timer if needed. Old/retained/repeated receipts do nothing, including during the deferred interval. It never calls `onEligible` inline.
- `settled(ticket,{retry})` handles rejected/stale/no-receipt work, including preparation rejection. Clear the active ticket, preserve existing demand OR retry, set nextDue from current completion time plus idleMs, then arm at most one timer. No old deadline catch-up. Controller must call `settled` only after its runner/native failure callback has actually settled; never admit a successor while old work drains.
- `blocked(ticket)` is the no-work path when layout is unusable, wheel mapping cannot yet agree, desired target is already satisfied, or the same failed key remains suppressed. It clears active ticket and demand without resetting the existing due boundary. No polling timer. A matching stable receipt, runner settlement, new canonical action, observed usable layout or explicit recovery can call request again if there is eligible work. The callback is synchronous, so controller can recompute what remains after blocking; do not blindly request again for a still-blocked wheel.
- `cancel()` permanently disables the helper and clears demand/active/timer, with queued continuations invalidated by instance identity/cancel generation. Stale calls/timers/receipts are inert. Controller can construct a fresh helper after an observed layout/failure invalidation and old runner drain; retain at most one current helper reference, not a helper history. Close must cancel synchronously and must never construct a replacement.
- If `onEligible` throws while admitted, helper defensively settles its ticket without adding retry, preserving bounds, then invokes optional `onError(error)` or rethrows if no handler was supplied. It never silently swallows exceptions. This clarification is coordinator-approved. Controller must catch functional preparation/publication failures and publish status; an exception after successful publication cannot undo bytes, so retain that published receipt obligation (or explicit controller lifetime cancellation), report the error, and do not invent an uncommitted state. Helper-worker should cover both pre-publication throw and already-published throw explicitly.
- Clock/timer inputs and idleMs are validated. Timer callbacks recheck now versus nextDue and rearm the single timer if invoked early. Late callbacks admit once. No intervals/missed-tick loop.

This intentionally small scheduling-only API leaves state math, dirty detection, wheel/press mapping and failure policy in the controller. Phase B can test pan semantics by invoking actual exported viewport helpers against an independent sequential clamp reference, not by putting native/UI ownership in the pacer. Wheel expiry helper is optional policy machinery, explicitly disabled with null in tests when not selected; production wiring/value needs coordinator review.

## Early controller agreement

- Keep `token.zoomFactor`/`center` canonical. Split `applyState` into cheap canonical reduction plus `pacer.request()`; no intent/reuse/prepare/repaint on raw movement.
- Split `intent` into cheap live `describeDesired` (computeViewport/clamp/base/key only), scheduled `admitSample(ticket)` and synchronous guarded publication.
- Replace the runner's eager `while latest`/finally `intent` relaunch with one admitted sample and settlement-driven future request; retain one runner plus one latest canonical record, not one job per input.
- Render must never call intent/applyState/reuse/prepare or consume wheel. It returns only current ready own-view rows/status under live policy/layout/residency gates and reports its ready ticket to `rendered`. Layout observation may revoke stale state and arrange a future eligible request, never encode inside render.
- Helper `published` applies to zero-upload rows-only pan as well as prototype replacements and nominal/chrome-only eligible changes. The ready ticket distinguishes a new eligible frame from repeated retained receipts.
- Final release leaves canonical dirty until a matching current ready mapping and receipt satisfy it. Busy completion/rejection calls `settled(...,{retry:true})` when latest dirty geometry remains, without requiring more input.
- Native/presentation/extension APIs can remain unchanged: native reuse/prepare/isResident and public synchronous presentation.commit already provide the required seam. Detailed final guards and alias/mouse rules follow below.

## 1. Controller-local records and identities

Keep these explicit, bounded records per token (no maps of poses):

```js
canonical = { revision, zoomFactor, center }; // cheap accepted state, never ready-state substitution
layout = { generation, base, frame, cells, usable }; // latest OBSERVED public layout
sample = { ticket, layoutGeneration, revision, key, base, view, cells }; // immutable admitted target
ready = { ticket, revision, key, base, view, lines, isResident }; // its OWN view and native proof
drawn = { ticket, key, base, layoutGeneration }; // local component production receipt, not ACK
wheel = { direction, point, base, layoutGeneration, receivedAt }; // one replaceable slot
drag = { x, y, layoutGeneration, canvasKey }; // one incremental input point
finalRevision; // optional latest release obligation, not another pose/job
failedKey; // existing one-key failure suppression
runner; request; // existing one actual async operation/request controller
```

`drag` above is a controller record, not a field on the helper. It retains last **input** point, not last shown point. `finalRevision` is only a scalar marker; canonical is always the authoritative final/latest target. A later accepted state-changing keyboard/mouse action supersedes the marker; a press/zero-motion/unrecognized action does not silently erase an owed final pose. Observed resize carries that latest canonical pose forward with fresh clamps, not the old prepared geometry.

Three key classes are needed; do not overload input revision:

1. **Base/layout key:** existing `baseLayout` values: public terminal columns/rows, actual component frame/area/placement and numeric cell pixels. Include the observed layout generation separately, so observed A→B→A cannot revive an old job solely because the serialized dimensions match. Cell objects must be copied, not retained as mutable references from an injected `getCells()`.
2. **Representable image/mapping key:** existing `[base, view.canvas, view.window]`. With fixed payload/lease and base, these determine origin, padding, effective scale and addressed cells. This is the final stale-candidate geometry comparison and mouse mapping comparison. Ticket also carries token/lease/epoch/layout generation; identical geometry alone never validates a later lease.
3. **Shown chrome/metadata distinction:** nominal clamped zoom/limit information may change while image key does not. Use a separate chrome signature (at least shown Fit percentage and limit; preserving exact zoomFactor in the eligible view is safest). Subcell canonical center changes with the same mapping are important for subsequent math but need no row encoding. Never substitute `realizedCenter` for canonical `center`.

A candidate may survive any number of input revisions if its representable key still equals latest canonical key at the final guard. Conversely, no new sample revision is required for latest canonical changes to invalidate an admitted candidate. Exact input-revision equality would unnecessarily abort aliases and return-to-same-key cases.

## 2. Minimal function split in `src/viewer.mjs`

### `describeDesired(token, width?)`

Extract the cheap part of `intent`: derive live viewInput/frame/cells; computeViewport on **canonical** fields; return `{input, frame, view, base, key, layoutGeneration}`. This performs no native calls, row encoding, request abort, Promise creation or repaint. Collection paths adopt returned clamps when actually accepting input. Eligible layout reconciliation adopts new clamps under resize policy. Do not call this as an unpaced publication function from render.

### `reduceDesired(token, state, { final = false })`

Replace `applyState`: write canonical zoomFactor/center; increment revision only for changed state (or track input count separately); preserve sequential pan/clamp semantics. Set finalRevision on release if its current representable target is still owed, even if the release itself is zero displacement. Arrange `pacer.request()` when there is unsatisfied geometry/chrome or an admitted predecessor whose final guard must see the new canonical state. No `intent`, reuse/prepare/encode or raw movement repaint.

Every accepted drag delta runs existing `panViewport` on latest canonical input, updates last input x/y even when clamped, and adopts the clamped center immediately. Release computes its displacement first, reduces canonical, then clears drag immediately. Preserve every recognized key's discrete math effect from canonical state. Escape is immediate and never calls the pacer. `0` supersedes previous mouse desired state and aborts obsolete admitted work if desired as an explicit reset/lifecycle override, but successor admission still waits for runner settlement. Unknown keys remain consumed, not forwarded; preserving current unconditional gesture cancellation is least disruptive.

### `admitSample(token, ticket)` — sole hot-path entry

1. Validate token/epoch/policy and freshly observe layout. If unusable, revoke stale mapping/gestures and `blocked(ticket)` with no timer polling; observed future usable layout requests recovery.
2. Recompute latest canonical view/key, adopting resize clamps. Check ready proof and its own layout, never cache residency success indefinitely.
3. If canonical image key differs from ready/drawn, sample canonical first. Retain wheel until this pan/keyboard/layout pose settles. Do not consume wheel on an old mapping merely because it has a receipt.
4. If keys agree and there is owed chrome metadata, either publish an eligible metadata-only new ready ticket without row re-encoding, or fold it into the wheel target at this already-eligible opportunity while preserving canonical values. If no chrome/image change, reconcile satisfied alias/final markers with the existing matching receipt; do not create a fake changed-frame ticket or cooldown.
5. Only when canonical/ready/drawn mapping agrees may this opportunity consume a fresh pending wheel. Apply one `zoomViewportAt` step to **canonical input**, clear slot and increment canonical revision if changed; create the immutable sample for that zoom. At min/max no-op, preserve canonical state and no native work. Receiving wheel alone never changes canonical zoom, so later wheel replacement cannot stale-abort this sample.
6. Try existing synchronous `native.reuseViewer` for an eligible changed same-layout target when no request is draining. On success, perform final cheap guards, presentation.commit and immediate publication. A miss falls back to the existing guarded prepare path, not repeated reuse attempts per raw report.
7. For async work, set runner before the first await, retain one immutable sample/request, and run exactly one precheck → prepare → postcheck → final guard → commit/publication or release. Do not reserve anything before the pacing opportunity.

`select` no longer eagerly calls intent after payload/lease resolution; it marks initial canonical fit dirty and requests the helper. Picker/loading status can repaint independently without admitting image work. Open/selection normalization/retirement stay outside hot-path pacing.

### `runSample` and settlement

Delete the current eager `while (current && latest)` drain and `finally { if (latest) intent() }`. That is an unpaced catch-up seam. Subsequent input writes canonical only. When the one runner settles, clear request/running state and inspect latest work once:

- Valid committed frame: it already called `published(ticket)` and waits for its own receipt. If dirty canonical geometry/chrome or a pending admissible wheel remains, call request; helper stores only the demand bit until receipt/cooldown.
- Superseded geometry/layout rejection: call prepared.onUploadFailed immediately, then after runner drains call `settled(ticket,{retry:true})` if current-generation latest desired work remains. No error/failedKey for benign supersession. No further input is needed for final target rearming.
- No-op/blocked result: `blocked(ticket)`; do not request again just because a wheel exists but still lacks mapping agreement. External matching receipt or actual state/layout recovery unblocks it.
- Current functional failure: release/cancel/clear as below, publish error status once and suppress same failedKey. Never a repeating retry timer.

Existing native callbacks are idempotent, but controller should not depend on double failure callbacks as its normal path. Ensure tickets settle once, especially reuse false, thrown presentation.commit, aborted precheck, rejected postcheck and close while awaiting native predecessor.

## 3. Final guard and immediate publication

After postcheck, with no intervening await:

```js
const live = describeDesired(token); // recompute from latest CANONICAL + live public layout
const valid = current(token) && leaseStillExact && !request.signal.aborted
  && sample.layoutGeneration === token.layout.generation
  && live && live.base === sample.base && live.key === sample.key
  && policy(token);
if (!valid) { prepared.onUploadFailed?.(supersededError); /* settle/rearm after drain */ }
else if (presentation.commit(prepared, context)) {
  // native write/success/residency/accounting has completed synchronously
  token.ready = { ticket: sample.ticket, key: sample.key, base: sample.base,
    revision: token.canonical.revision, view: live.view,
    lines: prepared.lines, isResident: prepared.isResident };
  token.error = token.failedKey = undefined;
  pacer.published(sample.ticket);
  repaint(token); // PROMPT host repaint, not next cadence
}
```

Use newest `live.view` when its key equals the sample key: its nominal fit/subcell metadata is current while the candidate rows still address exactly that mapping. Do not rewrite canonical from `sample.view` or `ready.view` after slow work. Check the same live guard for synchronous zero-upload reuse and metadata-only publication. With all guards/commit/publication synchronous, there is no JS task yielding between the controller check and presentation's existing isCurrent/epoch/signal check/write; no new `beforeCommit` native or presentation API is required.

A same-slot nonempty commit can reinterpret physical old cells immediately. Never publish its new ready frame only at the next timer. Pacing blocks the **next mutation**, not write-before-cells order. Keep native onUploadStarted proof revocation and first-attempt cleanup intact, including thrown partial writes. No direct Terminal.write from controller/helper.

## 4. Passive rendering and receipt semantics

`render` currently calls `intent(token,width)` and then `queueWheel` when ready. Both must disappear. Replace with:

- Synchronous current/policy and public live layout observation. An observed base/cell/canvas invalidation synchronously clears drag/wheel/ready/drawn and invalidates old tickets; queue at most one future reconciliation after runner drain. It may signal canonical resize reconciliation, but may not adopt an unsampled pan or encode rows.
- Return current ready **own view** with its isResident proof if same live layout; otherwise safe loading/error/tiny text. Keep truthful ready Fit percentage while canonical zoom is preparing. Existing width-guaranteed ID-row assembly remains; no truncation/style wrapping of ID cells.
- Status/chrome derives from sampled/current ready state plus dirty indicator, not a secretly adopted canonical zoom percentage. Loading/tiny fallback may have no shown image view; report that truthfully.
- At the end of producing valid ready cells, record drawn `{ticket,key,base,layoutGeneration}` and call `pacer.rendered(ready.ticket)`. This function only marks matching receipt and queues its guarded deferred cooldown. It cannot consume wheel, call applyState or invoke onEligible inline. A stable receipt which resolves a previously blocked mapping may set one future demand, but still respects nextDue.

A ready ticket is the locally produced frame identity, not an outer-terminal ACK and not necessarily a successful full host frame write. Public Pi can perform later composition/write work after the component returns; a deferred microtask sees surrounding synchronous work but no public exact after-frame/backpressure event exists. The profile worker must measure/label this proxy around actual public full-host rendering, not call it display completion. If host rendering later throws, no public notification lets this extension infer that automatically; state safety remains guarded and controlled lifecycle/frame-failure tests must distinguish local component receipt from host output.

Repeated unchanged ready renders (including retained old zoom rows), host keyboard/background frames, theme-only renders and repeated matching receipts do not restart cooldown. If prepared work took longer than nominal interval, still await its own receipt then begin idleMs from deferred **current** time. No back-to-back admission because old start times were far apart.

Prefer **no new complete styled-frame cache** initially: baseline component rendering is already cheap, and row encoding is the per-report problem. Continue styling chrome statelessly at each render with the existing live `style` closure. Then the current no-op `invalidate()` is valid because there is no theme-colored cache. If controller adds a one-frame assembled cache, public invalidate must clear/rebuild only styled frame/chrome, while preserving ready native rows/ticket/proof; never recolor ID cells, reset pacing cooldown or create a new image opportunity for a theme change. Extension already reads `liveContext.ui.theme` dynamically, so no extension theme API change is required.

## 5. Mouse mapping agreement and canonical alias preservation

### Wheel collection

Keep existing current/policy, valid integer x/y, image-area hit and nonzero finite sign admission. Retain one latest slot even while a proven old own-view is preparing a new target or its new commit lacks receipt. Stamp monotonic local time and observed layout generation/base. Clear drag immediately, **not canonical accepted pan**. Do not requestRender per wheel. Helper request only schedules an opportunity; timer consumption is additionally mapping-gated.

At consumption, require exact token/lease/epoch, live base/generation, resident ready, drawn matching ready key/base and canonical representable key matching both. If final pan is unshown, choose it first and retain wheel. An expired pending slot clears **only itself**, never finalRevision/dirty canonical state. Recheck expiry at eligible consumption (`age >= positiveLimit`); replacement refreshes receivedAt. Once consumed, no timer-age expiry of admitted zoom is permitted by this design.

### Primary press

Cancel prior drag and pending wheel, but not owed canonical pan. Require primary button, live occupied ready cells, policy/residency plus canonical/ready/drawn mapping agreement. If canonical has moved but is unshown, consume without capture and keep/rearm its final target. If canonical aliases ready mapping, capture is safe even when canonical subcell center differs: subsequent delta math uses canonical, never ready.center.

### Concrete source alias trap

Current `queueWheel` explicitly sets `zoomFactor: token.ready.view.zoomFactor, center: token.ready.view.center`. That becomes wrong after cheap canonical collection is separated from presentation. `computeViewport` has two distinct notions: clamped floating center/nominal fit factor versus quantized geometry. Same mapping does **not** mean those metadata fields are equal.

A read-only direct viewport probe established:

- 640×480, area 36×10, cells 8×16, zoom 1.25 versus 1.251: identical canvas/window; next wheel-in factor is 1.5625 versus 1.5637499999999998. Old ready metadata silently changes future sensitivity/zoom history.
- Zoom 5, center (.5001,.5001) versus (.5002,.5002): identical canvas/window; four-cell x pan preserves distinct next centers (.5301,.5001) versus (.5302,.5002). Old ready center loses accepted subcell movement.

Use `zoomViewportAt(canonicalInput, direction, point)` **after** mapping-key agreement. Its anchor is reconstructed from canvas/window/effectiveScale/padding, so it is the same ready mapping; its current nominal factor/center remain canonical. No new viewport signature is needed. Preserve the same-key limit no-op state rather than quantizing/reconstructing center. Alias tests should include clamp-edge pan→wheel, nominal fit changes, subcell centers and candidates returning to the admitted geometry key while postcheck is held.

## 6. Source-specific retry, proof and failure pitfalls

1. **Cached desiredKey is no longer final truth.** Currently intent updates token.desiredKey on every report/render; after pacing, final guard must recompute canonical/live key even if no new sample was admitted. Checking only old token.desiredKey would commit stale poses.
2. **Current run abort behavior must change.** `intent` aborts request when runningKey differs. Ordinary canonical updates must not abort/relaunch repeatedly. Leave admitted job running to guarded completion; explicit close/reset/layout/policy cancellations can abort. Busy wheel remains a slot and cannot change canonical zoom/starve its own admitted zoom.
3. **Rejected preparation can revoke old proof before any bytes.** Native prepareSurface.onUploadFailed removes private placement trust when its batch/current privateRevision match, even if onUploadStarted never ran. Do not assume prewrite rejection means retained old rows are still resident. After every rejection/failure, recheck ready.isResident; drop rows/drawn/gestures when untrusted and repaint safe status. Conservative native revocation remains unchanged.
4. **isCurrent is not isResident.** Prepared reservation validity expires after success; ready proof must continue using persistent isResident. Reuse is unavailable while inline/private work is pending; one scheduled miss may need the guarded async path. Never poll reuse every raw drag or use row presence as proof.
5. **Runner settlement must rearm final state.** A due callback while busy is only demand. When predecessor rejects or drains, recompute latest canonical dirty work and request once/settled retry; no `while latest` immediate runner or unpaced finally intent. Release must not clear demand/finalRevision. Matching new receipt also requests remaining wheel/final work once; retained old receipt cannot satisfy a changed key.
6. **A no-op must not create a retry loop.** For same mapping plus no chrome change, reconcile alias metadata and receipt satisfaction without encoding/native commit/new ticket. `blocked` consumes helper demand. Do not request again for an unchanged failedKey or wheel lacking mapping until an external unblocking event.
7. **Real failure cancels deferred mouse work.** Clear ready/drawn/drag/wheel/final obligation as required by failure policy, cancel helper synchronously, set one error+failedKey and repaint status once. Preserve latest canonical fields for a later genuinely changed keyboard action/layout recovery, but never automatically replay pending wheel or retry the same key on every render. Create replacement scheduling generation only on permitted changed target/layout/recovery and after old runner settles. Capability rejection closes via existing policy, not retries behind cadence.
8. **Do not leave the shared reservation parked.** Admit before prepare, finish postcheck and final guard immediately; call failure callback on rejection and await legitimate predecessor drain. A viewer waiting only on timer/receipt must hold no prepared reservation, so inline successor can proceed.
9. **No successful accounting for text reuse.** Existing native commit correctly skips transport metrics for empty uploads. Do not treat helper publication/receipt as native transport or add new graphics IDs.
10. **Functionally committed bytes cannot be undone by a later error.** If controller code throws after successful presentation.commit, maintain the committed cleanup/native obligation and cancel/report as appropriate; do not mark that committed sample as a stale prewrite failure or forget first-attempt/scoped retirement.

## 7. Cancellation and lifetime ordering

Add a controller work/layout generation independently of active token/epoch. Observed layout/cell changes synchronously revoke old timed work/drag/wheel/drawn; abort old-layout request and cancel its helper. Preserve latest canonical fit factor/source center (including accepted final pan), then wait old runner drain before scheduling fresh layout reconciliation. An observed A→B→A increments generation twice; never reuse A's old timer/job/receipt. A never-observed round trip is not detectable and must not be claimed.

All deferred runner continuations and helper callbacks capture current token/epoch/lease/helper instance/layout generation; check before encoding, repaint, upload or changing state. A canceled microtask still exists in JS queue but is inert. Clear timer handles synchronously on Escape/focus loss/disconnect/refresh/session/branch/widget lifetime changes. `close` retains current ordering: closing flag + ready/gesture/timed revocation → controller/request abort → native.releaseViewer synchronous replay revocation → deferred owned hide/dispose → await selection/runner → public removal renderNow → capability-guarded scoped retirement. Pacing never delays removal/retirement flush and never owns another overlay/input loop.

Component dispose currently only sets disposed; explicit unexpected owning component disposal should converge on idempotent close if still active, without recursion from close's own dispose. Widget disconnect already calls close through presentation.bind. Do not let stale dispose/focused callbacks cancel a later token. Initial selection failures also clear pacing demand and publish only safe status; new open starts fresh fit with no wheel/final/ticket/dirty history.

## 8. Compact required tests and seams

### Pure helper / viewport tests

- Inject fake now/schedule/cancel/defer with explicit trial idleMs; 10,000 request replacements keep one timer/ticket/demand and one continuation. Early timer rearm, late many-interval callback admits once, cancellation before timer/defer and stale receipts are inert.
- Published-before-render, preparation longer than interval, repeated old/new receipts, long simulated host render and delayed defer: next admission is after first matching receipt's deferred now+idleMs, never start-to-start catch-up. No-op/blocked has no polling; settled retry wakes without more input.
- Throw in onEligible defensively settles and reports via onError or rethrow; no silent failure, dangling ticket or early mutation after already-published error.
- Independent sequential pan reference: overshoot each edge and reverse, zero-net pointer path with nonzero sequential clamp result, release final displacement and canonical alias cases above. These use actual viewport functions, not a new altered math helper.
- Expiry disabled with null and explicit positive experiment limit; exact before/at/after, replacement age reset, no expired wheel work, no expiry of consumed zoom or final pan.

### Controller fake-clock adaptation

Extend existing harness with clock/timer/defer injection and counters for requestRender, row reuse/prepare/capability/writes, plus direct held pre/post gates. Replace immediate 10,000 synchronous reuses assertion with canonical-reference equivalence and work proportional to eligible samples. Preserve zero probes/prepares/graphics on resident pan; counts alone are not performance evidence.

- Background render flood and keyboard-immediate host renders between deadlines return stable own-view cells and cannot call reuse/prepare/consume wheel. New layout may signal one wake only; no encoding in render.
- Resident drag flood, all edges/reversals, release while timer armed or postcheck held, obsolete candidate rejection and settlement: latest final target produces matching current-layout receipt with no additional pointer input and no historical intermediate trail.
- Pan→release→wheel and press before final presentation: final pose settles first, wheel remains one slot, premature press does not capture/clear final. Geometry aliases permit wheel/press while preserving canonical nominal/subcell metadata.
- Held postcheck: canonical changes without new sample reject old bytes; return-to-same-key aliases commit newest metadata; busy wheel replacement does not abort admitted wheel zoom. Use actual native proof for at least one rejection case to catch prewrite onUploadFailed revocation.
- First/replacement partial write failure, commit false, denied pre/post, no-op same failedKey and resize away/back: no candidate rows/accounting, no stale wheel/timers, bounded native obligation and existing recovery behavior.
- Repeated receipt/chrome/theme invalidation: nextDue unchanged except first matching receipt, theme chrome updates but ID cells remain identical and no native work.
- Close/focus/modal/disconnect/reload/branch/session/dispose during timer, helper defer, precheck, queued native reservation, held postcheck and awaiting receipt: immediate logical cancellation; own removal frame precedes deletion; unrelated upper modal remains; old callbacks cannot alter fitted reopened viewer.
- Unrelated inline successor drains while viewer waits only for cadence or receipt. Use real native/presentation tests (not mock queue) for this seam.

### Actual public-host / profile ownership

Existing host-viewer integration captures both modes/real SGR paths, exact model/storage/source counts and readiness/anchor oracle. Adapt waiting helpers to distinguish owed canonical target from retained ready placeholders; do not weaken existing new-mapping witness assertions. Include actual fullscreen SGR bursts/capture/release, regular keyboard fallback and both blocking states. Use explicit experiment cadence/expiry injection only through normal controller constructor test seams, no runtime environment flag or physical dependencies in repo.

Profile worker separately owns full-host cost and slow FIFO ledger. Compare final canonical/released state, sample, native commit, component receipt and simulated drained output timestamps independently. No terminal ACK/global-output bound claim. No active install/reload or settings/tmux changes.

## 9. Evidence and API conclusion

Inspected complete repository handoff and directly referenced performance/mouse/seam/lifetime/crop/native authorization/capability/accounting contracts; production viewer/viewport/native/presentation/extension wiring and controller tests. Installed Pi 1.0.3 complete README/docs tui/extensions/themes plus relevant shipped examples/public TUI scheduling/invalidations/Terminal declarations and implementation were inspected read-only. Context7 was already quota-exhausted per project primary-source records; no remote docs/provider request was needed. Pi requestRender coalesces with a 16 ms render-start boundary, and Terminal.write remains void; this proposal does not promise host frame throttling or stream backpressure.

Only a new helper API and controller constructor clock/pacing dependency injection are justified. Leave native/presentation/detector/metrics/extension APIs unchanged. Stateless live chrome avoids any theme seam addition. No viewport signature change is required for canonical alias-safe wheel anchoring. The owner-reviewed initial candidate is recorded above; benchmark feasibility remains conditional on declared workload and sink capacity.

Review verification: clean baseline was observed at start; one read-only Node probe confirmed alias pitfalls. No suite rerun, source edit, commit, active reload, configuration change, model/provider call or human pixel/performance observation is claimed by this worker. Coordinator owns implementation tests/commits and delivery.
