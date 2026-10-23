# Viewer crop / bounded subset feasibility — Step 1

Investigation date: 2026-10-23. Repository checkpoint inspected:
`d324d87e2b2f5abf009a23f9fb27550e4bbd1359`. This note and
`test/viewer-crop-feasibility.test.mjs` are a design/spec harness only. No
production renderer, terminal uploads, active installation, settings or license
changes. See [image-viewer-plan.md](image-viewer-plan.md) for the coordinated gate.
Context7 quota was already exhausted; primary upstream sources were fetched read-only.

## Decision / blocker

**Do not implement `U=1,x/y/w/h` viewport cropping as though it works on the
supported Ghostty terminal.** Ghostty **1.3.1** accepts and stores the source crop
on a virtual prototype, but its Unicode-placeholder rendering path **does not
read that crop**. It fits the original whole image into `c/r`, then computes a
source rectangle from the placeholder row/column subset. Current Ghostty main
has the same boundary. Current Kitty's actual placeholder rendering path also
uses the whole image, not the virtual prototype's stored crop. The protocol's
general layout section is not sufficient evidence for virtual crop support.

Consequently a bounded `80x30` virtual prototype with `x=1000,y=500,w=640,h=480`
and marks beginning at `(0,0)` will not display that requested source window.
It displays the whole image fitted to `80x30`. An `OK` reply (which we suppress)
would prove parsing/storage, not pixels. No human crop observation or compiled
Ghostty execution was performed here. This is a precise implementation-path
blocker, not a claim that all terminals reject cropping.

A viewport subset of a **full-image** virtual prototype is supported in both
inspected renderer paths and is the recommended v1 protocol alternative. Keep
the entire prototype within **297 columns and 297 rows**, then emit only the
visible independently addressed subset. This avoids unsupported source cropping,
new PNG payloads and pan-time uploads. It imposes a dynamic zoom maximum, which
the coordinator explicitly authorized investigating as an honest v1 limit.
For an 8192-pixel-wide image on 8-pixel-wide cells, the maximum natural scale is
approximately `297*8/8192 = 29%`; fit-relative zoom can still enlarge the view
several times. Natural 125% would require about 1280 full-image columns and is
not supported. Never emit that unaddressable canvas. Omitted/inherited marks,
a high image-ID mark or ordinary positioned placements are not workarounds.

**Recommended gate outcome for this worker: source-backed bounded subset is
feasible for implementation review; virtual source-crop is not.** Actual Pi
compositing/lifecycle and owner-observed new pixels remain separate pending
gates. Proposed v1 UX: 100% means initial fit, `+/-` use 1.25× fit-relative steps
and stop at the computed maximum; optionally label natural pixel percentage
separately. Do not claim that 100% means natural pixel size under this convention.
A 1200px-longest-side PDF at 9x18 cells has a natural canvas around 134x67 for
portrait or 134x34 for landscape, leaving useful room before 297. No PDF
rerasterization is needed.

Other options, not prerequisites to this honest limited v1: pursue upstream
virtual-crop support for arbitrary high zoom, or separately approve local cropped
PNG re-encoding under private payload IDs (new transfer/metrics/lifetime costs).
Neither is implemented/required here; do not quietly add either.

## Primary evidence, pinned revisions

Reviewed upstream code is not copied into this package. The small independent
spec model in the test is written from the described coordinate relations; it
is not terminal code or an upstream test transplant. No project license chosen.
Fetched originals are disposable under `/tmp/pi-viewer-crop-evidence`, not Git.

### Kitty

- Public [graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/).
  Pinned source: `kovidgoyal/kitty`
  **`07c8731470f4f7d461b5418c355b17a6d6edd9d3`** (master fetched at investigation).
