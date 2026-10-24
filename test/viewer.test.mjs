import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewerController, indexSnapshots, viewerArea, viewerTitle } from '../src/viewer.mjs';
import { encodeViewportRows, PLACEHOLDER } from '../src/kitty.mjs';
import { computeViewport, panViewport, zoomViewport, zoomViewportAt } from '../src/viewport.mjs';

const strip = (text) => text.replace(/\x1b\[[0-9:;]*m/g, '').replace(/\p{Mark}/gu, '');
const width = (text) => [...strip(text)].length;
const cut = (text, limit) => width(text) <= limit ? text : [...strip(text)].slice(0, limit).join('');
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await turn(); } assert.fail('viewer did not settle'); }
const snapshots = [1, 2].map((page) => ({ occurrence: `page-${page}`, label: `PDF — page ${page}`, attachment: { type: 'image', mimeType: 'image/png', data: `snapshot-${page}` } }));

function fakeClock({ automatic = false } = {}) {
  let now = 0, sequence = 0;
  const timers = new Map(), deferred = [];
  const clock = {
    now: () => now,
    schedule(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, due: now + delay });
      if (automatic) setImmediate(() => {
        const timer = timers.get(id);
        if (!timer) return;
        timers.delete(id); now = Math.max(now, timer.due); timer.callback();
      });
      return id;
    },
    cancelScheduled: (id) => timers.delete(id),
    defer(callback) {
      deferred.push(callback);
      if (automatic) queueMicrotask(() => clock.flush());
    },
    flush() { const batch = deferred.splice(0); for (const callback of batch) callback(); },
    advance(ms = 0) {
      now += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.due <= now);
      for (const [id, timer] of due) if (timers.delete(id)) timer.callback();
    },
    get timerCount() { return timers.size; }, get deferredCount() { return deferred.length; },
    get callbacks() { return [...timers.values()].map((timer) => timer.callback); },
  };
  return clock;
}

function harness(options = {}) {
  const clock = options.clock || fakeClock({ automatic: true });
  let repaints = 0, theme = 'original';
  const terminal = { columns: 40, rows: 16, writes: [], write(bytes) {
    if (writeFailure) throw new Error('mock partial graphics write');
    this.writes.push(bytes);
  } };
  const overlays = [], preparations = [], events = [];
  let focused, connection, observer, policy, hold, cleanupHold, normalize = 0, reserve = 0, pending = 0, maxPending = 0, retirement = false;
  const retirementEpochs = [];
  let frameFailure = false, writeFailure = false, cells = { widthPx: 8, heightPx: 16 };
  let liveLease, committed, capabilityCalls = 0, reuses = 0, reusedInput, capabilityHold;
  const tui = {
    terminal, requestRender() { repaints++; }, renderNow() { if (frameFailure) throw new Error('mock host removal frame failed'); events.push('repaint'); }, hasOverlay: () => overlays.length > 0,
    showOverlay(component) {
      const entry = { component, previous: focused }; overlays.push(entry);
      if (focused && 'focused' in focused) focused.focused = false;
      focused = component; component.focused = true;
      return { hide() {
        events.push('hide'); const index = overlays.indexOf(entry); if (index < 0) return;
        overlays.splice(index, 1);
        for (const other of overlays) if (other.previous === component) other.previous = entry.previous;
        if (focused === component) { component.focused = false; focused = overlays.at(-1)?.component || entry.previous; if (focused && 'focused' in focused) focused.focused = true; }
      }, isFocused: () => focused === component };
    },
  };
  connection = { tui, epoch: Symbol('epoch') };
  const presentation = {
    bind(callbacks) { observer = callbacks; return () => { observer = undefined; }; },
    get connection() { return connection; },
    commit(prepared, context) {
      if (!connection || connection.epoch !== context.epoch || context.signal.aborted) { prepared.onUploadFailed?.(); return false; }
      if (prepared.uploads) { prepared.onUploadStarted?.(); terminal.write(prepared.uploads); }
      prepared.onUploaded?.(); return true;
    },
  };
  const native = {
    async resolvePayload(attachment, signal) {
      normalize++; signal.throwIfAborted();
      if (options.normalizeFailure) throw new Error('snapshot conversion failed');
      return { width: 640, height: 480, attachment };
    },
    reserveViewerPlacement() { reserve++; liveLease = { generation: reserve }; return liveLease; },
    releaseViewer(lease) { events.push('release'); retirement = Boolean(lease.committed || lease.attempted); liveLease = undefined; },
    reuseViewer(input, context) {
      if (!options.reuse || pending || !resident(input, context)) return;
      reuses++; reusedInput = input;
      return { uploads: '', lines: rows(input), isResident: () => resident(input, context),
        isCurrent: () => resident(input, context), onUploaded() {}, onUploadFailed() {} };
    },
    async prepareViewer(input, context) {
      pending++; maxPending = Math.max(maxPending, pending); preparations.push({ ...input, context });
      if (hold) await new Promise((resolve) => { hold.finish = resolve; });
      pending--;
      return { uploads: `WRITE-${preparations.length}`, lines: rows(input),
        isResident: () => resident(input, context),
        onUploadStarted() { input.lease.attempted = true; committed = undefined; },
        onUploaded() { input.lease.committed = true; committed = { ...input, epoch: context.epoch }; events.push('uploaded'); },
        onUploadFailed() {
          if (options.revokeOnReject) committed = undefined;
          events.push('failed');
        } };
    },
    async prepareViewerRetirement(context) {
      if (!retirement) return { uploads: '', lines: [] };
      retirementEpochs.push(context.epoch);
      events.push('retire'); return { uploads: 'RETIRE', lines: [], onUploaded() { retirement = false; events.push('retired'); }, onUploadFailed() { events.push('retirement-failed'); } };
    },
  };
  function resident(input, context) {
    return committed?.lease === input.lease && liveLease === input.lease &&
      committed.epoch === context.epoch && connection?.epoch === context.epoch &&
      JSON.stringify(committed.canvas) === JSON.stringify(input.canvas);
  }
  function rows(input) {
    return encodeViewportRows({ ...input.window, imageId: 42, placementId: 43,
      canvasColumns: input.canvas.columns, canvasRows: input.canvas.rows });
  }
  const controller = createViewerController({ native, presentation, getContext: () => ({ mode: 'tui' }),
    getSnapshots: () => options.snapshots || [snapshots[0]], requireCapability: async (_ctx, signal) => {
      capabilityCalls++;
      if (capabilityHold?.target === capabilityCalls) await new Promise((resolve) => { capabilityHold.finish = resolve; });
      signal?.throwIfAborted(); if (cleanupHold && events.includes('hide')) await new Promise((resolve) => { cleanupHold.finish = resolve; });
      if (policy) throw new Error(policy);
    },
    readyPolicy: () => policy, getCells: () => cells,
    // Match the real Pi '+' syntax boundary: literal '+' is not a matcher key.
    matchesKey: (data, name) => name !== '+' && data === name,
    truncateToWidth(text, limit) {
      if (options.forbidRowScanning && text.includes(PLACEHOLDER)) throw new Error('known-width cells were truncated');
      return cut(text, limit);
    },
    visibleWidth(text) {
      if (options.forbidRowScanning && text.includes(PLACEHOLDER)) throw new Error('known-width cells were rescanned');
      return width(text);
    },
    pacing: { ...clock, idleMs: 100, wheelExpiryMs: null },
    style: (_kind, text) => options.theme ? `${theme}:${text}` : text,
    notify: (message) => events.push(message), sanitizeText: (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '') });
  return { controller, terminal, tui, preparations, events, clock,
    get repaints() { return repaints; }, setTheme(value) { theme = value; },
    get pendingWork() { return pending || clock.timerCount || clock.deferredCount; },
    get component() { return overlays[0]?.component; }, get overlays() { return overlays; },
    get normalize() { return normalize; }, get reserve() { return reserve; }, get maxPending() { return maxPending; },
    get capabilityCalls() { return capabilityCalls; }, get reuses() { return reuses; },
    get reusedInput() { return reusedInput; },
    holdCapability(offset = 1) { capabilityHold = { target: capabilityCalls + offset }; return capabilityHold; },
    releaseCapability() { const old = capabilityHold; capabilityHold = undefined; old?.finish?.(); },
    render() { return overlays[0]?.component.render(terminal.columns) || []; },
    key(data) { focused?.handleInput?.(data); },
    mouse(event) { return focused?.handleMouse?.({ x: 20, y: 8, button: 'none', ...event }); },
    hold() { hold = {}; return hold; }, unhold() { const previous = hold; hold = undefined; previous?.finish?.(); },
    holdCleanup() { cleanupHold = {}; return cleanupHold; },
    unholdCleanup() { const previous = cleanupHold; cleanupHold = undefined; previous?.finish?.(); },
    refresh() { observer?.onDisconnect(connection); connection = { tui, epoch: Symbol('refreshed') }; },
    get epoch() { return connection?.epoch; }, retirementEpochs,
    setPolicy(reason) { policy = reason; }, setFrameFailure(value) { frameFailure = value; },
    setCells(value) { cells = value; }, setWriteFailure(value) { writeFailure = value; },
    get retirementPending() { return retirement; },
    loseProof() { committed = undefined; },
    disconnect() { observer?.onDisconnect(connection); connection = undefined; },
  };
}

