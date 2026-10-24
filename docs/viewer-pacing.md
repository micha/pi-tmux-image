# Latest-state viewer presentation pacing — 0.4.2

## Authority, policy and status

The owner authorized implementation and worker delegation after the
[frame-pacing handoff](viewer-frame-pacing-plan.md). After the Phase A profile,
the owner explicitly approved **150 ms idle headroom after the deferred first
own component receipt**, with **wheel expiry disabled**, as the initial production
candidate. The helper/design checkpoint is `253ebe9`; production implementation
is **`ab1301d` / 0.4.2**. Baseline production is `1f00268` / 0.4.1.

This is an implementation and automated-verification record, not human latency
acceptance or authorization to reload the active package. The earlier functional
viewer/mouse acceptance and partial 0.4.1 improvement remain separate. No owner
output trace, real terminal graphics or settings/tmux changes were used. Test
harnesses made no real model/provider requests. Coordinator semantic/stream
verification is recorded below;
matched performance evidence and its remaining limits are maintained in the
separate profile report.

## Implementation

`src/viewer-pacing.mjs` is a host-import-free scheduling primitive. The controller
supplies monotonic time, one-shot scheduling/cancellation, deferred continuation
and an explicit idle allowance. The helper retains one demand bit, one opaque
admitted ticket, one timer and one receipt continuation, not an input/frame FIFO.
Late callbacks sample once; they never replay missed ticks. Exceptions remain
observable, and an exception after publication cannot erase the committed
sample's outstanding own-receipt obligation.

`src/viewer.mjs` separates three responsibilities:

1. **Canonical collection:** every accepted drag delta updates/clamps the latest
   source center and advances the last input point. Recognized keyboard controls
   retain every discrete state effect. No per-report encoding, upload preparation,
   promise or repaint is created for ordinary movement. Edge overshoot/reversal
   remains path-dependent; the controller does not replace it with a final endpoint.
2. **Eligible sampling:** a scheduled opportunity takes the latest representable
   target. Same-layout resident pan uses the existing synchronous zero-upload
   `reuseViewer` proof. Other work uses the unchanged precheck → shared native
   prepare → postcheck path. It takes no native reservation before eligibility
   and never parks a prepared reservation behind a timer or receipt.
3. **Publication and receipt:** immediately before synchronous commit, the
   controller recomputes the current canonical/live layout and canvas/window key.
   A different key rejects/releases the candidate and rearms only the latest
   dirty state after runner drain. A newer state with the same key preserves its
   latest nominal fit/subcell metadata. Valid commits publish their own ready
   frame promptly, then wait for that frame's first component receipt and a
   deferred continuation before the next 150 ms idle allowance begins.

The first update can be admitted immediately when idle. The allowance is not a
150 ms start-to-start interval, universal FPS target or debounce that waits for
movement to stop. Already-published bytes are never delayed behind a later
ordinary pacing deadline. Repeated retained/chrome/background receipts do not
reset the cooldown. Failed or canceled work has explicit non-receipt settlement,
not an interval retry loop.

**Rendering stays passive:** public incidental and keyboard-triggered host frames
validate current policy, layout and native residency, then return the current
sampled ready/status frame. They do not adopt unsampled pan, prepare/reuse rows
or consume wheel. Chrome is styled live, without a persistent themed-frame cache;
ID-color placeholder rows are never recolored or redundantly width-scanned.

## Gesture and recovery precedence

- Release applies its final displacement and ends capture immediately. The latest
  dirty target remains owed through busy/rejected work and settles without another
  pointer report; intermediate viewport presentations are skipped, not state effects.
- Wheel retains one latest sign/point. If canonical pan has not been shown, pan
  settles first. Wheel consumption requires canonical/ready/drawn mapping agreement
  and eligibility. It anchors from that mapping using **canonical** nominal zoom
  and center, so quantized aliases do not silently substitute old ready metadata.
- A new primary press cancels queued wheel but cannot erase accepted pan. It is
  consumed without capture while canonical and rendered mappings differ. Safe
  mapping aliases can capture while preserving canonical subcell center.
- Layout/cell changes cancel stale timed work and gestures, preserve/recompute
  canonical fit/center under the existing resize policy, and use an observed
  generation to reject an observed away/back round trip. Unobserved dimension
  round trips cannot be detected through the public seam.
- Native proof loss cancels a dead own-receipt generation, clears deferred mouse
  work and reconciles latest canonical state after runner drain. Rejected native
  work can revoke old proof even before bytes; retained rows are rechecked.
- Functional failure clears readiness/gestures, publishes error and suppresses
  the same failed key rather than polling on render. Selection errors survive
  first/no-payload renders and resize. A changed target/layout or normal refresh
  can recover through existing guarded paths.
- Escape, public focus loss, widget/session/branch/refresh lifetime changes and
  disposal synchronously cancel timers, invalidate queued continuations and revoke
  replay. Owned deferred removal, public removal-frame flush and scoped retirement
  are unchanged and never wait for pacing headroom. New open is fitted.

One private placement slot, shared PNG residency, standard snapshots/model policy,
commands/tools, two-page PDFs, successful-write metrics and no-budgeting policy
are unchanged. No native, presentation, detector, viewport, protocol or extension
API changes were required. Constructor pacing injection is ordinary testability,
not a runtime flag, setting or public tuning command.

## Review and automated evidence