- [`docs/graphics-protocol.rst`](https://github.com/kovidgoyal/kitty/blob/07c8731470f4f7d461b5418c355b17a6d6edd9d3/docs/graphics-protocol.rst),
  lines 583–592: same `(i,p)` replacement; same-ID image retransmission deletes
  image data and **all** placements. Lines 608–622: general source `x/y/w/h`
  intersection and `c/r` aspect-preserving letterbox. Lines 675–684: virtual
  prototype creation and aspect fit. Lines 720–724: underline color placement ID
  (omitted/zero allows arbitrary prototype). Lines 758–769: only ID/number/range
  deletion modes affect virtual prototypes; placeholder-derived images are not
  protocol placements. Lines 836–883: lowercase `d=i,i=...,p=...` scopes a
  placement and does not free PNG data.
- [`kitty/graphics.c`](https://github.com/kovidgoyal/kitty/blob/07c8731470f4f7d461b5418c355b17a6d6edd9d3/kitty/graphics.c),
  `grman_create_image_reference`, especially lines 1194–1244: virtual `num_cols`
  and `num_rows` determine the box; fitting uses **`img->width/height`**, source
  coordinates are derived from placeholder `img_col/img_row`. It does not add
  `virt_img_ref->src_x/y` or use its source width/height. General placement
  creation stores/intersects crop at lines 1406–1411, but that is not evidence
  of applying crop to Unicode placeholders.

### Ghostty target and current upstream

Pinned target `ghostty-org/ghostty` **v1.3.1**:
**`332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28`**.
Current main also reviewed:
**`22f100c6367045bb5fc86172f837047dee2f7670`**.
All line numbers below refer to v1.3.1 unless stated otherwise.

- [`graphics_command.zig`](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/src/terminal/kitty/graphics_command.zig),
  `Display` / `parse`: parses `x/y/w/h`, `U`, `c/r` and placement ID.
- [`graphics_exec.zig`](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/src/terminal/kitty/graphics_exec.zig),
  display lines 210–256: `U=1` chooses `.virtual`; source fields are stored on
  the same placement. Cursor movement is skipped for virtual placements.
- [`graphics_unicode.zig`](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/src/terminal/kitty/graphics_unicode.zig),
  `Placement.renderPlacement` lines 130–350: fits whole `img.width/height`,
  calculates source from run row/col/width/height, emits rounded source and
  destination pixels. `grid` lines 361–400 looks up the exact nonzero underline
  ID but only uses prototype rows/columns. **Stored source fields are unused.**
  `IncompletePlacement.init` lines 443–450 reads underline color as a 24-bit
  placement ID; lines 456 onward decode independent row/column/high-image-byte
  marks. Existing upstream render tests cover whole-image subsets, not prototype
  crop. Main's same file, `renderPlacement` lines 45–267 / `grid` 277–298, still
  uses full image dimensions and only target rows/columns.
- [`renderer/image.zig`](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/src/renderer/image.zig),
  `prepVirtualPlacement` lines 467–520 calls that Unicode render path and uses
  its returned source rectangle, with no later merge of prototype crop. The
  ordinary pinned placement path at 432–440 **does** read/intersect stored
  source fields; that separate path cannot prove virtual support.
- [`graphics_storage.zig`](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/src/terminal/kitty/graphics_storage.zig),
  `addPlacement` lines 148–186 keys nonzero IDs by `(image,external placement)`
  and overwrites that entry, marking state dirty. `.virtual` deinit holds no
  tracked pin (`Placement.deinit`), so same-private-virtual replacement does
  not leave a cursor pin. `deleteById` lines 430–462 removes that exact pair,
  regardless of location type, and calls data deletion only for uppercase
  `delete_unused`. ID mode dispatch is at lines 248–254; visible-all deletion
  explicitly skips virtual prototypes at 227–230.
- [`renderer/generic.zig`](https://github.com/ghostty-org/ghostty/blob/332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28/src/renderer/generic.zig),
  lines 1224–1247: dirty graphics and virtual cell changes rebuild image state.
  This supports redefinition being observable, not a claim of flicker-free
  atomicity with Pi redraw.

## Recommended bounded-subset interfaces and math

These are exact proposed signatures for the integration worker, **not production
exports at this checkpoint**:

```ts
type SubsetState = {
  mode: 'fit' | 'zoom'; zoomFactor: number; // 1 = fit; +/- multiply/divide 1.25
  centerX: number; centerY: number; // floating source pixel center, not path/state entry
};
type SubsetInput = {
  image: { width: number; height: number };
  area: { columns: number; rows: number }; // AFTER chrome, each capped to 297
  cells: { widthPx: number; heightPx: number }; // public live cell dimensions
  state: SubsetState;
};
type SubsetResult = {
  state: SubsetState; fitScale: number; maxScale: number; maxZoomFactor: number;
  requestedScale: number; effectiveScale: number;
  fitPercent: number; naturalPercent: number; atZoomLimit: boolean;
  prototype: { columns: number; rows: number }; // full-image grid, each <=297
  visible: { columns: number; rows: number; columnOffset: number; rowOffset: number };
  originColumn: number; originRow: number; // centered visible grid in image area
  paddingX: number; paddingY: number; // pixel padding inside full prototype
  realizedCenterX: number; realizedCenterY: number; // diagnostic rounding/clamp
};
function computeViewerSubset(input: SubsetInput): SubsetResult;
function updateViewerSubset(input: SubsetInput,
  action: 'fit' | 'zoom-in' | 'zoom-out' |
    { panXCells: number; panYCells: number }): SubsetState;
function encodePlaceholderViewport(input: {
  imageId: number; placementId: number; columns: number; rows: number;
  rowOffset: number; columnOffset: number;
}): string[];
function encodeOwnedVirtualRetirement(input: { imageId: number; placementId: number }): string;
```

Encoding uses the **existing** `encodeVirtualPlacement({ imageId, placementId,
columns: prototype.columns, rows: prototype.rows })`, without `x/y/w/h`. Emit only
`visible.columns * visible.rows` cells, each mark `rowOffset+y,columnOffset+x`.
All offsets are integers; `offset + visibleDimension <= prototypeDimension <=297`.
Independent marks survive clipped first columns/rows; do not reset coordinates
when Pi clips a subset. Existing `encodePlaceholderRows` needs an additive offset
variant, not an upload escape prefix. The pure variant returns text rows only.

For W,H image pixels; C,R bounded usable cells; cw,ch actual cell pixels:

- `fit=min(C*cw/W,R*ch/H)`; `maxScale=min(297*cw/W,297*ch/H)`.
  `maxZoomFactor=maxScale/fit >= 1` for area <=297. Cap usable dimensions first;
  center the bounded area in a larger overlay; never synthesize a larger grid.
- `s=clamp(fit*zoomFactor, policyMin, maxScale)`; proposal `policyMin=fit` (do not
  zoom below fit in v1). If zoom-out below fit is desired, the same math supports
  it with smaller-grid letterbox, but choose a positive minimum explicitly.
  At maximum, repeated `+` is a no-op with a clear limit indication.
- `Pc=min(297,max(1,ceil(W*s/cw)))`, `Pr` similarly. The min(297) absorbs tiny
  floating-point overflow at the exact limit; it must not silently permit a
  requested scale above max. `sEff=min(Pc*cw/W,Pr*ch/H)`.
- `padX=(Pc*cw-W*sEff)/2`, `padY` similarly. BOTH inspected terminal paths fit
  the full image this way. Independent ceiling does not stretch aspect: uniform
  scale plus padding is required. Integer source/destination roundings in Ghostty
  can produce about one pixel of edge rounding; do not claim exact sample bounds.
- `vc=min(C,Pc)`, `vr=min(R,Pr)`;
  `ox=clamp(round((centerX*sEff+padX-vc*cw/2)/cw),0,Pc-vc)`, `oy` similarly.
  Both bounds are integer and all last marks <=296. Fit emits the full prototype
  (`ox=oy=0`), centered by `floor((C-vc)/2),floor((R-vr)/2)`.
- The visible source interval before clipping is
  `[(ox*cw-padX)/sEff,((ox+vc)*cw-padX)/sEff]`, intersected with `[0,W]`;
  vertical analog. Empty/padding parts are terminal letterbox, not fake pixels.
  At maximum offsets the source reaches its far edge, not a guessed crop origin.
- Realized source center is `(ox*cw+vc*cw/2-padX)/sEff`. Preserve the requested
  floating center across zoom/resize; normal non-edge error is <=half a cell in
  source units. Clamp requested center to the reachable realized-center range
  before committing an edge-pan state, so repeated out-of-range pan does not
  accumulate invisible movement. An undersized axis centers and cannot pan.
  Do not round-trip center from cell offsets every repaint (zoom drift).
- `h/j/k/l` recommendation: move four displayed cells in source units,
  `deltaSource=4*cellPixels/sEff`; owner/UI worker still chooses increment. `0`
  resets zoomFactor=1 and source center W/2,H/2 on every new open.
- Fit-relative resize policy recommendation: retain zoomFactor and source center,
  recompute fit and dynamic maximum, clamp to newly available max. Changed cell
  pixels may change natural max/percentage; a fixed pixel-scale resize policy is
  also possible, but must not be confused with fit-relative zoom. Record final
  policy in the UX worker's gate before shipping.

Pan changes only cell offsets/text, **not** virtual prototype geometry and not
PNG bytes. Zoom/resize changes bounded private `c/r` (same pair replacement).
Natural pixel scale can be shown secondarily as `100*sEff`; fit-relative label
uses `100*s/fit`, with cell rounding disclosed rather than promising exact zoom.
Tiny images at 100% fit upscale by policy; if allowed below fit, occupied grid
shrinks and centers, with internal padding. Arbitrary exact 100% natural scaling
is not guaranteed by `c/r` quantization alone.

The parent crop fallback section retains a natural-pixel convention for future
review; **v1 subset uses fit-relative 100% instead**. No production gate has
approved either helper implementation yet.

## Future crop interfaces (blocked on reviewed targets)

The remainder records the alternative crop design, not the recommended v1.
Do not implement these until crop support is established and separately approved.

```ts
type PixelCrop = { x: number; y: number; width: number; height: number };
type ViewerState = {
  mode: 'fit' | 'pixel'; // fit recalculates on resize; pixel retains scale
  scale: number;        // terminal pixels per normalized source pixel
  centerX: number; centerY: number; // source coordinates, floating point
};
type ViewportInput = {
  image: { width: number; height: number }; // immutable normalized PNG dimensions
  area: { columns: number; rows: number }; // usable area AFTER overlay chrome
  cells: { widthPx: number; heightPx: number }; // current public cell pixels
  state: ViewerState;
};
type ViewportResult = {
  state: ViewerState; fitScale: number; zoomPercent: number;
  crop: PixelCrop; // integer, nonempty, wholly inside image
  columns: number; rows: number; // private prototype size, EACH 1..297
  originColumn: number; originRow: number; // centered in usable area
  rowOffset: 0; columnOffset: 0; // bounded-crop marks restart at zero
  effectiveScale: number; // terminal's uniform min(boxWidth/cropW,boxHeight/cropH)
  contentPixels: { width: number; height: number; offsetX: number; offsetY: number };
};
function computeViewerViewport(input: ViewportInput): ViewportResult;
function updateViewerState(input: ViewportInput,
  action: 'fit' | 'zoom-in' | 'zoom-out' |
    { panXCells: number; panYCells: number }): ViewerState;
function encodeCroppedVirtualPlacement(input: {
  imageId: number; placementId: number; columns: number; rows: number;
  imageWidth: number; imageHeight: number; crop: PixelCrop;
}): string;
function encodeOwnedVirtualRetirement(input: { imageId: number; placementId: number }): string;
// Optional subset path needs explicit addressable offsets:
function encodePlaceholderViewport(input: {
  imageId: number; placementId: number; columns: number; rows: number;
  rowOffset: number; columnOffset: number;
}): string[];
```

Encoding proposal (individually wrapped with existing one-layer `wrapTmux`):
`ESC_Ga=p,U=1,i=<i>,p=<p>,x=<x>,y=<y>,w=<width>,h=<height>,c=<cols>,r=<rows>,q=2 ESC\\`.
**This encoding is syntactically valid but not a working crop on reviewed targets.**
Retirement: `ESC_Ga=d,d=i,i=<i>,p=<p>,q=2 ESC\\` (lowercase `d=i`, not deletion
mode `d=p`, not uppercase `I`, never missing `p`, never delete-all).
Both IDs remain nonzero 24-bit values. Validate source integers in `0..2^32-1`,
positive dimensions, sum/intersection bounds, finite cell pixels, usable integer
cell dimensions and last explicit mark `offset + dimension - 1 <= 296`.
The helper returns strings only; preparation never writes terminal bytes.

Every cell retains foreground image ID, underline **color** private placement
ID, explicit row and column marks and explicit zero high-image-byte mark. Do not
apply underline text styling or theme/restyle placeholder rows. Ordinary spaces
for letterbox/chrome live outside ID cells. Source dimensions/pixels have **no
297-pixel limit**; the limit is grid addressing. A bounded crop can be thousands
of source pixels while its local displayed grid is <=297.

## Proposed viewport math and rounding policy

These are recommendations awaiting UX/coordinator approval, not agreed shipping
controls. At known positive cell dimensions `cw,ch`, bounded usable `C,R`:
`Vw=C*cw`, `Vh=R*ch`, `fit=min(Vw/W,Vh/H)`. Fit means fit the entire image,
including upscaling small images as in the existing inline policy. If the owner
prefers never-upscale initial fit, use `min(1,fit)` explicitly; do not conflate
that choice with natural 100%.

Recommend **100% = one terminal pixel per normalized source pixel**, scale `s=1`;
fit may therefore show a percentage above or below 100%. `+/-` switch to pixel
mode and multiply/divide current scale by **1.25**, preserving viewed source
center before clamping. `0` selects fit mode and center `(W/2,H/2)`. Recommend
source-visible width/height `min(W,Vw/s)` / `min(H,Vh/s)`. Clamp center in each
axis to `[visible/2, dimension-visible/2]`; if the image is smaller than the
viewport, that axis centers and cannot pan. Recommend pan four cell widths /
heights divided by scale per keypress. Pixel mode keeps its scale across resize;
fit mode recalculates fit. Cell-size changes always recompute, never trust old
pixel geometry. Owner must still choose zoom limits and pan increment.

Round source extent **once** to nearest integer, at least one, no larger than
source. Recompute integer origin from requested center and rounded extent,
round to nearest then clamp to `[0, dimension-extent]`. Round width and height
independently but **never apply separate x/y display scales**: terminal fitting
must use uniform `min(displayW/cropW,displayH/cropH)` with centered padding.
Expose effectiveScale/contentPixels so chrome does not claim mathematically
exact 100% when integer/cell quantization has shifted it. Floating-point state
must not be overwritten on every repaint by rounded crop center (avoid drift).
At clamped edges an unavoidable center change is explicit.

When an axis's whole image at requested scale is smaller than viewport, choose
only `ceil(sourceExtent*s/cellPixels)` occupied cells (minimum one), center that
grid with integer origin, and allow terminal letterbox **inside** it. Otherwise
use that axis's entire bounded usable dimension. Using the full viewport grid
for a small image would enlarge it back to fit instead of honoring zoom-out.
Ceil-to-cell quantization can raise effective scale, particularly for tiny
images, and asymmetry from odd unused cells is <=one cell; it is not geometric
distortion. Exact arbitrary pixel scale/offset is not guaranteed by `c/r` alone;
we have not validated virtual `X/Y` as a way around this. Require a documented
quantization tolerance rather than claiming pixel-exact natural size.

An 8192-wide image at 125% still has a crop roughly `Vw/1.25` pixels, with local
marks starting at zero, and **never** a 1280-column virtual full canvas in the
proposed crop path. Extreme zoom needs bounds: proposed maximum keeps both
visible dimensions >=one source pixel (`s <= min(Vw,Vh)`), avoiding a 1x1 crop
being enlarged to an unrelated requested scale. Limits are policy pending, not
permission to allow infinities. Invalid/zero usable area must show a text-only
small-pane fallback, no graphics preparation; no fake 1x1 physical viewport.

## Private ephemeral ownership / integration handoff

The existing prototype helper can be reused for the recommended subset path;
the shared queue and ephemeral owner still require integration approval. In a
subset implementation, pan updates placeholder offsets without graphics writes;
zoom/resize replace the single bounded private full-image prototype. Crop fields
are absent, and row/column offsets plus surface/generation/cell geometry take
part in validation keys. The following rules also apply to a future crop path.

Scoped same-pair redefinition and scoped lowercase retirement are supported by
spec and inspected Ghostty source, independently of crop failure. Reserve one
private `(imageId, placementId)` prototype for the live overlay; never take an
inline occurrence/geometry placement ID. Repeated pan/zoom redefines that private
pair, so terminal prototype count is constant. Keep only current committed
prototype plus at most current in-flight candidate, not historical viewport keys.
Geometry generation/epoch validation must include crop, display grid, cell pixels
and private surface identity even though the placement ID is intentionally stable.

The current `GraphicsIdentityRegistry` and `ownedPlacements` inline retention are
not an ephemeral owner: allocating a fresh geometry key per pan, or appending
each pan to `ownedPlacements`, is unbounded. Use a reusable private surface slot,
not an allocator key per crop/open; reserve its numeric ID for this runtime to
avoid late completion / reused-ID alias. A bounded slot can be rebound to a new
image only after old work is quiesced and old owned pair retired. Failed writes
must retain enough ownership to retry retirement or explicitly report uncertain
terminal resources. No metrics claim that preparation or failed cleanup retired
anything. A replacement write updates committed geometry only on success.

Serialization must share native payload/residency ownership and transport queue:
normalize once, reuse exact PNG image ID; on same-ID retransmission restore all
retained inline prototypes and only live overlay prototypes. Close cancels stale
work, removes overlay text through public completion, then retires the private
pair when ordering is safe. If a canceled write may already have reached the
terminal, cleanup must be ordered after it, not just abort its callback. Never
retire a reused live generation. Do not store ephemeral prototypes as session
metadata or immutable transcript cells. Reload keeps existing no-global-delete
safety; any stronger cleanup/lifetime guarantee needs the coordinator lifecycle
gate. Measurement worker owns counting details.

## Evidence and remaining checks

Portable capture-only tests independently check proposed bounded-subset
math, stable center and edge clamps, small-image letterbox, changed cells,
8192-wide below-natural dynamic zoom cap, explicit mark bounds, full-prototype
command framing, and a small
protocol ownership model for same-pair replacement/scoped lowercase deletion /
retransmission restoration. A full-grid source-path counterexample records why
stored crop does not imply rendered crop. These are **not** execution of Kitty
or Ghostty, not public Pi overlay tests, and not human-observed pixels. No source
text assertions are used as a substitute for terminal execution.

`node --test test/viewer-crop-feasibility.test.mjs` is the focused command;
`npm test` also discovers it. Final run totals are in the worker report at
`/tmp/pi-viewer-crop-report.md` (ephemeral coordination artifact). Tests do not
contact providers or perform physical terminal uploads.

Before any subset option ships: observe an asymmetric quadrant/coordinate-labelled
image with full-prototype marks offset in both axes; check pan reaches all four
edges, uniform aspect, fit/reset, tiny-image padding and honest 8192-wide dynamic
zoom-limit behavior. Before any future crop option ships, additionally obtain
actual target crop support and observe a nonzero crop origin with crop aspect
different from original and far-edge >100% natural zoom.
Keep inline and overlay live on the same PNG while redefining, retransmitting
and retiring only overlay `(i,p)`; close must restore unchanged inline history.
Test partial cell-run clipping and borders with both ID colors, tmux pane resize /
zoom/window switch, cell-size change and pending-write close/reopen races. Capture
streams and public Pi lifecycle tests belong to the other gate workers; they
cannot establish rendered crop on Ghostty. **All new subset/crop pixel checks
remain human-pending; this note supports bounded-subset implementation review,
not completion of the full production/public-Pi gate.**
