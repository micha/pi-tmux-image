# pi-tmux-image

Display images and PDF pages in [Pi](https://pi.dev) inside tmux, with images that move with the transcript and survive scrolling.

Uses native Kitty **Unicode placeholders**: image pixels are uploaded through tmux passthrough, while ordinary text cells anchor the image. Simply forwarding Kitty image commands is not enough to keep graphics positioned correctly inside a pane. PNG encoding is built in; other advertised image formats are normalized with Pi's public converter. Chafa is no longer required.

## Requirements

- Pi with the `@earendil-works` extension APIs (tested with Pi 1.0.3).
- A terminal supporting Kitty graphics **and Unicode placeholders**. Tested with Ghostty behind tmux 3.6a.
- tmux passthrough enabled.
- Pi's native image protocol must remain at automatic tmux detection (normally no native protocol). Forced Pi Kitty graphics are rejected because host redraws can delete extension uploads.
- For PDFs, `pdftoppm` on PATH, from the Poppler command-line tools.

Enable passthrough for your tmux server:

```sh
tmux set-option -g allow-passthrough on
```

For future sessions, add this to `~/.tmux.conf`:

```tmux
set -g allow-passthrough on
```

`all` also works, but permits passthrough from invisible panes; `on` is sufficient for viewing images in the visible pane.

Install Poppler using your platform's package manager if you need PDFs. For a temporary Nix environment without changing system configuration:

```sh
nix shell nixpkgs#poppler-utils
pi
```

If Pi is already running, adding programs to another shell's PATH does not change Pi's PATH. Start Pi from the environment containing the dependencies.

## Install

From a local checkout:

```sh
cd /path/to/pi-tmux-image
pi install .
```

After the repository has been pushed to GitHub:

```sh
pi install git:github.com/micha/pi-tmux-image
```

The HTTPS repository URL is also accepted:

```sh
pi install https://github.com/micha/pi-tmux-image
```

Run `/reload` in Pi after installation. Local installs load from the checkout without copying it.

**If you used the original spike:** remove `.pi/extensions/tmux-images-spike.ts` from that project before loading this package. Both versions register the same command and tool names.

## Use

In Pi:

```text
/tmux-image /path/to/image.png
/tmux-pdf /path/to/document.pdf
/tmux-image-refresh
```

PDFs show the **first two pages**. Paths resolve relative to Pi's working directory. For a slash command, the entire argument is the path; spaces are supported without shell quotes.

You can also ask the assistant to display a file. The package exposes:

| Tool | Arguments | Result |
| --- | --- | --- |
| `tmux_show_image` | `{ "path": "/path/to/image.png" }` | Displays one image |
| `tmux_show_pdf` | `{ "path": "/path/to/document.pdf" }` | Renders and displays the first two pages |

The tools require interactive Pi inside tmux. They report an error rather than emitting terminal graphics in print, JSON, or RPC mode.

After terminal reconnect/reset, run `/tmux-image-refresh` to invalidate upload residency and repaint existing image snapshots. It does not reread source files, append attachments, or start a model turn. Pi reload/resume rebuilds native presentation automatically; reconnects are not universally detectable, so the explicit refresh is the recovery path.

## Images and model access

Local display and sending images to the model are separate operations. These commands attach standard Pi image content, and **Pi's `images.blockImages` setting controls model access**:

```json
{
  "images": {
    "blockImages": true
  }
}
```

With blocking enabled, you can see the images while the model receives a text placeholder. With blocking disabled, the attachments remain available to Pi's model-request pipeline; actual vision support depends on the selected model and provider.

The extension does not override this setting or install a context filter. Terminal upload sequences and placeholder rows stay in runtime presentation state, not session details or model-facing content. Attachments are stored in Pi's session even when they are blocked from model requests; blocking is not a session-storage privacy setting.

## Limits

- This is an early package based on a working prototype, not a general replacement for Pi's native image renderer.
- Only these commands/tools use the placeholder renderer. Built-in `read` and images from other tools are unchanged.
- PDFs are rasterized to PNG at up to 1200 pixels on the longest side; the original PDF document is not sent to the model.
- PNG, JPEG, GIF, WebP and BMP snapshots are supported. Animated GIF/WebP use a still frame. Pi's built-in read detection currently rejects APNG files before this viewer receives an attachment.
- Display grids aspect-fit within 60 columns by 24 rows using actual component width and Pi's supported cell-pixel dimensions. The vertical policy reserves 8 terminal rows for Pi chrome/editor (minimum one image row); it is a bound, not an exact measurement of every transcript viewport. Width/height/cell-size changes prepare new geometry-versioned placements without retransmitting resident PNGs. Superseded pending resize work is coalesced; completed geometries can be reused when resizing back.
- Local normalization is bounded to 16 MiB input, 64 MiB PNG output, 8192 pixels per dimension and 16 million pixels. These are local image limits, not PDF file-size limits.
- Pi reports normalized PNG bytes and anticipated upload chunks. Shared PNGs transmit once per runtime connection; additional occurrences or geometries need only virtual placement commands. There is no graphics-memory eviction policy.
- PDF scratch PNGs are removed after viewing. Versioned messages keep the standard image snapshot plus label/geometry metadata, not temporary paths as their pixel source or duplicated pixels in details.
- Native and known unversioned Chafa messages prepare from stored snapshots when rendered, including after reload/resume, without rereading the source file. Legacy migration is runtime-only: old upload IDs/cells are ignored and stored content/details are unchanged. Missing/malformed snapshots and unsupported future schemas show readable fallbacks. Use `/tmux-image-refresh` for explicit terminal-reconnect recovery or retrying failed presentation.
- The extension deliberately retains terminal pixels/placements across shutdown/reload to avoid orphaning retained scrollback; it never globally deletes images. A fresh runtime can allocate new IDs while previous-runtime resources remain until the terminal resets. Graphics budgeting/eviction is not implemented.
- Non-PNG normalization uses Pi's in-process converter. Cancellation is cooperative between steps, not preemptive during decoding. PDF conversion retains a bounded 30-second Poppler timeout.
- The old Chafa renderer was human-tested in Ghostty/tmux. Native encoding, ordering, normalization, reload/resume, legacy snapshots, geometry resizing, clipping and refresh have automated checks; native image/PDF pixel correctness and interactive scroll/resize/window-switch checks are still pending.

## Remove

Remove using the same source you installed:

```sh
pi remove /absolute/path/to/pi-tmux-image
# or
pi remove git:github.com/micha/pi-tmux-image
```

Then run `/reload`. The package does not patch stdout, change tmux options, or modify Pi's image-blocking settings.

## Development

The automated tests require only Node.js, without installing the host-provided Pi modules:

```sh
npm test
```

Optional installed-host checks use public Pi APIs without real model requests:

```sh
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent/package \
  PI_IMAGE_HOST_MODULE=/path/to/installed/coding-agent/package/dist/index.js npm test
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent/package \
  node --test test/host-integration.mjs
```

See `docs/renderer-seam.md`, `docs/kitty-protocol.md` and `docs/pixel-normalization.md` for integration boundaries and specification attribution. The protocol helpers follow the public Kitty specification; no OMP implementation was copied and no project license has been selected.

After changing the extension, coordinate `/reload` and visually verify images/PDFs, scrolling and pane/window behavior in a real tmux pane. Automated stream/component tests cannot establish that a terminal actually displays the image.
