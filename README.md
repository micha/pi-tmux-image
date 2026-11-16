# pi-tmux-image

View images and browse PDFs in [Pi](https://pi.dev) inside tmux. Open the viewer to zoom and pan.

## Demo

Image display, zoom/pan and PDF viewing (1 min 16 sec). View fullscreen for clearer text.

https://github.com/user-attachments/assets/30a2393a-9f01-4958-9c75-bd5237e9594e

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

## Remote clipboard

Press **Ctrl+V** or run `/tmux-image-paste` in interactive Pi inside tmux with
**Ghostty ≥1.4**. First use asks for consent; Ghostty may also ask for permission.
The dialog reads a **still, noninterlaced PNG up to 8 MiB**, then makes it ready
for your next prompt. Your draft and existing attachments stay intact; nothing
is submitted automatically. Remove a pending image with `/tmux-image-paste clear`.

- **Stay in the same focused pane; do not type while the dialog is open.**
- **Ctrl+C** cancels import but keeps waiting. It does not cancel terminal
  permission/read; resolve that before leaving or restarting Pi.
- **Ctrl+Q twice** warns, then leaves anyway; late replies may enter your draft.
  Escape keeps the dialog open. New reads stay blocked while unresolved.

Ctrl+V opens the PNG dialog, with no native/text-paste fallback. **Cmd+V remains
ordinary terminal text paste.** Submitted images use normal Pi storage/model
policy; `images.blockImages` blocks model access, not storage.

### Shortcut preferences

Ctrl+V is registered by default only with inherited tmux/pane context; outside
that context native paste is unchanged. To disable or choose another key, start
a **fresh Pi process** (not `/reload`):

```sh
PI_TMUX_IMAGE_PASTE_SHORTCUT=off pi
PI_TMUX_IMAGE_PASTE_SHORTCUT=ctrl+shift+v pi
```

Accepted literal overrides: `ctrl+v`, `ctrl+shift+v`, `ctrl+alt+v`, `off`.
Unset/empty uses the tmux default. Overrides do not enable shortcuts outside tmux.

Pi's native Ctrl+V overlap warning is separate. Optionally **merge** this into your
agent directory's `keybindings.json` to retain native paste on an unused alternative
key (or use `[]` to disable it); the extension never edits your settings:

```json
{ "app.clipboard.pasteImage": "alt+v" }
```

Check `/hotkeys` and host conflict warnings if a key does not activate; reserved
bindings and other extensions may take precedence. Do not use command-plus-Enter
terminal macros to paste into a draft.

[Details, limits and verification](docs/clipboard-paste.md).

More: [PDF caveats](docs/pdf-document-viewer.md) · [terminal compatibility](docs/capabilities.md).
