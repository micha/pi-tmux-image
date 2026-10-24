# Handoff: self-contained PDF previews and viewer pagination

## 1. Status, authority and next action

**Documentation-only design checkpoint.** The owner requested a review and a
written handoff after agreeing the behavior below. This checkpoint does not
implement pagination, activate/reload the package, bump its version, change
settings, or authorize graphics budgeting. Obtain an explicit implementation
proceed before starting the phases.

Reviewed checkout: **`5f5c59b`**, package **0.4.2**, tested host API **Pi 1.0.3**.
Discover dependencies from the current environment; installed-host paths and
historical temporary fixtures are not prerequisites. Current production still
shows the first two PDF pages as independent image messages.

This plan supersedes earlier plans' two-page-default/no-pagination/no-PDF-work
restrictions **only for the proposed PDF-document feature**. Until implemented,
those documents correctly describe production. All image behavior, native
ownership, policy gates, approved pacing and disabled budgeting remain in force.
The new exception is rasterization of a requested PDF page from an immutable
captured document, never rereading its original path during viewing.

First next-session actions:

1. Read `AGENTS.md`, inspect Git state and preserve unrelated work.
2. Read this plan and its relevant linked contracts below.
3. Confirm implementation authorization; complete Phase A's feasibility gates.
4. Agree the schema/provider/page-transition interfaces before delegating edits.

Required reference contracts:

- [implementation-plan.md](implementation-plan.md),
  [pixel-normalization.md](pixel-normalization.md),
  [capabilities.md](capabilities.md),
  [renderer-seam.md](renderer-seam.md),
  [kitty-protocol.md](kitty-protocol.md),
  [graphics-memory.md](graphics-memory.md).
- [image-viewer-plan.md](image-viewer-plan.md),
  [viewer-seam.md](viewer-seam.md), [viewer-crop.md](viewer-crop.md),
  [viewer-lifetime.md](viewer-lifetime.md),
  [viewer-mouse.md](viewer-mouse.md).
- [viewer-performance.md](viewer-performance.md),
  [viewer-pacing-design.md](viewer-pacing-design.md),
  [viewer-pacing.md](viewer-pacing.md). The historical pacing handoff/profile
  remain relevant if investigating hot paths; do not tune pacing as PDF scope.
- [verification.md](verification.md),
  [viewer-verification.md](viewer-verification.md) for evidence boundaries.

## 2. Owner-agreed behavior

### Conversation, model access and selection

- `/tmux-pdf` and `tmux_show_pdf` retain their names and required path semantics,
  but new imports create **one PDF conversation entry, displaying page 1 only**.
- Page 1 remains standard Pi image content acquired through the public image-read
  pipeline. Its label identifies the document and `Page 1 of N`.
- Clicking ready preview cells opens the existing in-pane viewer on page 1.
  `/tmux-image-view` lists one document entry per new PDF occurrence, newest first.
- The immutable original PDF is embedded in that same entry's `details` when
  retained. It is not model-facing content. Only the preview participates in
  Pi's existing image/model conversion and `images.blockImages` policy.
- Opening, pagination, zoom/pan, resize, close and refresh add **no messages,
  entries, attachments or model requests** and never alter stored content.
- Ordinary images keep their existing source-independent attachment snapshots.
  Exact-original image-file preservation is not requested.

### Size and retention choice

- The threshold is **32 MiB = 33,554,432 original PDF bytes**.
- At or below the threshold, retain the original PDF normally, without a prompt.
- Above it, the user chooses **Keep / Temporary / Cancel**. This applies to both
  the slash command and model-callable tool; the assistant cannot make the choice.
- Keep embeds the complete original bytes. Temporary persists only page 1 and
  metadata; an immutable runtime-only document supports browsing until reload or
  session-runtime replacement. Cancel produces no display entry or retained asset.
- No fixed application PDF-size ceiling and no post-hoc excision/disable command.
  Allocation/string/JSON/storage limits and bounded subprocess timeouts still
  exist; consent is not a promise that arbitrarily large imports succeed.
  Pi's JSON serialization/persistence/loading can be synchronous and costly for
  large entries. Async capture/Poppler does not make those host operations
  interruptible; explain Temporary as the alternative, not a cure for Keep's
  entire memory/latency cost.
- Cancellation, an unavailable selector, or an invalid selector result never
  defaults to Keep. Do not silently switch a failed Keep import to Temporary.

