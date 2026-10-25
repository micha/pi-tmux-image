# Self-contained PDF previews and pagination

## Status and authority

**Implemented and automated-verified in 0.5.0**, following owner implementation
and coordinator final documentation authorization. Independent production review,
full stable offline suites and isolated installation/loading gates passed; their
exact scope is below. **The broader new-PDF human visual/regular scrollback/
responsiveness matrix remains pending.** No active package installation/reload is implied.
The subsequent [blank-page recovery change](pdf-blank-recovery.md) records the
conservative private-retirement upload-trust repair separately from the original
0.5.0 gates below. The owner confirmed its pixels in a fresh Pi process after the
existing-process `/reload` workflow failed to activate changed native code; that
is general recovery acceptance, not completion of the broader PDF matrix.

The [historical PDF handoff](pdf-document-viewer-plan.md) records agreed intent
and planning-checkpoint evidence. The owner explicitly approved the publication
correction below after executed Pi **1.0.3** feasibility checks: report submission
and selected retention, not acknowledged display/durable persistence. Older
[two-page inline observations](verification.md) and [viewer acceptance](viewer-verification.md)
remain historical; they do not establish human acceptance of new pagination.
Human setup, usage and privacy guidance belong in [README](../README.md).

## Representation and ownership

New `/tmux-pdf` / `tmux_show_pdf` imports submit one `pi-tmux-image` custom message:

- `content`: sanitized document label and `Page 1 of N`, plus one **standard Pi
  image attachment**, acquired through public `createReadTool` and validated by
  the unchanged native normalization path before submission.
- `details.schema`: `pi-tmux-image/pdf-v1`. Preview occurrence/label/geometry
  accompany `document` metadata: `application/pdf`, `keep|temporary`, exact
  captured byte length/SHA-256, page count, preview page 1 and render longest side
  1200. Only Keep includes `document.data`, one canonical base64 original.
- Tool results contain only compact path/count/size/retention/submitted summaries,
  never a duplicate preview/original. No durable sidecar or extra asset entry.

The provenance label is **not a source locator**. Capture streams a regular file
into private immutable scratch, incrementally hashes/counts bytes, and checks
metadata/inode/path/size races. Detected changes fail with a retry explanation;
stat checks are not proof of atomic capture against every concurrent writer.
The bytes actually captured define the document.

`readPdfDetails` performs cheap structural validation and freezes small records,
retaining the large immutable data string by reference. Picker/render scans do
not decode, hash or clone it. `readPdfPreviewDetails` adapts safe preview fields to
the existing `native-v1` display path without expanding native's schema or giving
invalid documents browsing access. Full canonical base64/length/hash validation
happens during lazy Keep materialization, before later-page Poppler work.

Ownership is deliberately split:

| Owner | Responsibility |
| --- | --- |
| `extensions/tmux-image/index.ts` | Public capability/UI gates, standard preview/model-policy wiring, one import reservation, final guards/send, all-history submission reconciliation, active-branch indexing and exact runtime-service handle dispatch |
| `src/pdf-document.mjs` | Immutable capture, retention transactions, private runtime registry, service-branded handles, canonical preview and lazy original materialization/page acquisition |
| `src/pdf.mjs` | Bounded asynchronous PATH Poppler commands and actual-child-close-before-scratch cleanup |
| `src/viewer.mjs` | One owned overlay, latest page target/generation, serialized transition/retirement/rebind and existing paced viewport sampling |
| `src/native.mjs` / `src/presentation.mjs` | Unchanged PNG identity/residency/shared queue, fixed private slot, guarded terminal transport and successful-write accounting |

The host-import-free service receives `acquireImage(path, {signal})` from the
extension. Its delivered surface (interface notation, not executable JavaScript) is:

```text
createPdfDocumentService({ acquireImage, tempRoot?, run?, encodeKeep? })
service.prepareImport(path, { occurrence, label, signal, chooseRetention })
// -> transaction: document, previewAttachment, details({geometry}),
//                 synchronous commit(), async rollback()
service.openDocument({ occurrence, label, attachment, document }, { signal })
// -> cheap handle: pageCount, available, optional unavailableReason
service.pageAttachment(handle, pageNumber, { signal })
service.releaseDocument(handle)
service.discardTemporary(occurrence, sha256)
service.dispose()
```

