# pi-tmux-image

View images and browse PDFs in [Pi](https://pi.dev) inside tmux. Open the viewer to zoom and pan.

## Setup

Requires **interactive Pi inside tmux**, **Ghostty ≥1.0 or Kitty ≥0.28**,
truecolor and local images enabled. Use one tmux layer and one attached client.
For PDFs, install **Poppler** with `pdfinfo` and `pdftoppm` on Pi's PATH.
Leave Pi's `terminal.images` at its normal `auto`; forcing `kitty` is unsupported.

Enable passthrough and install:

```sh
tmux set-option -g allow-passthrough on
pi install git:github.com/micha/pi-tmux-image
```

For future sessions, add `set -g allow-passthrough on` to `~/.tmux.conf`.
For a first install, run `/reload` inside Pi. When updating an already-loaded
version on Pi 1.0.3, restart Pi and resume the session: `/reload` can retain old module code.

## Use

```text
/tmux-image /path/to/image.png
/tmux-pdf /path/to/document.pdf
/tmux-image-view
```

Use `/tmux-image-view` to open stored images/PDFs, or ask the assistant to display a file.
Paths are relative to Pi's working directory; spaces need no quotes.

- `+` / `-`: zoom; `0`: fit and recenter.
- `h` / `j` / `k` / `l`: pan left / down / up / right.
- PDFs: `n` / PageDown: next; `p` / PageUp: previous; `g`, page number, Enter to jump.
- Escape closes (or cancels a page jump).

In **fullscreen mode**, click an image to open, wheel to zoom, drag to pan.
Regular mode is keyboard-only. If images disappear, run `/tmux-image-refresh`.
Viewing uses stored copies, not live files. PDF zoom adds no extra detail.
Closing or changing pages can require a fresh upload of the cached image; pan and zoom reuse the current upload.

## PDFs and privacy

The transcript shows **only page 1**; browse other pages in the viewer.

- **Up to 32 MiB:** Keep automatically stores the captured original in the session.
  Above that, choose **Keep / Temporary / Cancel**.
- **Temporary:** browsing is lost on reload, switching sessions or exit; the preview remains in history.
- **Keep:** sessions, copies and exports can carry the **whole PDF**, including unseen pages.
  Large documents can increase memory use and slow saving/loading.

Local viewing is independent of `images.blockImages`: it blocks model access, **not storage**.
Original PDF bytes and later pages are not sent to the model.

More: [PDF caveats](docs/pdf-document-viewer.md) · [terminal compatibility](docs/capabilities.md).
