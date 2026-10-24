import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { computeViewport, zoomViewport, zoomViewportAt, panViewport, resetViewport,
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

// Reconstruct source pixels independently from the rendered prototype/window.
// This deliberately does not use either center field or the zoom helper math.
function sourceAt(view, data, point, offsets = view.window) {
  return {
    x: ((point.column - view.origin.column + offsets.columnOffset) * data.cells.widthPx -
      view.padding.x) / view.effectiveScale,
    y: ((point.row - view.origin.row + offsets.rowOffset) * data.cells.heightPx -
      view.padding.y) / view.effectiveScale,
  };
}

function assertBestAnchor(data, direction, point) {
  const before = computeViewport(data);
  const anchor = sourceAt(before, data, point);
  const updated = zoomViewportAt(data, direction, point);
  const after = computeViewport({ ...data, ...updated });
  const actual = sourceAt(after, data, point);
  // Exhaust all independently addressable windows as an oracle: no other valid
  // integer offset may preserve the old source point better on either axis.
  for (const [axis, offset, canvas, visible] of [
    ['x', 'columnOffset', 'columns', 'columns'], ['y', 'rowOffset', 'rows', 'rows'],
  ]) {
    let bestError = Infinity;
    for (let i = 0; i <= after.canvas[canvas] - after.window[visible]; i++) {
      const candidate = sourceAt(after, data, point, { ...after.window, [offset]: i });
      bestError = Math.min(bestError, Math.abs(candidate[axis] - anchor[axis]));
    }
    near(Math.abs(actual[axis] - anchor[axis]), bestError, 1e-8);
  }
  assert.ok(after.canvas.columns <= 297 && after.canvas.rows <= 297);
  assert.ok(after.window.columnOffset + after.window.columns <= after.canvas.columns);
  assert.ok(after.window.rowOffset + after.window.rows <= after.canvas.rows);
  near((after.canvas.columns * data.cells.widthPx - 2 * after.padding.x) / data.image.width,
    (after.canvas.rows * data.cells.heightPx - 2 * after.padding.y) / data.image.height);
  return { before, after, anchor, actual, updated };
}

test('pointer zoom anchors both off-center axes using realized offsets, not requested center', () => {
  const data = { ...input, zoomFactor: 2.5, center: { x: 0.547, y: 0.563 } };
  const point = { column: 23.5, row: 20.5 };
  const { before, after, anchor, actual, updated } = assertBestAnchor(data, 'in', point);
  assert.notEqual(before.center.x, before.realizedCenter.x);
  assert.notEqual(before.center.y, before.realizedCenter.y);
  assert.ok(after.window.columnOffset > 0 && after.window.rowOffset > 0);
  for (const [axis, cell] of [['x', 'widthPx'], ['y', 'heightPx']]) {
    near(actual[axis], anchor[axis], data.cells[cell] / after.effectiveScale / 2 + 1e-9);
    assert.notEqual(updated.center[axis], before.center[axis]);
  }
  assertBestAnchor({ ...data, ...updated }, 'out', point);
  // The old keyboard helper still retains the requested normalized center.
  assert.deepEqual(zoomViewport(data, 'in').center, before.center);
});

test('pointer anchors remain nearest across portrait/landscape rounding and fractional cell pixels', () => {
  for (const image of [{ width: 701, height: 499 }, { width: 499, height: 701 },
    { width: 1201, height: 603 }, { width: 603, height: 1201 }]) {
    for (const cells of [input.cells, { widthPx: 7.3, heightPx: 15.7 }]) {
      for (const direction of ['in', 'out']) {
        const data = { ...input, image, cells, area: { columns: 61, rows: 27 },
          zoomFactor: 2.35, center: { x: 0.523, y: 0.481 } };
        const point = { column: 20.5, row: 17.5 };
        const { before, after, anchor, actual } = assertBestAnchor(data, direction, point);
        assert.ok(before.padding.x > 0 || before.padding.y > 0);
        for (const [axis, full, window, cell] of [
          ['x', 'columns', 'columns', 'widthPx'], ['y', 'rows', 'rows', 'heightPx'],
        ]) {
          if (after.canvas[full] > after.window[window]) {
            near(actual[axis], anchor[axis], cells[cell] / after.effectiveScale / 2 + 1e-9);
          } else assert.equal(after.center[axis], 0.5);
        }
      }
    }
  }
  // Dense non-binary-exact boundary cases include both internal padding axes.
  for (let width = 13; width < 450; width += 11) {
    const data = { ...input, image: { width, height: width + 17 },
      area: { columns: 39, rows: 19 }, cells: { widthPx: 7.25, heightPx: 15.5 },
      zoomFactor: 1.97, center: { x: 0.493, y: 0.517 } };
    for (const direction of ['in', 'out']) {
      assertBestAnchor(data, direction, { column: 11.125, row: 12.875 });
    }
  }
});

test('pointer zoom handles undersized/centered origins becoming clipped and necessarily recentering', () => {
  const data = { image: { width: 701, height: 499 }, area: { columns: 41, rows: 19 },
    cells: { widthPx: 7.3, heightPx: 15.7 }, zoomFactor: 0.9 };
  const point = { column: 29.5, row: 12.5 };
  const { before, after, updated } = assertBestAnchor(data, 'in', point);
  assert.ok(before.window.columns < data.area.columns && before.origin.column > 0);
  assert.ok(after.canvas.columns > data.area.columns);
  assert.ok(before.window.rows < data.area.rows && after.canvas.rows < data.area.rows);
  assert.equal(after.center.y, 0.5);
  const reverse = assertBestAnchor({ ...data, ...updated }, 'out', point);
  assert.deepEqual(reverse.after.center, { x: 0.5, y: 0.5 });
  // A portrait transposes the transition to the row axis.
  const portrait = { ...data, image: { width: 499, height: 701 },
    area: { columns: 41, rows: 19 } };
  const transition = assertBestAnchor(portrait, 'in', { column: 25.5, row: 13.5 });
  assert.ok(transition.before.window.rows < portrait.area.rows);
  assert.ok(transition.after.canvas.rows > portrait.area.rows);
  assert.equal(transition.after.center.x, 0.5);
});

test('pointer anchoring clamps all edges, accepts area letterbox and has stable limit no-ops', () => {
  for (const center of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 0 }]) {
    for (const point of [{ column: 0, row: 0 }, { column: 79.999, row: 29.999 },
      { column: 0.5, row: 29.5 }, { column: 79.5, row: 0.5 }]) {
      for (const direction of ['in', 'out']) {
        assertBestAnchor({ ...input, zoomFactor: 2.5, center }, direction, point);
      }
    }
  }
  const clamped = assertBestAnchor({ ...input, zoomFactor: 2.5, center: { x: 0, y: 0 } },
    'out', { column: 70.5, row: 23.5 });
  assert.equal(clamped.after.window.columnOffset, 0);
  assert.equal(clamped.after.window.rowOffset, 0);
  assert.ok(Math.abs(clamped.actual.x - clamped.anchor.x) >
    input.cells.widthPx / clamped.after.effectiveScale / 2);
  assertBestAnchor({ ...input, zoomFactor: 0.3 }, 'in', { column: 0.5, row: 0.5 });

  for (const [zoomFactor, direction] of [[1e9, 'in'], [0.001, 'out']]) {
    const data = { ...input, zoomFactor, center: { x: 0.547, y: 0.563 } };
    const view = computeViewport(data);
    let updated = { zoomFactor: view.zoomFactor, center: view.center };
    for (let i = 0; i < 50; i++) {
      const next = zoomViewportAt({ ...data, ...updated }, direction, { column: 13.5, row: 23.5 });
      assert.deepEqual(next, updated);
      updated = next;
    }
  }
  // One step reaches each limit; further events must not move the view.
  const maximum = computeViewport(input).maxZoomFactor;
  for (const [zoomFactor, direction] of [[maximum / 1.1, 'in'], [0.26, 'out']]) {
    const data = { ...input, zoomFactor, center: { x: 0.547, y: 0.563 } };
    const { updated } = assertBestAnchor(data, direction, { column: 13.5, row: 23.5 });
    assert.equal(updated.zoomFactor, direction === 'in' ? maximum : MIN_ZOOM_FACTOR);
    assert.deepEqual(zoomViewportAt({ ...data, ...updated }, direction,
      { column: 70.5, row: 3.5 }), updated);
  }
});