async function openReady(h) {
  const done = h.controller.open();
  await until(() => h.component); h.render();
  await until(() => h.render().some((row) => row.includes(PLACEHOLDER)));
  return { done };
}

test('viewer snapshot index newest first: stable occurrence, frozen copy, no storage mutation', () => {
  const entries = snapshots.map((snapshot) => ({ snapshot }));
  const original = JSON.stringify(entries);
  const index = indexSnapshots(entries, (entry) => entry.snapshot);
  assert.equal(index[0].occurrence, 'page-2'); assert.equal(index[1].occurrence, 'page-1');
  assert.ok(Object.isFrozen(index[0]) && Object.isFrozen(index[0].attachment));
  assert.equal(JSON.stringify(entries), original);
});

test('viewer area reserves chrome and bounds full-pane inner canvas; tiny panes are text-only', () => {
  assert.deepEqual(viewerArea(40, 16).area, { columns: 36, rows: 10 });
  assert.deepEqual(viewerArea(1000, 1000).area, { columns: 297, rows: 297 });
  assert.equal(viewerArea(3, 5).usable, false);
  assert.equal(viewerArea(19, 16).usable, false); assert.equal(viewerArea(20, 7).usable, true);
});

test('title reserves complete Fit/limit suffix and carries PDF page separately from long labels', () => {
  const label = '/long/path/'.repeat(30) + '図像'.repeat(50) + '.pdf — page 2';
  for (const columns of [20, 24, 40, 80]) {
    const title = viewerTitle(label, { fitPercent: 29700, atZoomLimit: true }, columns, { truncateToWidth: cut, visibleWidth: width });
    assert.ok(title.title.endsWith('29700% Fit (limit)'));
    assert.equal(title.pageHint, 'page 2'); assert.ok(width(title.title) <= columns);
  }
});

test('single snapshot auto-opens fit, controls/pointer barrier, new open resets and unknown keys stay owned', async () => {
  const h = harness(); const { done } = await openReady(h);
  assert.equal(h.normalize, 1); assert.equal(h.reserve, 1);
  const first = h.preparations[0].canvas;
  h.key('+'); await until(() => h.preparations.length === 2); await mouseReady(h);
  assert.ok(h.preparations[1].canvas.columns > first.columns);
  h.key('l'); h.key('j'); h.key('garbage');
  const mouse = h.component.handleMouse({ type: 'wheel' }); assert.equal(mouse.handled, true);
  h.key('0'); await mouseReady(h);
  assert.deepEqual(h.preparations.at(-1).canvas, first);
  h.key('escape'); await done;
  assert.ok(h.events.indexOf('release') < h.events.indexOf('hide')); assert.ok(h.events.indexOf('hide') < h.events.indexOf('retire'));
  assert.ok(h.events.lastIndexOf('repaint') < h.events.lastIndexOf('retired'), 'public removal frame must precede private retirement');
  assert.equal(h.controller.isOpen, false);
  const next = await openReady(h); assert.deepEqual(h.preparations.at(-1).canvas, first);
  await h.controller.close(); await next.done;
});

async function mouseReady(h) {
  for (let n = 0; n < 100; n++) {
    const before = h.render(); await turn(); const after = h.render();
    if (!h.pendingWork && before.some((row) => row.includes(PLACEHOLDER)) &&
        !before.some((row) => row.includes('Updating viewport')) &&
        before.join('\n') === after.join('\n')) return;
  }
  assert.fail('viewer did not reach a stable resident frame');
}
const lastPrepare = (h) => h.preparations.at(-1);

