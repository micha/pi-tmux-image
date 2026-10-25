# Agent handoff: native tmux image rendering and lifecycle improvements

## Contributor context

Resolve this project's file paths relative to the **current checkout root**.
External `/path/to/...` locations below are placeholders, not directories assumed
to exist. Host versions, temporary fixture locations and completed verification
records describe the original implementation environment; they are not proof of
what is installed or available on another contributor's machine. Use `README.md`
for current requirements, discover optional installed-host test roots locally,
and generate your own disposable fixtures. Do not change system configuration or
install dependencies merely to reproduce a historical machine layout.

## Status and authorization

**Follow-up recovery boundary:** [PDF blank-page recovery](pdf-blank-recovery.md)
records the current successful-private-retirement invalidation of PNG upload-reuse
trust. Cached payloads and all inline prototypes remain; the next actual native
preparation can retransmit that image within the same connection epoch. Historical
once-per-epoch/placement-only reopen assumptions below are superseded only at
that boundary. Same-lease resident geometry/pan reuse, gates, pacing and disabled
budgeting remain unchanged. The owner confirmed the repair's pixels in a fresh
Pi process; the existing-process `/reload` workflow did not activate the changed
native module. This is general visual recovery acceptance, not a full matrix pass.

**Viewer 0.3.0 implementation / general owner acceptance:** UI/controller is
committed at `210d524` after plan `d324d87`, feasibility gate `e92b1cd`, pure
phase `dd13569` and shared runtime `5898185`. Final production public SDK matrix
**15/15**, host suite **181/181**, existing SDK **12/12** and portable
**150 passed / 31 optional skips** pass. The owner confirmed “all is working!”
after being asked to reload and try click-open/zoom/pan/reset/Esc on Ghostty 1.3.1 /
tmux 3.6a / Pi 1.0.3 with `terminal.images: auto` and `images.blockImages: true`,
package 0.3.0. This is general human acceptance of the new in-pane viewer, not
individual manual matrix passes. Both PDF pages, keyboard picker/regular mode,
other terminals, modal/search, bounds, reconnect, source-deletion and failure races
were not separately reported; narrower cases remain automated-only or human-pending.
No camera inspection or latency measurement was made. Baseline inline observations
remain distinct.
`/tmux-image-view` and ready-cell-only fullscreen clicks select active-branch stored
snapshots without rereads, session/history fields, attachments or model turns.
Defaults: 1.25× fit-relative zoom, 25% minimum, dynamic 297-canvas maximum,
four-cell pan, fit each open, normalized-center/zoom preservation on resize and
20×7 graphical minimum. Admission/focus-loss cancellation, a single prepare/latest
runner, public removal-frame flush before retirement and guarded tombstone recovery
are integrated. See [viewer-seam.md](viewer-seam.md) for current evidence and
[viewer-verification.md](viewer-verification.md) for the separate acceptance matrix.

**Viewer Step 1 update:** owner-authorized proceeding from plan checkpoint
`d324d87`; coordinated automated gates now pass (**131/131** host suite).
Use widget-injected public `TUI.showOverlay` with owned scoped cleanup, existing
modal/search admission refusal and close-on-public-focus-loss; do not use
`ctx.ui.custom` lifetime ownership. Viewer geometry uses a full-image canvas
bounded at **297x297** and explicit viewport-subset marks, not ignored virtual
source cropping. Exact evidence/limitations: [viewer-seam.md](viewer-seam.md),
[viewer-crop.md](viewer-crop.md), [viewer-lifetime.md](viewer-lifetime.md).
Fit-relative defaults/limits are explicitly selected above. General viewer human
acceptance is recorded above; unreported manual cases remain pending. Existing
native contracts and disabled budgeting below remain unchanged.

**Next UX handoff:** [image-viewer-plan.md](image-viewer-plan.md) records the agreed
in-pane Pi overlay viewer and mandatory public-API/protocol feasibility gate.
The plan was a documentation-only Git checkpoint, not implemented controls or a
machine/EBS checkpoint; current viewer implementation/acceptance is summarized above.
Known-working observed-inline baseline is `9dc2944` / version 0.2.0; local annotated
tag `checkpoint/image-viewer-plan` identifies plan commit `d324d87`, the parent
checkpoint for viewer phases. Existing native contracts below remain in force;
budgeting/eviction is still disabled.

