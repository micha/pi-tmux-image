# Phase A: reproducible baseline capture and FIFO profile

## Scope and status

The initial bounded Phase A pass left production unchanged and proposed a policy;
the subsequent matched section records the owner-authorized reviewed candidate.
Neither pass is the full Phase A/D matrix or owner-path attribution. The useful
result is reproducible CPU/byte evidence and a catch-up-like local/simulated
reproduction with a measured, conditional comparison.

After delivery, the owner generally accepted 0.4.2's performance: “it's much,
much better! i'm satisfied with the performance!” See the separate scoped human
acceptance record in [viewer-pacing.md](viewer-pacing.md). This does not turn the
capture/FIFO figures below into owner-path latency measurements or a full manual
matrix pass; the profiling-period evidence and limitations remain unchanged.

Standalone harness:

- `scripts/viewer-pacing-profile.mjs`
- `scripts/viewer-pacing-profile-support.mjs`
- `scripts/viewer-pacing-profile-pdf.mjs` (generated PDF support)
- `scripts/viewer-pacing-compare.mjs` (matched report validation)

All four scripts are outside the normal unit suite. Generated asymmetric,
coordinate-ruler PNGs exist only in memory. JSON contains aggregate metadata and
byte ledgers, never pixels, placeholder strings, raw input/output or sessions.
Redirect JSON to private temporary storage, not Git.

```sh
# Forced changed-frame CPU/FIFO exploration is restricted to this exact export.
BASELINE_SOURCE=$(mktemp -d /tmp/pi-pacing-source.XXXXXX)
git archive 1f00268 src | tar -x -C "$BASELINE_SOURCE"
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  PI_PROFILE_SOURCE_ROOT="$BASELINE_SOURCE" PI_PROFILE_SOURCE_REVISION=1f00268 \
  node scripts/viewer-pacing-profile.mjs > /tmp/pi-pacing-baseline.json

# Bounded smoke pass; default is 16 samples, accepted range 4..200.
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  PI_PROFILE_SOURCE_ROOT="$BASELINE_SOURCE" PI_PROFILE_SOURCE_REVISION=1f00268 \
  PI_PROFILE_SAMPLES=4 node scripts/viewer-pacing-profile.mjs \
  > /tmp/pi-pacing-smoke.json
rm -rf "$BASELINE_SOURCE"

node --check scripts/viewer-pacing-profile.mjs
node --check scripts/viewer-pacing-profile-support.mjs
node --check scripts/viewer-pacing-profile-pdf.mjs
node --check scripts/viewer-pacing-compare.mjs
git diff --check
```

Neither the default nor `PI_PROFILE_MODE=baseline` path may benchmark the paced
candidate: it requires explicit exported `1f00268` source-root/revision and exact
baseline viewer/native/presentation/viewport hashes. **An unqualified default
invocation against the current candidate fails before benchmark setup.** Use
`PI_PROFILE_MODE=trace` for current/candidate normal-scheduling capture. This
prevents retained passive renders being mislabeled as changed-frame CPU/bytes
or being fed into the Phase A synthetic comparison.

The installed root must supply public `dist/index.js` and its own pi-tui peer.
No host dependencies are installed into this repository, no active package is
installed/reloaded, and no tmux query/configuration, provider call, stdout patch,
private host mutation or real terminal write is made. The harness refuses
`PI_TUI_WRITE_LOG`. `setCapabilities` affects only the isolated benchmark process.
Cleanup closes the owned viewer, drains its normal scoped retirement and stops
its public TUI. Timings are output data, never pass/fail thresholds.

## API evidence and measurement boundaries

Installed Pi **1.0.3** primary docs read: `docs/tui.md`, `extensions.md`, `themes.md`,
`packages.md`, `settings.md`, `configuration.md`, shipped
`examples/extensions/overlay-qa-tests.ts`, public pi-tui exports and
`terminal.d.ts`, plus read-only `tui.js` scheduling source. This worker made a
fresh Phase A Context7 `resolve-library-id` lookup for Pi coding agent; it returned
**“Monthly quota exceeded.”** Installed primary evidence supplied verification
for this version, rather than an unverified training-memory fallback.
Existing `test/host-viewer-seam.test.mjs` and
`test/host-viewer-integration.mjs` supplied the public capture/input reference.