`commit()` stages Temporary runtime ownership **before** send; it does not mean
host publication/disk commit. Generic rollback cannot delete staged originals.
`discardTemporary` checks exact occurrence/hash and refuses any consumer,
including an idle page-one handle; it removes the registry entry before awaited
unlink to prevent racing acquisition. Handles belong to their creating service,
not whichever runtime happens to be current when a late callback releases them.

## Retention, persistence and privacy

Threshold is exactly **32 MiB = 33,554,432 original bytes**. At/below it Keep is
selected without UI. Above it both entry points require the user's public
Keep/Temporary/Cancel selector, showing original size, approximate base64 overhead
and save/load/copy/export consequences. Undefined, invalid, unavailable or aborted
selection never defaults to Keep. One import is reserved before awaits; importing
refuses a live viewer/public overlay instead of using selector focus loss to close
it. Pi 1.0.3 exposes no general ownership query for unrelated editor-area selectors;
public `hasOverlay()` is not such a query.

Keep stores one original in details. Materialized decoded originals are temporary
per-handle scratch, released after users drain; reopening may rematerialize. Pi
owns session persistence: a custom-message-only new session can remain in memory
until a user/assistant conversation exists, and `--no-session` remains ephemeral.
There is no forced flush, atomic durable-save promise or automatic recovery of an
unsaved session.

Temporary persists only preview/metadata. Its streamed captured copy belongs to
the session runtime, not the overlay or active branch. Close/reopen, branch
navigation and explicit refresh preserve it; reload/shutdown/new/resume/fork
runtime replacement aborts/drains consumers and disposes it. Only active-branch
entries are pickable. After replacement the preview remains usable with an honest
original-not-retained explanation; there is no old-path lookup or loading loop.

Raw JSONL, forks/clones/copies, backups/trash and HTML-export serialized session
data may carry the **entire retained original**, including never-viewed pages.
Details are excluded from model-converted content, not from storage/sharing.
Compaction/model blocking does not erase them. Deleting one session does not erase
copies or automatically cancel a live runtime holding scratch. No original
excision command, session rewrite, cross-session deduplication or durable sidecar
store is provided.

### Conditional Phase A storage-cost observations

Executed feasibility used public session APIs on Pi **1.0.3**, Node **24.21.0**,
Poppler **26.06.0**. Disposable inert valid PDFs at 4 KiB, 32 MiB minus/exact/plus
one byte and 64 MiB were accepted by real `pdfinfo`. Each size ran in one fresh
process; `performance.now()` timed individual operations and
`process.resourceUsage().maxRSS` measured the **whole run**. There was one sample
per size on a warm local filesystem/cache, no fsync/crash-durability ACK, and a
small standard preview rather than a realistic complete UI workload.

| Original | Base64 characters | Append ms | Load ms | Fork ms | Whole-run peak RSS MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 32 MiB | 44,739,244 | 147.477 | 691.252 | 1,468.611 | 998.0 |
| 64 MiB | 89,478,488 | 292.960 | 2,682.033 | 5,740.492 | 1,950.3 |

The process held several managers/strings/load/fork/copy checks concurrently and
included host imports. Peaks are **not single-import/incremental memory**, GPU
usage or a universal safe-size ceiling. Synchronous JSON/save/load/fork costs are
real; asynchronous capture/Poppler cannot make host synchronous work interruptible.
All three adjacent threshold fixtures had the same base64 length: the decision
must use original bytes, not encoded size. A separate 64 MiB streaming Temporary
experiment avoided a whole-document Buffer/base64; sampling missed possible
transients and was outside the full host UI, so it is not a hard memory bound.

A separate engine encoding-boundary experiment produced `ERR_STRING_TOO_LONG`
before send. There is **no fixed application PDF byte ceiling**: consent does not
remove engine allocation/string/JSON limits, storage failures, OOM or child bounds.
No huge/hostile-PDF, disk-full, partial-write or arbitrary-size success guarantee
was established. These are scoped feasibility observations, not production-import
latency benchmarks or owner responsiveness acceptance.

