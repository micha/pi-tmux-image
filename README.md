# pi-tmux-image

Display images and PDF pages in [Pi](https://pi.dev) inside tmux, with images that move with the transcript and survive scrolling.

Uses Chafa's Kitty **Unicode placeholders**: image pixels are uploaded through tmux passthrough, while ordinary text cells anchor the image. Simply forwarding Kitty image commands is not enough to keep graphics positioned correctly inside a pane.

## Requirements

- Pi with the `@earendil-works` extension APIs (tested with Pi 1.0.3).
- A terminal supporting Kitty graphics **and Unicode placeholders**. Tested with Ghostty behind tmux 3.6a.
- tmux passthrough enabled.
- `chafa` on PATH (tested with Chafa 1.18.2).
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

Install Chafa and Poppler using your platform's package manager. For a temporary Nix environment without changing system configuration:

```sh
nix shell nixpkgs#chafa nixpkgs#poppler-utils
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
```

PDFs show the **first two pages**. Paths resolve relative to Pi's working directory. For a slash command, the entire argument is the path; spaces are supported without shell quotes.

You can also ask the assistant to display a file. The package exposes:

| Tool | Arguments | Result |
| --- | --- | --- |
| `tmux_show_image` | `{ "path": "/path/to/image.png" }` | Displays one image |
| `tmux_show_pdf` | `{ "path": "/path/to/document.pdf" }` | Renders and displays the first two pages |

The tools require interactive Pi inside tmux. They report an error rather than emitting terminal graphics in print, JSON, or RPC mode.

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

The extension does not override this setting or install a context filter. Terminal upload sequences and placeholder rows stay in rendering details, not model-facing content. Attachments are stored in Pi's session even when they are blocked from model requests; blocking is not a session-storage privacy setting.

## Limits

- This is an early package based on a working prototype, not a general replacement for Pi's native image renderer.
- Only these commands/tools use the placeholder renderer. Built-in `read` and images from other tools are unchanged.
- PDFs are rasterized to PNG at up to 1200 pixels on the longest side; the original PDF document is not sent to the model.
- Display grids are capped at 60 columns by 24 rows. Resizing does not regenerate existing grids; narrow panes show a warning.
- Chafa output is captured with a **64 MiB per-image limit**, with its size reported in Pi. This is not a limit on the PDF file size.
- PDF scratch PNGs are removed after viewing. Standard image attachments and placeholder rows remain in the session.
- Image upload replay after `/reload`, a restart, or terminal reconnection is not implemented. Redisplay the file if old images go blank.
- External converters run synchronously, with a 10-second Chafa timeout and a 30-second PDF timeout. Very large or complex files can fail. Cancellation is checked between processing steps, not during a running converter.

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

After changing the extension, use `/reload` and visually verify scrolling in a real tmux pane. Automated tests cannot establish that a terminal actually displays the image.