- Actual exported `TuiAltScreen` / `TuiMainScreen`, production controller,
  presentation and native owner run against a supplied capture `Terminal`.
  The controller gets the TUI through the production widget seam.
- Full changed-frame timing brackets **public `tui.renderNow()`**, with three
  warm-ups and 16 retained samples. It includes host layout/compositing/width
  work and synchronous capture bookkeeping. It excludes terminal/tmux/SSH/GPU
  work. This background is a simple transcript/editor, **not full
  `InteractiveMode`, SDK/session or streaming transcript overhead**.
- Input timing brackets the terminal's **installed input callback**. Native
  timing decorates only the injected package-native interface, never host
  renderer methods. It measures `reuseViewer` row encoding separately; that
  interval is contained within input-handler time, not an additive cost.
- Public `StdinBuffer` splits concatenated SGR for batch tests and forwards each
  sequence to that same installed callback. No direct controller mouse call.
- Separate-turn tests use real timers and normal `requestRender` scheduling;
  they do **not** force a host render after every report. Target ingress times
  are generated locally, not timestamps supplied by a device/SGR protocol.
- The native/placeholder-write ordinals recorded for final release are harness
  seam ordinals. There is no private canonical revision access or public display
  ACK. A matching final write ordinal demonstrates local production of that
  target, not outer-terminal visibility. Full per-frame canonical/sample/commit
  age histograms remain a later instrumentation task.
- Capability guards are injected supported/abort-aware counters. These timings
  **do not measure real tmux probes or pre/post probe delays**. Resident pan
  asserts zero additional prepares/guards/graphics and stable allocated IDs.
- Images originate in memory: one payload-resolution call and two allocated
  IDs per case. Source reads/model requests are zero by construction. No SDK
  session is instantiated; unchanged session/model-conversion/PDF assertions
  remain the existing acceptance harness's responsibility.

Read-only scheduling evidence agrees with the handoff: ordinary `requestRender`
coalesces at a 16 ms start-based minimum; synchronous frames can consume that
interval. Keyboard input can ask for immediate host rendering independently.
`Terminal.write(string): void` supplies neither drain nor screen ACK.

## Recorded run and CPU contention

The initial Phase A run used the working baseline checkout before controller
editing; the replay command above now deliberately requires the equivalent
Git-exported baseline. Default 16 samples, Node **v24.21.0**, Pi **1.0.3**, HEAD
**`94fafaf1fd5de02cca5846cd6b15f27f4273afca`** (documentation checkpoint;
production 0.4.1). Production SHA-256 prefixes before/after were equal:

| Source | Prefix |
|---|---|
| `src/viewer.mjs` | `56091474f578` |
| `src/native.mjs` | `c03cb3332eaa` |
| `src/presentation.mjs` | `12265f6f05c2` |
| `src/viewport.mjs` | `3f80c1e9fde2` |

The run rejects changing source hashes, so concurrent production changes cannot
silently produce a mixed-revision profile. Other workers/coordinator were active:
8 logical/available CPUs, load averages **2.00/1.54/1.21** before and
**1.85/1.55/1.22** after. Process snapshots include other Pi/tmux tasks; `%CPU`
is lifetime-average context, **not instantaneous utilization or an isolation
proof**. Wall duration **22.895 s**, process user/system CPU **22.000/0.116 s**.
Outliers may include allocation/GC and contention; neither was isolated.

Cell pixels are the installed public default **9×18**, not queried owner pixels.
Landscape is **1200×600**, portrait **600×1200**. Each opens fitted and is zoomed
to its representable maximum, genuinely occupying both usable axes. Landscape
canvas **297×75**; portrait canvas **297×297**. The full protocol-boundary
**297×297** occupied encoder-only sample is **1,014,849 exact row bytes**, median
**4.553 ms**, p95/max **21.859 ms** (16 samples). It cannot pan because no origin
range remains; no giant-host rendering claim is made.

## Changed-frame CPU and exact text

