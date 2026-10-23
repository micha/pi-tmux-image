import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewerController, indexSnapshots, viewerArea, viewerTitle } from '../src/viewer.mjs';
import { encodePlaceholderRows, PLACEHOLDER } from '../src/kitty.mjs';

const strip = (text) => text.replace(/\x1b\[[0-9:;]*m/g, '').replace(/\p{Mark}/gu, '');
const width = (text) => [...strip(text)].length;
const cut = (text, limit) => width(text) <= limit ? text : [...strip(text)].slice(0, limit).join('');
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await turn(); } assert.fail('viewer did not settle'); }
const snapshots = [1, 2].map((page) => ({ occurrence: `page-${page}`, label: `PDF — page ${page}`, attachment: { type: 'image', mimeType: 'image/png', data: `snapshot-${page}` } }));

function harness(options = {}) {
  const terminal = { columns: 40, rows: 16, writes: [], write(bytes) { this.writes.push(bytes); } };
  const overlays = [], preparations = [], events = [];
  let focused, connection, observer, policy, hold, cleanupHold, normalize = 0, reserve = 0, pending = 0, maxPending = 0, retirement = false;
  const retirementEpochs = [];
  let frameFailure = false;
  const tui = {
    terminal, requestRender() {}, renderNow() { if (frameFailure) throw new Error('mock host removal frame failed'); events.push('repaint'); }, hasOverlay: () => overlays.length > 0,
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
      if (prepared.uploads) terminal.write(prepared.uploads);
      prepared.onUploaded?.(); return true;
    },
  };
  const native = {
    async resolvePayload(attachment, signal) { normalize++; signal.throwIfAborted(); return { width: 640, height: 480, attachment }; },
    reserveViewerPlacement() { reserve++; return { generation: reserve }; },
    releaseViewer(lease) { events.push('release'); retirement = Boolean(lease.committed); },
    async prepareViewer(input, context) {
      pending++; maxPending = Math.max(maxPending, pending); preparations.push({ ...input, context });
      if (hold) await new Promise((resolve) => { hold.finish = resolve; });
      pending--;
      return { uploads: `WRITE-${preparations.length}`, lines: encodePlaceholderRows({ imageId: 42, placementId: 43, columns: input.window.columns, rows: input.window.rows }),
        onUploaded() { input.lease.committed = true; events.push('uploaded'); }, onUploadFailed() { events.push('failed'); } };
    },
    async prepareViewerRetirement(context) {
      if (!retirement) return { uploads: '', lines: [] };
      retirementEpochs.push(context.epoch);
      events.push('retire'); return { uploads: 'RETIRE', lines: [], onUploaded() { retirement = false; events.push('retired'); }, onUploadFailed() { events.push('retirement-failed'); } };
    },
  };
  const controller = createViewerController({ native, presentation, getContext: () => ({ mode: 'tui' }),
    getSnapshots: () => options.snapshots || [snapshots[0]], requireCapability: async (_ctx, signal) => {
      signal?.throwIfAborted(); if (cleanupHold && events.includes('hide')) await new Promise((resolve) => { cleanupHold.finish = resolve; });
      if (policy) throw new Error(policy);
    },
    readyPolicy: () => policy, getCells: () => ({ widthPx: 8, heightPx: 16 }),
    // Match the real Pi '+' syntax boundary: literal '+' is not a matcher key.
    matchesKey: (data, name) => name !== '+' && data === name, truncateToWidth: cut, visibleWidth: width,
    notify: (message) => events.push(message), sanitizeText: (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '') });
  return { controller, terminal, tui, preparations, events,
    get component() { return overlays[0]?.component; }, get overlays() { return overlays; },
    get normalize() { return normalize; }, get reserve() { return reserve; }, get maxPending() { return maxPending; },
    render() { return overlays[0]?.component.render(terminal.columns) || []; },
    key(data) { focused?.handleInput?.(data); },
    hold() { hold = {}; return hold; }, unhold() { const previous = hold; hold = undefined; previous?.finish?.(); },
    holdCleanup() { cleanupHold = {}; return cleanupHold; },
    unholdCleanup() { const previous = cleanupHold; cleanupHold = undefined; previous?.finish?.(); },
    refresh() { observer?.onDisconnect(connection); connection = { tui, epoch: Symbol('refreshed') }; },
    get epoch() { return connection?.epoch; }, retirementEpochs,
    setPolicy(reason) { policy = reason; }, setFrameFailure(value) { frameFailure = value; },
    get retirementPending() { return retirement; },
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
  h.key('+'); await until(() => h.preparations.length === 2); await until(() => h.render().some((row) => row.includes(PLACEHOLDER)));
  assert.ok(h.preparations[1].canvas.columns > first.columns);
  h.key('l'); h.key('j'); h.key('garbage');
  const mouse = h.component.handleMouse({ type: 'wheel' }); assert.equal(mouse.handled, true);
  h.key('0'); await until(() => h.render().some((row) => row.includes(PLACEHOLDER)));
  assert.deepEqual(h.preparations.at(-1).canvas, first);
  h.key('escape'); await done;
  assert.ok(h.events.indexOf('release') < h.events.indexOf('hide')); assert.ok(h.events.indexOf('hide') < h.events.indexOf('retire'));
  assert.ok(h.events.lastIndexOf('repaint') < h.events.lastIndexOf('retired'), 'public removal frame must precede private retirement');
  assert.equal(h.controller.isOpen, false);
  const next = await openReady(h); assert.deepEqual(h.preparations.at(-1).canvas, first);
  await h.controller.close(); await next.done;
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