### Viewer controls

| Input | Result |
| --- | --- |
| `n` / PageDown | Next page |
| `p` / PageUp | Previous page |
| `g` | Enter a 1-based page number inside the existing viewer |
| Enter during jump entry | Validate and request that page |
| Escape during jump entry | Cancel jump entry, not the viewer |
| Escape otherwise | Close viewer |

- Show `Page P of N`; do not wrap at either end. Invalid jumps show a readable
  inline error and leave the number editable.
- **Every actual page change fits and recenters**, including revisits and jumps.
  Ordinary resize preserves/clamps the current page's zoom/center as today.
- Existing `+/-`, `0`, `hjkl`, fullscreen wheel zoom and grab-to-pan stay unchanged.
  Pagination and jump entry remain usable in the small-pane text fallback and in
  regular mode. Other keys never reach the hidden editor.
- Temporary documents lose full-document browsing after reload/resume. Their
  preview stays usable and explains that the original PDF was not retained;
  there is no dangling path, automatic source reread or misleading loading loop.

## 3. Review findings and exact implementation boundaries

### Current source

| File | Current behavior / consequence |
| --- | --- |
| `src/pdf.mjs` | `withPdfPages` runs synchronous `execFileSync(pdftoppm)` for pages 1–2 at a 1200-pixel longest side, visits scratch PNGs, then removes scratch. Cannot be reused unchanged for responsive, cancellable pagination. |
| `extensions/tmux-image/index.ts` | `showPdf` calls `showImage` once per raster page. `showImage` validates normalization before `sendMessage`, preserving `triggerTurn: false`. `storedSnapshots` indexes image attachments, not documents. |
| `src/native.mjs` | `readNativeDetails` accepts only `pi-tmux-image/native-v1` and returns selected fields. Native owns immutable normalization, payload IDs, the shared queue, one private viewer slot and one retirement obligation. |
| `src/viewer.mjs` | `select` selects once per overlay token; `close` releases replay before owned removal/drain/retirement. Desired/sample keys presently describe geometry within a fixed payload/lease; they are not sufficient across page changes. Page hints currently parse labels. |
| `src/presentation.mjs` | `commit` synchronously checks epoch/signal/prepared validity, invokes `onUploadStarted`, writes and commits. `component` is an inline occurrence/geometry history cache, not a page-navigation cache. |
| `test/host-integration.mjs`, `test/host-viewer-integration.mjs` | Assert the two-page default and no further Poppler work during snapshot viewing. Update only those assumptions intentionally superseded by this feature; keep old-session/image regressions. |

### Verified installed Pi boundaries

The installed complete `docs/extensions.md`, `sdk.md`, `session-format.md`,
`sessions.md`, `message-types.md`, `tui.md` and `keybindings.md`, plus shipped
`entry-renderer.ts` and `examples/sdk/11-sessions.ts`, supplied primary evidence.
Relevant public declarations and shipped implementations were inspected read-only:

- Custom-message `details` and custom-entry `data` accept extension JSON.
  Custom-message details are not included in its model-converted user message.
  A PDF base64 string in details needs no private host import or custom provider.
- `ctx.ui.select(title, options, { signal? })` returns a string or `undefined`;
  use this public three-choice selector during import. Pagination's `g` field
  stays inside the owned viewer, not `ctx.ui.input/select/custom`, which could
  transfer focus and close it.
- Sessions are append-only trees. Compaction and context edits do not erase raw
  PDF bytes. No public session-deletion event was found in this version.
- Interactive deletion tries `trash`, then unlinks the JSONL. Embedded bytes
  travel with that file; trash, backups and exported/forked copies remain copies.
- Branch cloning copies the selected path's entries; `forkFrom` copies non-header
  history. A self-contained preview entry needs no ancestor session's asset file.
- Pi may keep a new session in memory until it contains a user/assistant message.
  Respect that host persistence policy and `--no-session`; do not force a file
  flush or promise restart recovery for an unsaved/ephemeral session.
- Fullscreen source defers PageUp/PageDown to a focused non-search overlay before
  transcript paging. Search remains a global pre-routing/focus-loss boundary.
  This is source evidence, not new actual-host pagination acceptance.
- Raw JSONL contains details. The HTML exporter also embeds serialized session
  data. Warn that the **full retained PDF**, including never-viewed pages, may
  travel in exports/shares; do not equate model blocking with storage privacy.

