import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createViewerController, viewerArea } from '../src/viewer.mjs';
import { createNativeRenderer } from '../src/native.mjs';
import { createPresentation } from '../src/presentation.mjs';
import { GraphicsIdentityRegistry } from '../src/identity.mjs';
import { PLACEHOLDER } from '../src/kitty.mjs';
import { computeViewport } from '../src/viewport.mjs';

const hostRoot = process.env.PI_TEST_HOST_ROOT;
const hostKeys = hostRoot ? await import(pathToFileURL(join(hostRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js')).href) : undefined;
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let n = 0; n < 100; n++) { if (check()) return; await turn(); }
  assert.fail('PDF viewer did not settle');
}
function png(width, height, color) {
  function chunk(type, bytes) {
    const body = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(bytes.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set(color, y * (width * 3 + 1) + 1 + x * 3);
  return Object.freeze({ type: 'image', mimeType: 'image/png', data: Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64') });
}
const preview = png(32, 48, [200, 0, 0]);
const landscape = png(64, 24, [0, 200, 0]);
const document = Object.freeze({ sha256: 'a'.repeat(64), pageCount: 3, previewPage: 1, render: { longestSide: 1200 }, retention: 'keep' });
const snapshot = Object.freeze({ occurrence: 'document-one', label: 'Stored PDF', attachment: preview, document });
const strip = text => text.replace(/\x1b\[[0-9:;]*m/g, '').replace(/\p{Mark}/gu, '');
const width = text => [...strip(text)].length;
const cut = (text, n) => width(text) <= n ? text : [...strip(text)].slice(0, n).join('');

// Quiet protocol storage, not Ghostty pixels: independent loss never notifies native.
function lossTerminal() {
  const images = new Map(), ignored = [];
  let imageId, chunks;
  return { images, ignored, lose(id) { images.delete(id); }, write(wire) {
    for (const m of wire.matchAll(/\x1b\x1b_G([^;\x1b]+)(?:;([^\x1b]*))?\x1b\x1b\\/g)) {
      const f = Object.fromEntries(m[1].split(',').map(part => part.split('=')));
      if (f.a === 't') { imageId = +f.i; chunks = []; images.delete(imageId); }
      if (f.a === 't' || !f.a && f.m !== undefined) {
        assert.ok(imageId); chunks.push(m[2]);
        if (f.m === '0') { images.set(imageId, { png: Buffer.from(chunks.join(''), 'base64'), placements: new Map() }); imageId = undefined; }
      } else if (f.a === 'p') {
        const image = images.get(+f.i);
        if (!image) { ignored.push(f); continue; }
        assert.equal(f.U, '1'); image.placements.set(+f.p, { columns: +f.c, rows: +f.r });
      } else if (f.a === 'd') {
        assert.equal(f.d, 'i'); assert.ok(+f.p > 0); images.get(+f.i)?.placements.delete(+f.p);
      }
    }
  } };
}

function harness(options = {}) {
  let now = 0, sequence = 0, focused, component, requestCount = 0;
  const timers = new Map(), deferred = [], events = [], pages = [], samples = [], notifications = [];
  const clock = {
    now: () => now, idleMs: 100, wheelExpiryMs: null,
    schedule(callback, ms) { const id = ++sequence; timers.set(id, { callback, due: now + ms }); return id; },
    cancelScheduled(id) { timers.delete(id); }, defer(callback) { deferred.push(callback); },
    flush() { for (const callback of deferred.splice(0)) callback(); },
    advance(ms = 100) { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now && timers.delete(id)) timer.callback(); },
  };
  let frameFailure = false, deleteFailure = false, capabilityGate, pageGate, openGate, releaseGate, normalizeGate, pageFailure = false;
  let cells = { widthPx: 8, heightPx: 16 }, released = 0, activeChildren = 0, maxChildren = 0;
  const overlays = [], terminal = lossTerminal();
  const tui = {
    terminal: { columns: 40, rows: 16, write(wire) {
      events.push({ kind: wire.includes('a=d') ? 'delete' : 'graphics', wire });
      if (deleteFailure && wire.includes('a=d')) throw new Error('delete write failed');
      terminal.write(wire);
    } },
    requestRender() { requestCount++; }, hasOverlay: () => overlays.length > 0,
    renderNow() {
      if (frameFailure) throw new Error('removal frame failed');
      events.push({ kind: 'frame', lines: component?.render(tui.terminal.columns) || [] });
    },
    showOverlay(value) {
      const entry = { value, previous: focused }; overlays.push(entry);
      if (focused) focused.focused = false;
      focused = value; value.focused = true;
      if (!component) component = value;
      return { hide() {
        const index = overlays.indexOf(entry); if (index < 0) return;
        overlays.splice(index, 1);
        if (focused === value) { value.focused = false; focused = overlays.at(-1)?.value || entry.previous; if (focused) focused.focused = true; }
        if (component === value) component = undefined;
      } };
    },
  };
  const presentation = createPresentation();
  const ctx = { mode: 'tui', ui: { setWidget(_key, factory) { factory(tui); } } };
  presentation.attach(ctx, true);
  let id = 0;
  const native = createNativeRenderer({ identity: new GraphicsIdentityRegistry({ random: () => ++id }) });
  const resolvePayload = native.resolvePayload;
  native.resolvePayload = async (attachment, signal) => {
    if (normalizeGate) {
      const gate = normalizeGate; gate.signal = signal;
      await new Promise(resolve => { gate.finish = resolve; });
    }
    return resolvePayload(attachment, signal);
  };
  const prepare = native.prepareViewer;
  native.prepareViewer = async (input, context) => { samples.push({ ...input, context }); return prepare(input, context); };
  const handle = { pageCount: 3, available: options.available !== false, unavailableReason: 'Original PDF not retained; browsing unavailable' };
  const controller = createViewerController({ native, presentation, getContext: () => ctx, getSnapshots: () => [snapshot],
    async requireCapability(_ctx, signal) {
      events.push({ kind: 'capability' });
      if (capabilityGate && --capabilityGate.remaining === 0) {
        const gate = capabilityGate; await new Promise(resolve => { gate.finish = resolve; });
      }
      signal?.throwIfAborted();
    }, readyPolicy: () => undefined, getCells: () => cells,
    matchesKey: options.keys?.matchesKey || ((data, key) => data === key || ({ '\x1b[6~': 'pageDown', '\x1b[5~': 'pageUp', '\r': 'return', '\x7f': 'backspace', '\x1b': 'escape' })[data] === key),
    parseKey: options.keys?.parseKey || (data => /^\x1b\[(\d+);1u$/.test(data) ? String.fromCodePoint(Number(/^\x1b\[(\d+);1u$/.exec(data)[1])) : undefined),
    truncateToWidth: cut, visibleWidth: width, pacing: clock, notify: message => notifications.push(message),
    async openDocument(descriptor, { signal }) {
      assert.equal(descriptor, snapshot);
      if (openGate) await new Promise(resolve => { openGate.finish = resolve; });
      // Deliberately permit late resolution to exercise exact-handle release.
      return handle;
    },
    async pageAttachment(ownHandle, page, { signal }) {
      assert.equal(ownHandle, handle); pages.push(page); activeChildren++; maxChildren = Math.max(maxChildren, activeChildren);
      try {
        if (pageGate) {
          const gate = pageGate; gate.signal = signal;
          await new Promise(resolve => { gate.finish = resolve; });
        }
        signal.throwIfAborted();
        if (pageFailure) throw new Error('requested page unavailable');
        return page === 1 || options.identical ? preview : landscape;
      } finally { activeChildren--; events.push({ kind: 'page-drained', page }); }
    },
    async releaseDocument(ownHandle) {
      assert.equal(ownHandle, handle); assert.equal(activeChildren, 0); released++;
      if (releaseGate) await new Promise(resolve => { releaseGate.finish = resolve; });
      events.push({ kind: 'document-released' });
    },
  });
  const h = { controller, native, presentation, tui, terminal, events, pages, samples, notifications, clock, overlays,
    get component() { return component; }, get released() { return released; }, get maxChildren() { return maxChildren; },
    get timerCount() { return timers.size; }, get deferredCount() { return deferred.length; },
    get timerCallbacks() { return [...timers.values()].map(timer => timer.callback); },
    get requestCount() { return requestCount; },
    render: () => component?.render(tui.terminal.columns) || [], key: data => focused?.handleInput?.(data),
    mouse: event => focused?.handleMouse?.({ x: 20, y: 8, button: 'none', ...event }),
    holdCapability(n = 1) { capabilityGate = { remaining: n }; return capabilityGate; },
    releaseCapability() { const old = capabilityGate; capabilityGate = undefined; old?.finish?.(); },
    holdPage() { pageGate = {}; return pageGate; }, releasePage() { const old = pageGate; pageGate = undefined; old?.finish?.(); },
    holdOpen() { openGate = {}; return openGate; }, releaseOpen() { const old = openGate; openGate = undefined; old?.finish?.(); },
    holdRelease() { releaseGate = {}; return releaseGate; }, releaseHandle() { const old = releaseGate; releaseGate = undefined; old?.finish?.(); },
    holdNormalize() { normalizeGate = {}; return normalizeGate; }, releaseNormalize() { const old = normalizeGate; normalizeGate = undefined; old?.finish?.(); },
    pageFailure(value) { pageFailure = value; },
    frameFailure(value) { frameFailure = value; }, deleteFailure(value) { deleteFailure = value; }, setCells(value) { cells = value; },
    graphics: () => events.filter(event => event.kind === 'graphics'),
  };
  return h;
}
async function ready(h, page = 1) {
  for (let n = 0; n < 100; n++) {
    const lines = h.render(); h.clock.flush();
    if (lines.some(line => line.includes(PLACEHOLDER)) && lines[1].includes(`Page ${page} of 3`) && !h.timerCount && !h.deferredCount) return lines;
    h.clock.advance(); await turn();
  }
  assert.fail(`page ${page} not ready: ${h.render().map(strip).join('\n')}`);
}
async function opened(options) {
  const h = harness(options); h.done = h.controller.open(); await until(() => h.component); await ready(h); return h;
}
async function closed(h) { await h.controller.close(); await h.done; assert.equal(h.released, 1); }

test('PDF page burst/reversal uses requested scalar, one overlay/child and fixed slot; each revisit fits', async () => {
  const h = await opened(); const component = h.component;
  h.key('+'); await ready(h); assert.match(h.render()[0], /125% Fit/);
  h.key('n'); h.key('n'); h.key('p');
  assert.equal(h.render().some(line => line.includes(PLACEHOLDER)), false);
  await ready(h, 2); assert.deepEqual(h.pages, [1, 2]); assert.equal(h.component, component);
  assert.match(h.render()[0], /100% Fit/); assert.equal(h.maxChildren, 1);
  const uploaded = h.graphics().filter(event => event.wire.includes('a=t')).map(event => {
    const match = /a=t,[^;]*;([A-Za-z0-9+/=]+)\x1b\x1b\\/.exec(event.wire);
    assert.ok(match, 'actual wrapped PNG upload is present'); return match[1];
  });
  assert.deepEqual(uploaded, [preview.data, landscape.data], 'actual native payload identifies each requested page');
  h.key('\x1b[5~'); await ready(h, 1); assert.equal(h.pages.at(-1), 1);
  const graphics = h.graphics().length; h.key('p'); await turn(); h.clock.advance(); assert.equal(h.graphics().length, graphics);
  assert.equal(h.native.stats().viewer.slotAllocated, true);
  await closed(h);
});

test('PDF retirement recovery navigation/equal PNG/repeated loss/reopen restores inline history and only current private tuple', async () => {
  const h = harness();
  for (const [occurrence, columns] of [['history', 2], ['history', 3], ['other-history', 1]]) {
    const p = await h.native.prepare({ attachment: preview, occurrence, geometry: { columns, rows: 1 } }, { epoch: h.presentation.epoch });
    assert.equal(h.presentation.commit(p, { epoch: h.presentation.epoch }), true);
  }
  const previewPayload = await h.native.resolvePayload(preview), laterPayload = await h.native.resolvePayload(landscape);
  const retained = new Map(h.terminal.images.get(previewPayload.imageId).placements);
  h.done = h.controller.open(); await until(() => h.component); await ready(h);
  const component = h.component, initial = h.samples.at(-1).lease;
  assert.equal(h.graphics().at(-1).wire.includes('a=t'), false, 'never-retired inline-first bind stays placement-only');
  for (const page of [2, 3, 2, 1, 2, 1]) {
    const start = h.events.length, oldLease = h.samples.at(-1).lease;
    h.key('g'); h.key(String(page)); h.key('\r');
    await until(() => h.events.slice(start).some(event => event.kind === 'delete'));
    h.terminal.lose(oldLease.imageId);
    await ready(h, page);
    const events = h.events.slice(start), deletion = events.findIndex(event => event.kind === 'delete');
    const graphics = events.filter(event => event.kind === 'graphics');
    assert.equal(graphics.length, 1, 'one admitted target write per actual page transition');
    assert.ok(events.slice(0, deletion).some(event => event.kind === 'frame' && !event.lines.some(line => line.includes(PLACEHOLDER))));
    assert.ok(events.findIndex(event => event.kind === 'graphics') > deletion);
    assert.ok(graphics[0].wire.includes('a=t'), 'transition slice must reupload retired target exact PNG');
    const lease = h.samples.at(-1).lease, payload = page === 1 ? previewPayload : laterPayload;
    assert.equal(lease.imageId, payload.imageId); assert.equal(lease.placementId, initial.placementId);
    assert.notEqual(lease.generation, oldLease.generation); assert.equal(h.component, component);
    const stored = h.terminal.images.get(payload.imageId);
    assert.deepEqual(stored.png, Buffer.from((page === 1 ? preview : landscape).data, 'base64'));
    const inline = page === 1 ? retained : new Map();
    const sample = h.samples.at(-1);
    assert.deepEqual(stored.placements, new Map([...inline, [lease.placementId, { columns: sample.canvas.columns, rows: sample.canvas.rows }]]));
    assert.match(h.render()[0], /100% Fit/);
  }
  assert.deepEqual(h.pages, [1, 2, 3, 2, 1, 2, 1], 'reupload adds no provider work beyond requested navigation');
  const start = h.graphics().length, pages = h.pages.length;
  h.key('g'); h.key('1'); h.key('\r'); h.clock.advance(); await turn();
  assert.equal(h.graphics().length, start); assert.equal(h.pages.length, pages, 'same-ready page is no-op');
  await closed(h); h.terminal.lose(previewPayload.imageId);
  const reopenStart = h.events.length;
  h.done = h.controller.open(); await until(() => h.component); await ready(h);
  assert.equal(h.events.slice(reopenStart).filter(event => event.kind === 'graphics').length, 1);
  assert.ok(h.events.slice(reopenStart).find(event => event.kind === 'graphics').wire.includes('a=t'));
  assert.deepEqual(h.terminal.images.get(previewPayload.imageId).png, Buffer.from(preview.data, 'base64'));
  assert.equal(h.terminal.images.get(previewPayload.imageId).placements.size, retained.size + 1);
  assert.equal(h.terminal.ignored.length, 0); assert.equal(h.native.stats().accounting.errors, 0);
  assert.deepEqual(h.pages, [1, 2, 3, 2, 1, 2, 1, 1]);
  await h.controller.close(); await h.done; assert.equal(h.released, 2);
});

test('PDF public raw/Kitty jump digits are bounded/editable; Escape cancels field and unsupported/mouse input stays owned', async () => {
  const h = await opened(); const graphics = h.graphics().length;
  h.key('g'); h.key('\r'); assert.match(h.render().at(-2), /Enter 1–3/);
  h.key('\x1b[51;1u'); h.key('9'); h.key('n'); h.key('\x1b[200~123\x1b[201~');
  assert.match(h.render().at(-2), /Page: 3▏/);
  assert.notEqual(h.mouse({ type: 'press', button: 'left' }).capture, true);
  h.mouse({ type: 'wheel', wheelDelta: -1 }); h.key('\x1b'); assert.equal(h.controller.isOpen, true);
  h.clock.advance(10000); await turn(); assert.equal(h.graphics().length, graphics);
  h.key('g'); h.key('0'); h.key('\r'); assert.match(h.render().at(-2), /Enter 1–3/);
  h.key('\x7f'); h.key('2'); h.key('\r'); await ready(h, 2);
  h.key('g'); h.key('9'); h.key('\r'); assert.match(h.render().at(-2), /Enter 1–3/);
  h.key('\x1b'); h.key('\x1b'); await h.done; assert.equal(h.released, 1);
});

test('PDF tiny pane collects page/jump but defers provider/native until usable; ordinary resize preserves page zoom', async () => {
  const h = harness(); h.tui.terminal.columns = 12; h.tui.terminal.rows = 6;
  h.done = h.controller.open(); await until(() => h.component); await turn();
  h.key('n'); h.key('n'); h.key('p'); h.key('g'); h.key('3'); h.key('\r');
  for (let n = 0; n < 10; n++) { h.render(); h.clock.advance(); await turn(); }
  assert.deepEqual(h.pages, []); assert.equal(h.samples.length, 0);
  h.tui.terminal.columns = 40; h.tui.terminal.rows = 16; await ready(h, 3); assert.deepEqual(h.pages, [3]);
  h.key('+'); await ready(h, 3); h.tui.terminal.columns = 38; await ready(h, 3);
  assert.match(h.render()[0], /125% Fit/); assert.deepEqual(h.pages, [3]);
  h.key('p'); await ready(h, 2); assert.match(h.render()[0], /100% Fit/);
  const expected = computeViewport({ image: { width: 64, height: 24 }, area: viewerArea(38, 16).area, cells: { widthPx: 8, heightPx: 16 } });
  assert.deepEqual(h.samples.at(-1).canvas, { ...expected.canvas, cellWidthPx: 8, cellHeightPx: 16 });
  await closed(h);
});

test('PDF no-caller removal frame precedes scoped delete and cross-payload rebind; failed frame/write reflush and block reserve', async () => {
  for (const failure of ['frame', 'delete']) {
    const h = await opened(); const oldSamples = h.samples.length;
    if (failure === 'frame') h.frameFailure(true); else h.deleteFailure(true);
    h.key('n'); await until(() => h.render()[1].includes('Error loading'));
    assert.deepEqual(h.pages, [1]); assert.equal(h.samples.length, oldSamples);
    assert.equal(h.native.stats().viewer.retirementPending, true);
    assert.equal(h.render().some(line => line.includes(PLACEHOLDER)), false);
    h.frameFailure(false); h.deleteFailure(false); const start = h.events.length;
    h.key('g'); h.key('2'); h.key('\r'); await ready(h, 2);
    const events = h.events.slice(start), deletion = events.findIndex(event => event.kind === 'delete');
    assert.ok(deletion >= 0);
    assert.ok(events.slice(0, deletion).some(event => event.kind === 'frame' && !event.lines.some(line => line.includes(PLACEHOLDER))));
    assert.ok(events.findIndex(event => event.kind === 'graphics') > deletion);
    assert.equal(h.native.stats().viewer.retirementPending, false);
    assert.ok(events[deletion].wire.includes('d=i')); assert.ok(!events[deletion].wire.includes('d=I'));
    await closed(h);
  }
});

test('PDF superseded identical PNG/layout page native postguard cannot publish stale bytes/receipts', async () => {
  const h = await opened({ identical: true }); const oldCallbacks = h.timerCallbacks;
  h.key('n'); await until(() => h.pages.at(-1) === 2);
  // Page installation precedes its paced sample. Hold sample postguard.
  await until(() => h.timerCount); const held = h.holdCapability(2); h.clock.advance(); await until(() => held.finish);
  const writes = h.graphics().length, staleLease = h.samples.at(-1).lease;
  h.key('n'); h.key('p');
  h.releaseCapability(); await turn(); assert.equal(h.graphics().length, writes);
  for (const callback of oldCallbacks) callback(); h.clock.flush();
  await ready(h, 2); assert.notEqual(h.samples.at(-1).lease, staleLease);
  const freshWrites = h.graphics().slice(writes);
  assert.equal(freshWrites.length, 1); assert.ok(freshWrites[0].wire.includes('a=t'), 'only latest equal-byte page generation may reupload');
  const live = h.samples.at(-1);
  assert.deepEqual(h.terminal.images.get(live.lease.imageId), { png: Buffer.from(preview.data, 'base64'),
    placements: new Map([[live.lease.placementId, { columns: live.canvas.columns, rows: live.canvas.rows }]]) });
  assert.equal(h.terminal.ignored.length, 0);
  assert.deepEqual(h.pages, [1, 2, 2]); assert.equal(h.maxChildren, 1);
  assert.match(h.render()[0], /100% Fit/); await closed(h);
});

test('PDF held provider abort drains before latest successor; unavailable Temporary retains canonical page1 zoom/pan', async () => {
  const h = await opened(); const gate = h.holdPage(); h.key('n'); await until(() => gate.finish);
  h.key('n'); h.key('p'); assert.equal(gate.signal.aborted, true);
  await turn(); assert.deepEqual(h.pages, [1, 2]); h.releasePage(); await ready(h, 2);
  assert.deepEqual(h.pages, [1, 2, 2]); assert.equal(h.maxChildren, 1); await closed(h);
  const unavailable = await opened({ available: false });
  unavailable.key('n'); unavailable.key('g'); unavailable.key('3'); unavailable.key('\r');
  assert.deepEqual(unavailable.pages, [1]); assert.match(unavailable.render().at(-2), /not retained/);
  unavailable.key('+'); await ready(unavailable); assert.match(unavailable.render()[0], /125% Fit/);
  unavailable.key('p'); await ready(unavailable); assert.match(unavailable.render()[0], /125% Fit/, 'current ready page is a no-op even after unavailable navigation');
  unavailable.key('l'); await ready(unavailable); assert.deepEqual(unavailable.pages, [1]); await closed(unavailable);
});

test('PDF close drains exact document during open/provider/native-postguard/retirement/release and cancels old work', async () => {
  for (const phase of ['open', 'provider', 'normalize', 'postguard', 'retirement', 'release']) {
    const h = phase === 'open' ? harness() : await opened();
    let gate;
    if (phase === 'open') { gate = h.holdOpen(); h.done = h.controller.open(); await until(() => gate.finish); }
    if (phase === 'provider') { gate = h.holdPage(); h.key('n'); await until(() => gate.finish); }
    if (phase === 'normalize') { gate = h.holdNormalize(); h.key('n'); await until(() => gate.finish); }
    if (phase === 'postguard') { gate = h.holdCapability(2); h.key('+'); h.clock.advance(); await until(() => gate.finish); }
    if (phase === 'retirement') { gate = h.holdCapability(1); h.key('n'); await until(() => gate.finish); }
    if (phase === 'release') gate = h.holdRelease();
    const callbacks = h.timerCallbacks, before = h.graphics().length, close = h.controller.close();
    assert.equal(h.timerCount, 0); assert.equal(h.render().length, 0);
    for (const callback of callbacks) callback(); h.clock.flush(); h.clock.advance(10000);
    await turn(); assert.equal(h.controller.isOpen, true, 'close must retain owned drain reservation');
    h.releaseOpen(); h.releasePage(); h.releaseNormalize(); h.releaseCapability(); h.releaseHandle();
    await close; await h.done;
    assert.equal(h.released, 1); assert.equal(h.graphics().length, before); assert.equal(h.controller.isOpen, false);
  }
});

test('PDF real native proof loss before own receipt recovers current page without raster, wheel or stale receipt', async () => {
  const h = await opened(); h.key('n'); await ready(h, 2);
  h.key('+'); h.clock.advance(); await until(() => h.graphics().length === 3);
  // A new epoch through a genuine inline preparation revokes the ready native proof.
  const inline = await h.native.prepare({ attachment: preview, occurrence: 'inline', geometry: { columns: 2, rows: 1 } }, { epoch: Symbol('external') });
  inline.onUploadFailed(new Error('external epoch changed'));
  const pages = h.pages.length; assert.equal(h.render().some(line => line.includes(PLACEHOLDER)), false);
  await ready(h, 2); assert.equal(h.pages.length, pages); assert.match(h.render()[0], /125% Fit/);
  await closed(h);
});

test('PDF pending unavailable open falls back to canonical page1 and failed later page suppresses incidental retries', async () => {
  const h = harness({ available: false }); const open = h.holdOpen();
  h.done = h.controller.open(); await until(() => open.finish); h.key('n'); h.key('n');
  h.releaseOpen(); await ready(h, 1); assert.deepEqual(h.pages, [1]); await closed(h);
  const failed = await opened(); failed.pageFailure(true); failed.key('n');
  await until(() => failed.render()[1].includes('Error loading page 2'));
  const count = failed.pages.length;
  for (let n = 0; n < 20; n++) { failed.render(); failed.clock.advance(10000); await turn(); }
  assert.equal(failed.pages.length, count); assert.equal(failed.timerCount, 0);
  failed.pageFailure(false); failed.key('g'); failed.key('2'); failed.key('\r'); await ready(failed, 2); await closed(failed);
});

test('PDF focus/disconnect during provider immediately aborts, waits drain, and never closes unrelated upper overlay', async () => {
  for (const disconnect of [false, true]) {
    const h = await opened(); const gate = h.holdPage(); h.key('n'); await until(() => gate.finish);
    const old = h.component;
    if (disconnect) h.presentation.disconnect(); else h.tui.showOverlay({ focused: false, handleInput() {} });
    assert.equal(gate.signal.aborted, true); assert.deepEqual(old.render(40), []);
    await turn(); assert.equal(h.controller.isOpen, true); assert.equal(h.released, 0);
    h.releasePage(); await h.done; assert.equal(h.released, 1);
    assert.equal(h.overlays.length, disconnect ? 0 : 1);
    old.handleInput('n'); old.handleMouse({ type: 'wheel', wheelDelta: -1 });
    assert.deepEqual(h.pages, [1, 2]);
  }
});

test('PDF native queued predecessor drains before close releases document; no stale lease reserve or write', async () => {
  const h = await opened();
  const inline = await h.native.prepare({ attachment: preview, occurrence: 'held-inline',
    geometry: { columns: 2, rows: 1 } }, { epoch: h.presentation.epoch });
  h.key('+'); h.clock.advance(); await until(() => h.samples.length === 2);
  const before = h.graphics().length, close = h.controller.close();
  await turn(); assert.equal(h.controller.isOpen, true); assert.equal(h.released, 0);
  inline.onUploaded(); await close; await h.done;
  assert.equal(h.released, 1); assert.equal(h.graphics().length, before);
  assert.equal(h.native.stats().viewer.pending, false);
});

test('PDF jump chrome stays editable during paced pending zoom, and loading gestures cannot queue unknown-page state', async () => {
  const h = await opened(); h.key('+'); h.key('g'); h.key('2');
  assert.match(h.render().at(-2), /Page: 2▏/, 'pending viewport chrome must not hide the jump editor');
  h.key('\r'); const gate = h.holdPage(); await until(() => gate.finish);
  h.key('+'); h.key('l'); h.mouse({ type: 'wheel', wheelDelta: -1 });
  assert.notEqual(h.mouse({ type: 'press', button: 'left' }).capture, true);
  h.releasePage(); await ready(h, 2); assert.match(h.render()[0], /100% Fit/);
  await closed(h);
});

test('PDF installed public matchesKey/parseKey recognize raw and Kitty page/jump controls without accepting paste/modifiers', {
  skip: !hostKeys && 'set PI_TEST_HOST_ROOT for installed public key parser',
}, async () => {
  const h = await opened({ keys: hostKeys });
  h.key('\x1b[6~'); await ready(h, 2);
  h.key('\x1b[112;1u'); await ready(h, 1); // Kitty p
  h.key('\x1b[110;1u'); await ready(h, 2); // Kitty n
  h.key('\x1b[103;1u'); // Kitty g
  h.key('\x1b[51;5u'); h.key('\x1b[200~3\x1b[201~');
  assert.match(h.render().at(-2), /Page: ▏/);
  h.key('\x1b[51;1u'); h.key('\x1b[127;1u'); h.key('\x1b[51;1u'); h.key('\x1b[13;1u');
  await ready(h, 3); h.key('\x1b[5~'); await ready(h, 2);
  h.key('\x1b[103;1u'); h.key('\x1b[27;1u'); assert.equal(h.controller.isOpen, true);
  h.key('\x1b[27;1u'); await h.done; assert.equal(h.released, 1);
});