Milliseconds are p50 / p95. With 16 samples the reported p95 is also the maximum;
this is exploratory evidence, not a stable tail-latency estimate. Encoding
samples include warm-up/release calls (18 fullscreen / 19 regular), explicitly
reported in JSON. Full-host/input samples retain 16 each.

| Pane / mode | Occupied cells | Input handler | Native reuse encoding | Full public-host render | Text bytes / changed frame |
|---|---:|---:|---:|---:|---:|
| 40×16 fullscreen | 36×10 | 0.175 / 0.409 | 0.074 / 0.118 | 1.089 / 5.557 | 5,106 |
| 40×16 regular | 36×10 | 0.115 / 0.157 | 0.033 / 0.048 | 1.160 / 1.362 | 5,045 |
| 100×40 fullscreen | 96×34 | 0.199 / 0.226 | 0.139 / 0.160 | 5.734 / 13.381 | 39,456 |
| 100×40 regular | 96×34 | 0.228 / 0.410 | 0.156 / 0.291 | 6.270 / 6.624 | 39,262 |
| 200×60 fullscreen | 196×54 | 0.515 / 10.287 | 0.444 / 10.201 | 18.606 / 20.018 | 119,302 |
| 200×60 regular | 196×54 | 0.532 / 0.661 | 0.463 / 0.574 | 16.659 / 24.929 | 118,988 |
| **292×61 fullscreen** | **288×55** | **0.755 / 7.504** | **0.671 / 7.394** | **25.321 / 28.988** | **175,246** |
| 292×61 regular | 288×55 | 0.736 / 1.084 | 0.655 / 0.967 | 25.032 / 31.915 | 174,926 |
| 100×40 fullscreen portrait | 96×34 | 0.220 / 0.339 | 0.151 / 0.294 | 5.905 / 13.368 | 42,788 |

Each changed measured frame made one text write. IDs are randomized by the
production owner; exact decimal/color escape lengths can vary slightly between
runs. JSON captures the actual totals, not a hardcoded bytes/cell formula.
Cursor helper output goes through capture `write`, too. Text and wrapped native
transport are separated; pan graphics are **zero bytes**. Setup PNG/prototype
transport is reported separately in JSON, not included in changed-pan totals.

These host numbers are **not matched reruns** of the earlier 20.5/68.4 ms profile:
fixtures, maximum canvas, geometry, chrome and background procedure differ.
They do not disprove that prior profile or measure the owner's full Pi frame.
Use this checked-in harness for subsequent matched baseline/candidate runs.

Cheap pure per-event `panViewport` math (16 batches of 1,000 sequential,
alternating, clamped operations) is about **0.0021–0.0028 ms median/report**.
At 292×61 the batch-normalized p95 is **0.0046 ms/report**; it is not an
individual-report latency distribution. Preserve sequential clamp semantics;
this evidence does not justify replacing path-dependent state with one endpoint.

## Catch-up-like reproductions

### Batched input wastes encoding before host coalescing

A concatenated 1,000-motion SGR batch plus release produced **999 native row
reuses but one text frame**, with zero prepares/probes/graphics. Batch wall times:
40×16 **54.8 ms**, 100×40 **178.7 ms**, 200×60 **491.6 ms**, 292×61 **758.5 ms**.
The native/controller has not stored 999 historical ready frames; it encoded
obsolete subsets synchronously before Pi merged repaint requests.

At 292×61, a separate 1,000-wheel-down batch took **7.25 ms** in input collection
and yielded **one prepare, two injected guards**, **58 graphics bytes** (one
prototype, no PNG), and **147,308 text bytes / three writes** through initial,
loading/retained and settled host frames. Settlement observed by the polling
harness took **138.36 ms**; this includes polling and host work, not real probe
latency or display completion. This is one sign-only burst case, not busy-wheel
expiry or all wheel/trackpad behavior.

### Separate-turn historical ingress can catch up locally

Triangular two-axis trajectories avoid the misleading case where alternating
poses alias to the same coalesced host frame. The generator preserves every
scheduled report; lateness measures accepted callback time against offered time.
This deliberately models delayed ingress. It is **not** evidence that the viewer
has a historical frame FIFO, nor that the owner's input path has this backlog.

