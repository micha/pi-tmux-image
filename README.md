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

## Experimental remote clipboard

With **Ghostty ≥1.4**, one focused tmux pane/client and interactive Pi:

```text
/tmux-image-paste
/tmux-image-paste clear
/tmux-image-paste cancel
```

The first use asks for consent, then opens **Reading clipboard—do not type**.
The visible dialog captures input so replies—including tmux CSI-u/xterm encoded
markers—do not reach the draft on the supported path. Ghostty may separately ask
for clipboard permission. A valid **still, noninterlaced PNG up to 8 MiB** closes
the dialog and is staged for your next interactive prompt. Existing attachments
are preserved; nothing is submitted automatically.

- **Ctrl+C:** cancel image import locally; keep the dialog visibly draining.
- **Ctrl+Q, then Ctrl+Q again:** acknowledge the warning and leave anyway.
  Late replies can then put protocol/base64 text in your draft.
- If owned dialog cleanup fails, **Ctrl+Q retries removal**.
- **Escape does not leave.** Ordinary typing/text paste is unchanged outside the dialog.
- `clear` removes a pending image; `cancel` stops import **locally only**, not
  Ghostty's permission prompt/read. Cmd+V is unchanged; Ctrl+V is unchanged by default.

**Stay in the same focused pane, client and Pi session, including permission
prompts.** Timeout/cancel keeps the visible waiting/draining dialog by default.
An **UNRESOLVED** state blocks new reads until a clean owned terminal completion
or error arrives, even after explicit dialog exit. Resolve any terminal prompt
before leaving; do not blindly retry, reload or disconnect.

Switching windows can send replies to another pane; another dialog taking focus
can receive them too. There is no protection after pane/client/session/process
changes or knowingly leaving the dialog, and no automatic draft erasure/repair.
If late protocol text appears, inspect/edit it manually.

A pending image is consumed when handed to the next interactive input pipeline,
**not** on a storage acknowledgement. Later input extensions or submission
failure may discard it without automatic retry. Submitted images follow normal
Pi model policy and session storage; `images.blockImages` does **not** prevent
storage. If these risks are unsuitable, transfer a file and use `/tmux-image`.

### Optional clipboard shortcut

No shortcut is registered by default. With this extension configured, explicitly
opt in when starting a **fresh Pi process**:

```sh
PI_TMUX_IMAGE_PASTE_SHORTCUT=ctrl+v pi
```

This intentionally replaces Pi's native Ctrl+V action with the **same** clipboard
dialog, leaving the existing draft/attachments intact and never submitting them.
The opted key is **PNG-dialog-only**: rejection/cancel never falls back to native
clipboard or text paste. Cmd+V stays normal terminal text paste. Accepted literal
values are `ctrl+v`, `ctrl+shift+v` and `ctrl+alt+v` (lowercase, no spaces);
terminal key reporting and Pi's reserved-key rules still apply.
Invalid values warn and leave `/tmux-image-paste` usable.

Pi 1.5.2 warns about native Ctrl+V overlap but uses the opted extension shortcut.
Optionally **merge**, never overwrite, this into your own
`~/.pi/agent/keybindings.json` (or your custom agent directory):

```json
{ "app.clipboard.pasteImage": "alt+v" }
```

Choose an unused alternative key, or use `[]` instead to unbind native paste.
This manual edit is optional; the extension never edits keybindings/settings.
Check `/hotkeys` and startup conflict warnings if the shortcut does not activate;
reserved bindings are skipped and another extension can win a collision.
Use a fresh process/restart-resume, not `/reload`, for extension opt-in changes.
To undo, omit the environment prefix on the next launch and restore any native
binding you manually changed. Do not use terminal macros that type the slash
command plus Enter into a possibly nonempty draft.

Details and automated versus human evidence: [clipboard import](docs/clipboard-paste.md).

More: [PDF caveats](docs/pdf-document-viewer.md) · [terminal compatibility](docs/capabilities.md).
