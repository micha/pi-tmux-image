import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { computeViewport, zoomViewport, panViewport, resetViewport,
  MIN_ZOOM_FACTOR, ZOOM_STEP, PAN_CELLS } from '../src/viewport.mjs';
import { encodeViewportRows, PLACEHOLDER, DIACRITICS } from '../src/kitty.mjs';

const input = { image: { width: 1200, height: 600 }, area: { columns: 80, rows: 30 },
  cells: { widthPx: 9, heightPx: 18 } };
const near = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function mapped(view, data) {
  const { window: w, padding: p, effectiveScale: s } = view;
  const x = Math.max(0, (w.columnOffset * data.cells.widthPx - p.x) / s);
  const y = Math.max(0, (w.rowOffset * data.cells.heightPx - p.y) / s);
  const right = Math.min(data.image.width, ((w.columnOffset + w.columns) * data.cells.widthPx - p.x) / s);
  const bottom = Math.min(data.image.height, ((w.rowOffset + w.rows) * data.cells.heightPx - p.y) / s);
  return { x, y, right, bottom };
}

test('default fit/reset, exported policies and immutable normalized state', () => {
  assert.equal(MIN_ZOOM_FACTOR, 0.25); assert.equal(ZOOM_STEP, 1.25); assert.equal(PAN_CELLS, 4);
  const original = structuredClone(input);
  const v = computeViewport(input);
  assert.deepEqual(v.canvas, { columns: 80, rows: 20 });
  assert.deepEqual(v.window, { columns: 80, rows: 20, columnOffset: 0, rowOffset: 0 });
  assert.deepEqual(v.origin, { column: 0, row: 5 });
  assert.deepEqual(v.center, { x: 0.5, y: 0.5 });
  assert.equal(v.fitPercent, 100); near(v.fitScale, 0.6);
  assert.deepEqual(resetViewport({ ...input, zoomFactor: 3, center: { x: 1, y: 0 } }),
    { zoomFactor: 1, center: { x: 0.5, y: 0.5 } });
  assert.deepEqual(input, original);
  for (const item of [v, v.canvas, v.window, v.padding, v.origin, v.center, v.realizedCenter]) {
    assert.ok(Object.isFrozen(item));
  }
});

test('uniform scale / centered padding for portrait, landscape and odd sizes', () => {
  for (const image of [{ width: 600, height: 1200 }, { width: 1200, height: 600 },
    { width: 701, height: 499 }, { width: 11, height: 7 }]) {
    for (const zoomFactor of [0.25, 1, 1.25, 2, 4]) {
      const data = { ...input, image, zoomFactor };
      const v = computeViewport(data);
      near((v.canvas.columns * input.cells.widthPx - 2 * v.padding.x) / image.width,
        (v.canvas.rows * input.cells.heightPx - 2 * v.padding.y) / image.height);
      assert.ok(v.padding.x >= 0 && v.padding.y >= 0);
      if (zoomFactor === 1) {
        const source = mapped(v, data);
        near(source.x, 0); near(source.y, 0);
        near(source.right, image.width); near(source.bottom, image.height);
      }
    }
  }
});

test('center remains stable over reversible zoom, within half-cell addressing error', () => {
  let state = { zoomFactor: 2, center: { x: 0.55, y: 0.53 } };
  const center = state.center;
  for (const direction of ['in', 'in', 'out', 'out']) {
    state = zoomViewport({ ...input, ...state }, direction);
    near(state.center.x, center.x); near(state.center.y, center.y);
    const v = computeViewport({ ...input, ...state });
    near(v.realizedCenter.x, v.center.x,
      input.cells.widthPx / v.effectiveScale / input.image.width / 2 + 1e-12);
    near(v.realizedCenter.y, v.center.y,
      input.cells.heightPx / v.effectiveScale / input.image.height / 2 + 1e-12);
  }
  near(state.zoomFactor, 2);
});

test('four-cell pans and edge clamps reach all source edges without hidden movement', () => {
  const data = { ...input, zoomFactor: 2.5 };
  const initial = computeViewport(data);
  const moved = panViewport(data, { xCells: PAN_CELLS, yCells: -PAN_CELLS });
  near(moved.center.x - initial.center.x, PAN_CELLS * input.cells.widthPx /
    initial.effectiveScale / input.image.width);
  near(moved.center.y - initial.center.y, -PAN_CELLS * input.cells.heightPx /
    initial.effectiveScale / input.image.height);
  for (const xCells of [-10000, 10000]) for (const yCells of [-10000, 10000]) {
    const state = panViewport(data, { xCells, yCells });
    assert.deepEqual(panViewport({ ...data, ...state }, { xCells, yCells }), state);
    const view = computeViewport({ ...data, ...state });
    const source = mapped(view, data);
    if (xCells < 0) near(source.x, 0); else near(source.right, input.image.width);
    if (yCells < 0) near(source.y, 0); else near(source.bottom, input.image.height);
  }
});

test('25% fit minimum, small-grid letterbox and maximum repeated zoom are stable', () => {
  const min = computeViewport({ ...input, zoomFactor: 0.001, center: { x: 0, y: 1 } });
  assert.equal(min.zoomFactor, 0.25);
  assert.equal(min.fitPercent, 25);
  assert.deepEqual(min.center, { x: 0.5, y: 0.5 });
  assert.ok(min.window.columns < input.area.columns && min.window.rows < input.area.rows);
  assert.deepEqual(zoomViewport({ ...input, zoomFactor: 0.25 }, 'out'),
    { zoomFactor: 0.25, center: { x: 0.5, y: 0.5 } });
  const tiny = computeViewport({ ...input, image: { width: 1, height: 1 },
    area: { columns: 79, rows: 29 }, zoomFactor: 0.25 });
  assert.ok(tiny.effectiveScale > tiny.requestedScale); // honest cell quantization
  const max = computeViewport({ ...input, zoomFactor: 1e9 });
  assert.ok(max.atZoomLimit);
  assert.deepEqual(zoomViewport({ ...input, zoomFactor: max.zoomFactor }, 'in'),
    { zoomFactor: max.zoomFactor, center: max.center });
});