## Publication boundary

Public Pi 1.0.3 extension `pi.sendMessage` returns **void**. During sequential tool
execution, `triggerTurn: false` accepts a queued preview which appends after tool
results. Awaiting void does not acknowledge append, display or disk, and waiting
inside execute for the later append would block the result that enables it.

Executed public-host checks observed idle filesystem failure reported through
Pi's `send_message` error path; in-memory append could already exist without
finalized display/messages. Deferred flush failure could reject the outer SDK
prompt after the tool had already returned. A queued preview could still append
after post-send tool cancellation. Custom `message_end` extension hooks are not
an append ACK for this path. Tree presence never proves durable save.

Consequently the owner-authorized contract is:

1. Complete consent/capture/metadata/page-one/read/normalization/Keep encoding and
   capability/cancellation/runtime checks **before** staging and one send. Known
   pre-send failures/cancel produce zero preview entries; no silent retention fallback.
2. With no await between final guards, synchronous staging and send, hand off one
   preview. Report **submitted preview / selected retention**, not “displayed” or
   “durably saved.” Accepted handoff is irreversible through public extension APIs.
3. Preserve staged Temporary through deferred/ambiguous handoff, even if immediate
   branch/history reads are empty or a synchronous send seam throws. Reconcile at
   final same-runtime boundaries using **all history**, snapshotting eligible
   candidate records before awaited cleanup and checking exact identities. An
   existing occurrence owns its runtime original even on an inactive branch or
   after persistence failure. Absence alone before queue settlement is insufficient.
4. Pi owns later host error reporting. Do not retroactively claim a returned tool
   failed, blindly retry/duplicate, retract queued messages, mutate history or force
   a file save. Runtime ownership reconciliation is not persistence acknowledgement.

Independent production review accepted this boundary and the fixed reconciliation
race: boundary-eligible candidates are snapshotted before awaited discard, with
exact runtime/record identity guards. Its persisted production-loader regression
holds old cleanup while submitting a later Temporary and proves the later original
survives. Final automated evidence is below; neither review nor those gates is
a display/disk acknowledgement.

## Pages, viewport and native resources

Page 1 always returns canonical stored preview fields without Poppler, original
decoding or source access. Later pages lazily use verified embedded bytes or runtime Temporary
capture. No eager all-page work, adjacent prefetch, persisted derived-page cache,
resolution escalation or rerasterization on pan/zoom/ordinary resize.

`n`/PageDown and `p`/PageUp clamp without wrapping against the **latest requested**
page, not only the shown page; bursts/reversals replace intent. `g` opens a bounded
same-overlay numeric jump field: digits/backspace, Enter range validation/editable
error, Escape field-only cancellation. Other keys never reach the hidden editor.
Actual page changes fit/recenter, including revisits; already-ready-page requests
are no-ops. Resize preserves/clamps the current viewport. Tiny panes retain page/
jump/Escape input and defer heavy work until usable. Missing Temporary originals
still permit canonical page-one zoom/pan. Existing fullscreen wheel/grab gestures
and regular keyboard-only controls remain unchanged.

One mounted overlay survives pagination. Every sample/ready/drawn/final guard
carries exact page generation/key/lease as well as epoch/layout; equal PNG bytes
or dimensions cannot validate stale work. Page change synchronously revokes old
replay/readiness/gestures, aborts old work and resets fit. One actual page runner
plus one scalar latest target drains predecessor/native work, flushes a loading
removal frame with public `renderNow`, scoped-retires the old private prototype,
then gates/acquires/resolves/binds the latest page. Failed cleanup retains one
obligation and blocks binding; every retry reflushes. The page runner never writes
graphics directly; initial viewport preparation uses the existing pacer.

