# Instructions for robots

This file is for coding agents. Human-facing installation, usage and limitations belong in `README.md`; do not turn this file into a second user manual.

The approved next-phase handoff is in `docs/implementation-plan.md`. Read it before implementing native encoding, replay/resizing, capability detection or graphics budgeting. It records the implementation order, acceptance criteria, scope boundaries and reviewed OMP sources.

## Scope and architecture

- `extensions/index.ts`: Pi commands, tools, standard image attachments and custom local renderer.
- `src/presentation.mjs`: public zero-row widget/TUI transport seam, connection epochs and asynchronous upload-before-placement/repaint ordering; successful-write callbacks commit runtime residency. See `docs/renderer-seam.md` for verified host boundaries.
- `src/native.mjs`: snapshot normalization cache, live aspect fitting keyed by actual component width/usable height/cell pixels, versioned metadata/legacy runtime migration and serialized per-epoch upload commits; uses pure `src/kitty.mjs`/`src/identity.mjs` helpers and injected public Pi conversion via `src/normalize.mjs`. Vertical policy reserves 8 terminal rows, caps image grids at 60x24 and is not an exact viewport measurement. Retain successfully committed occurrence/geometry prototypes per image and restore all after same-ID PNG retransmission (Kitty deletes all placements on replacement); count PNG chunks and placement batches separately.
- `src/kitty.mjs`, `src/kitty-diacritics.mjs`, `src/identity.mjs` and `src/normalize.mjs`: pure/bounded native protocol, stable IDs and immutable snapshot normalization; no terminal side effects. The obsolete Chafa implementation was removed after advertised format parity checks passed.
- `src/capabilities.mjs`: bounded/cached read-only actual-pane tmux client/effective inherited passthrough detection, conservative one-layer Ghostty/Kitty allowlist and public Pi settings/capability policy gates. `extensions/index.ts` uses public `pi.getSettings()` plus `getCapabilities()`, guards tools before source access and every prepare before handing uploads to the seam; never gate local display on `images.blockImages`. `on` paths recheck visibility before transport preparation.
- `src/metrics.mjs`: measurement-only metadata accounting injected into native rendering; normalization inventory plus successful-write batched transport/residency counters, with epoch trust distinct from cumulative runtime totals. Native catches accounting errors after committing functional residency so rows/queue remain safe. `/tmux-image-stats` is a local diagnostic only: no detector queries, uploads, messages, model turns or eviction.
- `src/pdf.mjs`: bounded two-page Poppler rasterization with temporary-file cleanup.
- `test/*.test.mjs`: dependency-free Node tests for parsing, subprocess contracts, cleanup, packaging and presentation; optional `test/host-seam.test.mjs` exercises installed Pi public APIs without model requests.
- `package.json`: explicit Pi package manifest. Extension imports are supplied by Pi as peer dependencies, never bundled runtime dependencies.

## Preserve the important contracts

1. Use Kitty Unicode placeholders (`U=1`), not ordinary positioned image placements. Pixel uploads bypass tmux; placeholder cells go through Pi's normal text layout.
2. The foreground color encodes the image ID. Do not restyle placeholder rows. Keep cursor movement and pixel-upload escapes out of transcript rows.
3. Use standard Pi image content from the built-in read pipeline. Do not filter image messages yourself or change `images.blockImages`; Pi owns model-image policy.
4. Rendering details must not leak uploads or placeholder text into model-facing content. Blocking images does not prevent session storage; document that distinction.
5. Use `triggerTurn: false` for viewer messages emitted during tool execution. Preserve tool-call/result ordering and do not accidentally steer or start another model turn.
6. Preserve `/tmux-image`, `/tmux-pdf`, `tmux_show_image` and `tmux_show_pdf` unless a breaking change is requested.
7. Require interactive Pi inside tmux. Non-interactive calls must fail without writing terminal graphics.
8. Resolve executables through PATH. Do not introduce machine-specific `/nix/store` paths, automatic package installation, persistent environment overrides, or stdout monkey patches.
9. Use subprocess argument arrays, never a shell. Keep timeouts and output limits. Remove PDF scratch files on success, error and cancellation.
10. Do not mutate the user's Pi settings or tmux configuration in the extension. Installation testing must use an isolated agent directory.
11. Preserve capability gates for initial display, snapshot/legacy replay, resizing and refresh; release native upload reservations if a post-preparation capability check fails. Refresh must invalidate detector decisions, presentation failures and residency together, not rely on cache TTL. Sync ready-row policy gates must remain subprocess-free. Unknown/nested/multi/control/linked paths fail closed; no force/native ownership workaround.

## Verification

- Run `npm test` before committing.
- Run optional actual-host tests with `PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent/package PI_IMAGE_HOST_MODULE=/path/to/installed/coding-agent/package/dist/index.js npm test` and `PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent/package node --test test/host-integration.mjs`. The root must contain `dist/index.js` and its host-supplied `node_modules/@earendil-works/pi-tui`; do not install physical host dependencies into this repository. Stream/component assertions are automated evidence, not human-observed pixels.
- Verify `pi install .` using a temporary `PI_CODING_AGENT_DIR`, not the active user's settings. Inspect package discovery/loading without contacting an LLM provider.
- For changes to Pi APIs, consult the installed Pi docs and extension examples. The tested starting API version is Pi 1.0.3; do not guess newer signatures.
- For renderer changes, visually test images and PDFs: new text, scroll up/down, pane position, resizing, and switching windows. State explicitly which checks were automated versus human-observed.
- Snapshot replay, runtime-only legacy migration and `/tmux-image-refresh` are automated-tested. Refresh clears failed prepared records and residency, without file rereads, new messages or model turns. Shutdown/reload deliberately retains prior-runtime terminal resources to avoid orphaning scrollback; never globally delete images. Prior-runtime graphics memory can remain until terminal reset; budgeting and universal reconnect detection are not implemented.
- `test/host-integration.mjs` uses a temporary PATH-resolved fake tmux executable plus isolated public SDK settings to test supported/unsupported paths without querying the active tmux server. Preserve zero-graphics/pre-source rejection, public preference precedence, both model-blocking states, ready-row disablement and explicit denied-to-supported refresh recovery with unchanged messages/turns. Do not add package runtime test flags.
- Metrics must derive normalized payload identity from exact PNG bytes and count wrapped wire totals once per successful current-epoch write, including every restored prototype; never treat describe/preparation/failure/stale/zero-byte reuse as transport. Epoch reset clears local trust, not terminal resources. Report accounting failures explicitly without breaking residency/rows. PNG/RGBA estimates are not terminal ACKs or global/GPU memory bounds; external/prior-runtime resources and overhead are unobservable. Eviction/budget settings remain disabled until separately owner-approved.
- Native visual acceptance remains pending: image/PDF pixels, transcript scrolling, pane position, shrink/expand/zoom, partial viewport visibility and window switching still require coordinated human observation. Automated geometry/stream tests do not establish those pixels. Preserve the two-page PDF default.
- Keep README installation examples and limitations consistent with the code.

## Repository hygiene

- Keep screenshots, PDFs, generated PNGs, logs, credentials, session data, node_modules and machine-local integration fixtures out of Git.
- Preserve unrelated work. Do not push or create a remote GitHub repository unless asked.
- Commit completed changes locally with a clean working tree. This package has no declared license yet; do not choose a license without the owner's decision.