Local read-only `pdftoppm -h` / `pdfinfo -h` verified Poppler 26.06.0 supports
single-page rasterization and page-count inspection. Proposed runtime now needs
**both `pdfinfo` and `pdftoppm` on PATH**. Verify the exact invocation/parsing with
real generated PDFs in Phase A; do not depend on this machine's executable paths.

### Review conclusion

The design is feasible without a host fork or external durable asset store.
The substantial work is single-entry import publication, asynchronous document
access,
page-generation cancellation and safe cross-payload slot rebinding. It is not
merely additional keys. Large JSONL persistence/load performance and physical
page-transition appearance remain unverified for this feature.

## 4. Proposed session representation and compatibility

**Recommended implementation choice, not an already exported API:** introduce a
separate `PDF_SCHEMA = "pi-tmux-image/pdf-v1"` while leaving `NATIVE_SCHEMA` and
legacy image readers unchanged. Keep the existing message custom type and teach
its renderer/index to discriminate validated image versus document records.
A shared preview descriptor can supply the existing inline native path.

Illustrative retained details:

```js
{
  schema: "pi-tmux-image/pdf-v1",
  occurrence: "<fresh logical occurrence>",
  label: "<sanitized original document label>",
  geometry: { columns, rows, cellWidthPx, cellHeightPx }, // preview geometry
  document: {
    mimeType: "application/pdf",
    retention: "keep", // or "temporary"
    byteLength: originalByteLength,
    sha256: "<hash of exact captured PDF bytes>",
    pageCount,
    previewPage: 1,
    render: { longestSide: 1200 },
    data: "<canonical base64>" // ONLY for keep
  }
}
```

The entry's `content` contains preview text and one standard image attachment,
not PDF bytes or terminal commands. Temporary records omit `document.data`
entirely. They do not persist a scratch pathname, file descriptor or runtime
availability flag. The label/path is provenance only, never a source locator.

Validation and identity rules:

- Validate schema, sanitized label, occurrence, ordinary preview geometry,
  positive safe-integer byte length/page count, preview page 1, supported render
  parameters and retention enum. Enforce `data` presence/absence by retention.
- Perform full base64/length/hash verification once on document materialization,
  outside rendering/input/picker scans. Decode/write in chunks if practical;
  reject malformed/truncated data and mismatched hashes before Poppler.
- An entry/occurrence identifies a document occurrence; its content hash identifies
  captured source bytes. Page identity is occurrence + PDF hash + page number +
  raster parameters. Native payload identity remains **exact normalized PNG bytes**,
  not the PDF hash or a pathname. Two identical-looking pages may share PNG pixels.
- Every admitted sample, ready/drawn frame and final commit guard carries the
  exact page generation/key and lease, in addition to epoch/layout/canvas/window.
  Same dimensions or PNG payload cannot revive stale page work.
- Persist original bytes only once in the preview details. Tool result details
  carry compact path/count/retention/size summaries, never the PDF or duplicate
  preview bytes. Do not append a separate durable asset entry.
- Index cheaply from the active branch, retaining references to immutable strings;
  do not `structuredClone`, hash, decode or normalize a PDF on each picker/render.
- Unknown/invalid PDF schemas must not cause file access or a renderer crash.
  Prefer a readable preview-only fallback when its standard image/preview fields
  are safe; otherwise a text error. Never mutate stored entries to repair them.

Old `native-v1` / supported unversioned messages remain image snapshots. Old PDF
pages stay separate picker entries with existing labels and no invented full-PDF
navigation. Do not group them by filename, fabricate page counts, reread paths,
rewrite history or infer that their original document was retained.

## 5. Import transaction and retention ownership

Introduce a host-import-free document service, for example `src/pdf-document.mjs`,
and asynchronous subprocess helpers in `src/pdf.mjs`. Names may change after the
interface gate. The viewer receives document/page access through injection, not
filesystem/source-path logic. Avoid making native own original PDF bytes.

### Import sequence

1. Reserve one import interaction in the current session runtime and capture its
   generation. Gate interactive tmux/public policy/capability **before stat/open**.
   Combine tool cancellation, when present, with an import-owned runtime signal.
   Slash commands need cancellation on shutdown/reload too; do not rely on a
   captured `ctx.signal` from an unrelated agent operation.