// Terminal-cell centers reconstructed independently from the prepared subset.
function pointerSource(h, x, y) {
  const job = lastPrepare(h), frame = viewerArea(h.terminal.columns, h.terminal.rows);
  const scale = Math.min(job.canvas.columns * 8 / 640, job.canvas.rows * 16 / 480);
  const origin = { x: Math.floor((frame.area.columns - job.window.columns) / 2),
    y: Math.floor((frame.area.rows - job.window.rows) / 2) };
  return { x: ((job.window.columnOffset + x - frame.left - 1 + 0.5 - origin.x) * 8 -
    (job.canvas.columns * 8 - 640 * scale) / 2) / scale,
  y: ((job.window.rowOffset + y - frame.top - 1 + 0.5 - origin.y) * 16 -
    (job.canvas.rows * 16 - 480 * scale) / 2) / scale, scale };
}

test('wheel uses pointer anchor, sign not accelerated lines, and one latest synchronous burst', async () => {
  const h = harness(); const { done } = await openReady(h);
  for (let n = 0; n < 5; n++) { h.key('+'); await mouseReady(h); }
  const x = 14, y = 7, before = pointerSource(h, x, y), old = lastPrepare(h).canvas.columns;
  const count = h.preparations.length;
  for (let n = 0; n < 10000; n++) h.mouse({ type: 'wheel', wheelDelta: n === 9999 ? -1000 : 1000, x, y });
  await until(() => h.preparations.length > count); await mouseReady(h);
  assert.equal(h.preparations.length, count + 1, 'a synchronous burst spawned more than one intent');
  const after = pointerSource(h, x, y);
  assert.ok(Math.abs(after.x - before.x) <= 8 / after.scale / 2 + 1e-9);
  assert.ok(Math.abs(after.y - before.y) <= 16 / after.scale / 2 + 1e-9);
  assert.ok(lastPrepare(h).canvas.columns > old);
  assert.ok(lastPrepare(h).canvas.columns <= Math.ceil(old * 1.25), 'accelerated lines multiplied zoom steps');
  h.mouse({ type: 'wheel', wheelDelta: 1000, x, y }); await turn(); await mouseReady(h);
  assert.equal(lastPrepare(h).canvas.columns, old, 'positive wheel did not zoom out by one step');
  assert.equal(h.maxPending, 1); assert.equal(h.normalize, 1); assert.equal(h.reserve, 1);
  h.key('escape'); await done;
});

test('left grab follows pointer in both axes, clamps, reverses immediately and ends on release', async () => {
  const h = harness(); const { done } = await openReady(h);
  for (let n = 0; n < 5; n++) { h.key('+'); await mouseReady(h); }
  const start = { ...lastPrepare(h).window }, canvas = { ...lastPrepare(h).canvas };
  assert.equal(h.mouse({ type: 'press', button: 'left', x: 20, y: 8 }).capture, true);
  h.mouse({ type: 'drag', button: 'left', x: 23, y: 10 }); await mouseReady(h);
  assert.equal(lastPrepare(h).window.columnOffset, start.columnOffset - 3);
  assert.equal(lastPrepare(h).window.rowOffset, start.rowOffset - 2);
  assert.deepEqual(lastPrepare(h).canvas, canvas);
  // Capture continues outside the usable area, without piling up edge motion.
  h.mouse({ type: 'drag', button: 'left', x: 200, y: 100 }); await mouseReady(h);
  assert.equal(lastPrepare(h).window.columnOffset, 0); assert.equal(lastPrepare(h).window.rowOffset, 0);
  h.mouse({ type: 'drag', button: 'left', x: 199, y: 99 }); await mouseReady(h);
  assert.equal(lastPrepare(h).window.columnOffset, 1); assert.equal(lastPrepare(h).window.rowOffset, 1);
  h.mouse({ type: 'release', button: 'none', x: 198, y: 98 }); await mouseReady(h);
  assert.equal(lastPrepare(h).window.columnOffset, 2); assert.equal(lastPrepare(h).window.rowOffset, 2);
  const released = h.preparations.length;
  h.mouse({ type: 'drag', button: 'left', x: 190, y: 90 }); await turn();
  assert.equal(h.preparations.length, released);
  h.key('escape'); await done;
});

test('mouse chrome/picker/invalid/loading/tiny input is consumed without gestures', async () => {
  const h = harness(); const { done } = await openReady(h), count = h.preparations.length;
  for (const event of [
    { type: 'wheel', wheelDelta: -1, y: 0 }, { type: 'wheel', wheelDelta: -1, x: 0 },
    { type: 'wheel', wheelDelta: NaN }, { type: 'wheel', wheelDelta: Infinity },
    { type: 'wheel', wheelDelta: 0 }, { type: 'wheel', wheelDelta: -1, x: Infinity },
    { type: 'press', button: 'right' }, { type: 'press', button: 'middle' },
    { type: 'press', button: 'left', y: 0 }, { type: 'press', button: 'left', x: 2 },
  ]) assert.equal(h.mouse(event).handled, true);
  h.mouse({ type: 'drag', button: 'left', x: 10, y: 5 }); await turn();
  assert.equal(h.preparations.length, count);
  h.hold(); h.key('+'); await until(() => h.preparations.length > count);
  const preparing = h.preparations.length;
  h.render(); h.mouse({ type: 'wheel', wheelDelta: -1 }); h.mouse({ type: 'press', button: 'left' });
  h.mouse({ type: 'drag', button: 'left', x: 25, y: 10 }); await turn();
  assert.equal(h.preparations.length, preparing);
  h.unhold(); await mouseReady(h);
  h.terminal.columns = 12; h.terminal.rows = 6; h.render();
  h.mouse({ type: 'wheel', wheelDelta: -1 }); h.mouse({ type: 'press', button: 'left' }); await turn();
  assert.equal(h.preparations.length, preparing); h.key('escape'); await done;
  const picker = harness({ snapshots }); const picked = picker.controller.open(); await until(() => picker.component);
  picker.render(); picker.mouse({ type: 'wheel', wheelDelta: -1 });
  picker.mouse({ type: 'press', button: 'left' }); await turn(); assert.equal(picker.reserve, 0);
  picker.key('return'); await mouseReady(picker);
  assert.equal(picker.reserve, 1);
  picker.key('escape'); await picked;
});