The owner approved the implementation order below and requested this written
handoff. The working package was committed first as `d92adcf`:
`Package tmux image and PDF viewer for Pi`.

Prerequisite renderer seam was committed as `a920572`, verified against installed
Pi 1.0.3 with automated public-API host tests. A zero-row widget supplies the TUI
transport, connection epochs guard stale work, and asynchronous preparation
uploads before exposing placeholder cells and requesting repaint. See
`docs/renderer-seam.md` for exact API evidence and the unsafe wrapped line-prefix/
forced-native Kitty reset boundaries.

Phase 1 native integration was committed as `594795a`: public Pi PNG
normalization, versioned snapshot metadata, randomized stable local IDs and
successful-write residency commits. PNG/JPEG/GIF/WebP/BMP normalization parity and
animated still handling have actual-host automated coverage. Chafa's
implementation/tests were removed after parity verification.

Phase 2 integration was committed as `2824f9e` and automated-tested: live aspect fitting
uses actual component width, injected terminal height minus 8 reserved chrome/
editor rows (minimum one image row, maximum 60x24 grid), and supported cell-pixel
dimensions. Geometry keys capture all these inputs before async work. Resident
PNGs are reused; geometry-versioned placements preserve previously retained
grids, ready resize reversals reuse caches, and superseded pending work is
coalesced. Known unversioned Chafa messages migrate from standard snapshots at
runtime only; old cells/IDs/source paths are ignored. Unknown schemas or malformed
content remain readable fallbacks.

`/tmux-image-refresh` resets the connection epoch/residency and failed prepared
records, then requests repaint without rereading files, appending messages or
starting model work. Reload/resume/switch also prepare from stored snapshots.
Shutdown/reload deliberately retain terminal resources instead of globally
deleting pixels and orphaning retained scrollback. Previous-runtime allocations
may remain until terminal reset; no eviction/budget policy is integrated.

Lifecycle follow-up was committed as `38da556`: Kitty's current specification
requires retransmitting an existing image ID to delete its image data **and all
placements**. Native runtime
now retains successfully committed occurrence/geometry prototypes per image;
every PNG retransmission restores the complete known prototype set before cells
are exposed, not only current geometry. This preserves older retained grids when
explicit refresh is invoked without a physical terminal reset. This registry is
runtime-only: a fresh process rebuilds current-session messages from snapshots
with new IDs, but cannot discover or rewrite arbitrary immutable prior-process
terminal scrollback IDs/geometry after a reset. Failed/canceled prototypes are
never added. Upload chunks count PNG commands only; placement
command batches can exceed one. A protocol-semantic simulator reproduces the
replacement deletion and verifies old/current prototypes, and actual SDK refresh
checks all earlier committed placement IDs/geometry with one PNG transmission.

Phase 3 was committed as `6e21a82` and automated-tested: read-only PATH-resolved tmux
queries check the actual pane's effective inherited `allow-passthrough` and its
session's single attached client. Conservative Ghostty/Kitty placeholder identity
checks reject unknown/old/multiplexer clients, multiple/control clients and
cross-session-linked windows. Public `pi.getSettings()`/`getCapabilities()` retain
explicit local-image disablement/protocol/truecolor policy without touching
settings; model `images.blockImages` never gates local display. Tools reject
before source access, initial/replay/resize preparation is guarded before native
work and again before returning its transport reservation, and synchronous
ready-row policy checks contain no subprocesses. Failed post-preparation guards
release reservations. `on` paths resample visibility before source access/upload
preparation; no negotiated support or transport acknowledgement is claimed.

Refresh clears detector decisions and failed prepared records/residency together,
then probes fresh and requests source-free repaint. Lifecycle changes invalidate
stale queries; name-only terminal identity carries an explicit current-version
assumption/warning. The known current Ghostty/tmux path requires no forced Pi
Kitty setting. See `docs/capabilities.md` for exact conservative boundaries.