2. Open/fstat the source, require a supported regular file and obtain size. Above
   the threshold, show the user size and approximate base64 storage (`4*ceil(n/3)`)
   plus preview/metadata overhead, retention consequences and the three choices.
   At exactly 32 MiB no prompt; one byte above it prompts. No persistence on cancel.
3. After the decision, capture a private immutable snapshot to a temporary file
   using asynchronous streaming; hash/count the exact copied bytes. Do not load
   an entire large PDF into a Buffer just to offer Temporary. Bound concurrent
   work, not file size. Avoid retaining multiple full decoded/base64 copies.
4. Reconcile source-change races. Recheck size/metadata; if an initially small
   source becomes large, obtain consent before publication. A changed large size
   must not bypass an approval for the earlier size. Prefer failing/retrying a
   detected concurrent source write over silently accepting it. Stat checks cannot
   prove an atomic source snapshot under every writer: the final captured bytes,
   not the original pathname, are the authoritative document.
5. Invoke bounded asynchronous `pdfinfo` against that snapshot, with a stable
   subprocess locale, small stdout/stderr limits and validated page-count parsing.
   Validate by Poppler, not extension or `%PDF` magic alone. Reject malformed,
   unreadable/password-required documents without a partial display entry. Do
   not add password persistence/input scope in this feature.
6. Rasterize **page 1 only**, longest side 1200, from the same snapshot. Acquire
   its standard image through public `createReadTool`; validate with existing
   `native.describe` and unchanged image normalization bounds before publication.
   Extract a prepare-image helper rather than sending via `showImage` early.
7. For Keep, encode the captured PDF for session details, with explicit errors
   for allocation/encoding/storage failure. For Temporary, register only its
   runtime snapshot under session-runtime identity + occurrence. Finish all
   preparation and recheck cancellation, generation and capability before sending.
8. Send exactly one preview message with `triggerTurn: false`; preserve sequential
   tool execution and tool-result-before-display ordering. Commit temporary
   ownership only for the matching successfully published occurrence; rollback on
   failure. Return a truthful compact summary indicating retention and page count.
9. Remove initial PNG scratch and untransferred PDF snapshots on all exit paths.
   Never claim successful durable storage if the public send/persistence operation
   throws. Pi's send operation is not an extension-controlled atomic disk transaction;
   test/report its failure boundary rather than promising crash-proof persistence.
   A host failure may follow an in-memory append or partial disk write. Do not
   rewrite history to roll it back or blindly retry and duplicate the preview;
   report the failure and reconcile ownership against the actual occurrence.

The selector is import UI, not viewer UI. Refuse competing import selectors;
never use a modal to displace a live viewer as an accidental control path. A
model-invoked Cancel should be an explicit cancelled/failed operation with zero
preview entries, not success text claiming display. The enclosing ordinary agent
turn may continue; cancellation is not permission for an extension-added turn.

### Temporary and scratch lifetime

- Temporary copies belong to the **session runtime**, not the viewer lease. They
  survive viewer close/reopen, branch navigation within that runtime and explicit
  image refresh. Only active-branch occurrences can be selected.
- Reload, shutdown, new/resume/fork/clone replacement or process termination makes
  that runtime's full-document access unavailable. Orderly shutdown aborts/drains
  users before deleting copies. A forked preview must not reuse a parent runtime's
  temporary registry accidentally.
- Keep documents may be materialized lazily to a private temporary file for an
  open viewer; release it after consumers drain. Reopening may rematerialize from
  embedded bytes. This is disposable scratch, not a persistent sidecar store.
- Create private directories/files with restrictive permissions. Use argument
  arrays, PATH resolution, timeouts, output limits and abort-aware child killing.
  Await actual child exit before scratch removal/rebind; no `Promise.race` that
  leaves hidden subprocesses alive. No source paths/bytes in diagnostic logs.
- Abrupt process kill cannot run JavaScript cleanup. Document possible orphaned
  OS-temporary files; do not claim secure erasure or add an unreviewed startup
  sweeper over other runtimes' directories. Session deletion owns embedded bytes,
  not automatic cancellation of an already-live runtime holding a copy.

## 6. Page provider, work bounds and resource honesty

Proposed injected interface:

