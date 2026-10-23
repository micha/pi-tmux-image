# Local PNG normalization from Pi attachments

## Decision and integration contract

Use **Pi's supported public `convertToPng` export**, not a private image module,
Chafa capture, Photon imported as an undeclared transitive dependency, or an
additional decoder package. Verified against installed Pi **1.0.3**: the package
root's `dist/index.js` and `dist/index.d.ts` both export this facility. Its declared
signature is:

```ts
convertToPng(base64Data: string, mimeType: string): Promise<{
  data: string;
  mimeType: string;
} | null>
```

The extension provides the host function explicitly:

```ts
import { convertToPng } from "@earendil-works/pi-coding-agent";
import { normalizeAttachment } from "../src/normalize.mjs";

const image = message.content.find(block => block.type === "image");
const normalized = await normalizeAttachment(image, { convertToPng, signal });
// normalized.pngBytes is suitable for Kitty f=100.
```

`normalizeAttachment(attachment, options)` returns:

- `pngBytes`: an owned Buffer, separate from persisted attachment data;
- `width`, `height`: PNG dimensions after host conversion/orientation;
- `sourceMimeType`: the attachment MIME, not necessarily the source file MIME;
- `inputBytes`, `outputBytes`: binary encoded sizes, not base64 character counts.

`options` accepts `convertToPng`, `signal`, and `limits`. Exported
`DEFAULT_NORMALIZE_LIMITS` and `NORMALIZE_MIME_TYPES` are frozen values. The helper
has no host import and can be tested without installing Pi. Non-PNG input without
the supplied host converter fails explicitly. A host conversion returning `null`
or invalid/non-PNG output fails explicitly; it does not reread the original file.
There is no new runtime dependency or package manifest change for normalization.

The helper reads **only** standard `ImageContent`'s `type`, `data`, and `mimeType`,
capturing these primitives before awaiting conversion. It never changes those
fields, receives no source path, does not read files, and emits no terminal bytes.
Store only standard attachment content in the session; cache the returned Buffer
at runtime, outside model-facing content. Do not duplicate PNG payloads in message
rendering details merely to persist a cache.

## Formats and still frames

Accept PNG, JPEG, GIF, WebP, and BMP. The host read tool advertises all five.
Installed Pi's read processing preserves its supported PNG/JPEG/GIF/WebP formats
when within resize limits and converts BMP to PNG. Thus the normalizer normally
sees `image/png` for a read-tool BMP, but it also handles a direct standard BMP
snapshot using the public conversion facility.

Ordinary PNG attachment bytes pass through byte-identically after framing and bounds
checks. APNG snapshots are reduced to the default still PNG as described below.
JPEG conversion uses the host's EXIF orientation handling; use returned
PNG dimensions, since orientation can swap width and height. GIF and animated
WebP produce **one still PNG** through the host decoder, not an animation. Tests
verify first-frame behavior using a red-then-green GIF and an animated WebP whose
frames are the same static fixture. The latter establishes successful animated
container decoding and still output, not distinct-color WebP frame selection.
An additional live Google animated-WebP fixture also converted successfully.

Animated PNG is not recognized by Pi 1.0.3's standard read MIME sniffer: it rejects
`acTL`, rather than passing it through `processImage`. Nevertheless, a stored or
other standard `image/png` snapshot containing APNG is handled locally: remove
only `acTL`, `fcTL`, and `fdAT` chunks, preserving the ordinary IDAT default image
and every retained chunk's original bytes and CRC. No pixel decoder is needed and
the model attachment is unchanged. The selected still is the **default PNG image**;
when APNG excludes its default image from the animation, that is not animation
frame zero. This is an explicit still-selection policy rather than animation.
The extension's initial `createReadTool` gate still cannot acquire an APNG file on
this host; broadening native Pi read format detection is outside this helper.

WebP VP8X canvas, VP8/VP8L coded dimensions and animation frames are each bounded
independently, without imposing canvas/coded-size equality. This avoids adding a
local variant restriction; the host decoder owns full container validation.
Actual-host tests include extended lossless VP8X+VP8L in addition to plain VP8L.
Corrupt or unsupported variants within advertised formats may still fail the host
decoder; the helper does not promise every codec variant supported by Chafa.

## Resource and validation boundaries

Defaults apply to the **attachment snapshot**, after Pi's own read preprocessing:

| Bound | Default |
|---|---:|
| Input encoded bytes | 16 MiB |
| PNG output encoded bytes | 64 MiB |
| Either pixel dimension | 8192 |
| Pixel area | 16,777,216 |

The input base64 character count is bounded before decoding/allocation; canonical
base64 is required. Header/container inspection bounds dimensions before invoking
the host decoder: PNG IHDR, JPEG SOF, GIF logical canvas and every frame, BMP DIB,
WebP VP8/VP8L/VP8X and animation envelopes **plus nested coded frames**. WebP nested
inspection permits only one animation-envelope level. Oversize images are
rejected, not silently resized by this helper. Check PNG byte size and dimensions
again after conversion. Options can adjust these positive safe-integer limits;
unknown limit names fail.

These are encoded-size and declared-dimension bounds, **not a sandbox or hard
process-memory guarantee**. Header checks do not validate every CRC, entropy
stream or pixel. The host decoder owns actual image decoding and variant support;
PNG passthrough is not decoded/recompressed. Peak memory includes input and output
Buffers/base64, nested WebP inspection copies, host RGBA allocations, orientation
copies, and retained WASM memory, not just `width * height * 4` (at the default
pixel cap, that estimate is 64 MiB). This is not graphics residency budgeting.