Phase 4 measurement-only integration is now delivered: one `GraphicsMetrics`
instance per native runtime inventories exact normalized payload metadata, then
records only successful current-epoch stream writes after functional residency
commit. Each write includes its full restored placement batch with wire totals
counted once, explicit PNG chunk count and placement command count. Failed,
partially failed, stale/canceled preparations and zero-byte reuse are not counted
as successful transport. Guarded accounting exceptions cannot invalidate rows,
residency or queue release; diagnostics explicitly report incomplete accounting.

`native.stats(presentationEpoch?)` exposes metadata-only snapshots and
`/tmux-image-stats` displays local diagnostics with no detector queries, graphics,
messages or model turns. Epoch changes clear measured residency trust/epoch
transfer, not terminal resources; normalization inventory and cumulative runtime
transfer remain. The scope is locally tracked successful writes, not terminal
ACK or globally observed residency. RGBA is an estimate (`width * height * 4`),
not measured GPU/RAM allocation; prior-runtime/external resources and
terminal/decoder/cache/metadata overhead are unobservable. Fixture/stress sample
commits in `docs/graphics-memory.md` are simulated; integrated tests compare
actual captured successful stream bytes/chunks/placement batches. No human
terminal-memory measurements establish a need for a limit.

**Optional budgeting/eviction is not implemented:** no default limit, settings,
resource deletion or history replacement. A policy requires a separate owner
choice and measured historical-image trade-off.

Native PNG and two-page PDF display are now human-observed on Ghostty 1.3.1/
tmux 3.6a/Pi 1.0.3 with `terminal.images: auto` and `images.blockImages: true`.
The owner confirmed initial PNG display (“i see it!”, recorded in `0496d60`),
correct rendering of both PDF pages, scrolling up to the earlier PNG while the
PDF was below the fold and back to the PDF (“everything looks like it should”),
and zoom/unzoom with the same scrolling checks repeated (“all good!”). Multiple
assistant/user replies followed the PNG and PDF in the live chat; the owner
scrolled back to the end after those replies and observed correct appearance,
repeating this after zoom. Images survived continued conversation and scrolling
in that live sequence, not a separate standalone experiment. PDF speed
feedback (“it was very fast!”) is subjective, not measured latency. Forced
`terminal.images: kitty` was correctly refused before the owner-authorized change
to `auto`; the follow-up observations retained those settings and model blocking.
The owner then switched to another tmux window and back (“all good”), ran
`/tmux-image-refresh` (“still looking good”), and ran `/reload` after being asked
to revisit the earlier PNG and both PDF pages (“still looking good after
/reload”). These establish human-observed window switching, explicit refresh and
reload recovery appearance on the same setup. No source files were removed in
this live check; source-deleted/no-reread replay is automated SDK evidence only.

The core requested live checks now pass, but the full visual matrix retains
narrower pending corners: separate pane-position checks, width/height drags,
isolated height/cell-size resizing, deliberate partial-edge cropping,
reconnect/resume, other image formats and other terminals. These are not
prerequisites for using the package on the observed setup. Other verification
remains automated stream/component/pipeline evidence. Phases 1–3 are not claimed
fully visually accepted across that matrix, and Phase 4 measurements do not
establish terminal memory bounds. Universal automatic reconnect detection is not
promised. See `docs/verification.md` for the evidence split; preserve the detailed
handoff below as the implementation and acceptance plan.

Read `AGENTS.md` before working. Keep human documentation in `README.md` and
implementation instructions here. Inspect Git state and current host APIs before
editing. Commit each verified phase separately. Do not push, choose a project
license, install OS packages, or change user/system configuration without a
separate request.

Approved order:

1. Native Kitty encoding and stable IDs.
2. Upload replay and resize-aware rendering.
3. Terminal capability and passthrough detection.
4. Optional graphics-memory budgeting, informed by measured usage.

## Current system and what has actually been demonstrated

Repository: the current `pi-tmux-image` checkout root. Repository file paths
below are relative to that root unless explicitly identified as external
reference paths or historical temporary fixture locations.

Current code:

