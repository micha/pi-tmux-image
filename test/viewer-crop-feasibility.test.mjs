// Independent Step-1 design harness. No production viewport implementation,
// terminal uploads, host imports, subprocesses, network or dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapTmux, encodePlaceholderCell, encodePlaceholderRows, DIACRITICS,
  MAX_GRID_DIMENSION, encodeVirtualPlacement } from '../src/kitty.mjs';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MAX = 297;

// Proposed bounded full-image subset path. Fit-relative percentage is distinct
// from natural pixel scale. This model exposes cell quantization, not exact zoom.
function subsetPlan({ image, area, cells, scale, center }) {
  const { width: W, height: H } = image;
  const { columns: C, rows: R } = area;
  const { widthPx: cw, heightPx: ch } = cells;
  for (const v of [W, H, C, R, cw, ch, scale, center.x, center.y]) {
    if (!Number.isFinite(v)) throw new RangeError('finite inputs required');
  }
  for (const v of [W, H, C, R, cw, ch, scale]) {
    if (v <= 0) throw new RangeError('positive inputs required');
  }
  for (const v of [W, H, C, R]) {
    if (!Number.isSafeInteger(v)) throw new RangeError('integer dimensions required');
  }
  if (C > MAX || R > MAX) throw new RangeError('bound usable viewport first');
  const fitScale = Math.min(C * cw / W, R * ch / H);
  const maxScale = Math.min(MAX * cw / W, MAX * ch / H);
  const requestedScale = Math.min(scale, maxScale);
  const columns = Math.min(MAX, Math.max(1, Math.ceil(W * requestedScale / cw)));
  const rows = Math.min(MAX, Math.max(1, Math.ceil(H * requestedScale / ch)));
  const effectiveScale = Math.min(columns * cw / W, rows * ch / H);
  const paddingX = (columns * cw - W * effectiveScale) / 2;
  const paddingY = (rows * ch - H * effectiveScale) / 2;
  const visibleColumns = Math.min(C, columns), visibleRows = Math.min(R, rows);
  const columnOffset = clamp(Math.round((center.x * effectiveScale + paddingX -
    visibleColumns * cw / 2) / cw), 0, columns - visibleColumns);
  const rowOffset = clamp(Math.round((center.y * effectiveScale + paddingY -
    visibleRows * ch / 2) / ch), 0, rows - visibleRows);
  const realizedCenter = {
    x: (columnOffset * cw + visibleColumns * cw / 2 - paddingX) / effectiveScale,
    y: (rowOffset * ch + visibleRows * ch / 2 - paddingY) / effectiveScale,
  };
  return { columns, rows, visibleColumns, visibleRows, columnOffset, rowOffset,
    originColumn: Math.floor((C - visibleColumns) / 2),
    originRow: Math.floor((R - visibleRows) / 2),
    fitScale, maxScale, requestedScale, effectiveScale, paddingX, paddingY,
    fitPercent: requestedScale / fitScale * 100,
    naturalPercent: effectiveScale * 100, realizedCenter };
}

// Independent coordinate relation seen in BOTH primary virtual rendering paths:
// whole image -> uniform fit in full prototype -> addressed cell run -> source.
// Crop on the stored prototype is deliberately not used by those source paths.
function observedVirtualMapping(image, prototype, run, cells) {
  const s = Math.min(prototype.columns * cells.widthPx / image.width,
    prototype.rows * cells.heightPx / image.height);
  const padX = (prototype.columns * cells.widthPx - image.width * s) / 2;
  const padY = (prototype.rows * cells.heightPx - image.height * s) / 2;
  const left = clamp((run.columnOffset * cells.widthPx - padX) / s, 0, image.width);
  const top = clamp((run.rowOffset * cells.heightPx - padY) / s, 0, image.height);
  const right = clamp(((run.columnOffset + run.visibleColumns) * cells.widthPx - padX) / s, 0, image.width);
  const bottom = clamp(((run.rowOffset + run.visibleRows) * cells.heightPx - padY) / s, 0, image.height);
  return { x: left, y: top, width: right - left, height: bottom - top, scale: s };
}

function subsetRows(ids, p) {
  if (p.columnOffset < 0 || p.rowOffset < 0 ||
      p.columnOffset + p.visibleColumns > MAX || p.rowOffset + p.visibleRows > MAX) {
    throw new RangeError('unaddressable subset');
  }
  // Reuse public pure row-prefix encoding; explicit cells have independent marks.
  const row = encodePlaceholderRows({ ...ids, columns: 1, rows: 1 })[0];
  const prefix = row.slice(0, row.indexOf(String.fromCodePoint(0x10eeee)));
  return Array.from({ length: p.visibleRows }, (_, y) => prefix +
    Array.from({ length: p.visibleColumns }, (_, x) =>
      encodePlaceholderCell(y + p.rowOffset, x + p.columnOffset)).join('') + '\x1b[0m');
}