| Pane | Offered workload | Actual input duration | Lateness p50 / p95 / max | Final release → last placeholder write |
|---|---|---:|---:|---:|
| 40×16 | 50 reports, 125/s, 400 ms target | 391 ms | 0 / 0.49 / 1.14 ms | 14.17 ms |
| 100×40 | same | 396 ms | 16.75 / 32.19 / 36.41 ms | 28.15 ms |
| 200×60 | same | 1,345 ms | 489.37 / 895.60 / 952.48 ms | 73.91 ms |
| **292×61** | **300 reports, 250/s, 1,200 ms target** | **11,843 ms** | **5,303 / 10,118 / 10,646 ms** | **94.20 ms** |

The owner-scale run made **301 row reuses** including final displacement and
emitted **26,445,338 text bytes in 152 writes**, zero graphics/probes/prepares.
Final input/native-reuse/placeholder-write ordinals all equal **301**. Large
host synchronous work materially delays timer-generated ingress even though
individual handlers are usually below 1 ms. The generation loop continues
accepting historical offered reports after its nominal target horizon: that
is the declared upstream-like backlog reproduction, not unbounded local
presentation replay after final *accepted* release.

## Honest downstream FIFO model

`FifoLedger.write` is void and records every write as an exact ordered byte range.
`advance` consumes only service capacity, including partial progress. It never
replaces old frames, drops output, awaits drain or invents public backpressure.
Emitted = drained + pending is checked at every transition. A built-in deterministic
self-check exercises partial progress, stall, overload and complete drain.

Capacity, storage and horizon are distinct. The recorded-write replay uses
**1,000,000 bytes/s**, an **8 MiB** modeled storage limit, and a **100 ms zero-service
stall at t=200..300 ms**. It includes every capture-host write in the workload
window, not just placeholder payloads. Actual write receipts delimit service
advances; completed-write ages are therefore explicitly **upper bounds at ledger
observation times**, not exact completion ages. Tail drain uses 1 ms steps.
Oldest pending age is exact at the observation point. This is a synthetic FIFO,
not a real terminal ACK.

After 200 ms of local idle following owner-scale release, the ledger had:

- emitted **26,445,338**, drained **11,847,626**, pending **14,597,712 bytes**;
- peak pending **14,705,353 bytes**, oldest pending age **6,717.74 ms**;
- explicit overload at **6,765.75 ms** (8 MiB crossed);
- another **14,598 ms** modeled idle drain tail; final pending zero and exact byte
  conservation, with **14,748 partial advances**.

After crossing the limit, the run is a **failed finite-storage model**. The
benchmark continues the exact ledger solely to expose the deficit and drain
obligation; it does not pretend that over-limit storage is physically feasible.
The viewer already stopped local production, yet emitted old output still drains.
A bounded application queue cannot retract those bytes.

## Fixed cadence candidates, not selected production defaults

The comparison is a **synthetic always-changed latest-state sampler** with
250 offered reports/s, fixed measured p95 host cost, and a completion-to-next-
admission idle allowance of **0 / 50 / 100 / 150 ms**. Each admitted changed frame
uses its measured exact p95 changed-frame write size. All modeled frame writes
are retained by the FIFO. One final latest target settles after release.

This is byte-rate/headroom exploration, not production scheduling/commit guards,
wheel semantics, adaptive estimation, preparation starvation or Phase B proof.
The 0 ms comparison is a **synthetic cost-limited emitter**, not a faithful
implementation of Pi's baseline scheduler. Initial source uploads, unrelated
background streaming and real downstream overhead are outside this model.

At 292×61, measured cost **28.988 ms** and frame **175,246 bytes**:

| Idle allowance | Approx. continuous text rate | At 4 MB/s, 1/3/6 s horizons | At 1 MB/s, 1/3/6 s horizons |
|---|---:|---|---|
| 0 ms | 6.05 MB/s | overload, increasing backlog | overload, increasing backlog |
| 50 ms | 2.22 MB/s | stable transient / 44 ms tail | overload, increasing backlog |
| 100 ms | 1.36 MB/s | stable transient / 44 ms tail | 645,312 / 1,385,442 / 2,449,379 pending bytes; overload at longer horizons |
| **150 ms** | **0.979 MB/s** | **stable transient / 44 ms tail** | **252,795 / 211,635 / 175,246 pending bytes; no overload; 253 / 212 / 176 ms tails** |