[Native ownership](viewer-lifetime.md), [addressed crop](viewer-crop.md),
[capability gates](capabilities.md), [transport seam](renderer-seam.md) and
[successful-write metrics](graphics-memory.md) are unchanged. Same-ID PNG replay
restores all retained inline prototypes and only the live private prototype.
No shared pixel/global deletion, second private slot or eviction is introduced.
Successful private retirement conservatively ends PNG upload-reuse trust for that
image ID, including payloads shared with inline previews. The next actual native
preparation can retransmit its cached exact PNG and restore all retained inline
prototypes plus only the live private prototype. This does not add PDF raster work,
change current-page pan/zoom reuse, acknowledge terminal residency or free pixels;
see the [blank-page recovery record](pdf-blank-recovery.md).
**150 ms idle after deferred first-own component receipt, wheel expiry disabled**
remains approved; receipt is not terminal display completion.

Provider scratch/derived-page references do not form a navigation history cache.
Native normalized PNGs, identities and residency inventory **can grow with every
distinct rendered page**. One runner/slot is not constant total heap/GPU usage.
Identical normalized bytes deduplicate; original immutability does not promise
byte-identical later-page rasters across Poppler/font/platform versions.

## Subprocess and cleanup boundaries

Production requires both `pdfinfo` and `pdftoppm` on PATH. Async argument arrays,
`shell: false`, child-only `LC_ALL=C`/`LANG=C`, **30,000 ms** default timeout and
**65,536 bytes combined stdout/stderr** bound apply. Metadata requires exactly one
anchored positive safe-integer `Pages:` field and successful exit. Exact raster:

```text
pdftoppm -f P -l P -singlefile -png -scale-to 1200 CAPTURED_PDF PRIVATE_PREFIX
```

Native dimensions come from actual PNG output, not PDF point arithmetic (real
Poppler can round a short side by one pixel). Unreadable/invalid/password-required
PDFs fail without password storage/input. Errors are sanitized, not raw metadata
or source bytes. Abort/timeout/output overflow kills the direct child and awaits
actual close/output drain before rejecting/removing scratch or starting successor
work; injected collaborators must honor those same drain semantics.

Directories are private 0700; captured/materialized PDFs and acquired page PNGs
are 0600. Orderly shutdown/replacement drains users before removal. Abrupt kill
cannot run JavaScript cleanup and may orphan OS-temporary files. No unreviewed
cross-runtime startup sweeper, secure-erasure promise or arbitrary descendant
process-tree sandbox is provided. Terminal resources remain subject to existing
scrollback retention, not PDF scratch deletion.

## Automated evidence and reproduction

Final stable **0.5.0 automated gates passed**, reported by the acceptance worker
and accepted by the coordinator for final documentation. Environment: Pi **1.0.3**,
Node **24.21.0**, Linux and PATH Poppler **26.06.0**. These are automated receipts,
not owner activation or human acceptance.

| Final gate | Total | Passed | Skipped | Failed/cancelled | Test duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| Portable `npm test` | 279 | 245 | 34 optional host | 0/0 | 1.6210 s |
| Host-enabled `npm test` (both host variables) | 292 | 292 | 0 | 0/0 | 10.5219 s |
| Standalone SDK | 12 | 12 | 0 | 0/0 | 9.9265 s |
| Standalone viewer + deterministic public TUI | 23 | 23 | 0 | 0/0 | 128.2019 s |
| Standalone PDF, full corrected rerun | 15 | 15 | 0 | 0/0 | 28.5847 s |
| PDF without host | 1 | 0 | 1 optional parent | 0/0 | 0.0644 s |
| Explicit isolated install/discovery/loading | — | PASS | — | 0 errors | Bounded installer |

All completed final gates exited 0. Durations are Node test-runner elapsed time,
not interactive latency/FPS or memory measurements. Portable/full-host checks
were rerun after the metadata-only version bump; only those 0.5.0 runs are final
0.5.0 evidence. The first final PDF run had **15 total, 12 passed, 3 failed**:
two harness oracles and their parent (invocation scroll baseline recorded before
inline layout settled; regular unchanged explanatory chrome omitted by a
differential-frame oracle). Corrections
retained identity/storage/model assertions, and the **entire PDF suite** was
rerun successfully; the failed run itself is not called acceptance.

Independent production safety review passed on the exact bytes below; native,
presentation, pure pacer, viewport and capability production sources are unchanged.
The live-Map/await reconciliation race was fixed with the persisted actual-loader
held-discard/later-submission regression.