- `extensions/tmux-image/index.ts` registers `/tmux-image`, `/tmux-pdf`,
  `/tmux-image-refresh`, `/tmux-image-stats`, `tmux_show_image`, `tmux_show_pdf`,
  and the `pi-tmux-image` message renderer.
- `src/native.mjs` prepares native PNG uploads/virtual placements from immutable
  image snapshots, caches normalization, aspect-fits live geometry, migrates
  known legacy snapshot metadata at runtime and serializes per-epoch transport
  commits. `src/kitty.mjs` and `src/identity.mjs`
  are pure protocol/identity helpers; `src/normalize.mjs` uses injected public
  Pi `convertToPng` for non-PNG snapshots.
- `src/presentation.mjs` separates public TUI transport from synchronous layout,
  captures complete geometry keys, coalesces pending resize jobs, publishes cells
  only after successful write callbacks, and rejects stale work. Explicit refresh
  resets epochs/caches under the same widget lifetime owner. No resource deletion
  is performed during refresh/shutdown/reload.
- `src/capabilities.mjs` performs bounded read-only actual-pane/effective inherited
  tmux probing and public host-policy preflight; the extension integrates both
  pre-source tool rejection and pre/post-native preparation guards. Public
  settings are read through `pi.getSettings()`, not private ctx properties/files.
  Refresh invalidates detector and failed presentation/residency together.
- `src/metrics.mjs` stores normalized payload metadata and success-only current-
  epoch residency/batched transport counters, with independent runtime totals.
  Native integrates it defensively after functional success; `/tmux-image-stats`
  is local-only and measurement errors do not break display. Eviction is disabled.
- The obsolete `src/graphics.mjs` Chafa parser/subprocess implementation and its
  tests were removed after actual-host advertised-format parity verification.
- `src/pdf.mjs` uses `pdftoppm` from PATH to rasterize the first two PDF pages
  (1200-pixel longest side), visits the PNGs, and removes temporary files.
- Viewer commands/tools attach standard Pi image content from `createReadTool`.
  Local normalization validates before `sendMessage` so failures remain failed
  tools. Versioned details contain only occurrence/label/geometry; upload bytes,
  placeholder cells and residency are runtime-only. No extension context filter
  exists, and render preparation never rereads the original path.
- `pi.sendMessage(..., { triggerTurn: false })` preserves tool-call/result ordering.
- Live grids are capped at 60 columns by 24 rows, using actual component width,
  terminal height minus 8 reserved rows, and supported cell-pixel dimensions.
  Geometry-only changes do not retransmit resident PNGs. Native byte/chunk metrics
  replace Chafa capture messaging. Forced Pi native Kitty graphics are explicitly
  rejected without changing host capabilities.
- `npm test` runs portable protocol, normalization, presentation and lifecycle
  tests; optional host imports exercise actual Pi conversion and renderer APIs.
  `test/host-integration.mjs` checks isolated package installation, sequential
  viewer tools, both image-blocking states, non-TUI zero-graphics behavior,
  source-deleted reload/legacy resume, width/height/cell changes, geometry reversal
  and failed-write/capability-denied recovery via the public refresh command,
  with unchanged messages/attachments/model requests. Local stats command checks
  compare exact successful captured wire/chunk/prototype counts and assert no
  graphics, probing, conversation or model effects. It uses a temporary
  PATH-resolved tmux fixture to cover unsupported/disabled/timeout paths without
  active-server changes and an offline test model runtime,
  never an arbitrary active provider model. Public clipping tests retain
  independent row/column marks and both ID colors when top/left cells are clipped.

Human-observed legacy prototype success: Ghostty behind tmux 3.6a, Pi 1.0.3,
image/PDF display surviving additional responses and transcript scrolling. Native
PNG/two-page PDF display, scrolling, zoom/unzoom, window switching, explicit
refresh and reload recovery appearance are now separately human-observed as
recorded above; the legacy observation does not establish the remaining native
visual corners. The native OMP code was inspected, not installed
or visually tested; no OMP implementation was copied. Do not treat its tests as
proof of our extension's behavior.

