# Agent handoff: native tmux image rendering and lifecycle improvements

## Status and authorization

The owner approved the implementation order below and requested this written
handoff. The working package was committed first as `d92adcf`:
`Package tmux image and PDF viewer for Pi`.

Prerequisite renderer seam was committed as `a920572`, verified against installed
Pi 1.0.3 with automated public-API host tests. A zero-row widget supplies the TUI
transport, connection epochs guard stale work, and asynchronous preparation
uploads before exposing placeholder cells and requesting repaint. See
`docs/renderer-seam.md` for exact API evidence and the unsafe wrapped line-prefix/
forced-native Kitty reset boundaries.

Phase 1 native integration is now implemented: fixed initial aspect-fit geometry,
public Pi PNG normalization, versioned snapshot metadata, randomized stable local
IDs and successful-write residency commits. PNG/JPEG/GIF/WebP/BMP normalization
parity and animated still handling have actual-host automated coverage. Chafa's
implementation/tests were removed after parity verification. Native messages
regenerate from stored snapshots in a fresh connection;
legacy unversioned messages currently show a readable redisplay fallback.

Verification is automated stream/component/pipeline evidence only; native
image/PDF pixel correctness, scrolling and window-switch observations remain
pending. Phase 1 is not claimed visually accepted. Phases 2–4 remain pending
integration and their full acceptance checks: actual geometry resizing, legacy
snapshot migration, explicit reconnect recovery, capability detection and optional
graphics budgeting are not integrated. Preserve the detailed handoff below as
the implementation and acceptance plan.

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

Repository: `/work/repos/micha/pi-tmux-image`.

Current code:

- `extensions/index.ts` registers `/tmux-image`, `/tmux-pdf`,
  `tmux_show_image`, `tmux_show_pdf`, and the `pi-tmux-image` message renderer.
- `src/native.mjs` prepares native PNG uploads/virtual placements from immutable
  image snapshots, caches normalization, aspect-fits the fixed initial grid and
  serializes per-epoch transport commits. `src/kitty.mjs` and `src/identity.mjs`
  are pure protocol/identity helpers; `src/normalize.mjs` uses injected public
  Pi `convertToPng` for non-PNG snapshots.
- `src/presentation.mjs` separates public TUI transport from synchronous layout,
  publishes cells only after a successful write callback, and rejects stale work.
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
- The initial grid is capped at 60 columns by 24 rows, using supported cell-pixel
  dimensions for aspect fitting. Existing grids do not resize yet. Native byte/
  chunk metrics replace Chafa capture messaging. Forced Pi native Kitty graphics
  are explicitly rejected without changing host capabilities.
- `npm test` runs portable protocol, normalization, presentation and lifecycle
  tests; optional host imports exercise actual Pi conversion and renderer APIs.
  `test/host-integration.mjs` checks isolated package installation, sequential
  viewer tools, both image-blocking states and non-TUI zero-graphics behavior
  against an offline test model runtime, never the active incompatible model.

Human-observed legacy prototype success: Ghostty behind tmux 3.6a, Pi 1.0.3,
image/PDF display surviving additional responses and transcript scrolling. This
observation does not establish native integration pixel correctness. The native
OMP code was inspected, not installed or visually tested; no OMP implementation
was copied. Do not treat its tests as proof of our extension's behavior.

Machine prerequisites are currently installed: Chafa 1.18.2 and Poppler CLI tools
26.06.0. Chafa is no longer required by the active extension. `pdftoppm` is on
`/run/current-system/sw/bin` after the independently verified NixOS configuration
commit `5b724a2`. No OS changes are needed for this handoff. Package code must
continue resolving executables through PATH.

Temporary manual fixtures may still exist:

- `/tmp/test-image.png`
- `/tmp/pi-pdf-spike/charts.pdf`: two pages containing SVG-origin bar, line, donut
  and scatter charts.

They are disposable, not test prerequisites. Generate replacement fixtures when
absent and keep generated images, PDFs and logs out of Git.

## Reference implementation and licensing boundary

Local source checkout: `/work/repos/can1357/oh-my-pi`.
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
   actual images to the current incompatible Bedrock model to perform this test.
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