Independent xhigh review accepted the scheduling primitive after the
post-publication exception contract was clarified. It identified controller
semantic obligations rather than calling reference simulations host acceptance.
During controller review, two recovery defects were found and fixed with persisted
regressions: lost residency stranding an awaiting-receipt helper, and layout
initialization erasing a failed snapshot conversion before first render.

Focused helper tests cover deterministic deadlines/cancellation, 10,000 requests,
first-own receipt and long-work headroom, exact optional local-expiry boundaries,
independent sequential pan/clamp reference and metadata aliases. Controller tests
exercise actual paced collection, passive renders, final target/wheel/press
precedence, canonical aliases, held guards/return-to-key, layout and proof-loss
recovery, failures, theme and owned lifetime. Pure reference simulations are
labeled separately from production-controller evidence.

The public SDK harness uses installed Pi input callbacks/SGR dispatch, production
native/presentation/controller and isolated installation/settings. Deterministic
cases use an explicit **100 ms test allowance**, not the product default. They
verify 10,000 reports with one eligible resident encoding, exact final-release
settlement, own-mapping wheel/cooldown, obsolete zero-write rejection, inline
successor drainage during rejected reservation and cadence wait, and immediate
Escape/modal cancellation. Existing production tests wait for exact target
poses, not any retained placeholder rows; source/model/storage/policy/accounting
assertions are preserved.

### Final coordinator verification

The coordinator reran the following on reviewed viewer SHA-256 prefix
`72693663a99d`, helper `9f80b269edf3`, controller tests `f329073beca7` and production
SDK harness `c1a375b4dd19`, using installed Pi **1.0.3**, Node **v24.21.0**:

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Portable `npm test` | 217 | 0 | 32 optional host tests |
| Host-enabled `npm test` | 249 | 0 | 0 |
| Existing standalone SDK | 12 | 0 | 0 |
| Production viewer SDK + deterministic public TUI | 23 | 0 | 0 |
| Focused helper/controller (independent reviewer) | 60 | 0 | 0 |

The combined viewer SDK took **125.8 s** in the coordinator run; the production
parent timeout is 180 s, increased to accommodate deliberate pacing of sequential
controls. Its 40 separately settled pans diagnostic includes pacing waits,
geometry decoding/assertions and timers; it is not a pure-render or FPS benchmark.
Two guarded zooms retain exactly 12 fresh fake-tmux queries, two prototype
replacements and zero PNG uploads. Resident settled pans retain zero extra
queries/graphics/accounting. Viewer and SDK harness hashes were unchanged across
the final run. The host suite also passed independently in review. Required
reproduction commands:

```sh
npm test
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  PI_IMAGE_HOST_MODULE=/path/to/installed/pi-package/dist/index.js npm test
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  node --test test/host-integration.mjs
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  node --test test/host-viewer-integration.mjs
git diff --check
```

Final source/hash, syntax and `git diff --check` checks passed for these gates.
Portable skips are the optional installed-host tests, not skipped pacing controls.
The SDK verifies isolated `pi install`/discovery/resource loading; no active
installation or reload is implied. Matched performance evidence is separate from
these semantic/stream gates.

## Profiling, limits and coordinated follow-up

[viewer-pacing-profile.md](viewer-pacing-profile.md) documents the reproducible
standalone harness, baseline CPU/bytes, declared FIFO capacity/storage/horizon,
byte conservation and matched candidate evidence. The final matched 292×61,
250-reports/s traces used 1/3/6 offered seconds and preserved every exact final
viewport. Native subset encodings fell **251/751/1,501 → 5/15/28**; emitted text
fell about **96%**. Final accepted-release local receipts were approximately
**208/225/54 ms** in that final pass, demonstrating the phase-dependent settling
trade-off rather than a latency guarantee. All 72 modeled FIFO cases conserved
bytes and drained. Under the declared 1 MB/s service, 1 MiB storage limit and
100 ms stall, the candidate showed no sustained backlog growth across those
longer traces; 250 KB/s remained a sustained deficit and explicitly overloaded
at longer horizons. Independent review accepted the scoped artifacts/claims,
not a universal output or human-performance bound.

The baseline encoded 999 subsets for one frame under a 1,000-drag batch. At
292×61 with occupied 288×55 cells, changed text frames were approximately 175 KB.
The 150 ms candidate was selected from full-host cost and byte-rate evidence,
not the earlier 0.04 ms component-only timing or an arbitrary 60 FPS goal.

A local component receipt/deferred continuation is an application timing proxy,
**not outer-terminal display completion or a successful full-host write ACK**.
Pi's public `Terminal.write` remains void; the extension cannot observe drain,
retract emitted bytes or bound arbitrary terminal/PTY/tmux/SSH/GPU backlog. Slow
FIFO feasibility is conditional on declared workload and capacity; impossible
capacities must remain explicit overload failures. One-slot pixel atomicity is
still unproven. Lower local production/encoding is not guaranteed human smoothness.

After isolated verification, coordinate reload and ask the owner to try the same
problematic pane/image: sustained drag, wheel/trackpad start-stop and reversal,
release/idle tail, immediate Escape, fit/reopen, resize and ordinary transcript
selection/scroll when closed. Record whether bogging down/racing remains, device,
pane size and approximate settling time. No such human result has been obtained
for 0.4.2. Do not reinterpret a general “better” as a latency measurement or full
manual matrix pass. Roll back only the pacing commits if needed, retain useful
profile/design evidence, rerun tests and coordinate reload; do not reset unrelated
work or reclaim arbitrary old terminal resources.