**Historical implementation host:** the recorded environment had Chafa 1.18.2
and Poppler CLI tools 26.06.0 available. These are observed versions, not an
installation inventory or required version pins for contributors. Chafa is no
longer required. Ensure `pdftoppm` is available through your own PATH when testing
PDFs, following `README.md`; package code must continue resolving executables
through PATH rather than a host-specific installation directory.

The original manual checks used disposable generated fixtures at these locations:

- `/tmp/test-image.png`
- `/tmp/pi-pdf-spike/charts.pdf`: two pages containing SVG-origin bar, line, donut
  and scatter charts.

These are historical references, not files expected to exist on any contributor's
machine or test prerequisites. Generate your own replacements in a writable
temporary directory and keep generated images, PDFs and logs out of Git.

## Reference implementation and licensing boundary

Optional external reference checkout: `/path/to/oh-my-pi` (a placeholder for a
contributor-chosen location), from <https://github.com/can1357/oh-my-pi>.
Normal package usage and tests do not require this checkout. If reproducing the
upstream review, locate or obtain it separately rather than assuming it already
exists on the current machine.

Reviewed revision: `0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0`.
Use that revision to reproduce the observations; explicitly record any newer
revision you consult.

Relevant upstream files (relative to that checkout):

- `packages/tui/src/kitty-graphics.ts`: virtual placements, placeholder/diacritic
  encoding, foreground/underline ID colors, feature gating.
- `packages/tui/src/terminal-capabilities.ts`: PNG transmit commands, chunking,
  direct versus virtual placements, fit calculation and capability selection.
- `packages/tui/src/tmux.ts`: outer-terminal identity query and effective
  `allow-passthrough` checks.
- `packages/tui/src/multiplexers/tmux.ts`: DCS wrapping and tmux behavioral flags.
- `packages/tui/src/components/image.ts`: stable keys, cached grids, transmit
  tracking, purge/retransmit handling and `ImageBudget`.
- `packages/tui/src/tui.ts`: upload-before-placement frame ordering, resize and
  reset handling. Understand the integration points rather than transplanting
  its much larger renderer.
- `packages/tui/test/image-budget.test.ts` and
  `packages/tui/test/terminal-capabilities.test.ts`: regression scenarios.
- `docs/tui-core-renderer.md`: ownership, history, resize and memory contracts.

OMP's reviewed LICENSE is MIT. If incorporating substantial upstream code, retain
its required notices and attribute the copied portions. Do not silently copy
code or assume that the owner's currently unlicensed project has a chosen
license. Prefer small protocol implementations based on the public Kitty
specification; decide and document the attribution approach before copying.

Consult the current Kitty graphics specification, especially Unicode placeholders,
virtual placement deletion semantics and chunked PNG transmission. Verify current
Pi extension APIs against installed documentation/examples; API names changed
between Pi families, and OMP's Bun-based internals are not drop-in Pi APIs.

## Non-negotiable contracts and non-goals

- Preserve both slash command names and both tool names and their `path` arguments.
- Keep standard Pi image content. `images.blockImages` alone decides whether
  image attachments enter model requests; never make that setting a local-display
  gate, change it, or install another image-context filter.
- Keep upload bytes and placeholder cells out of model-facing text. Standard
  attachments may be stored in sessions even while blocked from model requests.
- Preserve sequential tool execution, proper error propagation, and
  `triggerTurn: false`. Do not add extra assistant turns or duplicate attachments
  when merely repainting an image.
- Interactive Pi inside tmux remains the supported environment. Print, JSON and
  RPC invocations must produce no terminal graphics bytes.
- Do not patch stdout, use a fake `WEZTERM_PANE`, mutate tmux settings, or rely on
  machine-specific executable paths. Those were rejected prototype directions.
- Copy-image/context-menu/clipboard behavior is explicitly shelved.
- Native Pi `read` and unrelated image renderers are outside this scope.
- PDF page selection, pagination UI and changing the two-page default are separate
  enhancements. Preserve first-two-page behavior during this work.
- PDF rasterization stays with Poppler; native Kitty encoding does not replace a
  PDF renderer.

## First task: establish a safe renderer integration seam

Do this before promising automatic replay or resize recovery.

