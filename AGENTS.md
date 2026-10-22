# Instructions for robots

This file is for coding agents. Human-facing installation, usage and limitations belong in `README.md`; do not turn this file into a second user manual.

## Scope and architecture

- `extensions/index.ts`: Pi commands, tools, standard image attachments and custom local renderer.
- `src/graphics.mjs`: Chafa invocation and separation of tmux uploads from Unicode-placeholder rows.
- `src/pdf.mjs`: bounded two-page Poppler rasterization with temporary-file cleanup.
- `test/*.test.mjs`: dependency-free Node tests for parsing, subprocess contracts, cleanup and packaging.
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

## Verification

- Run `npm test` before committing.
- Verify `pi install .` using a temporary `PI_CODING_AGENT_DIR`, not the active user's settings. Inspect package discovery/loading without contacting an LLM provider.
- For changes to Pi APIs, consult the installed Pi docs and extension examples. The tested starting API version is Pi 1.0.3; do not guess newer signatures.
- For renderer changes, visually test images and PDFs: new text, scroll up/down, pane position, resizing, and switching windows. State explicitly which checks were automated versus human-observed.
- Existing grid resizing, upload replay, converter synchronization and two-page limitations are intentional current boundaries. Do not claim they are solved without implementing and testing them.
- Keep README installation examples and limitations consistent with the code.

## Repository hygiene

- Keep screenshots, PDFs, generated PNGs, logs, credentials, session data, node_modules and machine-local integration fixtures out of Git.
- Preserve unrelated work. Do not push or create a remote GitHub repository unless asked.
- Commit completed changes locally with a clean working tree. This package has no declared license yet; do not choose a license without the owner's decision.