| Production file | SHA-256 |
| --- | --- |
| `src/pdf-document.mjs` | `a2f334b2fe5b04e5b79b1a6a5b2fa5ca33375d48c2fed447a0a9fa849c1e168b` |
| `src/pdf.mjs` | `7ca03e37b75bfbd069963c1cf596894dff02850c890e090f8e69cb96171427bf` |
| `extensions/tmux-image/index.ts` | `8984e42fe9e22d648b09365e5e4ae713ec2891a6efb55df7dd8be792f5725d83` |
| `src/viewer.mjs` | `af30040bc476e6854892f84fa9cadc7f6c5a65935772bbbb254567bdc46e2d74` |

Final package manifest SHA-256:
`44baed8dfb0d49fb2c51c8f3c49153ee101065564e1c91d2d9c5527530887e4c`.
Standalone test SHA-256 prefixes: SDK `ed76ec0eb39a`, viewer `1ce49af9d20d`,
PDF `f407c093b729`. These identify checked source bytes, not a disk/display ACK.

Reviewer command with installed public host root:

```sh
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-package \
  node --test test/pdf-import.test.mjs test/pdf.test.mjs \
  test/pdf-document.test.mjs test/viewer-pdf.test.mjs test/viewer.test.mjs
```

Reviewer result: **87/87 passed, zero failures/cancellations/skips, 9.125 s**.
This focused scope is separate from the final standalone/full gates. Phase A
public-host/real-Poppler feasibility experiments are separate again, not packaged
repository tests or production acceptance by themselves.

Persisted coverage is organized as follows; rerun rather than promote old totals:

| Tests | Evidence scope |
| --- | --- |
| `pdf.test.mjs`, `pdf-document.test.mjs` | Strict/safe-preview schemas, threshold/consent, streaming capture/races, Keep faults/hash/base64 validation, canonical page1, Temporary consumers/runtime ownership, real multipage/rotation/color PNG oracles, child abort/timeout/output drain/private cleanup |
| `viewer-pdf.test.mjs` | Latest targets/jump/tiny panes/fit/resize, identical-payload generation guards, held provider/native work, no-caller removal-before-delete/rebind, failed frame/write retry, proof loss, close/focus/upper modal ownership |
| `pdf-import.test.mjs` (optional host) | Production loader/public read, threshold choices, zero-entry pre-send failure, details-only originals/model conversion, deferred tool ordering/error boundary, all-history Temporary ownership, fallback and lifecycle |
| `host-integration.mjs` | Isolated install/loading, sequential tools, both actual converted request policies, capability/no-graphics/pre-source gates, replay/refresh/stats and unchanged entries |
| `host-viewer-integration.mjs` | Existing ordinary-image/explicit legacy PDF controls, mouse/pacing/ownership/model regressions |
| `host-pdf-integration.mjs` | Production public SDK/InteractiveMode PDF storage/navigation/restoration matrix, genuine encrypted-source rejection, exact PNG/page identities, unchanged entries/conversion and scoped transition ordering |

Reproduction commands (installed host root must contain public `dist/index.js`
and its own pi-tui peer; do not install physical host dependencies into the repo):

```sh
npm test
node --test test/pdf.test.mjs test/pdf-document.test.mjs test/viewer-pdf.test.mjs
HOST=/path/to/installed/pi-package
PI_OFFLINE=1 PI_TEST_HOST_ROOT="$HOST" \
  PI_IMAGE_HOST_MODULE="file://$HOST/dist/index.js" npm test
PI_OFFLINE=1 PI_TEST_HOST_ROOT="$HOST" node --test test/pdf-import.test.mjs
PI_OFFLINE=1 PI_TEST_HOST_ROOT="$HOST" node --test test/host-integration.mjs
PI_OFFLINE=1 PI_TEST_HOST_ROOT="$HOST" node --test test/host-viewer-integration.mjs
PI_OFFLINE=1 PI_TEST_HOST_ROOT="$HOST" node --test test/host-pdf-integration.mjs
env -u PI_TEST_HOST_ROOT -u PI_IMAGE_HOST_MODULE -u PI_PDF_ACCEPTANCE_CHILD \
  node --test test/host-pdf-integration.mjs
git diff --check
```

