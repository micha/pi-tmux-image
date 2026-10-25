# Agent instructions

Human-facing setup, usage and limitations belong in `README.md`. Keep this file an actionable contract and task index; detailed design, history and acceptance evidence belong in `docs/`.

## Start here

- Inspect the checkout and preserve unrelated work. Resolve paths from this checkout; historical host/fixture paths in handoffs are not prerequisites.
- Read the task-specific docs below before implementing. Historical plans explain intent; current implementation/verification records supersede proposed API paths, not native ownership or no-budgeting contracts.
- Do not activate/reload the owner's package without coordination. Pacing implementation/tuning changes also require coordination.
- Current package: **0.5.0**, PDF implementation automated-verified. Prior core native behavior, viewer controls and latest-state pacing have general owner acceptance on Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3; remaining PDF pagination/retention human checks remain pending. This is not a case-by-case manual matrix pass or measured latency/FPS result. Do not infer human acceptance from automated streams, component receipts or synthetic FIFO drain.
- Follow-up PDF blank-page recovery ends upload reuse at successful private retirement, without pixel eviction or pacing changes. Read `docs/pdf-blank-recovery.md`; isolated Pi 1.0.3 `/reload` retained old transitive native behavior, while a fresh process sent the required PNG retransmissions. The owner confirmed **“pixels confirmed!”** in that fresh-process check: general visual recovery acceptance, not the full PDF matrix. Updates to already-loaded native modules require a coordinated process restart/resume, not merely `/reload`.
- Budgeting/eviction remains disabled. No new budget settings, placement slots or force path without separate owner approval.
- Delivered PDF scope: independent production review and final offline automated integration/install gates passed; no active reload is authorized by those results. Read `docs/pdf-document-viewer.md` for current interfaces/evidence and `docs/pdf-document-viewer-plan.md` for historical intent plus the approved submission correction. First-page previews/pagination supersede historical two-page/no-pagination restrictions only for new PDF documents; native ownership, pacing and model policy are unchanged.

## Required reading by task

| Task | Read |
| --- | --- |
| PDF document storage, retention or viewer pagination | `docs/pdf-document-viewer.md`, `docs/pdf-document-viewer-plan.md`, then their linked native/viewer/pacing/verification contracts |
| Native encoding, replay, resizing, capability detection or budgeting | `docs/implementation-plan.md`, then the relevant protocol/normalization/capability/metrics docs below |
| Overlay, zoom/pan or click behavior | `docs/image-viewer-plan.md` (historical), `docs/viewer-seam.md`, `docs/viewer-crop.md`, `docs/viewer-lifetime.md`, `docs/viewer-verification.md` |
| Wheel zoom or grab-to-pan | `docs/viewer-mouse.md` |
| Viewer hot paths, input sampling or pacing | `docs/viewer-performance.md`, `docs/viewer-frame-pacing-plan.md` (handoff), `docs/viewer-pacing-design.md`, `docs/viewer-pacing-profile.md`, `docs/viewer-pacing.md` |
| Transport/host integration | `docs/renderer-seam.md` |
| Kitty protocol or image normalization | `docs/kitty-protocol.md`, `docs/pixel-normalization.md` |
| Capability/settings policy | `docs/capabilities.md` |
| Accounting or graphics memory | `docs/graphics-memory.md` |
| Test/acceptance claims | `docs/verification.md` and the relevant viewer verification records |

For Pi API changes, read the installed Pi docs and extension examples, following related references. The tested API version is Pi 1.0.3; do not guess newer signatures.

## Code map

- `extensions/tmux-image/index.ts`: commands/tools, standard image attachments, local renderer and public settings/capability wiring.
- `src/viewer.mjs`: active-branch immutable snapshot/document picker, owned raw overlay, canonical desired viewport, admitted samples/ready frame and one latest native runner; injected PDF page access with exact page generations, one page-transition runner/latest target and serialized scoped retirement/rebind; no original-path reads, messages or model-policy changes.
- `src/viewport.mjs`: pure viewport geometry, including pointer-anchored `zoomViewportAt`.
- `src/viewer-pacing.mjs`: host-import-free scheduler with injected monotonic clock, one timer/ticket/demand bit, deferred cooldown and cancellation identities; no viewport/input queue, native reservations, terminal effects or chosen helper policy.
- `src/presentation.mjs`: public zero-row widget/TUI seam, connection epochs, asynchronous upload-before-placement/repaint ordering and successful-write callbacks.
- `src/native.mjs`: normalization cache, live aspect fitting, versioned metadata/runtime-only legacy migration, serialized per-epoch upload commits and native surface APIs. Geometry keys include actual component width, usable height and cell pixels; inline policy reserves eight rows and caps grids at 60×24, not exact viewport measurement.
- `src/kitty.mjs`, `src/kitty-diacritics.mjs`, `src/identity.mjs`, `src/normalize.mjs`: pure/bounded protocol, IDs and immutable normalization using injected public Pi conversion; no terminal side effects. Chafa is obsolete and removed.
- `src/capabilities.mjs`: bounded/cached read-only actual-pane client and inherited passthrough detection; conservative one-layer Ghostty/Kitty allowlist and public policy gates.
- `src/metrics.mjs`: measurement-only normalization inventory and successful-write transport/residency accounting; epoch trust is distinct from cumulative runtime totals.
- `src/pdf-document.mjs`: cheap `pdf-v1`/safe-preview validation, streamed immutable capture, details-only Keep encoding/lazy materialization, service-branded handles and runtime Temporary ownership; canonical page 1, no native/model effects.
- `src/pdf.mjs`: bounded async PATH `pdfinfo`/single-page `pdftoppm`, abort/actual-close-before-private-scratch cleanup; legacy two-page helper remains for compatibility.
- `test/*.test.mjs`: dependency-free Node suite, with optional installed-host API checks. `test/host-integration.mjs`, `test/host-viewer-integration.mjs` and `test/host-pdf-integration.mjs`: offline SDK integration.
- `package.json`: explicit Pi manifest; host extension imports are peer dependencies, never bundled runtime dependencies.