Pi's public converter calls synchronous Photon WASM decoding after lazy loading.
An `AbortSignal` is checked before work and after conversion, but **cannot preempt
that synchronous decode**. No misleading Promise-race timeout is used. A hard CPU,
wall-time or process-memory limit would require a separately designed isolated
worker/process boundary; it is not claimed here. Prepare asynchronously and cache
normalization outside synchronous component `render(width)` calls.

## Model policy: actual-host test approach

`images.blockImages` is exclusively Pi's responsibility. `convertToPng` and this
normalizer are local presentation operations and do not consult it. Blocked
images can still exist in session storage; blocking is not session redaction.

Important distinction verified in installed source:

- Public standalone `convertToLlm(messages)` converts custom image messages to
  user messages but does **not** apply the image-blocking setting.
- Public `createAgentSession()` installs its settings-aware conversion wrapper in
  public `session.agent.convertToLlm`. That wrapper dynamically reads
  `SettingsManager.getBlockImages()`, replacing images in user/tool-result content
  with `Image reading is disabled.` when enabled.
- `session.agent.convertToLlm(session.messages)` therefore exercises the actual
  SDK model-conversion pipeline **without a provider request**. Both the property
  and `session.agent` are public declarations, not private imports.

An isolated harness can use `SettingsManager.inMemory`,
`SessionManager.inMemory`, a custom no-discovery `ResourceLoader` (see Pi's checked
`examples/sdk/12-full-control.ts`), and `ModelRuntime.create` with scratch auth/model
paths, `refreshOnCreate: false`, `allowModelNetwork: false`. Seed a standard custom
message via `appendCustomMessageEntry`, create the session, toggle only in-memory
settings, and assert the conversion results. Local normalization must succeed in
both states and persisted snapshot/message counts must remain unchanged.

This worker ran that harness: blocking on -> zero model images, off -> one eligible
image; both states normalized locally and retained one persisted attachment. No
`prompt()`, provider request, network model discovery, active agent configuration
change or extension reload occurred. Full tool-turn ordering/integration belongs
to the coordinator's integration harness. For a full turn, the public
`session.agent.streamFunction` or `ModelRuntime.streamSimple` can be replaced with
an offline response stream rather than contacting a real provider.

## Automated verification

Portable suite:

```sh
node --test test/normalize.test.mjs
npm test
```

Two optional actual-host tests require the file URL of the installed package's
**public root entry**, without adding a dependency:

```sh
PI_IMAGE_HOST_MODULE="file:///absolute/path/to/pi-coding-agent/dist/index.js" \
  node --test test/normalize.test.mjs
```

They exercise PNG, JPEG, GIF, animated GIF, lossy WebP, plain and extended lossless
WebP, animated WebP, and BMP with the real root `convertToPng`; verify still-frame
GIF pixels; then read
each fixture with public `createReadTool`, delete the original file, and normalize
the remaining standard attachment. BMP read output is confirmed PNG. Scratch
files are cleaned in `finally`; the normalizer never knows their paths. Fixtures
are small synthetic encoded test constants, not machine-local screenshots.

Both optional tests passed on Pi 1.0.3. Portable tests cover byte/dimension limits,
truncated/hostile headers, MIME/base64 rejection, APNG default-still selection,
decoder failure,
missing decoder, output validation, cooperative cancellation and attachment
immutability (including mutation of the caller object while conversion awaits).
This worker performed no terminal visual tests; these tests prove normalization
and host model-policy conversion, not pane placement, scrolling or upload replay.

## Primary evidence

Context7 was already exhausted, so research used current installed primary docs,
checked examples, declarations, and implementation rather than guessed APIs:

- Pi package root export map and `dist/index.{js,d.ts}`: public conversion export.
- `dist/utils/image-convert.{js,d.ts}`: signature, PNG passthrough, host conversion,
  null failure, EXIF handling and freeing Photon images.
- `dist/utils/photon.js`: host-owned lazy Photon loading; no extension dependency
  or private import needed.
- `dist/utils/mime.js`, `dist/utils/image-process.js`, `dist/core/tools/read.js`:
  advertised formats, APNG rejection and standard read BMP conversion.
- PNG third-edition specification: https://www.w3.org/TR/png-3/#structure,
  static default image and APNG animation chunk semantics. Only simple chunk
  filtering is implemented; no specification sample implementation was copied.
- WebP RIFF container primary specification:
  https://developers.google.com/speed/webp/docs/riff_container (updated 2025-08-07),
  canvas/coded frame structure and VP8X+VP8L extended-lossless example.
- `dist/core/sdk.js`, `dist/core/messages.js`: settings-aware wrapper versus raw
  message conversion.
- Public `Agent` and `AgentSession` declarations: conversion/stream properties.
- Complete `docs/extensions.md`, `docs/tui.md`, `docs/sdk.md`, `docs/settings.md`,
  `docs/message-types.md`, `docs/session-format.md`; checked SDK full-control,
  settings, extensions, and sessions examples plus built-in tool renderer example.

No substantial OMP, Photon or upstream renderer implementation was copied, and no
project license decision was made.