Standalone host suites are not discovered by `npm test`. Host/Poppler-dependent
cases can skip when unavailable; a skipped case is not coverage. The optional new
PDF harness uses Linux/Node **24.21.0** `process.execve` wrappers to target real
Poppler directly for cancellation; that optional harness/API/platform compatibility
is not a new production Node pin or a guarantee for every Node/OS build.
Install/discovery verification passed with **pi-tmux-image 0.5.0**, exactly one
loaded extension, zero loading errors, all five commands, both sequential path
tools and the message renderer. It used the installed public CLI's
`pi install <checkout>` (the local-checkout equivalent of `pi install .`) only in a
temporary `PI_CODING_AGENT_DIR`, temporary HOME and offline/minimal environment,
with public resource loading and no session/model started. The three standalone
suites also performed isolated installation/loading. Node syntax and
`git diff --check` passed. Capture terminals,
PATH-resolved fake tmux and offline fake model runtime avoid active server queries,
configuration changes, physical graphics or real providers. Generated PDFs/PNGs
and session fixtures stay outside Git and are cleaned in test finally blocks;
raw logs remain external coordination artifacts, not package content.

Phase A additionally established retained source/parent-independent reload and
fresh-child-process fork/branch/copy restore, exact captured bytes/hash and real
later-page PNG, normal unsaved/in-memory policy, actual selector/key delivery in
both InteractiveMode modes and the void/deferred publication failure boundary.
Delivered production restoration/threshold/integration evidence must be reported
separately; feasibility scripts and machine-local results are not packaged APIs.

### Human-pending matrix

No new PDF human appearance/responsiveness result is inferred from earlier general
image/viewer/pacing acceptance, capture streams, actual raster pixel oracles or
component receipts. Coordinate activation/reload, then check:

- First-page-only transcript, correct labelled portrait/landscape/rotated pages,
  next/previous/jump and rapid latest-target convergence.
- Fit/reset on page change/revisit; resize, tiny-to-usable targets, wheel/drag/
  keyboard resumption and truthful loading/error chrome.
- Escape during actual rendering, Escape field-only jump cancellation, new host
  search/modal, tmux zoom/window switching, continued conversation and scrolling.
- Close preserving page-one inline/other images, selection/links; regular-mode
  physical terminal scrollback (no public Pi viewport restore/query).
- Large Keep/Temporary/Cancel responsiveness, retained resume after source deletion,
  Temporary close/reopen/refresh then reload with unavailable-original explanation.

No terminal ACK, pixel atomicity, latency/FPS, universal reconnect or global/GPU
memory bound is established. OOM/disk-full/partial persistence and arbitrary hostile
PDF behavior remain unverified. Password-required rejection now has a persisted
passing `host-pdf-integration.mjs` production slash/tool regression: an independently
generated genuine encrypted fixture is positively validated with real Poppler
using its disposable test password, then rejected unauthenticated with zero
preview entries/graphics/password storage. This does not add product password UI
or promise support for all encryption variants.

## Compatibility and rollback

Ordinary images and supported `native-v1`/unversioned snapshots are unchanged.
Old two-page PDF sessions stay separate image entries with existing labels: do
not group filenames, invent original retention/page counts, reread paths or rewrite
history. Invalid document metadata with safe preview fields falls back preview-only;
unknown schemas use readable text without path access.

A **0.4.2 binary does not understand `pdf-v1`**: its local renderer shows
`[Image: unsupported display schema]`, rather than promising forward PDF browsing.
Stored standard preview/model policy and embedded originals remain in the session.
Rollback only coordinated feature changes; preserve unrelated work and coordinate
reload. Code rollback does **not** remove originals from JSONL/export/fork/backup
copies or reclaim prior-runtime terminal pixels. Temporary originals are
intentionally not restart-recoverable. No automatic rewrite, deletion, blind send
retry, graphics budgeting, source live reload, PDF text/search/password UI or host
fork is part of this feature.