## Non-negotiable contracts

### Display and model policy

1. Use Kitty Unicode placeholders (`U=1`), not ordinary positioned placements. Pixels bypass tmux; placeholder cells go through Pi text layout. Foreground color encodes the image ID: never restyle these rows or put cursor movement/upload escapes in transcript text.
2. Use standard Pi image content from the built-in read pipeline. Do not filter image messages or change `images.blockImages`; local display must not depend on model blocking. Blocking does not prevent session storage.
3. Keep uploads/placeholders out of model-facing content and session details. Tool-execution display messages use `triggerTurn: false`; preserve tool-call/result ordering without steering or starting another model turn. The overlay itself emits no messages/attachments/turns.
4. Preserve `/tmux-image`, `/tmux-pdf`, `/tmux-image-view`, `/tmux-image-refresh`, `/tmux-image-stats`, `tmux_show_image` and `tmux_show_pdf` unless a breaking change is requested. New PDF imports submit one page-one standard preview; Keep embeds the captured original once in details, Temporary omits it. Exact original-byte threshold is 33,554,432; above it only the user chooses Keep/Temporary/Cancel. No fixed PDF-size ceiling, silent retention fallback, post-hoc excision or history rewrite.
   PDF send is void submission, not display/disk ACK: finish all guards before staging/send; pre-send cancel/failure creates zero preview entries, accepted send is irreversible. No blind retry or failed-tool promise for later host errors. Reconcile staged Temporary only at final same-runtime boundaries against **all history**, never active-branch absence; preserve exact runtime/record/handle ownership across awaits.

### Capabilities and subprocesses

5. Require interactive Pi inside tmux; non-interactive paths must emit zero graphics. Use public `pi.getSettings()` and `getCapabilities()`. Unknown, nested, multi-client, control-client and linked-window paths fail closed; no force/native-ownership workaround.
6. Gate tools before source access and every initial/replay/resize/refresh preparation before transport. Preserve pre/post checks and fresh visibility checks on `on` paths; release upload reservations after post-preparation denial. Synchronous ready-row/reuse/render policy gates remain subprocess-free.
7. Refresh invalidates detector decisions, failed presentation records and residency together, not just TTL. It uses snapshots without file rereads, new messages or turns. Legacy migration is runtime-only; do not mutate stored content/details.
8. Resolve executables through PATH, use argument arrays (never a shell), and retain timeouts/output limits. PDF children must actually close/drain before scratch removal or successor work. Private Temporary survives viewer close/branch/refresh in its owning runtime; replacement aborts/drains users before disposal. Page 1 is canonical stored content; later pages use captured originals, never the provenance path. Document orphan/non-secure-erasure limits. No machine-specific `/nix/store` paths, automatic installs, persistent environment overrides or stdout patches.
9. Never mutate user Pi settings or tmux configuration. Installation tests use an isolated agent directory, not the active user's settings.

### Native ownership and viewer lifecycle