test('pointer zoom validates finite area-relative coordinates and returns immutable state', () => {
  const data = structuredClone({ ...input, zoomFactor: 2.5, center: { x: 0.547, y: 0.563 } });
  const point = { column: 13.5, row: 23.5 };
  const original = structuredClone(data);
  const originalPoint = { ...point };
  const result = zoomViewportAt(data, 'in', point);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.center));
  assert.deepEqual(data, original); assert.deepEqual(point, originalPoint);
  assert.notEqual(result.center, data.center);
  assert.throws(() => { result.center.x = 0; }, TypeError);
  for (const invalid of [undefined, null, {}, { column: 1 }, { column: '1', row: 1 },
    { column: NaN, row: 1 }, { column: 1, row: Infinity }, { column: -0.001, row: 1 },
    { column: 1, row: -0.001 }, { column: 80, row: 1 }, { column: 1, row: 30 }]) {
    assert.throws(() => zoomViewportAt(data, 'in', invalid), RangeError);
    assert.throws(() => zoomViewportAt({ ...data, zoomFactor: 1e9 }, 'in', invalid), RangeError);
  }
  assert.throws(() => zoomViewportAt(data, 'sideways', point), RangeError);
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
    `import {computeViewport,panViewport,zoomViewport,zoomViewportAt,resetViewport} from ${JSON.stringify(module)};
     const input=${JSON.stringify(input)}; computeViewport(input); panViewport(input,{xCells:4});
     zoomViewport(input,'in'); zoomViewportAt(input,'in',{column:13.5,row:23.5}); resetViewport(input);`], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});