```js
// All results tied to the current document/session runtime and caller signal.
openDocument(descriptor, { signal }) -> documentHandle
pageAttachment(documentHandle, pageNumber, { signal }) -> ImageContent
releaseDocument(documentHandle) -> Promise<void>
```

- `openDocument` should create a cheap descriptor/handle, not decode a huge PDF
  eagerly. Materialize/validate the original only for a later-page request. A
  temporary-unavailable handle must still permit page-one snapshot viewing.
- Page 1 always returns the canonical stored preview attachment; do not rerasterize
  it on open, refresh or revisit. This preserves exact snapshot/model identity.
- Later pages use the immutable materialized PDF and an asynchronous
  `pdftoppm -f P -l P -singlefile -png -scale-to 1200 ...` candidate invocation,
  verified in Phase A. Read/validate the generated PNG through the normal public
  image pipeline and remove page scratch after attachment acquisition.
- Initially no eager all-page rendering, adjacent-page prefetch, resolution
  escalation or persisted derived-page cache. One actual page runner plus one
  latest requested page; replace obsolete intent, abort/drain obsolete child
  work, and only then launch its successor. Never create a promise per raw key.
- Provider scratch/derived-page references should not grow with navigation. Native
  already retains normalized snapshots and payload identity/residency inventory;
  **that existing retention may grow for each distinct rendered page**. Do not
  claim constant total heap/GPU usage or introduce native eviction to make the
  provider look bounded. Revisits deduplicate only when normalized PNG bytes match.
- Re-rendering later pages after restart can differ across Poppler/fonts/platform
  versions. Original PDF bytes are immutable; derived rasters are not promised
  byte-identical across render environments. Page 1 remains its stored snapshot.
- Resident pan/zoom does not rerasterize. Ordinary viewport resize does not create
  a new PDF render request. Source-free refresh retains current contracts; a new
  later-page request is the only reason for new page rasterization.

## 7. Viewer page-transition state machine

Recommended controller-local records, **not an existing API**:

```text
selected document descriptor / open document handle
requestedPage                 latest canonical page target
shownPage                     committed/rendered page, or absent
pageGeneration                identity distinct from layout/work generation
pageController / pageRunner   one actual abortable transition
jump                          one bounded editable numeric field
lease / payload / pacer       existing current page's native/viewport ownership
```

A single overlay token/owned handle stays mounted through pagination. Separate
its lifetime from page leases: reusing `close()` then reopening would settle the
interaction, risk focus/draft changes and discard temporary handles. Extract
shared scoped drain/retirement logic carefully instead.

### Input collection and jump mode

- Reduce next/previous against **requestedPage**, not the last shown page, so
  `n,n,p` remains a sequential clamped page target even while loading. Latest
  intent wins; intermediate pages need not be rendered. Re-requesting a ready
  current page is a no-op, not fit reset or a new attachment.
- Recognize pagination before the `viewInput`/usable-pane early return. A tiny
  pane can change the page target; defer new rasterization/native preparation
  until graphics are usable. Preserve the target when the pane grows.
- Handle jump mode before ordinary digit `0`/zoom/pan parsing. Bound its text to
  the decimal page-count length; accept digits/backspace with public key parsing,
  validate range/integer on Enter, and retain editable error state. Ignore
  paste/unsupported control reports safely rather than interpreting arbitrary
  terminal escape strings as numbers. A public embedded Input is an option;
  it must not refocus the raw overlay root or create another modal.
- Entering jump mode cancels drag/queued wheel, but does not secretly reset the
  shown viewport. Mouse events are consumed without image gestures while editing.
  Escape cancels the field only. `n/p` inside the field do not paginate.
- On an actual page change, clear old gestures, old page readiness and viewport
  intent; reset canonical fit/center. While loading/removal/retirement, image
  gestures are non-admitting; viewport keys do not queue actions against an
  unknown page. Pagination and Escape remain active.

### Ordered cross-page transition

1. Synchronously increment page generation, cancel the old pacer/deferred
   receipts, clear ready/drawn/drag/wheel state, abort its prepare/page work and
   call `native.releaseViewer(oldLease)` to revoke private replay. Do not lose
   the current native cleanup obligation.
2. Outside synchronous input/render/focus callbacks, await old selection/native
   runner and any page child drain. Produce a loading-only overlay frame that
   contains **no old private placeholder cells**.