test('297 limit is dynamic, no 8x policy cap, large image natural scale may be below 100%', () => {
  const large = computeViewport({ image: { width: 8192, height: 4096 },
    area: { columns: 80, rows: 30 }, cells: { widthPx: 8, heightPx: 16 }, zoomFactor: 10 });
  assert.equal(large.canvas.columns, 297);
  assert.ok(large.naturalPercent < 100 && large.fitPercent > 100);
  near(large.maxScale, 297 * 8 / 8192);
  const narrow = computeViewport({ ...input, area: { columns: 1, rows: 1 }, zoomFactor: 1e9 });
  assert.ok(narrow.maxZoomFactor > 8);
});

test('resize retains normalized center / fit factor unless new maximum or edge requires clamp', () => {
  const state = { zoomFactor: 2.5, center: { x: 0.55, y: 0.53 } };
  const resized = computeViewport({ ...input, ...state, area: { columns: 60, rows: 20 },
    cells: { widthPx: 12, heightPx: 24 } });
  assert.equal(resized.zoomFactor, state.zoomFactor);
  assert.deepEqual(resized.center, state.center);
  const bigger = computeViewport({ ...input, ...state, area: { columns: 297, rows: 297 } });
  assert.equal(bigger.maxZoomFactor, 1); assert.equal(bigger.zoomFactor, 1);
  assert.deepEqual(bigger.center, { x: 0.5, y: 0.5 });
  assert.notEqual(resized.canvas.rows, computeViewport({ ...input, ...state }).canvas.rows);
});

test('extreme dimensions, zoom, cell sizes and fit boundary stay within all addressing limits', () => {
  for (const image of [{ width: 8192, height: 1 }, { width: 1, height: 8192 },
    { width: 0xffffffff, height: 0xffffffff }, { width: 1, height: 1 }]) {
    for (const area of [{ columns: 297, rows: 297 }, { columns: 1, rows: 1 }, input.area]) {
      for (const cells of [input.cells, { widthPx: 7.25, heightPx: 15.5 }]) {
        for (const zoomFactor of [0.01, 1, 1.25, 1e12]) {
          const v = computeViewport({ image, area, cells, zoomFactor, center: { x: 0, y: 1 } });
          assert.ok(v.canvas.columns <= 297 && v.canvas.rows <= 297);
          assert.ok(v.window.columnOffset + v.window.columns <= v.canvas.columns);
          assert.ok(v.window.rowOffset + v.window.rows <= v.canvas.rows);
          assert.ok(v.effectiveScale <= v.maxScale * (1 + 1e-12));
          if (zoomFactor === 1) {
            assert.ok(v.canvas.columns <= area.columns && v.canvas.rows <= area.rows);
          }
        }
      }
    }
  }
  // Exercise many non-binary-exact fit calculations, not just round pixel ratios.
  for (let width = 11; width < 1000; width += 7) {
    const v = computeViewport({ ...input, image: { width, height: width + 13 },
      area: { columns: 79, rows: 29 }, cells: { widthPx: 7.3, heightPx: 15.7 } });
    assert.ok(v.canvas.columns <= 79 && v.canvas.rows <= 29);
  }
});

test('production viewport window drives independently decoded row/column marks', () => {
  const v = computeViewport({ ...input, zoomFactor: 100, center: { x: 1, y: 1 } });
  const lines = encodeViewportRows({ imageId: 123, placementId: 456, ...v.window,
    canvasColumns: v.canvas.columns, canvasRows: v.canvas.rows });
  for (let y = 0; y < lines.length; y++) {
    const cells = lines[y].replace(/\x1b\[[0-9:;]*m/g, '').split(PLACEHOLDER).slice(1);
    assert.equal(cells.length, v.window.columns);
    for (let x = 0; x < cells.length; x++) {
      assert.deepEqual(Array.from(cells[x], (mark) => DIACRITICS.indexOf(mark)),
        [v.window.rowOffset + y, v.window.columnOffset + x, 0]);
    }
  }
});

test('invalid values fail before graphics, and calculations produce no stdout/stderr', () => {
  for (const patch of [{ image: { width: 0, height: 1 } }, { image: { width: 1.5, height: 1 } },
    { image: { width: 0x100000000, height: 1 } }, { area: { columns: 298, rows: 1 } },
    { area: { columns: 0, rows: 1 } }, { cells: { widthPx: NaN, heightPx: 18 } },
    { cells: { widthPx: 1e308, heightPx: 1e308 } }, { zoomFactor: 0 }, { zoomFactor: Infinity },
    { center: { x: 1.01, y: 0.5 } }, { center: { x: NaN, y: 0 } }]) {
    assert.throws(() => computeViewport({ ...input, ...patch }), RangeError);
  }
  assert.throws(() => zoomViewport(input, 'sideways'), RangeError);
  assert.throws(() => panViewport(input, { xCells: Infinity }), RangeError);
  const module = new URL('../src/viewport.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {computeViewport,panViewport,zoomViewport,resetViewport} from ${JSON.stringify(module)};
     const input=${JSON.stringify(input)}; computeViewport(input); panViewport(input,{xCells:4});
     zoomViewport(input,'in'); resetViewport(input);`], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});