1. Inspect Pi's custom message renderer/component API and lifecycle events. Verify
   which events occur on `/reload`, session resume/switch, resize and shutdown.
2. Determine how the extension can safely schedule uploads **before** the frame
   displaying their cells, and request a repaint when preparation completes.
   Current command-time stdout writes are sufficient for initial display, but not
   automatically for rendering a restored message.
3. Investigate whether a component can carry wrapped APC/DCS prefixes safely.
   Pi's width/slicing/image-line recognition may identify nested Kitty sequences;
   do not assume OMP's line-prefix technique is compatible with Pi's renderer.
4. Prefer a small presentation/transport layer using supported component/lifecycle
   APIs. Keep pure encoding separate from side effects. Avoid expensive decoding,
   conversion or subprocess work on every synchronous `render(width)` call.
5. Establish an instance/connection epoch for upload residency. A new renderer
   runtime must not trust IDs or "uploaded" flags persisted by a previous process.
6. If the public extension API cannot safely support the required ordering or
   repaint signal, document the exact blocker and ask the owner whether to pursue
   an upstream Pi API change. Do not conceal it with a permanent monkey patch.

Deliverable: a brief recorded design decision and a focused test demonstrating
safe upload/placement ordering in Pi, not just a pure encoder test.

## Phase 1 — native encoding and stable image/placement IDs

### Design and implementation

- Replace Chafa's encoding with small pure helpers, preferably under
  `src/kitty.mjs` and `src/transport.mjs`; keep names flexible if a better
  structure emerges.
- Send PNG bytes using Kitty `f=100`, an image-data transmission command, bounded
  base64 chunks, quiet replies and correctly terminated continuation commands.
  Wrap each complete Kitty command individually in tmux DCS, doubling every
  inner ESC. Choose chunk sizes verified against both Kitty and tmux framing.
- Define virtual placements with `a=p,U=1` and return one real placeholder-cell
  string per row. No cursor-positioned placements, empty reserved-row tricks or
  cursor-up/down commands inside grid rows.
- Encode foreground image ID and, when needed, underline placement ID; each cell
  must explicitly encode its row and column so clipping does not depend on a
  missing left neighbor. Restore styling at each row boundary.
- Use the specification's diacritic table. Validate addressable grid bounds and
  image/placement IDs. If limiting IDs to 24 bits, allocate only nonzero 24-bit
  values; larger IDs require the protocol's high-byte encoding, not truncation.
- Stable keys should distinguish image payload identity from logical occurrence
  and placement geometry. Repeated rendering of an occurrence must reuse IDs.
  Randomized allocation plus collision checks is preferable to blindly using a
  truncated content hash. Account for the terminal-wide namespace shared with
  other applications; do not claim collision-free global coordination.
- Transmit once per residency epoch, then emit small placement commands and
  placeholder rows for repaints. Do not retransmit PNG base64 every frame.
- Plan geometry-versioned placements: redefining a single virtual prototype on
  resize can change older retained grids that still reference it. Use explicit
  placement identities/versions where necessary; do not corrupt old scrollback.

### Normalize pixels without changing model policy

Kitty `f=100` requires PNG. Pi's read pipeline may return JPEG, GIF or WebP rather
than PNG. Preserve those currently supported inputs:

1. Prefer an exported, supported host conversion facility if available.
2. Otherwise choose an explicit portable runtime dependency or converter, declare
   it correctly, and document why it is needed. Do not import private Pi modules
   or undeclared transitive dependencies.
3. Select a still frame for animated inputs, consistent with the existing viewer.
4. Keep local PNG normalization separate from model-facing standard Pi content.
   Prefer rendering from the attachment snapshot so persisted bytes, not an
   editable source path, define the displayed image.

Do not remove Chafa until PNG and non-PNG parity is verified. If conversion needs
an owner decision, retain a clearly temporary fallback rather than dropping
formats silently. Remove the Chafa dependency, parser and buffer-limit messaging
only when native rendering fully replaces them. Replace the capture-size metric
with useful native encoded-byte/chunk metrics; retain sensible input/resource
bounds despite removal of subprocess capture.

### Acceptance and tests

