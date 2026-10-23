import { MAX_GRID_DIMENSION, validateGrid } from './kitty.mjs';

export const MIN_ZOOM_FACTOR = 0.25;
export const ZOOM_STEP = 1.25;
export const PAN_CELLS = 4;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const frozen = (value) => Object.freeze(value);

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive and finite`);
}

// Fit calculations may land a few ulps above an integral cell boundary. Do not
// turn an exact fit into an extra column/row (or an unaddressable 298th mark).
function ceilCells(value) {
  const nearest = Math.round(value);
  const snapped = Math.abs(value - nearest) <= 8 * Number.EPSILON * Math.max(1, value)
    ? nearest : value;
  return clamp(Math.ceil(snapped), 1, MAX_GRID_DIMENSION);
}

/** Pure bounded full-image prototype and independently addressed visible window.
 * Center is normalized SOURCE position. Returned center is clamped, not rounded
 * to cells; realizedCenter describes the cell-quantized view separately.
 * Area is the usable image grid after chrome, each dimension already <=297.
 */
export function computeViewport({ image, area, cells, zoomFactor = 1, center = { x: 0.5, y: 0.5 } }) {
  const { width, height } = image;
  for (const [name, value] of Object.entries({ width, height })) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
      throw new RangeError(`${name} must be a positive 32-bit pixel dimension`);
    }
  }
  const { columns, rows } = validateGrid(area);
  const { widthPx, heightPx } = cells;
  positive(widthPx, 'cell width'); positive(heightPx, 'cell height');
  positive(zoomFactor, 'zoomFactor');
  for (const [name, value] of Object.entries({ x: center.x, y: center.y })) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`center.${name} must be normalized between 0 and 1`);
    }
  }
  const fitScale = Math.min(columns * widthPx / width, rows * heightPx / height);
  const maxScale = Math.min(MAX_GRID_DIMENSION * widthPx / width,
    MAX_GRID_DIMENSION * heightPx / height);
  positive(fitScale, 'fitScale'); positive(maxScale, 'maxScale');
  const maxZoomFactor = maxScale / fitScale;
  positive(maxZoomFactor, 'maxZoomFactor');
  zoomFactor = clamp(zoomFactor, MIN_ZOOM_FACTOR, maxZoomFactor);
  const requestedScale = Math.min(maxScale, fitScale * zoomFactor);
  positive(requestedScale, 'requestedScale');
  const canvas = frozen({ columns: ceilCells(width * requestedScale / widthPx),
    rows: ceilCells(height * requestedScale / heightPx) });
  const effectiveScale = Math.min(canvas.columns * widthPx / width, canvas.rows * heightPx / height);
  positive(effectiveScale, 'effectiveScale');
  const padding = frozen({ x: Math.max(0, (canvas.columns * widthPx - width * effectiveScale) / 2),
    y: Math.max(0, (canvas.rows * heightPx - height * effectiveScale) / 2) });
  const windowColumns = Math.min(columns, canvas.columns);
  const windowRows = Math.min(rows, canvas.rows);

  function axis(requested, pixels, cellPixels, fullCells, visibleCells, pad) {
    const maxOffset = fullCells - visibleCells;
    const centerAt = (offset) => (offset * cellPixels + visibleCells * cellPixels / 2 - pad) /
      effectiveScale / pixels;
    // A fully visible / undersized axis cannot pan. Otherwise constrain center
    // before rounding so edge pans do not build up invisible movement.
    const bounded = maxOffset === 0 ? 0.5 : clamp(requested,
      Math.max(0, centerAt(0)), Math.min(1, centerAt(maxOffset)));
    const offset = clamp(Math.round((bounded * pixels * effectiveScale + pad -
      visibleCells * cellPixels / 2) / cellPixels), 0, maxOffset);
    return { center: bounded, offset, realized: centerAt(offset) };
  }
  const x = axis(center.x, width, widthPx, canvas.columns, windowColumns, padding.x);
  const y = axis(center.y, height, heightPx, canvas.rows, windowRows, padding.y);
  return frozen({ canvas, window: frozen({ columns: windowColumns, rows: windowRows,
    columnOffset: x.offset, rowOffset: y.offset }),
    origin: frozen({ column: Math.floor((columns - windowColumns) / 2),
      row: Math.floor((rows - windowRows) / 2) }), padding,
    center: frozen({ x: x.center, y: y.center }),
    realizedCenter: frozen({ x: x.realized, y: y.realized }),
    zoomFactor, minZoomFactor: MIN_ZOOM_FACTOR, maxZoomFactor,
    fitScale, maxScale, requestedScale, effectiveScale,
    fitPercent: zoomFactor * 100, naturalPercent: effectiveScale * 100,
    atZoomLimit: zoomFactor === maxZoomFactor });
}

function state(view) { return frozen({ zoomFactor: view.zoomFactor, center: view.center }); }

/** Multiply/divide the current clamped fit-relative zoom; preserve source center. */
export function zoomViewport(input, direction) {
  if (direction !== 'in' && direction !== 'out') throw new RangeError("direction must be 'in' or 'out'");
  const current = computeViewport(input);
  const zoomFactor = direction === 'in' ? current.zoomFactor * ZOOM_STEP : current.zoomFactor / ZOOM_STEP;
  return state(computeViewport({ ...input, zoomFactor, center: current.center }));
}

/** Signed displayed-cell motion; positive x is right, positive y is down. */
export function panViewport(input, { xCells = 0, yCells = 0 }) {
  for (const value of [xCells, yCells]) {
    if (!Number.isFinite(value)) throw new RangeError('pan cell deltas must be finite');
  }
  const current = computeViewport(input);
  const dx = xCells * input.cells.widthPx / current.effectiveScale / input.image.width;
  const dy = yCells * input.cells.heightPx / current.effectiveScale / input.image.height;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new RangeError('pan delta exceeds finite bounds');
  return state(computeViewport({ ...input, zoomFactor: current.zoomFactor,
    center: { x: clamp(current.center.x + dx, 0, 1), y: clamp(current.center.y + dy, 0, 1) } }));
}

/** Every open/reset starts fit and recentered; validate against current geometry. */
export function resetViewport(input) {
  return state(computeViewport({ ...input, zoomFactor: 1, center: { x: 0.5, y: 0.5 } }));
}