test('resize, keyboard, wheel and close invalidate drag and queued mouse work', async () => {
  const h = harness(); const { done } = await openReady(h);
  for (let n = 0; n < 5; n++) { h.key('+'); await mouseReady(h); }
  h.mouse({ type: 'press', button: 'left' }); h.key('l'); await mouseReady(h);
  let count = h.preparations.length;
  h.mouse({ type: 'drag', button: 'left', x: 25 }); await turn(); assert.equal(h.preparations.length, count);
  h.mouse({ type: 'press', button: 'left' });
  h.terminal.columns = 38; h.render(); await mouseReady(h); count = h.preparations.length;
  h.mouse({ type: 'drag', button: 'left', x: 25 }); await turn(); assert.equal(h.preparations.length, count);
  h.mouse({ type: 'press', button: 'left' });
  h.setCells({ widthPx: 9, heightPx: 18 }); h.render(); await mouseReady(h); count = h.preparations.length;
  h.mouse({ type: 'drag', button: 'left', x: 25 }); await turn(); assert.equal(h.preparations.length, count);
  h.setCells({ widthPx: 8, heightPx: 16 }); h.render(); await mouseReady(h);
  h.mouse({ type: 'press', button: 'left' }); h.mouse({ type: 'wheel', wheelDelta: -1 });
  await turn(); await mouseReady(h); count = h.preparations.length;
  h.mouse({ type: 'drag', button: 'left', x: 25 }); await turn(); assert.equal(h.preparations.length, count);
  const obsolete = h.component;
  h.mouse({ type: 'wheel', wheelDelta: -1 }); h.key('escape'); await done;
  assert.equal(h.preparations.length, count, 'close allowed queued wheel work');
  await openReady(h); const freshCount = h.preparations.length;
  obsolete.handleMouse({ type: 'drag', button: 'left', x: 25, y: 8 }); await turn();
  assert.equal(h.preparations.length, freshCount);
  assert.deepEqual(lastPrepare(h).canvas, { ...computeViewport({ image: { width: 640, height: 480 },
    area: viewerArea(38, 16).area, cells: { widthPx: 8, heightPx: 16 } }).canvas, cellWidthPx: 8, cellHeightPx: 16 });
  await h.controller.close();
});

test('mouse admission requires a rendered frame, not merely a committed surface', async () => {
  const h = harness(); const { done } = await openReady(h);
  const count = h.preparations.length; h.key('+');
  await until(() => h.events.filter((event) => event === 'uploaded').length === 2);
  const writes = h.terminal.writes.length;
  assert.notEqual(h.mouse({ type: 'press', button: 'left' }).capture, true);
  h.mouse({ type: 'wheel', wheelDelta: -1 }); await turn();
  assert.equal(h.preparations.length, count + 1); assert.equal(h.terminal.writes.length, writes);
  h.render(); assert.equal(h.mouse({ type: 'press', button: 'left' }).capture, true);
  await h.controller.close(); await done;
});

test('queued wheel is cancelled by live cells, focus loss and disconnect before its microtask', async () => {
  for (const cancel of [
    (h) => h.setCells({ widthPx: 10, heightPx: 20 }),
    (h) => h.tui.showOverlay({ focused: false }),
    (h) => h.refresh(),
  ]) {
    const h = harness(); const { done } = await openReady(h), count = h.preparations.length;
    h.mouse({ type: 'wheel', wheelDelta: -1 }); cancel(h); await turn();
    assert.equal(h.preparations.length, count);
    await h.controller.close(); await done;
  }
});

test('10000 captured moves during held prepare stay bounded and cannot publish after close', async () => {
  const h = harness(); const { done } = await openReady(h);
  for (let n = 0; n < 5; n++) { h.key('+'); await mouseReady(h); }
  assert.equal(h.mouse({ type: 'press', button: 'left' }).capture, true);
  const gate = h.hold(); h.mouse({ type: 'drag', button: 'left', x: 21, y: 9 });
  await until(() => gate.finish);
  const count = h.preparations.length, writes = h.terminal.writes.length;
  for (let n = 0; n < 10000; n++) h.mouse({ type: 'drag', button: 'left', x: 20 + n % 3, y: 8 + n % 3 });
  h.mouse({ type: 'release', button: 'none', x: 22, y: 10 });
  assert.equal(h.maxPending, 1); assert.equal(h.preparations.length, count);
  const closed = h.controller.close(); await turn(); h.unhold(); await closed; await done;
  assert.equal(h.terminal.writes.length, writes + 1, 'cancelled pan published transport after close');
  assert.equal(h.terminal.writes.at(-1), 'RETIRE');
});

test('resident pan samples rows with no capability calls, prepares or transport', async () => {
  const h = harness({ reuse: true }); const { done } = await openReady(h);
  for (let n = 0; n < 5; n++) { h.key('+'); await mouseReady(h); }
  const calls = h.capabilityCalls, writes = h.terminal.writes.length, prepared = h.preparations.length;
  const original = lastPrepare(h).window;
  assert.equal(h.mouse({ type: 'press', button: 'left' }).capture, true);
  h.mouse({ type: 'drag', button: 'left', x: 23, y: 10 });
  assert.equal(h.reusedInput, undefined, 'raw motion encoded rows before eligibility');
  await mouseReady(h);
  assert.equal(h.reusedInput.window.columnOffset, original.columnOffset - 3);
  assert.equal(h.reusedInput.window.rowOffset, original.rowOffset - 2);
  for (let n = 0; n < 10000; n++) h.mouse({ type: 'drag', button: 'left', x: 20 + n % 2, y: 8 + n % 2 });
  h.mouse({ type: 'release', button: 'none', x: 20, y: 8 });
  await mouseReady(h);
  assert.ok(h.render().some((line) => line.includes(PLACEHOLDER)));
  assert.equal(h.reuses, 2, 'report flood encoded obsolete intermediate windows');
  assert.equal(h.capabilityCalls, calls); assert.equal(h.preparations.length, prepared);
  assert.equal(h.terminal.writes.length, writes); assert.equal(h.normalize, 1); assert.equal(h.reserve, 1);
  await h.controller.close(); await done;
});

test('pending zoom preserves its own old frame and consumes only latest wheel after new frame renders', async () => {
  const h = harness({ reuse: true }); const { done } = await openReady(h);
  const old = h.render(), images = (lines) => lines.filter((line) => line.includes(PLACEHOLDER));
  const gate = h.hold(); h.mouse({ type: 'wheel', wheelDelta: -1 }); await until(() => gate.finish);
  const pending = h.render();
  assert.deepEqual(images(pending), images(old), 'old cells were moved into desired geometry');
  assert.match(strip(pending[0]), /100% Fit/); assert.match(strip(pending.at(-2)), /Updating viewport/);
  for (let n = 0; n < 10000; n++) h.mouse({ type: 'wheel', wheelDelta: n === 9999 ? 1 : -1, x: 14, y: 7 });
  await turn();
  assert.equal(h.preparations.length, 2); assert.equal(h.preparations[1].context.signal.aborted, false);
  h.unhold(); await until(() => h.events.filter((event) => event === 'uploaded').length === 2);
  // There has been no new render since commit: even another report must wait.
  h.mouse({ type: 'wheel', wheelDelta: 1, x: 15, y: 7 }); await turn();
  assert.equal(h.preparations.length, 2);
  const committed = h.render(); assert.match(strip(committed[0]), /125% Fit/);
  await mouseReady(h);
  assert.equal(h.preparations.length, 3); assert.match(strip(h.render()[0]), /100% Fit/);
  assert.equal(h.maxPending, 1);
  await h.controller.close(); await done;
});