3. Reuse the existing guarded retirement path: public `renderNow()` removal flush
   before nonempty scoped deletion, pre/post capability checks, synchronous final
   epoch/lifetime commit. Retain/retry the obligation after frame/write/denial
   failure; every retry must reflush. No global/pixel delete and no new slot.
4. Only after retirement/drain succeeds, re-evaluate latest requestedPage/current
   document/runtime. Obtain its attachment, with capability gating before PDF
   materialization/rasterization and after preparation. A superseded page cannot
   reserve the slot, publish labels/cells or repaint a newer page.
5. Resolve its native payload, reserve the same fixed private slot with a stable
   occurrence/page identity, install fit/center and create a fresh page-specific
   scheduling generation. Use existing pacing admission for the first viewport
   prepare; do not issue writes directly from the page runner.
6. Final prepare/commit checks include exact page generation/key, document identity,
   lease, epoch, policy and live layout, in addition to canonical geometry. Publish
   ready cells promptly after successful commit and await the normal first-own
   component receipt. Old page receipts are inert even when dimensions match.

No second native slot or parallel page pipeline is proposed. Prefer the simple
serialized transition first; overlapping target rendering with retirement is not
required and needs independent review if later justified.

Keep **150 ms idle after deferred first-own component receipt, wheel expiry
disabled**. The pure pacer owns no page/source work. Lifecycle page rebinding
starts a new generation, not a change to the viewport cadence. Coalesce page-key
bursts before heavy work;
do not introduce a page animation timer, historical page queue or receipt timeout.

Failure/close rules:

- Loading chrome shows `Loading page P of N`, not a false claim that P's pixels
  are ready. Error chrome identifies the requested page. Ready chrome derives
  from its own page/frame, never a newer request.
- A failed page stays suppressed rather than retrying on every render. A new
  deliberate page request may recover; refresh retains its current close/recovery
  semantics. If cleanup is unresolved, block new binding rather than leaking IDs.
- Escape/focus loss/branch/session/widget/refresh closes immediately at the
  logical boundary: abort page/import work as applicable, revoke replay and cancel
  scheduling before deferred scoped cleanup. Close awaits both page and native
  drain without permitting stale reservations after closure.
- Old transition `finally`, focus/dispose callbacks and promise completions must
  check identity before clearing a newer runner/lease/error. Close during a
  transition still settles once and preserves unrelated upper modal ownership.
- Unavailable Temporary originals still allow page-one snapshot zoom/pan. Explain
  that pagination is unavailable; never probe the old path or fake new pages.

## 8. Phased implementation and file ownership

### Phase A — public-host/storage/subprocess feasibility

Before production changes, build focused disposable/offline evidence:

- Persist a small retained preview entry with public session APIs, reload and
  open it after deleting the original. Copy/fork its branch and delete the
  parent's JSONL; verify exact PDF bytes/hash and preview survive independently.
- Exercise the three-choice selector through actual InteractiveMode in both
  modes, including tool cancellation, background fake streaming, reload/session
  replacement and undefined selection. Confirm no accidental viewer focus steal.
- Verify raw/Kitty keyboard reports for PageUp/PageDown, `n/p/g`, digits,
  backspace and Escape through real installed terminal input dispatch. Do not
  assume a label or matcher string establishes key delivery.
- Test real `pdfinfo` count parsing and exact single-page Poppler output with
  labelled 1/2/3-page, mixed-size/rotated and invalid/password-required documents.
  PATH lookup errors for both executables must be actionable and clean.
- Test an inert valid PDF just below/at/above 32 MiB, plus a modest larger sample;
  record persist/load/fork wall time and peak-memory evidence where available.
  Do not call measurements a universal safe-size limit or benchmark tiny mocks
  as large-document acceptance. Include Keep encoding failure and Temporary's
  streaming path. Generate fixtures in scratch, not Git.
- Stop/report any public persistence/input/lifetime blocker rather than adding
  private host imports, a session rewrite, stdout patch or hidden size ceiling.

### Phase B — schema and immutable document service

Suggested ownership: new `src/pdf-document.mjs`, schema/provider tests and
`src/pdf.mjs` / `test/pdf.test.mjs` by one worker; interface reviewed first.

Implement validated document descriptors, streamed source capture, hash/length
checks, retained materialization, temporary registry ownership, async bounded
metadata/raster subprocesses and idempotent abort/drain/cleanup. Keep helpers
host-import-free using injected image acquisition/runner seams. Do not alter
native graphics or persist pages through a helper side effect.

