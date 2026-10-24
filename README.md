# pi-tmux-image

Display images and first-page PDF previews in [Pi](https://pi.dev) inside tmux. Images stay anchored to the transcript as you scroll; an in-pane viewer adds zoom, pan and PDF pagination.

See the [PDF implementation record](docs/pdf-document-viewer.md) for architecture, automated evidence and the human-pending matrix.

Uses native Kitty Unicode placeholders: pixels pass through tmux, while text cells keep them positioned in the pane.

## Requirements

- **Pi** with the `@earendil-works` extension APIs (tested with Pi 1.0.3).
- **Ghostty ≥1.0 or Kitty ≥0.28**, truecolor, and a single tmux layer with one attached non-control client. Nested tmux/screen, multiple clients and cross-session-linked windows are unsupported.
- **tmux passthrough** enabled (tested with tmux 3.6a):

  ```sh
  tmux set-option -g allow-passthrough on
  ```

  For future sessions, add `set -g allow-passthrough on` to `~/.tmux.conf`. `all` also works, but `on` is sufficient for visible panes.
- **Pi local images enabled**, with `terminal.images: auto` (the normal tmux default). Do not force Pi's Kitty protocol: host redraws can delete these uploads. Explicitly disabled images/truecolor or iTerm2 selection prevent local display.
- **For PDFs:** Poppler's **`pdfinfo` and `pdftoppm`** on Pi's PATH. Install them with your package manager, or start Pi inside `nix shell nixpkgs#poppler-utils`. Changing another shell's PATH does not change a running Pi's environment.

The extension checks support and fails with an explanation before reading files or emitting graphics. It never changes your Pi settings or tmux configuration. See [capability detection](docs/capabilities.md) for the exact policy.

## Install

```sh
pi install git:github.com/micha/pi-tmux-image
```

Or, from a local checkout:

```sh
cd /path/to/pi-tmux-image
pi install .
```

Run `/reload` in Pi. Local installs load directly from the checkout. The extension appears as **`tmux-image`**; its entrypoint is `extensions/tmux-image/index.ts`.

## Use

| Command | Action |
| --- | --- |
| `/tmux-image /path/to/image.png` | Display an image |
| `/tmux-pdf /path/to/document.pdf` | Submit one page-one preview; open it to browse the captured PDF |
| `/tmux-image-view` | Open a stored image/PDF document, or choose from a newest-first active-branch picker |
| `/tmux-image-refresh` | Recheck support and repaint stored images after terminal reset/reconnect or a corrected setting |
| `/tmux-image-stats` | Show local transport and estimated graphics-residency diagnostics |

Paths are relative to Pi's working directory. The entire slash-command argument is the path; spaces need no shell quotes.

You can also ask the assistant to display a file using `tmux_show_image` or `tmux_show_pdf`, each taking `{ "path": "/path/to/file" }`. Display requires interactive Pi inside tmux; print, JSON and RPC modes emit no graphics.

Refresh uses stored snapshots: it does **not** reread files, add attachments or start a model turn. Reload/resume rebuilds presentation automatically, but terminal reconnects are not universally detectable; use refresh if images disappear or a failed display needs retrying.

### Zoom, pan and PDF pages

In Pi's **fullscreen mode**, click ready image or PDF-preview cells to open the viewer. New PDFs open on page 1; old sessions' independent PDF-page snapshots still open as individual images. `/tmux-image-view` works in either mode and selects stored snapshots/documents, not file paths. In the picker, use arrows or `j`/`k`, then Enter.

| Control | Action |
| --- | --- |
| `+` / `-` | Zoom in/out by 1.25× |
| `0` | Fit and recenter |
| `h` / `j` / `k` / `l` | Pan left/down/up/right by four cells |
| Wheel up/down (fullscreen) | Zoom around the pointer |
| Left-button drag (fullscreen) | Grab and pan |
| `n` / PageDown (PDF) | Next page; stop at the last page |
| `p` / PageUp (PDF) | Previous page; stop at page 1 |
| `g` (PDF) | Enter a 1-based page number; Enter goes, Escape cancels the field |
| Escape | Close (unless editing a page jump), preserving inline size and the editor draft |

**100% Fit** is the initial fitted size, not source-pixel scale. Zoom ranges from 25% of fit to an image-dependent maximum bounded by a 297×297-cell canvas. Each open and every actual PDF page change fits and recenters, including revisits; requesting the already-ready page is a no-op. Resize preserves/clamps the current page's zoom and source center. Pan is terminal-cell-stepped, not pixel-smooth. Panes smaller than 20×7 show a keyboard-only text fallback: PDF pagination/jump remains usable, but new page rendering waits until the pane is large enough. Invalid jumps stay editable with an inline error.

Mouse input requires a ready image: wheel zoom uses its display area, while dragging starts on occupied image cells. Regular mode is keyboard-only. Close existing Pi dialogs/search before opening. A new host dialog/search, refresh, reload or session/branch change closes the viewer. Viewing and controls add **no messages, attachments or model turns**.

Updates present the latest desired viewport rather than queuing every input event. Slow terminal output can still lag; there is no terminal display acknowledgment. See [viewer pacing](docs/viewer-pacing.md) for timing details.

## PDF retention and privacy

New PDF imports submit **one conversation entry with one standard page-one image** and `Page 1 of N`. Later pages are local viewer work, not additional conversation attachments. The original is captured once; editing or deleting the source afterward does not change that document. Page 1 always uses its stored preview, including on refresh or revisit.

- **At or below 32 MiB (33,554,432 original PDF bytes):** Keep is selected without a prompt.
- **Above 32 MiB:** the user, not the assistant, chooses **Keep / Temporary / Cancel**, for both `/tmux-pdf` and `tmux_show_pdf`.
  - **Keep** embeds the full captured original once in the preview entry's session `details`.
  - **Temporary** stores only the preview and metadata in history. A private runtime copy supports pagination through close/reopen, branch navigation and refresh, but is lost on reload, new/resumed/forked session-runtime replacement or process exit. Afterward the page-one preview still works and explains that the original was not retained.
  - **Cancel**, an unavailable selector or an invalid selection imports no entry. Failed Keep is never silently changed to Temporary.

Base64 alone costs `4 × ceil(original bytes / 3)` characters—about one third more than the PDF—plus preview, metadata and JSON overhead. Large Keep entries can make Pi's synchronous save/load/fork operations expensive and require substantial memory. **There is no fixed application PDF-size ceiling**, but allocation, string/JSON/storage limits and subprocess bounds can still make an import fail. Temporary avoids embedding the original, not every memory or processing cost.

**Keep originals are not model-facing content, but they are session data.** Raw JSONL, copied/forked sessions, backups, trash and HTML exports can carry the full PDF, including pages never viewed. Compaction/model blocking is not erasure. Deleting one session does not delete its copies; there is no post-import original-removal command or automatic history rewrite. Keep respects Pi's normal persistence and `--no-session` policy: an unsaved or ephemeral session is not guaranteed recoverable after restart.

The PDF tool truthfully reports **submitted preview and selected retention**, not confirmed display or durable storage. Pi's extension send returns void; during a tool turn, preview delivery follows tool results. All preparation failures/cancellation before submission create zero preview entries, but an accepted send cannot be retracted and later host errors cannot retroactively fail an already-returned tool. Do not blindly retry an ambiguous submission. See [publication and evidence limits](docs/pdf-document-viewer.md#publication-boundary).

Private PDF/page scratch is removed after orderly abort/drain, failure and shutdown. Abrupt termination can leave OS-temporary files; cleanup is **not secure erasure** and does not sandbox arbitrary subprocess descendants.

## Images and model access

**Local display and model access are separate.** Image commands and PDF page-one previews attach standard Pi image content; Pi's `images.blockImages` setting controls whether the model receives it. Original PDF bytes stay in session details only for Keep; viewer pagination never sends later pages to the model:

```json
{
  "images": {
    "blockImages": true
  }
}
```

With blocking enabled, you see images while the model receives a text placeholder. Otherwise, vision support depends on the model/provider. The extension never overrides this setting; terminal graphics and placeholder rows are not model-facing content.

**Attachments are still stored in Pi sessions when blocked.** Model blocking is not a session-storage privacy setting.

## Limits and compatibility

- Only this package's commands/tools use its renderer; built-in `read` and other tools are unchanged.
- PNG, JPEG, GIF, WebP and BMP are supported. Animated formats use a still frame; Pi's read pipeline currently rejects APNG before the extension receives it.
- PDF pages are rasterized to PNG at up to 1200 pixels on the longest side. Only a requested later page invokes new rasterization; zoom, pan and ordinary resize do not. Later-page rasters may differ across Poppler/fonts/platform versions; page 1 remains its exact stored snapshot. Password-required/unreadable PDFs are rejected; password input, text extraction/search, prefetch and higher-resolution rendering are not provided.
- Inline images aspect-fit within 60×24 cells, with an eight-row reserve for Pi's UI. This is a bound, not an exact transcript-viewport measurement.
- Image normalization is bounded to 16 MiB input, 64 MiB PNG output, 8192 pixels per dimension and 16,777,216 pixels total. These are not PDF file-size limits. See [normalization](docs/pixel-normalization.md).
- Stored snapshots support replay without source files. After a terminal reset, arbitrary previous-process scrollback cannot be reconstructed.
- **No graphics-memory budget or eviction.** Each distinct normalized PDF-page PNG can add to native cache/residency inventory; a single page runner/private viewer slot is not a total memory bound. Terminal resources are deliberately retained across reload/shutdown to preserve scrollback, and may remain until terminal reset. `/tmux-image-stats` tracks successful local writes and residency estimates, not terminal acknowledgments or measured RAM/GPU usage. See [graphics measurements](docs/graphics-memory.md).

Core image/viewer behavior has general owner acceptance on **Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3**. **New PDF pagination/retention visuals and responsiveness remain human-pending**; prior two-page-PDF observations do not establish them. Other terminals, formats and narrower resize/edge/reconnect cases are not fully visually verified; this is not a measured latency guarantee. See [verification](docs/verification.md), [viewer verification](docs/viewer-verification.md) and the [PDF record](docs/pdf-document-viewer.md) for coverage.

## Remove

Use the same source you installed, then run `/reload`:

```sh
pi remove git:github.com/micha/pi-tmux-image
# or
pi remove /absolute/path/to/pi-tmux-image
```

## Development

Run `npm test` with Node.js; no host Pi modules need installing. See [verification](docs/verification.md) for optional offline installed-host tests and [AGENTS.md](AGENTS.md) for contribution contracts and task-specific docs.

Coordinate live reloads and visual checks after renderer changes: automated stream/component tests cannot prove terminal pixels.