Storage limit here is **1 MiB**, stall again 200..300 ms. Ending pending bytes
include the final frame, not an assertion that output should be pointwise empty.
At 150 ms / 1 MB/s, peak stays **267,763 bytes** across matched longer horizons;
backlog does not grow with duration. This is only a narrow, finite-horizon
conditional envelope, with little throughput margin. At **250,000 bytes/s**,
even 150 ms fails: ending pending **983,241 / 2,418,730 / 4,637,214 bytes**, overload
at 3/6 seconds and a **18,549 ms** 6-second run drain tail. The deliberately
impossible capacity is not hidden by frame dropping inside the sink.

**Proposal for coordinator review:** start the first matched production trial
with **150 ms idle after the admitted frame's own receipt/deferred host-work
boundary**, not a 150 ms start-to-start interval. This gives approximately
179 ms between changed owner-scale presentations here, substantial CPU headroom,
and the lowest tested emission volume. Trial 100 ms remains informative for a
faster declared sink, but is not feasible for this 1 MB/s model. At 1 MB/s,
150 ms is marginal; 200 ms idle or an independently reviewed byte policy could
be needed for background output/headroom. A smaller viewport is **not** proposed.
Do not turn any capacity model into a global stream/terminal guarantee.

No wheel-expiry value is proposed from this batch-only evidence. Keep the
handoff's receipt/lease/layout/commit guards and final-pan rearming; do not use
synthetic cost or a component receipt as an outer-terminal ACK.

## Matched Phase D support (subsequent owner-authorized candidate)

After accepting the bounded Phase A evidence, the owner selected **150 ms idle
following the deferred own local receipt, wheel expiry disabled (`null`)** for
the initial production candidate. This supersedes the proposal-only decision
status above, not the conditional capacity or ACK limitations.