### Phase C — import and active-branch integration

Suggested ownership: `extensions/tmux-image/index.ts` and focused import/index
coverage by one worker, disjoint from the viewer owner.

Split acquire/validate from send, integrate threshold selector and single-entry
publication, add compact tool summaries/descriptions, runtime service shutdown,
PDF/image schema discrimination, structured page labels and active-branch indexing.
Keep ordinary image behavior and known legacy migration intact. No persistence
bytes in tool updates/results, notifications or model-facing preview text.

### Phase D — controller pagination and safe lease rebinding

Suggested ownership: `src/viewer.mjs` / `test/viewer.test.mjs` by one worker.

Implement latest page target, generation-specific work, embedded jump field,
small-pane pagination, loading/error/temporary-unavailable chrome and ordered
release/removal/retirement/reserve. Preserve passive render, viewport pacing,
mouse mapping and existing lifetime behavior. Native/presentation APIs should
remain unchanged unless a narrow reviewed blocker demonstrates otherwise.
`src/viewer-pacing.mjs` is not a page scheduler and should not gain page state.

### Phase E — integration, docs and delivery

Separate verification owner: extend `test/host-integration.mjs`,
`test/host-viewer-integration.mjs` and focused actual-host seam cases; add a
standalone PDF integration harness if existing tests become unwieldy.

Update README only once implemented: first-page preview, requirements for both
Poppler executables, retention choices, size/storage costs, privacy, controls,
temporary loss and existing terminal-memory limitations. Reconcile `AGENTS.md`
contracts/code map for the delivered scope; annotate historical records without
rewriting their acceptance evidence. Package version/release choice belongs to
the implementation coordinator, not this checkpoint.

If delegating, follow current `AGENTS.md` role/model policy and workmux named tabs.
Inspect exact properly spaced prompts, agree interfaces, assign disjoint files
and say thank you when a worker is safe to close. The coordinator owns integrated
review, full tests and local commits. This planning checkpoint spawned no workers.

## 9. Required automated acceptance

| Area | Required evidence |
| --- | --- |
| Threshold/selector | Below/at threshold no dialog; above threshold all three choices; undefined/abort/invalid results never Keep; no source access before capability denial; changed source size cannot bypass consent. |
| Single-entry import | One PDF message/one preview image, exact source hash/count/retention, one copy of PDF bytes in details only; no entry on cancel or pre-publication failure; injected host send/persistence failure is explicit and never blindly retried; tool ordering/sequential execution preserved. |
| Restoration | Retained bytes work after original edit/delete, reload and fresh process resume; copied/branched/forked session independent of deleted parent; custom session dirs and `--no-session` respected. |
| Temporary | Original removed immediately after import still browses during runtime; close/reopen/tree/refresh preserve access; shutdown/reload/replacement release copies; restored page-one preview works and pagination explains absence. |
| Navigation | 1/last boundaries, latest-target bursts/reversals, jump empty/zero/out-of-range/overflow/backspace/error/Escape, mixed dimensions, revisits fit, current-ready-page no-op, tiny-to-usable restoration. |
| Correct page identity | Actual captured PNG bytes / native IDs and independent page labels identify page P, not merely placeholder presence; same-sized/identical-PNG pages cannot validate stale generations. |
| Cancellation | Close/modal/session/refresh during capture/selector/metadata/render/normalization/native queue/postguard/retirement/receipt; actual child exit/drain, no stale cells/reserve/repaint or shared-queue deadlock. |
| Retirement | No-caller-renderNow tests prove old-cell removal frame precedes scoped delete and new-page placement; frame/write failure retains one obligation; retry reflushes; no global/pixel delete, fixed slot reused. |
| Replay/metrics | Same-ID PNG replay restores every retained inline prototype plus only live current-page private prototype; old page never resurrected; wire/chunks/prototypes/deletes counted once on successful writes only. |
| Policy/model | Both blocking states use exact SDK conversion/request assertions; PDF bytes absent from requests; pagination leaves exact entries/content/conversion unchanged and starts zero requests; denied/non-TUI paths emit zero graphics. |
| Performance/resources | Async Poppler does not block Escape/input; one page runner/latest target, no eager all-page work or per-event promises; no rasterization on pan/zoom/resize; retained native pixel growth explicitly acknowledged. |
| Compatibility | Ordinary images and legacy independent PDF snapshots unchanged; malformed/unknown PDF schema/hash/base64 falls back without path access; labels/errors sanitized and ID rows not restyled. |

