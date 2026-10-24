# pi-tmux-image

Display images and PDF pages in [Pi](https://pi.dev) inside tmux, with images that move with the transcript and survive scrolling.

Uses native Kitty **Unicode placeholders**: image pixels are uploaded through tmux passthrough, while ordinary text cells anchor the image. Simply forwarding Kitty image commands is not enough to keep graphics positioned correctly inside a pane. PNG encoding is built in; other advertised image formats are normalized with Pi's public converter. Chafa is no longer required.

## Requirements

- Pi with the `@earendil-works` extension APIs (tested with Pi 1.0.3).
- A recognized Unicode-placeholder terminal: current Ghostty (>=1.0) or Kitty (>=0.28). Native PNG and two-page PDF display, transcript scrolling, tmux zoom/unzoom, window switching, explicit refresh and reload recovery appearance were human-observed on Ghostty 1.3.1 behind tmux 3.6a with Pi 1.0.3 and model image blocking enabled; the remaining visual corners are listed below.
- tmux with effective pane `allow-passthrough` set to `on` or `all` (read-only detection tested with tmux 3.6a).
- Pi local images and truecolor enabled. The package reads public Pi settings/capabilities; explicit `terminal.showImages: false`, `terminal.images: false`, iTerm2 selection or disabled truecolor is respected as a local-display rejection.
- Pi's native image protocol must remain at automatic tmux detection (`terminal.images: auto`, normally no native protocol). Forced Pi Kitty graphics are rejected because host redraws can delete extension uploads. **The current Ghostty/tmux setup needs no forced image-protocol setting.**
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
The entrypoint is `extensions/tmux-image/index.ts`, so Pi displays the extension
as **`tmux-image`**. If you load the entrypoint directly rather than installing
this package, use that path.

**If you used the original spike:** remove `.pi/extensions/tmux-images-spike.ts` from that project before loading this package. Both versions register the same command and tool names.

## Use

In Pi:

```text
/tmux-image /path/to/image.png
/tmux-pdf /path/to/document.pdf
/tmux-image-refresh
/tmux-image-stats
/tmux-image-view
```

PDFs show the **first two pages**. Paths resolve relative to Pi's working directory. For a slash command, the entire argument is the path; spaces are supported without shell quotes.

You can also ask the assistant to display a file. The package exposes:

| Tool | Arguments | Result |
| --- | --- | --- |
| `tmux_show_image` | `{ "path": "/path/to/image.png" }` | Displays one image |
| `tmux_show_pdf` | `{ "path": "/path/to/document.pdf" }` | Renders and displays the first two pages |

The tools require interactive Pi inside tmux. Before reading an image or rasterizing a PDF, they check the actual pane's inherited passthrough option and its session's attached-client identity. Unknown/old terminals, disabled or unqueryable passthrough and unsupported paths fail with a readable explanation rather than emitting graphics. Print, JSON and RPC calls also produce no terminal graphics. The extension never enables passthrough or changes Pi settings for you.

After terminal reconnect/reset, a visibility change that caused preparation to fail, or correcting display policy/passthrough, run `/tmux-image-refresh`. It rechecks capability, invalidates upload residency and **failed presentation records**, then repaints existing snapshots. It does not reread source files, append attachments, or start a model turn. Pi reload/resume rebuilds native presentation automatically; reconnects are not universally detectable. Detector TTL expiry alone does not retry an already-failed presentation.

Detection is conservative: only a single non-control client in a single-session window and one tmux layer are supported. Multiple attached clients, cross-session-linked windows, nested tmux/screen and unrecognized identities are rejected. Terminal type is authoritative; only an absent type falls back to exact `xterm-ghostty`/`xterm-kitty`. Name-only identities assume a current supported version and produce a warning—they are not feature negotiation. Pi's concrete image preference overrides `PI_IMAGE_PROTOCOL`; `auto`/unset leaves the environment/auto-detection fallback active.

## Snapshot overlay viewer

Click the **ready image cells** (including a particular PDF page) in Pi's
fullscreen mode, or run `/tmux-image-view` in either mode. The command opens the
single stored image automatically; with multiple images it shows a **newest-first
active-branch picker**. Use arrows or `j`/`k`, then Enter. It selects existing
snapshots only—it is not a file-path command, and does not reread images or PDFs.
Labels, padding and loading/error rows are not click targets. With the viewer
closed, transcript drag selection, wheel scrolling and link precedence remain
Pi-owned. Regular mode supports the keyboard path, not image mouse opening.

| Viewer control | Action |
| --- | --- |
| `+` / `-` | Zoom by 1.25×, preserving the source center until edge clamping |
| `0` | Fit and recenter |
| `h` / `j` / `k` / `l` | Pan left/down/up/right by four displayed cells |
| Wheel up/down (fullscreen) | Zoom in/out around the pointer, subject to cell rounding and edge clamping |
| Left-button drag (fullscreen) | Grab the image and pan; pixels follow the pointer |
| Escape | Close; preserve inline image size and editor draft |

**100% Fit** means the initial fitted size, not one terminal pixel per source
pixel. Minimum zoom is 25% of fit; maximum varies with image/aspect/cell size so
the full-image placeholder canvas never exceeds **297×297 cells**. At the limit,
`+` is a no-op and the label shows a limit indication. Zoom enlarges the existing
snapshot; PDFs remain the original first-two-page, 1200-pixel-longest-side
rasters. Every new open starts fit/recentered. Resize retains the fit-relative
zoom factor and source center, clamped to the new bounds. Very small panes (less than **20 columns × 7 rows**) show a
keyboard-owned text fallback until enlarged.

The overlay fills the current pane. In **fullscreen mode**, wheel zoom works
inside the ready image area, and left-drag starts on occupied image cells.
Dragging can continue outside the image area within the pane until release. Motion is
terminal-cell-stepped, not pixel-smooth. Wheel zoom uses 1.25× steps,
ignoring Pi's transcript-scroll acceleration; synchronous bursts coalesce to the
latest direction/position. During a guarded zoom update, the last valid image
stays visible with an “Updating viewport…” status. One latest wheel event is
retained and applied after the new ready frame renders, rather than accumulating
a backlog. Same-canvas pan is a resident text-only update without upload
preparation or tmux queries. Picker, chrome, initial loading/error rows and
tiny-pane fallback consume mouse input
without changing the viewport. Resize/cell changes, keyboard or wheel input cancel
an active grab. Regular mode remains keyboard-only; the terminal owns its mouse
and scrollback. Unknown keys do not reach the hidden editor. Close any existing
Pi dialog/search before
opening; if a new host dialog or fullscreen search takes focus, the viewer closes
and exposes that host UI. Reserved host global keys are not trapped. Refresh,
reload, widget replacement and session/branch changes also close the viewer.

Viewing, controls and closing add **no session messages, attachments or model
turns** and do not change image-blocking settings. The viewer shares resident PNG
pixels with inline images but owns one separate, reusable private placement.
Pan updates addressed text cells without graphics commands; zoom/resize replaces
that private prototype. Close removes its cells and synchronously flushes Pi's
public removal frame before scoped placement retirement,
never deleting shared PNG pixels or inline history. If capability denial prevents
retirement, one bounded pending obligation blocks unsafe reuse; a later supported
open or `/tmux-image-refresh` retries it.

The original 0.3.0 viewer controls and lifecycle passed the production public SDK matrix (**15/15**),
host-enabled suite (**181/181**) and existing offline SDK suite (**12/12**).
These are automated stream/component checks, not terminal pixel observations.
**The owner generally accepted package 0.3.0 (`210d524`)** on Ghostty 1.3.1 /
tmux 3.6a / Pi 1.0.3 with `terminal.images: auto` and `images.blockImages: true`:
“all is working!” after being asked to reload and try click-open/zoom/pan/reset/Esc.
This was not a case-by-case report; narrower unreported checks remain
automated-only or human-pending. See `docs/viewer-verification.md` for detailed
remaining cases and `docs/viewer-seam.md` for the public UI evidence boundary.
The **0.4.0 wheel/grab enhancement (`fcf465f`)** was also generally owner-accepted:
“it works!” after being asked to reload and try wheel zoom and dragging.
`docs/viewer-mouse.md` records separate automated verification and the scope of
that confirmation; narrower edge/resize/trackpad checks remain unreported.
The owner subsequently reported slow/janky zoom and pan. **0.4.1** removes
avoidable pan preparation and placeholder width scans, retains valid zoom frames,
and keeps one latest busy-phase wheel event. Upload capability checks are
unchanged. See `docs/viewer-performance.md` for measurements and verification;
improved live responsiveness still needs the owner's follow-up.

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
- Inline display grids aspect-fit within 60 columns by 24 rows using actual component width and Pi's supported cell-pixel dimensions. The vertical policy reserves 8 terminal rows for Pi chrome/editor (minimum one image row); it is a bound, not an exact measurement of every transcript viewport. Width/height/cell-size changes prepare new geometry-versioned placements without retransmitting resident PNGs. Superseded pending resize work is coalesced; completed geometries can be reused when resizing back.
- Local normalization is bounded to 16 MiB input, 64 MiB PNG output, 8192 pixels per dimension and 16 million pixels. These are local image limits, not PDF file-size limits.
- Pi reports normalized PNG bytes and anticipated upload chunks; `/tmux-image-stats` measures successful runtime transport and estimated residency, including retained inline versus live/private viewer surfaces and successful replacement/retirement commands. Shared PNGs transmit once per runtime connection; additional occurrences or geometries need only virtual placement commands. There is no graphics-memory eviction policy.
- PDF scratch PNGs are removed after viewing. Versioned messages keep the standard image snapshot plus label/geometry metadata, not temporary paths as their pixel source or duplicated pixels in details.
- Native and known unversioned Chafa messages prepare from stored snapshots when rendered, including after reload/resume, without rereading the source file. Legacy migration is runtime-only: old upload IDs/cells are ignored and stored content/details are unchanged. Missing/malformed snapshots and unsupported future schemas show readable fallbacks. Use `/tmux-image-refresh` for explicit terminal-reconnect recovery or retrying failed presentation.
- The extension deliberately retains terminal pixels/placements across shutdown/reload to avoid orphaning retained scrollback; it never globally deletes images. Within a runtime, PNG retransmission of the same image ID restores **all previously committed occurrence/geometry prototypes** before painting cells: Kitty replaces that image and deletes its placements on retransmit. This preserves known older grids even when refresh is invoked without an actual terminal reset. A fresh runtime rebuilds current-session snapshots with new IDs but cannot discover/rewrite arbitrary previous-process terminal scrollback after a reset. Previous-runtime resources can remain until the terminal resets. Graphics budgeting/eviction is not implemented.
- Non-PNG normalization uses Pi's in-process converter. Cancellation is cooperative between steps, not preemptive during decoding. PDF conversion retains a bounded 30-second Poppler timeout.
- Capability subprocesses use argument arrays, PATH, a 300 ms timeout per query and an 8 KiB output bound. Up to three sequential read-only queries establish a path. Results cache for 5 seconds (failures 250 ms); `on` paths resample visibility before source access/upload preparation. This is not a delivery acknowledgement: unannounced client changes can require explicit refresh, and cached/physical old scrollback is not rewritten by policy changes. There is no force override for unsupported paths.
- The old Chafa renderer was human-tested in Ghostty/tmux. Native encoding, ordering, normalization, reload/resume, legacy snapshots, geometry resizing, clipping, refresh, capability rejection and public-policy behavior have automated checks. With `terminal.images: auto` and `images.blockImages: true`, the owner confirmed initial native PNG display, correct rendering of both PDF pages, scrolling up to the earlier PNG and back to the PDF, and zoom/unzoom with the same scrolling checks repeated successfully. Images survived continued conversation and scrolling in that live sequence. The owner also confirmed switching to another tmux window and back, `/tmux-image-refresh`, and correct appearance after `/reload` when asked to revisit the earlier PNG and both PDF pages. The core requested live checks now pass on this setup. Separate pane-position checks, width/height drags, isolated height/cell-size resizing, deliberate partial-edge cropping, reconnect/resume, other image formats and other terminals remain pending human visual verification. Sources were not removed in the live reload check; source-deleted/no-reread replay is automated SDK evidence only.

## Graphics measurements

Run `/tmux-image-stats` for local runtime diagnostics: normalized PNG inventory,
known resident image/payload counts, inline/viewer surface counts, occurrence/geometry
prototypes, estimated RGBA bytes, and exact successful encoded wire bytes/PNG
chunks/placement/replacement/retirement commands
for the current epoch and cumulatively across this runtime. It does not upload,
probe tmux, change settings, append messages or start model work.

These are **locally tracked successful writes, not terminal acknowledgments**.
Wire totals include Kitty/tmux framing but exclude transcript cells and unrelated
Pi output. RGBA is only `width × height × 4`, not measured RAM/GPU usage. Failed
writes may have unknown partial effects; prior-runtime/external pixels and
terminal/GPU/cache/metadata overhead cannot be counted. Refresh resets residency
trust and epoch totals, not terminal resources; runtime transfer totals and
normalization inventory remain. Accounting errors produce an explicit diagnostic
without interrupting display or forcing reuploads.

**Eviction remains disabled**, with no default limit or budget setting. Long
history and prior-runtime allocations are deliberately retained; measurements do
not impose a global graphics-memory bound. See `docs/graphics-memory.md` for
scope and simulated fixture/stress evidence, distinct from actual successful
captured-stream accounting and still-pending human memory observations.

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

See `docs/renderer-seam.md`, `docs/viewer-seam.md`, `docs/viewer-crop.md`, `docs/viewer-lifetime.md`, `docs/kitty-protocol.md`, `docs/pixel-normalization.md`, `docs/capabilities.md` and `docs/graphics-memory.md` for integration boundaries, public-policy sourcing and specification attribution. The protocol helpers follow the public Kitty specification; no OMP implementation was copied and no project license has been selected.

After changing the extension, coordinate `/reload` and visually verify images/PDFs, scrolling and pane/window behavior in a real tmux pane. Automated stream/component tests cannot establish that a terminal actually displays the image.