test('live width, height and cells are resampled after final gate even before render', async () => {
  for (const change of [
    (h) => { h.terminal.columns = 38; },
    (h) => { h.terminal.rows = 15; },
    (h) => h.setCells({ widthPx: 9, heightPx: 18 }),
  ]) {
    const h = harness({ reuse: true }); const { done } = await openReady(h);
    const writes = h.terminal.writes.length, gate = h.holdCapability(2);
    h.key('+'); await until(() => gate.finish);
    change(h); h.releaseCapability(); await turn();
    assert.equal(h.terminal.writes.length, writes, 'old live layout committed without a render');
    assert.equal(h.preparations.length, 2); assert.ok(h.events.includes('failed'));
    h.render(); await mouseReady(h); assert.equal(h.preparations.length, 3);
    await h.controller.close(); await done;
  }
});

test('failed zoom clears retained cells and queued wheel across a resize round trip', async () => {
  const h = harness({ reuse: true }); const { done } = await openReady(h);
  const gate = h.hold(); h.mouse({ type: 'wheel', wheelDelta: -1 }); await until(() => gate.finish);
  h.render(); h.mouse({ type: 'wheel', wheelDelta: 1 }); await turn();
  h.setWriteFailure(true); h.unhold(); await turn();
  const failed = h.render(); assert.ok(!failed.some((line) => line.includes(PLACEHOLDER)));
  assert.match(failed.join('\n'), /mock partial graphics write/);
  h.setWriteFailure(false); h.terminal.columns = 38; h.render(); await mouseReady(h);
  h.terminal.columns = 40; h.render(); await mouseReady(h);
  assert.equal(h.preparations.length, 4, 'failed pending wheel survived recovery');
  assert.match(strip(h.render()[0]), /125% Fit/);
  await h.controller.close(); await done;
});

test('validated placeholder rows bypass redundant width scans and remain within supplied width', async () => {
  const h = harness({ reuse: true, forbidRowScanning: true }); const { done } = await openReady(h);
  for (const columns of [20, 40, 100, 320]) {
    h.terminal.columns = columns; h.render(); await mouseReady(h);
    h.key('+'); await mouseReady(h);
    for (const line of h.render()) assert.ok(width(line) <= columns);
  }
  await h.controller.close(); await done;
});

test('newest-first picker uses same owned overlay and prepares only selected immutable page', async () => {
  const h = harness({ snapshots: [snapshots[1], snapshots[0]] });
  const done = h.controller.open(); await until(() => h.component);
  assert.ok(h.render().join('').includes('page 2')); assert.equal(h.normalize, 0);
  h.key('j'); h.key('return');
  await until(() => h.render().some((row) => row.includes(PLACEHOLDER)));
  assert.equal(h.overlays.length, 1); assert.equal(h.normalize, 1);
  await h.controller.close(); await done;
});

test('existing modal denies admission before capability/normalization; single-open reserved before await', async () => {
  const h = harness(); const upper = h.tui.showOverlay({ focused: false });
  await assert.rejects(h.controller.open(), /current dialog\/search/); assert.equal(h.normalize, 0); upper.hide();
  const done = h.controller.open(); await assert.rejects(h.controller.open(), /already open or closing/);
  await h.controller.close(); await done; assert.equal(h.overlays.length, 0);
});

test('public focus loss revokes synchronously, deferred scoped hide preserves unrelated upper and guards stale component', async () => {
  const h = harness(); const { done } = await openReady(h); const old = h.component;
  const upper = h.tui.showOverlay({ focused: false });
  assert.ok(h.events.includes('release')); assert.deepEqual(old.render(40), []);
  await done; assert.equal(h.overlays.length, 1); assert.equal(upper.isFocused(), true);
  upper.hide(); const next = await openReady(h);
  old.focused = false; assert.equal(h.controller.isOpen, true, 'stale focused setter cannot close a new generation');
  await h.controller.close(); await next.done;
});

test('10000 rapid zoom/pan inputs retain one pending runner/latest intent and wait before retiring/reopening', async () => {
  const h = harness(); const { done } = await openReady(h);
  const gate = h.hold(); h.key('+'); await until(() => gate.finish);
  for (let n = 0; n < 10000; n++) h.key(n % 4 === 0 ? '+' : n % 4 === 1 ? '-' : n % 4 === 2 ? 'l' : 'h');
  assert.equal(h.maxPending, 1); assert.equal(h.preparations.length, 2);
  const close = h.controller.close(); await turn();
  assert.equal(h.controller.isOpen, true); assert.equal(h.events.includes('retire'), false);
  await assert.rejects(h.controller.open(), /closing/);
  h.unhold(); await close; await done;
  assert.equal(h.events.filter((event) => event === 'retire').length, 1);
  assert.equal(h.terminal.writes.includes('WRITE-2'), false, 'stale pending view cannot upload after immediate revocation');
});

test('resize retains fit-relative zoom/center and never publishes stale geometry; small pane stays keyboard-owned', async () => {
  const h = harness(); const { done } = await openReady(h); h.key('+');
  await until(() => h.preparations.length >= 2); await until(() => h.render().some((row) => row.includes(PLACEHOLDER)));
  h.terminal.columns = 20; h.render(); await until(() => h.preparations.length >= 3);
  assert.ok(h.render().every((line) => width(line) <= 20));
  h.terminal.rows = 5; assert.ok(h.render().join('').includes('Pane too small')); assert.equal(h.overlays.length, 1);
  h.key('escape'); await done;
});

test('ready policy denial revokes rows with no synchronous probing/transport; disconnect closes owned lease', async () => {
  const h = harness(); const { done } = await openReady(h); const writes = h.terminal.writes.length;
  h.setPolicy('disabled'); assert.deepEqual(h.render(), []); assert.equal(h.terminal.writes.length, writes);
  await done; assert.ok(h.events.some((event) => String(event).includes('cleanup')));
  const fresh = harness(); const opened = await openReady(fresh); fresh.disconnect(); await opened.done;
  assert.equal(fresh.overlays.length, 0); assert.equal(fresh.events.includes('retire'), false, 'disconnected epoch must not emit retirement graphics');
});