const image = { width: 1200, height: 600 };
const area = { columns: 80, rows: 30 };
const cells = { widthPx: 9, heightPx: 18 };
const input = { image, area, cells, scale: 1, center: { x: 600, y: 300 } };
const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('source crop parser acceptance is not virtual render support: counterexample', () => {
  const prototype = { columns: 80, rows: 30, crop: { x: 300, y: 100, width: 600, height: 300 } };
  const run = { columnOffset: 0, rowOffset: 0, visibleColumns: 80, visibleRows: 30 };
  const actual = observedVirtualMapping(image, prototype, run, cells);
  assert.deepEqual(actual, { x: 0, y: 0, width: 1200, height: 600, scale: 0.6 });
  assert.notEqual(actual.x, prototype.crop.x);
});

test('1200px PDF natural size and 1.25x steps have useful bounded zoom', () => {
  const natural = subsetPlan(input);
  assert.equal(natural.columns, 134);
  assert.equal(natural.rows, 34);
  const zoom = subsetPlan({ ...input, scale: 1.25 });
  assert.equal(zoom.columns, 167);
  assert.equal(zoom.rows, 42);
  assert.ok(zoom.maxScale > 2);
  assert.ok(zoom.fitPercent > natural.fitPercent);
});

test('fit/reset centers entire image; portrait and landscape preserve uniform aspect', () => {
  for (const img of [image, { width: 600, height: 1200 }, { width: 701, height: 499 }]) {
    const fit = Math.min(area.columns * cells.widthPx / img.width, area.rows * cells.heightPx / img.height);
    const p = subsetPlan({ ...input, image: img, scale: fit, center: { x: img.width / 2, y: img.height / 2 } });
    assert.ok(p.columns <= area.columns && p.rows <= area.rows);
    assert.equal(p.columnOffset, 0); assert.equal(p.rowOffset, 0);
    near(p.fitPercent, 100);
    const mapped = observedVirtualMapping(img, p, p, cells);
    near(mapped.width / mapped.height, img.width / img.height);
    near(mapped.scale, p.effectiveScale);
  }
});

test('zoom preserves requested source center within half-cell quantization, then clamps', () => {
  const center = { x: 660, y: 320 };
  for (const scale of [1, 1.25, 1.5625, 1.25, 1]) {
    const p = subsetPlan({ ...input, scale, center });
    near(p.realizedCenter.x, center.x, cells.widthPx / p.effectiveScale / 2 + 1e-9);
    near(p.realizedCenter.y, center.y, cells.heightPx / p.effectiveScale / 2 + 1e-9);
  }
  const edge = subsetPlan({ ...input, scale: 1.25, center: { x: 99999, y: -99999 } });
  assert.equal(edge.columnOffset, edge.columns - edge.visibleColumns);
  assert.equal(edge.rowOffset, 0);
});

test('four pan boundaries map to source edges with centered aspect padding', () => {
  for (const x of [-1e6, 1e6]) for (const y of [-1e6, 1e6]) {
    const p = subsetPlan({ ...input, scale: 1.25, center: { x, y } });
    const source = observedVirtualMapping(image, p, p, cells);
    if (x < 0) near(source.x, 0); else near(source.x + source.width, image.width);
    if (y < 0) near(source.y, 0); else near(source.y + source.height, image.height);
  }
});

test('small image zoom-out occupies centered smaller grid, does not refit to viewport', () => {
  const p = subsetPlan({ ...input, image: { width: 20, height: 10 },
    scale: 0.5, center: { x: 10, y: 5 } });
  assert.equal(p.columns, 2); assert.equal(p.rows, 1);
  assert.equal(p.columnOffset, 0); assert.equal(p.rowOffset, 0);
  assert.equal(p.originColumn, 39); assert.equal(p.originRow, 14);
  assert.ok(p.effectiveScale < p.fitScale);
  assert.ok(p.paddingY > 0);
  // Grid rounding means requested 50% is not guaranteed pixel-exact.
  assert.ok(p.effectiveScale > 0.5);
});

test('8192px image is honestly limited below natural 100%, not encoded as huge canvas', () => {
  const large = { width: 8192, height: 4096 };
  const p = subsetPlan({ ...input, image: large, cells: { widthPx: 8, heightPx: 16 },
    scale: 1.25, center: { x: 8192, y: 4096 } });
  assert.equal(p.columns, MAX);
  assert.ok(p.rows <= MAX);
  assert.ok(p.naturalPercent < 100);
  assert.ok(p.fitPercent > 100);
  assert.ok(p.columnOffset + p.visibleColumns - 1 <= 296);
  assert.ok(p.rowOffset + p.visibleRows - 1 <= 296);
});