- PNG, JPEG and at least one of GIF/WebP render; exercise all advertised formats
  before claiming complete parity. PDF page PNGs render unchanged.
- Protocol tests reconstruct the PNG from chunk payloads and verify ordering,
  continuation flags, escaping and terminators. Cover chunk boundaries, not just
  a tiny one-command upload.
- Placeholder tests decode known image/placement IDs and row/column marks, check
  foreground/style resets, independently addressable cells and out-of-range input.
- Repeated layout produces stable IDs and no redundant transmit. Distinct payloads
  and occurrences do not accidentally alias. Test intentional allocation collisions.
- No terminal bytes are emitted by pure helpers or non-TUI invocation.
- Human verification: correct pane position, image and PDF scrolling, another
  response below the image, and switching tmux windows. Native rendering does
  not depend on Chafa being available once that dependency is declared removed.

## Phase 2 — upload replay and resize-aware rendering

### Session representation and renderer state

- Version rendering details with a schema discriminator. Keep immutable standard
  image content as the canonical persisted source and display labels/page metadata
  separately. Runtime upload residency and connection epochs are not persisted.
- Support the current unversioned `pi-tmux-image` messages containing
  `lines`, `columns`, `outputBytes` and `label`. They already contain standard image
  content: regenerate their presentation from that snapshot when possible, rather
  than relying on Chafa IDs that may no longer exist in the terminal.
- Prototype-only custom message types need not be migrated unless separately
  requested. Handle malformed/missing content gracefully with a readable fallback.
- Separate the persisted model attachment from the runtime graphics cache. Do not
  duplicate base64 payloads into session rendering details without a concrete need.

### Replay

- On `/reload`, resume, new process or known terminal reset, invalidate residency,
  prepare surviving images from message snapshots and upload before painting.
- Replaying an old image must not reread its original file. Source images may have
  been edited/deleted, and PDF scratch files are deliberately removed.
- Recovery must repaint existing messages, not append replacements or trigger
  model work. Test that message/attachment counts remain unchanged.
- Define explicit reset/replay recovery for a terminal reconnect that the extension
  cannot automatically observe. Do not claim universal automatic reconnection
  detection; document whether the user must invoke a refresh command.
- Release or retain owned terminal resources deliberately on shutdown/reload.
  Never issue global image deletion that affects other programs. Handle deletion
  followed by replay without briefly orphaning the currently visible cells.

### Resizing

- Derive grid geometry from the actual component width and usable vertical limits,
  with aspect ratio and cell-pixel dimensions handled consistently. Prefer Pi's
  supported cell-dimension query rather than unrelated process defaults.
- Cache by image identity, geometry, protocol and residency epoch; reuse PNG uploads
  when only placement dimensions change.
- Avoid repeated work during resize drags; coalesce preparation/repaint where the
  host allows it. Cached geometry must be invalidated on relevant cell-size changes.
- Respect independent per-row ID colors through Pi width fitting, clipping and
  selection. Never feed upload payloads into ordinary text-width calculations.

### Acceptance and tests

- Images survive `/reload` and session resume after the source file is removed.
- PDF messages survive after their temporary PNG directories are removed.
- Layout at multiple widths produces the correct dimensions and retains aspect
  ratio. A narrower pane renders a smaller image instead of a stale-grid warning.
- Repeated unchanged frames neither convert pixels nor retransmit data.
- Recovery and resize do not add session messages or alter model attachment content.
- Human verification: shrink/expand width and height, tmux zoom/unzoom, images
  partially visible near viewport edges, scroll up/down after each operation,
  reload, resume and an explicitly documented reconnect/recovery workflow.
- If replay is impossible through current public Pi APIs, stop at the documented
  feasibility boundary rather than declaring this phase complete.

## Phase 3 — capability and passthrough detection

- Query tmux's attached-client `client_termtype` and `client_termname` with bounded
  subprocess calls. Use terminal-type identity first, recognizable client TERM
  second; the pane's `TERM=tmux-*` is not proof of graphics support.
- Check effective `allow-passthrough` for the actual pane, including inherited
  values. Accept `on`/`all`; handle older tmux versions without that option based
  on verified behavior, not an empty-response assumption.