`PI_PROFILE_MODE=trace` runs normal scheduling only, against either production
source tree. Unlike the Phase A forced changed-frame loop, it never assumes a
raw report or incidental render adopts a desired viewport. It waits for exact
final native window equality, an emitted first-cell origin receipt, and verifies
**every composed final public row/column mark**. A 200 ms idle tail must preserve
that final geometry. An already-visible quantized geometry alias may satisfy a
final release immediately; that case is labeled separately, not fabricated as a
new receipt. Pure sequential pan math supplies the final reference; it is not an
independent clamp proof (the controller's semantic tests own that proof).

```sh
# Export only production sources; never reset the shared working checkout.
BASELINE_SOURCE=$(mktemp -d /tmp/pi-pacing-source.XXXXXX)
git archive 1f00268 src | tar -x -C "$BASELINE_SOURCE"

PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  PI_PROFILE_MODE=trace PI_PROFILE_TRACE_MATRIX=bounded \
  PI_PROFILE_SOURCE_ROOT="$BASELINE_SOURCE" PI_PROFILE_SOURCE_REVISION=1f00268 \
  node scripts/viewer-pacing-profile.mjs > /tmp/pi-pacing-matched-baseline-bounded-final.json

# Wait for coordinator's stable reviewed source / tests-complete gate first.
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  PI_PROFILE_MODE=trace PI_PROFILE_TRACE_MATRIX=bounded \
  node scripts/viewer-pacing-profile.mjs > /tmp/pi-pacing-matched-candidate-bounded-final.json

node scripts/viewer-pacing-compare.mjs \
  /tmp/pi-pacing-matched-baseline-bounded-final.json \
  /tmp/pi-pacing-matched-candidate-bounded-final.json > /tmp/pi-pacing-matched-comparison-bounded-final.json
rm -rf "$BASELINE_SOURCE"
```

These are **test-harness source selection flags**, not production runtime flags.
Source hashes include the candidate pacing helper (null on the exported
baseline) and PDF implementation; before/after hashes must match. Fixture PNG
hashes, cells, dimensions, canvas, offered trace/rate/horizon and expected final
window must match between runs. Random allocated IDs can slightly change ANSI
byte lengths, which are measured exactly rather than normalized away.

Bounded matrix: 40×16, 100×40 and 200×60 at 125/s; 292×61 at 60/125/s for one
second, 250/s for **1/3/6 offered seconds**, and 1,000/s for a short 250 ms burst;
portrait and both freshly generated **actual Poppler PDF page snapshots** at
100×40/125/s. PDF source/raster scratch is removed before gesture work. Support
is `scripts/viewer-pacing-profile-pdf.mjs`; no checked-in pixels/files or extra
source/PDF work during interaction. One rasterization produces exactly two pages.

All capture writes replay into **4 MB/s / 1 MB/s / 250 KB/s** FIFOs, each with a
**1 MiB limit**, the same 200..300 ms zero-service stall, actual capture horizon,
conservation and partial progress, peak/ending bytes, oldest age and complete
idle drain tail. `scripts/viewer-pacing-compare.mjs` checks workload equivalence
and prints longer-horizon trends. It imposes no raw timing acceptance thresholds.
The offered horizons match, but baseline's actual ingress/observation horizon
may be much longer: report both, not a false same-wall-time workload claim.

The actual exported **0.4.1 baseline remains normal Pi scheduling**. Do not
relabel it as the Phase A synthetic idle=0 cost-limited emitter. Full exact host
wall-time measurements remain the separate Phase A forced changed-frame run;
this matched trace uses emitted writes/normal callbacks and does not monkeypatch
host rendering to time automatic frames. SDK invariants, busy zoom/failure/policy
matrix, long-held input, every device/shape/layout and human acceptance remain
outside this bounded trace pass.

## Final matched trace results

After the coordinator's tests-complete/lower-contention gate, the **same final
harness** ran sequentially against Git-exported **`1f00268`** then the reviewed
candidate. Both completed all **12 bounded cases**, exact final native geometry,
every public final cell mark and local emitted origin receipt, zero new native
reuse/prepare/guard/payload work during the 200 ms stop tail, zero gesture graphics,
and exact byte conservation at all three service capacities. One baseline
1,000/s case made one unchanged host tail write; it performed no native work and
preserved exact final geometry. Candidate tail writes were zero in every case.

All before/after source and harness hashes matched within each run. Candidate
viewer **`72693663a99d`**, pacer **`9f80b269edf3`**; native/presentation/viewport/PDF
were identical to the exported baseline. The comparator verified identical Pi
**1.0.3**, Node **v24.21.0**, 9×18 cells, mode/workload/fixture hashes, offered
rates/horizons, dimensions/canvas/expected final windows and per-case
capacity/storage/stall assumptions. Actual observation horizons intentionally
differ. Final harness SHA-256 prefixes:

| File | Prefix |
|---|---|
| `viewer-pacing-profile.mjs` | `0f52231fa63a` |
| `viewer-pacing-profile-support.mjs` | `7d05fb07e0d5` |
| `viewer-pacing-profile-pdf.mjs` | `bb4b41a5452c` |
| `viewer-pacing-compare.mjs` | `e44ba7fc01cc` |

Private current aggregate outputs: `/tmp/pi-pacing-matched-baseline-bounded-final.json`,
`/tmp/pi-pacing-matched-candidate-bounded-final.json`,
`/tmp/pi-pacing-matched-comparison-bounded-final.json`. The earlier matched
`*-final.json` pair is retained as historical evidence. The final narrow change
bounded read-only git/ps metadata calls with a common **3,000 ms timeout,
256 KiB maxBuffer and SIGKILL**; both source trees were rerun on that same final
harness. Original Phase A `/tmp/pi-pacing-baseline.json` was preserved;
no raw traces/pixels entered Git.

### Exact work/byte benefits and latency trade-off

Each row is **baseline → candidate**. Time values are local milliseconds,
rounded here; JSON retains full precision. These are single matched runs, not
repeated-trial distributions or owner latency measurements. The final column
measures **final accepted release → matching local placeholder receipt**, not
first offered input → screen completion.

| Pane / fixture / offered rate / target horizon | Native reuses | Exact emitted text bytes | Actual input duration (ms) | Final release → receipt (ms) |
|---|---:|---:|---:|---:|
| 40×16 landscape, 125/s, 0.4 s | 51 → 3 | 121,846 → 15,318 | 392 → 392 | 1.2 → 68.6 |
| 100×40 landscape, 125/s, 0.4 s | 51 → 3 | 907,442 → 117,960 | 403 → 392 | 20.6 → 109.4 |
| 200×60 landscape, 125/s, 0.4 s | 51 → 3 | 3,103,040 → 357,798 | 1,440 → 437 | 79.8 → 166.3 |
| 292×61 landscape, 60/s, 1 s | 61 → 5 | 5,430,151 → 876,027 | 2,434 → 983 | 101.5 → 160.8 |
| 292×61 landscape, 125/s, 1 s | 126 → 6 | 11,042,973 → 1,051,586 | 4,963 → 1,022 | 92.6 → 176.3 |
| 292×61 landscape, 250/s, 1 s | 251 → 5 | 22,078,356 → 876,979 | 9,940 → 1,001 | 99.3 → 207.8 |
| 292×61 landscape, 250/s, 3 s | 751 → 15 | 61,492,569 → 2,631,360 | 19,484 → 2,996 | 76.8 → 225.5 |
| **292×61 landscape, 250/s, 6 s** | **1,501 → 28** | **122,848,304 → 4,915,257** | **37,969 → 5,996** | **35.8 → 53.9** |
| 292×61 landscape, 1,000/s, 0.25 s | 251 → 3 | 20,341,274 → 525,920 | 7,076 → 511 | existing receipt (0) → 229.1 |
| 100×40 portrait, 125/s, 0.4 s | 51 → 3 | 939,012 → 128,181 | 394 → 391 | 13.3 → 108.9 |
| 100×40 PDF page 1, 125/s, 0.4 s | 51 → 3 | 788,916 → 117,892 | 408 → 392 | 7.7 → 92.9 |
| 100×40 PDF page 2, 125/s, 0.4 s | 51 → 3 | 941,982 → 128,283 | 408 → 392 | 20.6 → 108.3 |

Owner-scale 250/s reuses fell **98.01% / 98.00% / 98.13%** at 1/3/6 seconds;
text fell **96.03% / 95.72% / 96.00%**. Final movement was not lost. Ingress
lateness p95 dropped **8,517 / 15,699 / 30,458 ms → 85.4 / 81.5 / 81.8 ms**;
candidate maxima remained **95.2 / 103.6 / 113.4 ms**. The 1,000/s burst still
had **134.4 ms p95 / 262.4 ms max ingress lateness**, and twice its nominal input
duration: this is improvement, **not universal flood responsiveness**.

The cooldown deliberately increases final *accepted*-release settling compared
with baseline's often synchronous adoption. Measured owner-scale final receipt
ages span **53.9–229.1 ms** in this pass. At 250/s specifically: candidate
**207.8 / 225.5 / 53.9 ms**, baseline **99.3 / 76.8 / 35.8 ms**. Final-step latency
is **not universally faster**; phase alignment changes the settling delay, and
prior run values are not substituted for this run. This headroom/responsiveness trade-off
needs owner judgment on the problematic device; no human performance acceptance
or outer-terminal diagnosis follows from these results.

### Matched downstream envelope and explicit failures

Every capture write is retained in the same void FIFO ledger: capacities
**4,000,000 / 1,000,000 / 250,000 bytes/s**, **1 MiB limit**, **100 ms stall** at
200..300 ms. The following owner 250/s trends use **1/3/6 offered seconds**;
actual observation horizons were baseline **10.250 / 19.771 / 38.218 s** and
candidate **1.416 / 3.429 / 6.258 s**. Comparing the offered trace is valid;
pretending those are identical wall-time producer workloads is not.

| Producer / capacity | Ending pending bytes, 1 / 3 / 6 s offered | Peak pending bytes, 1 / 3 / 6 s offered | Additional idle drain tail |
|---|---|---|---|
| Baseline / 4 MB/s | 0 / 0 / 0 | 256,699 / 436,340 / 436,305 | 0 / 0 / 0 ms |
| **Candidate / 1 MB/s** | **0 / 0 / 0** | **185,886 / 246,692 / 175,865** | **0 / 0 / 0 ms** |
| Candidate / 4 MB/s | 0 / 0 / 0 | 175,755 / 175,755 / 175,865 | 0 / 0 / 0 ms |
| Baseline / 1 MB/s | 12,049,616 / 41,916,812 / 84,826,207 | 12,261,082 / 42,128,413 / 85,042,115 | 12,050 / 41,917 / 84,827 ms |
| **Candidate / 250 KB/s** | **597,949 / 1,849,101 / 3,425,791** | **650,010 / 1,901,239 / 3,478,097** | **2,392 / 7,397 / 13,704 ms** |

Candidate 1 MB/s has no sustained positive ending backlog trend under these
longer matched traces, and its transient peaks stay below **247 KB** (roughly
one to one-and-a-half frames), not pointwise empty output. Baseline
4 MB/s also remains conditionally feasible; pacing is not needed to hide a
capacity failure there. Baseline 1 MB/s overloads at every horizon. Candidate
250 KB/s explicitly overloads the 1 MiB model at 3/6 seconds, with oldest pending
ages **952 / 2,325 / 4,248 ms** across 1/3/6 seconds. Baseline 250 KB/s fails
still more severely (6-second offered trace: **113,342,780 pending bytes**, modeled
**453,372 ms** additional drain). Bytes were conserved through every failure;
over-limit continuation is diagnostic ledger accounting, not feasible storage.

These capacities are declared simulations, **not measured SSH/tmux/PTY or Ghostty
capacity**. Fixed finite horizons and one synthetic stall do not establish a
global sink bound. Queued text may still drain after local settlement. No
real-path attribution, GPU/terminal ACK or physical display latency was measured.

### CPU context, verification and remaining omissions

Runs followed coordinator test completion and were sequential, but not CPU-
isolated. Eight logical/available CPUs; load averages baseline
**1.37/1.45/1.50 → 2.23/1.68/1.57**, candidate
**2.23/1.68/1.57 → 1.99/1.68/1.57**. Other Pi/tmux tasks remained active.
Process wall/user/system totals: baseline **91.776 / 88.527 / 0.734 s**,
candidate **31.006 / 9.800 / 0.139 s**. These include in-loop PNG fixture/setup,
reference/oracle and ledger work, not isolated renderer CPU; preliminary imports
and the shared Poppler fixture generation are outside the recorded run interval.
Single-run JIT/GC and scheduling variance were not separated.

All four scripts passed `node --check`; `git diff --check` passed. The comparator
accepted the final pair and eight deliberately mutated reports were rejected:
Pi version, Node version, mode, workload, capacity, storage, stall and harness
hash mismatch. Temporary negative fixtures were removed. Default forced-render
invocation without explicit baseline selection was rejected before setup.

This matched pass adds representative rates, longer horizons and actual PDF
snapshots, but still omits real device/terminal output, regular-mode matched
pacing gestures, fractional/changed cells, wheel-busy/expiry timing, delayed
probe/preparation/commit attribution, source/session/model SDK invariants, the
failure/modal/resize lifetime matrix and multiple repeated timing trials. Those
are separate semantic SDK tests or future coordinated measurements. The checked
capture stream, reference math and native counters establish the scoped local
production result only; final performance acceptance remains the owner's.

## Phase A omissions (historical checkpoint)

The initial first-pass reproduction/proposal was sufficient to start pure design
review, not to claim all Gate A/D cases passed. At that checkpoint it omitted
portrait at every layout, actual Poppler/PDF snapshots, 60/1,000 separate-turn
rates, long holds, all edge/reversal and closed-transcript behavior, delayed async
probes, canonical/sample/native/receipt age histograms, fractional/changed cells,
active SDK session/model invariants, the pacing candidate, source-deleted replay,
policy/failure/resize matrix, owner output path and human latency. The subsequent
matched pass above addresses representative rates, PDF snapshots, exact final
receipt and the candidate comparison; its remaining omissions are stated there.
Use the existing SDK acceptance harness for semantic invariants. Do not enable
owner traces or reload without coordination.