test('retirement retry selects fresh connection after held close drains across concurrent refresh', async () => {
  const h = harness(); const opened = await openReady(h);
  const oldEpoch = h.epoch, gate = h.holdCleanup();
  const retry = h.controller.retryRetirement();
  await until(() => gate.finish); h.refresh(); const newEpoch = h.epoch;
  assert.notEqual(newEpoch, oldEpoch); h.unholdCleanup();
  await retry; await opened.done;
  assert.equal(h.retirementEpochs.at(-1), newEpoch);
  assert.equal(h.terminal.writes.filter((wire) => wire === 'RETIRE').length, 1, 'old stale attempt cannot write; new supported epoch retires once');
  assert.equal(h.events.filter((event) => event === 'retired').length, 1);
  const next = await openReady(h); await h.controller.close(); await next.done;
});

test('failed public removal frame cannot delete; supported recovery paints before retire/rebind', async () => {
  const h = harness(); const opened = await openReady(h); h.setFrameFailure(true);
  await h.controller.close(); await opened.done;
  assert.equal(h.retirementPending, true); assert.equal(h.terminal.writes.includes('RETIRE'), false);
  assert.ok(h.events.includes('retirement-failed'), 'failed public flush releases the prepared reservation');
  await assert.rejects(h.controller.open(), /removal frame failed/);
  assert.equal(h.reserve, 1); assert.equal(h.terminal.writes.includes('RETIRE'), false);
  h.setFrameFailure(false); const next = await openReady(h);
  assert.equal(h.retirementPending, false); assert.equal(h.reserve, 2);
  const retired = h.events.indexOf('retired'); assert.ok(retired > 0 && h.events[retired - 1] === 'repaint');
  await h.controller.close(); await next.done;
});

async function manualReady(h) {
  for (let n = 0; n < 100; n++) {
    const lines = h.render(); h.clock.flush();
    if (!h.pendingWork && lines.some((row) => row.includes(PLACEHOLDER)) &&
        !lines.some((row) => row.includes('Updating viewport'))) return;
    h.clock.advance(100); await turn();
  }
  assert.fail('manual clock did not settle the canonical target');
}
async function manualOpen(options = {}) {
  const h = harness({ ...options, clock: fakeClock() });
  h.done = h.controller.open(); await until(() => h.component);
  await manualReady(h); return h;
}
async function manualZoom(h, steps = 5) {
  for (let n = 0; n < steps; n++) { h.key('+'); await manualReady(h); }
}
const canonicalInput = (h, state = {}) => ({ image: { width: 640, height: 480 },
  area: viewerArea(h.terminal.columns, h.terminal.rows).area,
  cells: { widthPx: 8, heightPx: 16 }, ...state });
const shownInput = (h) => h.reusedInput || lastPrepare(h);

// Independent sequential clamp oracle, not panViewport's center as its answer.
function panReference(input, points, start = { x: 20, y: 8 }) {
  const view = computeViewport(input), center = { ...view.center };
  const bounds = (pixels, cell, full, visible, pad) => full === visible ? [0.5, 0.5] :
    [Math.max(0, (visible * cell / 2 - pad) / view.effectiveScale / pixels),
      Math.min(1, ((full - visible) * cell + visible * cell / 2 - pad) / view.effectiveScale / pixels)];
  const xb = bounds(640, 8, view.canvas.columns, view.window.columns, view.padding.x);
  const yb = bounds(480, 16, view.canvas.rows, view.window.rows, view.padding.y);
  let previous = start;
  for (const point of points) {
    center.x = Math.min(xb[1], Math.max(xb[0], center.x + (previous.x - point.x) * 8 / view.effectiveScale / 640));
    center.y = Math.min(yb[1], Math.max(yb[0], center.y + (previous.y - point.y) * 16 / view.effectiveScale / 480));
    previous = point;
  }
  return { zoomFactor: view.zoomFactor, center };
}

test('paced 10000-report flood preserves sequential edge/reversal final pose; incidental renders stay passive', async () => {
  const h = await manualOpen({ reuse: true }); await manualZoom(h);
  const input = canonicalInput(h, { zoomFactor: 1.25 ** 5 });
  const old = h.render().filter((row) => row.includes(PLACEHOLDER));
  const points = [{ x: 200, y: 100 }, { x: 199, y: 99 }];
  for (let n = 0; n < 10000; n++) points.push({ x: 20 + n % 3, y: 8 + n % 5 });
  points.push({ x: 198, y: 98 }, { x: 197, y: 97 });
  const expected = computeViewport({ ...input, ...panReference(input, points) });
  const counts = [h.preparations.length, h.capabilityCalls, h.terminal.writes.length, h.repaints];
  h.mouse({ type: 'press', button: 'left' });
  for (const point of points.slice(0, -1)) h.mouse({ type: 'drag', button: 'left', ...point });
  h.mouse({ type: 'release', ...points.at(-1) });
  assert.equal(h.reuses, 0); assert.equal(h.clock.timerCount, 1);
  for (let n = 0; n < 100; n++) assert.deepEqual(h.render().filter((row) => row.includes(PLACEHOLDER)), old);
  assert.deepEqual([h.preparations.length, h.capabilityCalls, h.terminal.writes.length, h.repaints], counts);
  await manualReady(h); assert.equal(h.reuses, 1); assert.deepEqual(shownInput(h).window, expected.window);
  assert.deepEqual([h.preparations.length, h.capabilityCalls, h.terminal.writes.length], counts.slice(0, 3));
  h.clock.advance(10000); h.render(); h.clock.flush(); assert.equal(h.reuses, 1);
  await h.controller.close(); await h.done;
});