- Recognize supported Kitty-placeholder terminals conservatively. Kitty graphics
  support alone does not establish Unicode-placeholder support. Include Ghostty;
  evaluate other identities using primary evidence.
- Decide how to respect Pi's existing capability configuration. If a package-level
  override is genuinely necessary, document precedence and meaning, and do not
  confuse forcing a capability with configuring tmux to forward it.
- Cache bounded queries, but provide re-evaluation when a client reconnects or
  changes and avoid caching transient failures forever. Nested tmux is a distinct
  case: declare its support boundary and do not promise one wrapper crosses every
  multiplexer layer.
- Fail or use a readable non-graphics fallback with an actionable explanation.
  Never change `allow-passthrough` automatically.

Acceptance: tests cover supported/unknown clients, disabled/inherited passthrough,
failed or timed-out tmux queries, explicit override precedence, non-TUI execution
and supported nested-session behavior. Human testing verifies that the known
Ghostty/tmux setup works without unnecessary forced capability settings and that
unsupported cases produce no leaked escape payloads.

## Phase 4 — optional graphics-memory budgeting

This is intentionally last. Measure before introducing an eviction policy.

1. Measure unique resident images, PNG transfer bytes and an estimate of decoded
   RGBA memory. Geometry, occurrences and placements are separate from image data.
2. Provide an opt-in limit or explicitly owner-approved default. Preserve existing
   long-scrollback behavior unless the owner accepts its trade-off.
3. Choose and document recency: display observation, access, or creation order.
   OMP keeps recent graphics live and uses height-preserving text fallbacks.
4. Evict by owned image ID, with correct virtual-placement deletion semantics.
   Removing placeholder text or deleting only ordinary visible placements is not
   equivalent to freeing virtual prototypes and pixels.
5. Do not delete images still needed by another live occurrence or renderer
   surface. Track shared-payload residency and placement references coherently.
6. Keep fallback height stable so eviction does not shift unrelated transcript
   rows. Old native scrollback may still lose pixels; never claim immutable
   history can be rewritten into a fallback unless the host actually does so.
7. Permit explicit recovery or re-upload on access where feasible. Do not turn
   old-message scrolling into an unbounded retransmission/eviction loop.

Acceptance: deterministic lifecycle tests for reuse, eviction, deletion, recovery
and multiple occurrences; stress test bounded residency; visual scrollback test
with a deliberately small budget. Update README with the exact historical-image
trade-off. If the owner prefers retaining all images, ship measurement and leave
budgeting disabled rather than imposing a silent regression.

## Verification, delivery and rollback

For each phase:

1. Run portable `npm test`; add behavioral/regression tests, not more source-text
   assertions. Keep protocol/lifecycle helpers independently testable without
   installing physical copies of host Pi modules.
2. Test `pi install .` and resource loading using an isolated
   `PI_CODING_AGENT_DIR`. Inspect commands and non-TUI rejection without making an
   LLM provider request. Keep diagnostics and credentials out of fixtures/logs.
3. Exercise tool execution and both image-blocking states through Pi's actual
   model-conversion pipeline or a valid host integration harness. Assert that
   local display works with blocking on, image content is absent from the model
   request when on, and eligible image content survives when off. Do not send
   actual fixture images to an arbitrary active provider model to perform this
   test; use the offline test runtime instead.
4. Run the relevant manual matrix above in a real terminal. Record separately
   automated results, owner-observed results and unresolved compatibility limits.
5. Update README requirements, metrics and limitations. Update AGENTS architecture
   notes when helpers move; keep this handoff's status accurate.
6. Commit the phase locally with a clean tree. Do not push without authorization.

Keep the last known-working package commit as a rollback point. Coordinate active
package replacement/reload with the owner; do not load the original spike and the
package together because command/tool names overlap. A renderer regression should
be recoverable by reverting the relevant package commit and reloading Pi, without
changing system packages, model-image settings or tmux configuration.

Final handoff/report should identify completed phases, commits, remaining phases,
license/attribution decisions, measured resource behavior, installed requirements,
and any tests that still need another terminal or human verification.