test('all extreme aspect/zoom subsets stay addressable and have one uniform scale', () => {
  for (const img of [{ width: 8192, height: 4096 }, { width: 4096, height: 8192 },
    { width: 1, height: 8192 }, { width: 8192, height: 1 }, { width: 1, height: 1 }]) {
    for (const a of [area, { columns: 297, rows: 297 }, { columns: 1, rows: 1 }]) {
      for (const scale of [0.0001, 0.5, 1.25, 1e9]) {
        const p = subsetPlan({ ...input, image: img, area: a, scale,
          center: { x: img.width, y: img.height } });
        assert.ok(p.columns >= 1 && p.columns <= MAX);
        assert.ok(p.rows >= 1 && p.rows <= MAX);
        assert.ok(p.columnOffset + p.visibleColumns <= p.columns);
        assert.ok(p.rowOffset + p.visibleRows <= p.rows);
        assert.ok(p.requestedScale <= p.maxScale);
        near((p.columns * cells.widthPx - 2 * p.paddingX) / img.width,
          (p.rows * cells.heightPx - 2 * p.paddingY) / img.height);
      }
    }
  }
});

test('cell-size changes recompute limit and mapping; invalid viewport is text-only boundary', () => {
  const before = subsetPlan(input);
  const after = subsetPlan({ ...input, cells: { widthPx: 12, heightPx: 24 } });
  assert.notEqual(before.columns, after.columns);
  assert.notEqual(before.maxScale, after.maxScale);
  for (const patch of [{ scale: Infinity }, { scale: 0 }, { area: { columns: 0, rows: 30 } },
    { area: { columns: 298, rows: 30 } }, { cells: { widthPx: NaN, heightPx: 18 } }]) {
    assert.throws(() => subsetPlan({ ...input, ...patch }), RangeError);
  }
});

test('capture-only subset framing: full prototype has no crop, explicit clipped marks and IDs', () => {
  assert.equal(MAX_GRID_DIMENSION, MAX);
  const ids = { imageId: 0x123456, placementId: 0xabcdef };
  const p = subsetPlan({ ...input, scale: 1.25, center: { x: 1e6, y: 1e6 } });
  const bytes = encodeVirtualPlacement({ ...ids, columns: p.columns, rows: p.rows });
  assert.ok(bytes.includes('a=p,U=1,i=1193046,p=11259375,c=167,r=42,q=2'));
  assert.ok(!bytes.includes(',x=') && !bytes.includes(',w='));
  const rows = subsetRows(ids, p);
  assert.equal(rows.length, p.visibleRows);
  assert.ok(rows[0].includes('\x1b[38;2;18;52;86m'));
  assert.ok(rows[0].includes('\x1b[58:2::171:205:239m'));
  const lastCell = encodePlaceholderCell(p.rowOffset + p.visibleRows - 1,
    p.columnOffset + p.visibleColumns - 1);
  assert.ok(rows.at(-1).includes(lastCell));
  assert.ok(lastCell.endsWith(DIACRITICS[0]));
  assert.throws(() => encodePlaceholderCell(0, 297), RangeError);
  assert.throws(() => subsetRows(ids, { ...p, columnOffset: 297 }), RangeError);
});

// Spec-only ownership model, not execution or acknowledgement by a terminal.
test('same private pair replaces boundedly; scoped lowercase retirement preserves shared PNG', () => {
  const png = new Set([7]);
  const prototypes = new Map([['7:10', { surface: 'inline', columns: 60, rows: 24 }]]);
  const inline = prototypes.get('7:10');
  for (let n = 0; n < 10000; n++) {
    prototypes.set('7:20', { surface: 'overlay', columns: 80 + n % 100, rows: 30 });
    assert.equal(prototypes.size, 2);
  }
  const retire = wrapTmux('\x1b_Ga=d,d=i,i=7,p=20,q=2\x1b\\');
  assert.ok(retire.includes('a=d,d=i,i=7,p=20,q=2'));
  prototypes.delete('7:20'); // lowercase scoped semantics; does not delete png
  assert.ok(png.has(7)); assert.equal(prototypes.get('7:10'), inline);
  const retained = [...prototypes];
  prototypes.clear(); // same image-ID retransmission deletes all prototypes
  for (const [key, value] of retained) prototypes.set(key, value);
  assert.equal(prototypes.size, 1); assert.ok(!prototypes.has('7:20'));
});