test('pan release precedes wheel; premature press consumes without losing dirty final target', async () => {
  for (const prematurePress of [false, true]) {
    const h = await manualOpen({ reuse: true }); await manualZoom(h);
    const start = { ...shownInput(h).window };
    h.mouse({ type: 'press', button: 'left' }); h.mouse({ type: 'drag', button: 'left', x: 23, y: 10 });
    h.mouse({ type: 'release', x: 24, y: 11 }); h.mouse({ type: 'wheel', wheelDelta: -1 });
    if (prematurePress) assert.notEqual(h.mouse({ type: 'press', button: 'left' }).capture, true);
    h.clock.advance(100); await turn();
    assert.equal(h.reuses, 1); assert.equal(shownInput(h).window.columnOffset, start.columnOffset - 4);
    assert.equal(shownInput(h).window.rowOffset, start.rowOffset - 3);
    const prepared = h.preparations.length;
    h.clock.advance(10000); await turn(); assert.equal(h.preparations.length, prepared, 'new ready without receipt admitted wheel');
    h.render(); assert.equal(h.preparations.length, prepared, 'receipt consumed wheel inline');
    h.clock.flush(); h.clock.advance(99); await turn(); assert.equal(h.preparations.length, prepared);
    h.clock.advance(1); await turn(); assert.equal(h.preparations.length, prepared + (prematurePress ? 0 : 1));
    await manualReady(h); await h.controller.close(); await h.done;
  }
});

test('nominal canonical alias wheel/press preserves latest fit factor instead of old ready metadata', async () => {
  const h = await manualOpen({ reuse: true });
  h.terminal.columns = 20; h.terminal.rows = 7; h.render(); await manualReady(h);
  for (let n = 0; n < 8; n++) { h.key('-'); await manualReady(h); }
  assert.match(strip(h.render()[0]), /25% Fit/);
  const count = h.preparations.length, rows = h.render().filter((row) => row.includes(PLACEHOLDER));
  h.key('+'); // 31.25% aliases the same 1x1 mapping; old shown metadata is 25%.
  assert.deepEqual(h.render().filter((row) => row.includes(PLACEHOLDER)), rows);
  assert.match(strip(h.render()[0]), /25% Fit/);
  const frame = viewerArea(20, 7), point = { x: frame.left + 1 + 7, y: frame.top + 1 };
  assert.equal(h.mouse({ type: 'press', button: 'left', ...point }).capture, true);
  assert.equal(h.preparations.length, count, 'unadmitted nominal alias prepared geometry');
  h.mouse({ type: 'release', ...point }); h.mouse({ type: 'wheel', wheelDelta: -1, ...point });
  await manualReady(h);
  assert.match(strip(h.render()[0]), /39% Fit/, 'wheel substituted 25% ready factor for canonical 31.25%');
  const expected = computeViewport(canonicalInput(h, { zoomFactor: 0.25 * 1.25 ** 2 }));
  assert.deepEqual(lastPrepare(h).canvas, { ...expected.canvas, cellWidthPx: 8, cellHeightPx: 16 });
  await h.controller.close(); await h.done;
});

test('subcell canonical alias permits press and preserves center for next drag/wheel math', async () => {
  const h = await manualOpen({ reuse: true }); await manualZoom(h, 1);
  const original = canonicalInput(h, { zoomFactor: 1.25 });
  const alias = panViewport(original, { yCells: 1 });
  assert.deepEqual(computeViewport(original).window, computeViewport({ ...original, ...alias }).window);
  assert.notDeepEqual(computeViewport(original).center, alias.center);
  h.mouse({ type: 'press', button: 'left' }); h.mouse({ type: 'release', y: 7 });
  const before = h.reuses;
  assert.equal(h.mouse({ type: 'press', button: 'left', y: 7 }).capture, true);
  assert.equal(h.reuses, before, 'alias press performed native work inline');
  h.mouse({ type: 'release', y: 8 }); // reverse from canonical alias, not ready.center
  const reversed = panViewport({ ...original, ...alias }, { yCells: -1 });
  await manualReady(h); assert.deepEqual(shownInput(h).window, computeViewport({ ...original, ...reversed }).window);
  const canonical = { ...original, ...zoomViewport({ ...original, ...reversed }, 'in') };
  const stale = computeViewport({ ...original, ...zoomViewport({ ...original,
    ...panViewport(original, { yCells: -1 }) }, 'in') });
  h.key('+'); await manualReady(h);
  assert.deepEqual(lastPrepare(h).window, computeViewport(canonical).window);
  assert.notDeepEqual(lastPrepare(h).window, stale.window, 'test must distinguish ready-center substitution');
  const frame = viewerArea(40, 16), point = { column: 20 - frame.left - 1 + 0.5, row: 8 - frame.top - 1 + 0.5 };
  const expected = computeViewport({ ...canonical, ...zoomViewportAt(canonical, 'in', point) });
  h.mouse({ type: 'wheel', wheelDelta: -1 }); await manualReady(h);
  assert.deepEqual(lastPrepare(h).window, expected.window);
  await h.controller.close(); await h.done;
});

test('long prepare plus long host receipt starts headroom only at deferred first-own boundary', async () => {
  const h = await manualOpen({ reuse: true });
  const held = h.hold(); h.key('+'); h.clock.advance(100); await until(() => held.finish);
  const oldRows = h.render().filter((row) => row.includes(PLACEHOLDER));
  h.mouse({ type: 'wheel', wheelDelta: -1 }); h.clock.advance(10000);
  for (let n = 0; n < 20; n++) assert.deepEqual(h.render().filter((row) => row.includes(PLACEHOLDER)), oldRows);
  assert.equal(h.preparations.length, 2);
  h.unhold(); await turn(); h.clock.advance(10000); await turn(); assert.equal(h.preparations.length, 2);
  h.render(); assert.equal(h.clock.deferredCount, 1);
  h.clock.advance(500); h.render(); h.clock.flush();
  h.clock.advance(99); await turn(); assert.equal(h.preparations.length, 2);
  h.render(); h.clock.advance(1); await turn(); assert.equal(h.preparations.length, 3);
  await manualReady(h); await h.controller.close(); await h.done;
});

test('held final guard rejection drops revoked proof and rearms final release without another report', async () => {
  const h = await manualOpen({ revokeOnReject: true }); await manualZoom(h);
  h.mouse({ type: 'press', button: 'left' });
  const held = h.holdCapability(2), writes = h.terminal.writes.length;
  h.mouse({ type: 'drag', button: 'left', x: 21, y: 9 }); h.clock.advance(100); await until(() => held.finish);
  h.mouse({ type: 'release', x: 24, y: 11 });
  const input = canonicalInput(h, { zoomFactor: 1.25 ** 5 });
  const expected = computeViewport({ ...input, ...panReference(input, [{ x: 21, y: 9 }, { x: 24, y: 11 }]) });
  h.releaseCapability(); await turn(); assert.equal(h.terminal.writes.length, writes);
  assert.ok(!h.render().some((row) => row.includes(PLACEHOLDER)), 'rejected old proof remained visible');
  assert.equal(h.clock.timerCount, 1);
  await manualReady(h); assert.deepEqual(lastPrepare(h).window, expected.window);
  assert.equal(h.terminal.writes.length, writes + 1); await h.controller.close(); await h.done;
});