Do not globally replace no-PDF-work assertions: they still apply to ordinary
images, old snapshots, page 1, and viewport gestures on the current page. Only
explicit later-page navigation gains rasterization. Update expected attachment
counts for new PDFs, retain old two-page fixtures as legacy coverage, and assert
exact unchanged serialized entries before/after viewing (not counts alone).

Persist controller fake-clock cases for old page tickets/deferred callbacks,
identical layout across pages, page-key bursts while native postguard is held,
page close during cleanup, tiny-pane pending targets and real native proof loss.
Retain current resident-pan zero-probe/zero-transport, final-pan/wheel ordering,
canonical aliases, focus/modal and no-caller-removal-frame regressions.

Verification commands (discover installed public host root locally):

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

Run new focused suites too. Host root must contain `dist/index.js` and its own
pi-tui peer; never install physical host dependencies into the repo. Verify
`pi install .` and resource loading in a temporary `PI_CODING_AGENT_DIR`. Fake
tmux is temporary/PATH-resolved; tests never query/configure the active server.
Use capture terminal and offline fake model runtime, not real providers or tty
pixels. Keep generated PDFs/PNGs, sessions, credentials and raw logs out of Git.
Report revisions, totals/skips, timings/methodology and failures separately.

## 10. Coordinated human checks, non-goals and rollback

After isolated tests and owner-coordinated activation/reload, ask for:

- A labelled multipage PDF: preview is only page 1; next/previous/jump identify
  correct pages; portrait/landscape/rotated pages fit without distortions.
- Page changes after zoom/pan reset fit; wheel/drag/keyboard resume correctly;
  rapid pagination converges on latest page with truthful loading chrome.
- Escape during rendering, Escape inside jump mode, tiny panes, resizing,
  tmux zoom/window switching and new host modal/search retain expected ownership.
- Close leaves page-one inline preview and other images unchanged; continued
  conversation, scroll, transcript selection and links remain intact in both
  relevant modes. Regular terminal scrollback appearance needs human evidence.
- Large-document Keep/Temporary/Cancel, retained resume after original deletion,
  temporary close/reopen and explicit refresh, then reload explaining unavailable
  full document while page-one snapshot remains viewable.

Do not mark these passed from capture streams, scheduler receipts or prior
0.4.2 general acceptance. No display ACK, latency/FPS, GPU bound or universal
reconnect claim. Consent to embed a large document is not consent to share it.

Non-goals: source-path live reload, arbitrary page resolution increases, animation,
PDF text extraction/search/password management, exact-original image retention,
post-hoc excision/session rewrites, durable sidecar store, deduplication across
sessions, prefetch, remembered page/viewport across opens, native slot pool,
graphics eviction/budgeting, terminal/Pi configuration changes or a host fork.

Rollback: preserve reviewed **`5f5c59b` / 0.4.2** as the current implementation
baseline. Commit verified implementation phases separately and revert only their
changes if needed; never reset unrelated work. Coordinate reload. Old binaries
may not understand `pdf-v1`; document a readable fallback or forward-compatibility
strategy before release, without changing old persisted entries. Session files
still retain embedded originals after code rollback; no automatic removal is
promised. Temporary assets are intentionally not restart-recoverable. No push,
remote creation, license choice, machine checkpoint or OS installation authorized.

## 11. Planning-checkpoint evidence

Read-only review of production source, installed Pi declarations/docs/selected
implementation and Poppler help supports the architecture above. No new PDF
session, renderer experiment, actual-host pagination suite, provider call,
physical graphics or human check was performed by this checkpoint. No workers
were delegated. Proposed helper names/schema/transition policy are implementation
recommendations, not shipped interfaces or independent runtime acceptance.

Documentation-checkpoint `npm test`: **249 total, 217 passed, 32 optional host
skips, zero failures/cancellations**. This verifies the unchanged production
baseline, not the proposed feature. Production code/tests, package version,
README's current usage, active installation and settings remain unchanged.
`git diff --check` and local handoff-link/code-fence checks passed. Installed-host
suites and isolated installation were not rerun for this documentation-only task;
they remain required implementation gates above.