10. Retain all successfully committed occurrence/geometry prototypes and restore them after same-ID PNG retransmission: Kitty replacement deletes every placement. Count PNG chunks and placement batches separately. Successful scoped private retirement invalidates upload-reuse trust for that exact image ID, including inline-shared payloads; keep cached PNGs, identities, retained inline prototypes and successful-write metrics inventory. Failed/stale/no-op retirement cannot invalidate a later upload. Same-lease pan/zoom reuse is unchanged. Shutdown/reload retains terminal resources for scrollback; never globally delete images. Universal reconnect detection and graphics budgeting are not implemented.
11. Use widget-injected public `TUI.showOverlay` and an owned handle, not `ctx.ui.custom`. Refuse existing modals/search. Focus loss synchronously revokes replay/aborts the lease, with deferred scoped hide/disposal. Crop an independently addressed subset of a full-image canvas bounded at 297×297; virtual source crop is ignored by the terminal.
12. Flush the public `renderNow` removal frame before scoped placement retirement/reopen. Frame failure retains the native obligation; every retry reflushes before deletion. `retryRetirement` captures connection/context after draining close. Never delete shared PNG pixels or inline history.
13. Admit transcript clicks and drag starts only on rendered-ready occupied image cells; wheel zoom uses the rendered-ready image area. Regular mode is keyboard-only. Preserve center-based keyboard zoom, pointer-based wheel zoom, sign-only burst coalescing and layout/cell-change grab cancellation. `+` requires literal/public `parseKey` recognition: Pi 1.0.3 `matchesKey('+','+')` is false.
14. Same-layout pan reuses committed-canvas synchronous `reuseViewer` / persistent `isResident` proof. Guarded zoom retains one own-geometry ready frame and at most one latest busy/unrendered wheel event. Call `onUploadStarted` only after final guards and before a nonempty write; revoke row trust and retain the first attempted tuple for scoped cleanup. Known-width ID rows may bypass viewer width scans, not host layout.
15. Keep canonical desired state distinct from immutable admitted samples and ready frames. Reduce cheap pan/key state per event; sample only at eligibility and recompute canonical/live keys at final commit. Render stays passive and never adopts unsampled input. Lost native proof cancels the dead receipt generation; final targets survive benign rejection and observed layout changes.
16. Current approved pacing: **150 ms idle after deferred first-own component receipt**, **wheel expiry disabled**. Receipt is not a screen ACK. No extra timers/input queues or implicit tuning-policy changes in the pure scheduler.
    PDF page changes keep one overlay and the fixed native slot: revoke/drain old page, flush removal, scoped-retire, then bind latest exact generation/key/lease. Actual changes fit/recenter; resize preserves/clamps. Tiny panes collect page/jump but defer page work. No prefetch/derived-page cache or source rerasterization on pan/zoom/resize; native retained payload inventory may grow per distinct page, not a memory bound.

### Metrics

17. Derive payload identity from exact normalized PNG bytes. Count wrapped wire totals once per successful current-epoch write, including restored prototypes; preparation, failures, stale work and zero-byte reuse are not transport. Commit functional residency before accounting; report accounting errors without breaking rows/queue or forcing reuploads.
18. Epoch reset clears local trust, not terminal resources. PNG/RGBA estimates are not terminal ACKs or global/GPU bounds; prior-runtime/external resources and overhead are unobservable. `/tmux-image-stats` must not query detectors, upload, emit messages, start turns or evict.

## Verification and completion

- Run `npm test` before committing. Optional host checks (discover the installed package root locally):

  ```sh
  PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent/package \
    PI_IMAGE_HOST_MODULE=/path/to/installed/coding-agent/package/dist/index.js npm test
  PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent/package \
    node --test test/host-integration.mjs
  PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent/package \
    node --test test/host-viewer-integration.mjs
  PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent/package \
    node --test test/host-pdf-integration.mjs
  ```

  The root must contain `dist/index.js` and host-supplied `node_modules/@earendil-works/pi-tui`. Do not install physical host dependencies into this repository.
- Verify `pi install .` in a temporary `PI_CODING_AGENT_DIR`; inspect discovery/loading without contacting an LLM provider.
- Preserve integration coverage for zero-graphics/pre-source rejection, public preference precedence, both model-blocking states, ready-row disablement and denied-to-supported refresh with unchanged messages/turns. Use isolated public SDK settings and temporary PATH-resolved fake tmux, not the active server. Do not add runtime test flags.
- For renderer changes, coordinate human checks of images/PDFs, continued text, scrolling, pane position, resizing and window switching. Report automated versus human-observed evidence separately. Narrower resize/edge/reconnect/format/terminal cases remain human-pending; source-deleted replay is automated-only. Consult the linked acceptance records rather than promoting old suite counts into current claims.
- Keep README examples/limitations consistent with code. Keep generated images/PDFs, screenshots, logs, credentials, session data, `node_modules` and machine-local fixtures out of Git.
- Commit completed changes locally with a clean working tree, preserving unrelated work. Do not push/create a remote repository or select a license without the owner's request/decision.

## Worker delegation

- Use Pi model `us.openai.gpt-6.1-sol`: planning/review workers use `--thinking xhigh`; implementation workers use `--thinking medium`. This role policy supersedes the earlier all-medium baseline, not historical records.
- Coordinate through workmux using stable named tabs in the current workspace, never window indexes. Say **thank you** when a worker is safe to close.
- Write normal, properly spaced prompts/follow-ups with clear scope, file ownership, interfaces, constraints and verification. Do not minify prose; preserve exact literals.
- Inspect exact prompt-file contents and literal follow-ups before dispatch; correct run-together words and ambiguity. If a received prompt looks corrupted, compare it with dispatch text before blaming Pi, tmux or workmux.