test('return to admitted key across held postcheck commits without revision-equality churn', async () => {
  const h = await manualOpen(); await manualZoom(h);
  const held = h.holdCapability(2), count = h.preparations.length;
  h.key('l'); h.clock.advance(100); await until(() => held.finish);
  const sample = lastPrepare(h).window; h.key('h'); h.key('l');
  h.releaseCapability(); await turn(); await manualReady(h);
  assert.deepEqual(lastPrepare(h).window, sample); assert.equal(h.preparations.length, count + 1);
  await h.controller.close(); await h.done;
});

test('final release survives observed pane/cell round trips and stale timer callbacks stay inert', async () => {
  for (const change of [(h) => { h.terminal.columns = 38; }, (h) => h.setCells({ widthPx: 9, heightPx: 18 })]) {
    const h = await manualOpen({ reuse: true }); await manualZoom(h);
    const input = canonicalInput(h, { zoomFactor: 1.25 ** 5 });
    h.mouse({ type: 'press', button: 'left' }); h.mouse({ type: 'release', x: 24, y: 11 });
    const expected = computeViewport({ ...input, ...panReference(input, [{ x: 24, y: 11 }]) });
    const stale = h.clock.callbacks;
    change(h); h.render(); h.terminal.columns = 40; h.setCells({ widthPx: 8, heightPx: 16 }); h.render();
    const count = h.preparations.length; for (const callback of stale) callback();
    assert.equal(h.preparations.length, count);
    await manualReady(h); assert.deepEqual(lastPrepare(h).window, expected.window);
    await h.controller.close(); await h.done;
  }
});

test('external proof loss before own receipt and after same-key blockage replaces dead receipt generation', async () => {
  for (const receipt of [false, true]) {
    const h = await manualOpen({ reuse: true }); h.key('+'); h.clock.advance(100); await turn();
    if (receipt) {
      h.render(); h.clock.flush(); h.clock.advance(100);
      h.mouse({ type: 'press', button: 'left' }); h.mouse({ type: 'release', y: 7 });
      h.clock.advance(0); await turn(); // alias blocks; no changed-frame receipt
    }
    h.mouse({ type: 'wheel', wheelDelta: -1 });
    const stale = h.clock.callbacks, count = h.preparations.length;
    h.loseProof(); assert.ok(!h.render().some((row) => row.includes(PLACEHOLDER)));
    for (const callback of stale) callback();
    await manualReady(h); assert.equal(h.preparations.length, count + 1);
    assert.match(strip(h.render()[0]), /125% Fit/, 'trust loss replayed deferred wheel');
    h.clock.advance(10000); h.render(); h.clock.flush(); assert.equal(h.preparations.length, count + 1);
    await h.controller.close(); await h.done;
  }
});

test('partial failure suppresses same key and wheel on incidental frames; changed key recovers', async () => {
  const h = await manualOpen({ reuse: true });
  h.key('+'); h.mouse({ type: 'wheel', wheelDelta: -1 }); h.setWriteFailure(true);
  h.clock.advance(100); await turn(); const count = h.preparations.length;
  for (let n = 0; n < 20; n++) { assert.ok(!h.render().some((row) => row.includes(PLACEHOLDER))); h.clock.advance(1000); h.clock.flush(); }
  assert.equal(h.clock.timerCount, 0); assert.equal(h.preparations.length, count);
  h.setWriteFailure(false); h.key('-'); await manualReady(h);
  assert.match(strip(h.render()[0]), /100% Fit/); assert.equal(h.preparations.length, count + 1);
  await h.controller.close(); await h.done;
});

test('zero-motion reports and theme invalidation perform no native work or cooldown reset', async () => {
  const h = await manualOpen({ reuse: true, theme: true });
  const count = [h.preparations.length, h.capabilityCalls, h.reuses, h.repaints];
  h.mouse({ type: 'press', button: 'left' });
  for (let n = 0; n < 10000; n++) h.mouse({ type: 'drag', button: 'left' });
  h.mouse({ type: 'release' }); h.clock.advance(10000); h.render(); h.clock.flush();
  assert.deepEqual([h.preparations.length, h.capabilityCalls, h.reuses, h.repaints], count);
  const idRows = h.render().filter((row) => row.includes(PLACEHOLDER));
  const cells = (rows) => rows.map((row) => row.slice(row.indexOf('\x1b[38;2;'), row.lastIndexOf('\x1b[0m') + 4));
  h.setTheme('changed'); h.component.invalidate(); const themed = h.render();
  assert.ok(themed[0].startsWith('changed:')); assert.deepEqual(cells(themed.filter((row) => row.includes(PLACEHOLDER))), cells(idRows));
  assert.equal(h.clock.timerCount, 0); assert.equal(h.preparations.length, count[0]);
  await h.controller.close(); await h.done;
});

test('public disposal and stale queued receipt cancel synchronously and cannot affect reopened fit', async () => {
  const h = await manualOpen({ reuse: true }); h.key('+');
  const stale = h.clock.callbacks, old = h.component, count = h.preparations.length;
  old.dispose(); assert.equal(h.clock.timerCount, 0); assert.deepEqual(old.render(40), []);
  for (const callback of stale) callback(); h.clock.advance(10000); h.clock.flush();
  assert.equal(h.preparations.length, count); await h.done;
  h.done = h.controller.open(); await until(() => h.component); await manualReady(h);
  h.key('+'); h.clock.advance(100); await turn(); h.render(); assert.equal(h.clock.deferredCount, 1);
  await h.controller.close(); await h.done; h.clock.flush(); h.clock.advance(10000);
  h.done = h.controller.open(); await until(() => h.component); await manualReady(h);
  const fresh = h.preparations.length; old.dispose(); old.handleInput('+'); h.clock.advance(10000);
  assert.equal(h.preparations.length, fresh); assert.match(strip(h.render()[0]), /100% Fit/);
  await h.controller.close(); await h.done;
});

test('selection conversion error survives first render and resize without any payload', async () => {
  const h = harness({ normalizeFailure: true }); const done = h.controller.open();
  await until(() => h.normalize === 1); await turn();
  assert.match(h.render().join('\n'), /snapshot conversion failed/);
  h.terminal.columns = 38; h.terminal.rows = 14;
  assert.match(h.render().join('\n'), /snapshot conversion failed/);
  assert.equal(h.preparations.length, 0); assert.equal(h.clock.timerCount, 0);
  await h.controller.close(); await done;
});
