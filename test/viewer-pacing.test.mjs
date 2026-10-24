import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerPacer, isWheelExpired } from '../src/viewer-pacing.mjs';
import { computeViewport, panViewport, zoomViewport, zoomViewportAt, resetViewport } from '../src/viewport.mjs';

// Test-only values. No cadence/expiry production default is chosen here.
const IDLE = 50;
const EXPIRY = 125;
class Clock {
  time = 0;
  serial = 0;
  timers = new Map();
  deferred = [];
  peakTimers = 0;
  peakDeferred = 0;
  now = () => this.time;
  schedule = (callback, delay) => {
    assert.ok(Number.isFinite(delay) && delay >= 0);
    const handle = ++this.serial;
    this.timers.set(handle, { callback, due: this.time + delay });
    this.peakTimers = Math.max(this.peakTimers, this.timers.size);
    return handle;
  };
  cancelScheduled = (handle) => { this.timers.delete(handle); };
  defer = (callback) => {
    this.deferred.push(callback);
    this.peakDeferred = Math.max(this.peakDeferred, this.deferred.length);
  };
  fire() {
    assert.equal(this.timers.size, 1);
    const [handle, timer] = this.timers.entries().next().value;
    this.timers.delete(handle);
    timer.callback();
  }
  flush() {
    while (this.deferred.length) this.deferred.shift()();
  }
  advance(ms) { this.time += ms; }
  due() {
    assert.equal(this.timers.size, 1);
    return this.timers.values().next().value.due;
  }
  pacer(onEligible, extra = {}) {
    return createViewerPacer({ now: this.now, schedule: this.schedule,
      cancelScheduled: this.cancelScheduled, defer: this.defer, idleMs: IDLE,
      onEligible, ...extra });
  }
}
const clean = (pacer) => assert.deepEqual(pacer.inspect(), {
  cancelled: false, demanded: false, timerArmed: false, continuationQueued: false,
  phase: 'idle', sequence: 0, nextDue: 0,
});

function publishReceipt(pacer, ticket, clock) {
  assert.equal(pacer.published(ticket), true);
  assert.equal(pacer.rendered(ticket), true);
  clock.flush();
}

test('required injected inputs and explicit finite monotonic clock/idle are validated', () => {
  const c = new Clock();
  const options = { now: c.now, schedule: c.schedule, cancelScheduled: c.cancelScheduled,
    defer: c.defer, onEligible() {}, idleMs: IDLE };
  for (const name of ['now', 'schedule', 'cancelScheduled', 'defer', 'onEligible']) {
    assert.throws(() => createViewerPacer({ ...options, [name]: undefined }), TypeError);
  }
  for (const idleMs of [undefined, null, 0, -1, NaN, Infinity, '50']) {
    assert.throws(() => createViewerPacer({ ...options, idleMs }), RangeError);
  }
  assert.throws(() => createViewerPacer({ ...options, onError: true }), TypeError);
  assert.throws(() => createViewerPacer({ ...options, now: () => Infinity }), RangeError);
  const p = c.pacer(() => {});
  c.advance(1); p.request(); c.time = 0;
  assert.throws(() => c.fire(), /monotonic/);
});

test('10,000 requests replace latest demand, one scheduled opportunity, opaque tickets and O(1) diagnostics', () => {
  const c = new Clock();
  let latest = 0;
  const samples = [];
  const p = c.pacer((ticket) => samples.push({ latest, ticket }));
  clean(p);
  for (latest = 1; latest <= 10000; latest++) p.request();
  latest = 10000;
  assert.equal(samples.length, 0); // Even first zero-delay request is not inline.
  assert.equal(c.timers.size, 1);
  assert.equal(c.due(), 0);
  c.fire();
  assert.equal(samples.length, 1);
  assert.equal(samples[0].latest, 10000);
  assert.ok(Object.isFrozen(samples[0].ticket));
  assert.deepEqual(Reflect.ownKeys(samples[0].ticket), []);
  const snapshot = p.inspect(); snapshot.phase = 'tampered';
  assert.equal(p.inspect().phase, 'admitted');
  assert.deepEqual(Object.keys(p.inspect()).sort(), ['cancelled', 'demanded', 'timerArmed',
    'continuationQueued', 'phase', 'sequence', 'nextDue'].sort());
  for (let i = 0; i < 10000; i++) p.request();
  assert.equal(c.timers.size, 0);
  publishReceipt(p, samples[0].ticket, c);
  assert.equal(c.due(), IDLE);
  c.advance(IDLE); c.fire();
  assert.equal(samples.length, 2);
  assert.notEqual(samples[0].ticket, samples[1].ticket);
  assert.equal(c.peakTimers, 1); assert.equal(c.peakDeferred, 1);
});

test('early timer rearms once; late multi-interval timer samples once with no missed-tick replay', () => {
  const c = new Clock();
  const tickets = [];
  const p = c.pacer((ticket) => tickets.push(ticket));
  p.request(); c.fire(); p.settled(tickets[0], { retry: true });
  c.advance(10); c.fire();
  assert.equal(tickets.length, 1); assert.equal(c.due(), 50);
  c.advance(990); c.fire();
  assert.equal(tickets.length, 2); assert.equal(c.timers.size, 0);
  p.settled(tickets[1], { retry: true });
  assert.equal(c.due(), 1050); // From completion, not a historical tick grid.
  assert.equal(c.peakTimers, 1);
});

test('deferred first-own receipt gives host-cost headroom and rejects retained/repeated receipts', () => {
  const c = new Clock();
  const tickets = [];
  const p = c.pacer((ticket) => tickets.push(ticket));
  p.request(); c.fire();
  const first = tickets[0];
  assert.equal(p.rendered(first), false); // Not yet published.
  p.published(first); p.request();
  assert.equal(p.rendered(Object.freeze({})), false);
  c.advance(30);
  assert.equal(p.rendered(first), true);
  for (let i = 0; i < 10000; i++) assert.equal(p.rendered(first), false);
  assert.equal(c.deferred.length, 1); assert.equal(c.timers.size, 0);
  c.advance(70); c.flush();
  assert.equal(c.due(), 150); // Includes host work through deferred continuation.
  c.advance(49); c.fire(); assert.equal(tickets.length, 1);
  c.advance(1); c.fire(); assert.equal(tickets.length, 2);
  p.published(tickets[1]); p.request();
  assert.equal(p.rendered(first), false); // Old retained rows cannot unlock new work.
  assert.equal(c.timers.size, 0);
  assert.equal(p.inspect().phase, 'awaiting-receipt');
  p.rendered(tickets[1]); c.flush();
  const due = c.due();
  c.advance(20); assert.equal(p.rendered(tickets[1]), false);
  assert.equal(c.due(), due); // Background receipts neither unlock nor restart idle.
});

test('slow preparation publishes promptly but cannot admit a successor before own receipt/cooldown', () => {
  const c = new Clock(); const tickets = [];
  const p = c.pacer((ticket) => tickets.push(ticket));
  p.request(); c.fire(); p.request();
  c.advance(1000);
  assert.equal(c.timers.size, 0); assert.equal(tickets.length, 1);
  p.published(tickets[0]); // Valid commit is not parked awaiting a cadence timer.
  assert.equal(p.inspect().phase, 'awaiting-receipt');
  c.advance(1000); assert.equal(c.timers.size, 0);
  p.rendered(tickets[0]); c.advance(100); c.flush();
  assert.equal(c.due(), 2150);
  c.advance(50); c.fire(); assert.equal(tickets.length, 2);
});

test('settlement preserves demand or explicit retry and stale/rejected settlement cannot mutate successor', () => {
  const c = new Clock(); const tickets = [];
  const p = c.pacer((ticket) => tickets.push(ticket));
  p.request(); c.fire();
  assert.equal(p.settled({}), false);
  assert.equal(p.settled(tickets[0], { retry: true }), true);
  c.advance(50); c.fire(); p.request();
  const before = p.inspect();
  assert.equal(p.settled(tickets[0], { retry: true }), false);
  assert.deepEqual(p.inspect(), before);
  p.settled(tickets[1]); assert.equal(c.due(), 100);
  c.advance(50); c.fire(); p.published(tickets[2]);
  assert.equal(p.settled(tickets[2], { retry: true }), false);
  assert.equal(c.timers.size, 0);
  p.rendered(tickets[2]); c.flush();
  assert.equal(c.timers.size, 0); // No repeating timer without demand.
});

test('blocked is external-wake-only, clears busy demand, preserves deadline and never polls', () => {
  const c = new Clock(); const tickets = [];
  const p = c.pacer((ticket) => { tickets.push(ticket); p.request(); p.blocked(ticket); });
  p.request(); c.fire();
  assert.equal(p.inspect().demanded, false); assert.equal(c.timers.size, 0);
  assert.equal(p.inspect().nextDue, 0);
  c.advance(10000); c.flush(); assert.equal(tickets.length, 1);
  p.request(); assert.equal(c.due(), 10000); c.fire();
  assert.equal(tickets.length, 2); assert.equal(c.timers.size, 0);
  assert.equal(p.blocked(tickets[0]), false);
});

test('blocked external wake retains the previous completion boundary rather than inventing a retry cadence', () => {
  const c = new Clock(); let ticket;
  const p = c.pacer((value) => { ticket = value; });
  p.request(); c.fire(); p.settled(ticket, { retry: true });
  c.advance(IDLE); c.fire();
  p.request(); p.blocked(ticket);
  assert.equal(p.inspect().nextDue, IDLE);
  assert.equal(c.timers.size, 0);
  c.advance(500); p.request();
  assert.equal(c.due(), 550); // External recovery can wake now, not after another idle.
});

test('cancel invalidates queued timer, deferred continuation, stale tickets and later-instance callbacks', () => {
  for (const stage of ['timer', 'admitted', 'receipt', 'continuation']) {
    const c = new Clock(); let calls = 0; let ticket;
    const old = c.pacer((value) => { calls++; ticket = value; });
    old.request();
    let staleTimer;
    if (stage === 'timer') staleTimer = c.timers.values().next().value.callback;
    else {
      c.fire();
      if (stage !== 'admitted') old.published(ticket);
      if (stage === 'continuation') old.rendered(ticket);
    }
    old.request(); old.cancel(); old.cancel();
    assert.equal(c.timers.size, 0);
    let freshTicket;
    const fresh = c.pacer((value) => { calls++; freshTicket = value; });
    fresh.request(); const before = fresh.inspect();
    staleTimer?.(); c.flush();
    old.request();
    assert.equal(old.published(ticket), false); assert.equal(old.rendered(ticket), false);
    assert.equal(old.settled(ticket, { retry: true }), false); assert.equal(old.blocked(ticket), false);
    assert.deepEqual(fresh.inspect(), before);
    c.fire(); assert.ok(freshTicket);
    assert.equal(calls, stage === 'timer' ? 1 : 2);
    assert.equal(fresh.published(ticket), false);
    assert.equal(old.inspect().cancelled, true);
    assert.equal(old.inspect().demanded, false);
    assert.equal(old.inspect().continuationQueued, false);
  }
});

test('onEligible exceptions release admission and remain observable with or without onError', () => {
  for (const report of [false, true]) {
    const c = new Clock(); const error = new Error('intent failed'); const errors = [];
    let ticket;
    const p = c.pacer((value) => { ticket = value; p.request(); throw error; },
      report ? { onError: (caught) => errors.push(caught) } : {});
    p.request();
    if (report) c.fire(); else assert.throws(() => c.fire(), (caught) => caught === error);
    assert.deepEqual(errors, report ? [error] : []);
    assert.equal(p.inspect().phase, 'idle');
    assert.equal(p.published(ticket), false);
    assert.equal(c.due(), IDLE); assert.equal(c.peakTimers, 1);
    p.cancel();
  }
  const c = new Clock();
  const p = c.pacer(() => { throw new Error('without demand'); });
  p.request(); assert.throws(() => c.fire(), /without demand/);
  assert.equal(p.inspect().phase, 'idle'); assert.equal(c.timers.size, 0);
});

test('post-publication exceptions preserve own-receipt and deferred cooldown obligations', () => {
  for (const stage of ['published', 'rendered']) for (const report of [false, true]) {
    const c = new Clock(); const errors = []; let ticket; let calls = 0;
    const error = new Error('after publication');
    const p = c.pacer((value) => {
      calls++; ticket = value; p.published(value); p.request();
      if (stage === 'rendered') p.rendered(value);
      throw error;
    }, report ? { onError: (caught) => errors.push(caught) } : {});
    p.request();
    if (report) c.fire(); else assert.throws(() => c.fire(), (caught) => caught === error);
    assert.deepEqual(errors, report ? [error] : []);
    assert.equal(p.inspect().phase, stage === 'published' ? 'awaiting-receipt' : 'cooldown-pending');
    assert.equal(p.settled(ticket, { retry: true }), false);
    assert.equal(p.blocked(ticket), false);
    assert.equal(c.timers.size, 0);
    c.advance(1000); p.request();
    assert.equal(c.timers.size, 0); assert.equal(calls, 1);
    if (stage === 'published') assert.equal(p.rendered(ticket), true);
    else assert.equal(p.rendered(ticket), false);
    assert.equal(c.deferred.length, 1);
    c.advance(70); c.flush();
    assert.equal(c.due(), 1120);
    assert.equal(p.inspect().phase, 'idle');
    assert.equal(c.peakTimers, 1); assert.equal(c.peakDeferred, 1);
    p.cancel();
  }
});

test('10,000 separate-turn requests sample latest at cost-plus-idle bounds, not a trailing debounce', () => {
  const c = new Clock(); const samples = []; let latest = 0; let p;
  p = c.pacer((ticket) => {
    samples.push({ latest, at: c.time });
    p.published(ticket); p.rendered(ticket);
    c.advance(20); // Explicit simulated host/event-loop cost, not real-host evidence.
    c.flush();
  });
  for (latest = 1; latest <= 10000; latest++) {
    p.request();
    if (c.due() <= c.time) c.fire();
    c.advance(1);
  }
  latest = 10000;
  if (c.timers.size) { c.time = c.due(); c.fire(); }
  assert.equal(samples.at(-1).latest, 10000);
  assert.ok(samples.length > 100 && samples.length < 250);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].at - samples[i - 1].at >= IDLE + 20);
    assert.ok(samples[i].latest > samples[i - 1].latest);
  }
  assert.equal(c.peakTimers, 1); assert.equal(c.peakDeferred, 1);
  assert.equal(c.timers.size, 0);
});

test('wheel expiry requires explicit null or positive limit; boundary is age >= limit', () => {
  assert.equal(isWheelExpired(10, 10 + EXPIRY - 0.001, EXPIRY), false);
  assert.equal(isWheelExpired(10, 10 + EXPIRY, EXPIRY), true);
  assert.equal(isWheelExpired(10, 10 + EXPIRY + 0.001, EXPIRY), true);
  assert.equal(isWheelExpired(10, 1e9, null), false);
  assert.equal(isWheelExpired(10, 9, EXPIRY), false);
  for (const limit of [undefined, 0, -1, NaN, Infinity, '125']) {
    assert.throws(() => isWheelExpired(0, 1, limit), RangeError);
  }
  for (const args of [[NaN, 1, null], [0, Infinity, EXPIRY]]) {
    assert.throws(() => isWheelExpired(...args), RangeError);
  }
});

// Independent sequential pan oracle. Only static canvas/scale geometry comes
// from computeViewport; the reference derives bounds in source pixels without
// calling panViewport or using its returned center/realizedCenter as the oracle.
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10,
  `${actual} != ${expected}`);
const geometry = { image: { width: 1201, height: 603 }, area: { columns: 61, rows: 27 },
  cells: { widthPx: 7.3, heightPx: 15.7 } };
function referencePan(data, center, delta) {
  const v = computeViewport({ ...data, center: { x: 0.5, y: 0.5 } });
  const result = {};
  for (const [axis, cells, full, visible, pixels] of [
    ['x', 'widthPx', 'columns', 'columns', 'width'], ['y', 'heightPx', 'rows', 'rows', 'height'],
  ]) {
    const cell = data.cells[cells]; const size = data.image[pixels];
    const span = v.window[visible] * cell;
    const total = v.canvas[full] * cell;
    const pad = (total - size * v.effectiveScale) / 2;
    const lo = Math.max(0, (span / 2 - pad) / v.effectiveScale / size);
    const hi = Math.min(1, (total - span / 2 - pad) / v.effectiveScale / size);
    result[axis] = total === span ? 0.5 : clamp(clamp(center[axis], lo, hi) +
      (delta[axis] ?? 0) * cell / v.effectiveScale / size, lo, hi);
  }
  return result;
}
function assertPanPath(data, path) {
  let state = { zoomFactor: data.zoomFactor, center: { x: 0.5, y: 0.5 } };
  let reference = { ...state.center };
  for (const delta of path) {
    reference = referencePan(data, reference, delta);
    state = panViewport({ ...data, ...state }, { xCells: delta.x ?? 0, yCells: delta.y ?? 0 });
    near(state.center.x, reference.x); near(state.center.y, reference.y);
  }
  return state;
}

test('reference simulation: every edge overshoot/reversal preserves sequential clamp semantics', () => {
  for (const image of [geometry.image, { width: 603, height: 1201 }]) {
    for (const zoomFactor of [1, 2.35, 4.1]) {
      const data = { ...geometry, image, zoomFactor };
      for (const axis of ['x', 'y']) for (const sign of [-1, 1]) {
        assertPanPath(data, [{ [axis]: sign * 10000 }, { [axis]: sign * 7 },
          { [axis]: -sign * 3 }, { [axis]: -sign * 9 }, { [axis]: sign * 2 }]);
      }
      // Deterministic dense paths, including simultaneous-axis subcell movement.
      const path = Array.from({ length: 1000 }, (_, i) => ({
        x: ((i * 17) % 47 - 23) / 3, y: ((i * 31) % 59 - 29) / 5,
      }));
      assertPanPath(data, path);
    }
  }
});

test('reference simulation: zero-net endpoint is not sequential pan after edge overshoot', () => {
  const data = { ...geometry, zoomFactor: 2.35 };
  for (const axis of ['x', 'y']) for (const sign of [-1, 1]) {
    const sequential = assertPanPath(data, [{ [axis]: sign * 10000 }, { [axis]: -sign * 10000 }]);
    const endpoint = panViewport(data, { xCells: 0, yCells: 0 });
    assert.notEqual(sequential.center[axis], endpoint.center[axis]);
  }
});

// These tests model canonical/sample ownership OUTSIDE the helper. They are
// reference simulations only, not production viewer/controller/host acceptance.
function simulation() {
  const clock = new Clock();
  const model = { canonical: { zoomFactor: 2.35, center: { x: 0.5, y: 0.5 } },
    shown: null, admitted: null, wheel: null, grabbing: true, samples: [] };
  const key = (state) => {
    const v = computeViewport({ ...geometry, ...state });
    return JSON.stringify([v.canvas, v.window]);
  };
  const dirty = () => !model.shown || key(model.shown) !== key(model.canonical);
  const pacer = clock.pacer((ticket) => {
    if (!dirty() && !model.wheel) { pacer.blocked(ticket); return; }
    if (model.wheel && !dirty()) {
      const wheel = model.wheel; model.wheel = null;
      if (!isWheelExpired(wheel.at, clock.time, EXPIRY)) {
        model.canonical = zoomViewportAt({ ...geometry, ...model.canonical }, wheel.direction, wheel.point);
      }
    }
    if (!dirty()) { pacer.blocked(ticket); return; }
    const sample = { ticket, state: model.canonical, key: key(model.canonical) };
    model.admitted = sample; model.samples.push(sample);
  });
  const reducePan = (x, y) => {
    model.canonical = panViewport({ ...geometry, ...model.canonical }, { xCells: x, yCells: y });
    if (dirty()) pacer.request();
  };
  return { clock, model, pacer, key, dirty, reducePan,
    release(x, y) { reducePan(x, y); model.grabbing = false; },
    wheel(direction, point) {
      model.grabbing = false;
      model.wheel = { direction, point, at: clock.time }; pacer.request();
    },
    complete() {
      const sample = model.admitted; model.admitted = null;
      if (sample.key !== key(model.canonical)) {
        pacer.settled(sample.ticket, { retry: dirty() }); return false;
      }
      model.shown = model.canonical; pacer.published(sample.ticket); return true;
    },
    receipt() {
      pacer.rendered(model.samples.at(-1).ticket); clock.flush();
    },
    keyAction(action) {
      model.grabbing = false; model.wheel = null;
      model.canonical = action === 'reset' ? resetViewport({ ...geometry, ...model.canonical }) :
        zoomViewport({ ...geometry, ...model.canonical }, action);
      pacer.request();
    },
  };
}

test('reference simulation: release displacement stays dirty while armed/busy and rejects stale final guard', () => {
  for (const busy of [false, true]) {
    const s = simulation();
    s.reducePan(1, 0);
    if (busy) s.clock.fire();
    s.reducePan(4, -3); s.release(5, 2);
    const expected = assertPanPath({ ...geometry, zoomFactor: 2.35 },
      [{ x: 1 }, { x: 4, y: -3 }, { x: 5, y: 2 }]);
    assert.deepEqual(s.model.canonical, expected);
    assert.equal(s.model.grabbing, false); assert.equal(s.dirty(), true);
    if (busy) {
      s.clock.advance(100); assert.equal(s.complete(), false);
      assert.equal(s.clock.due(), 150);
      s.clock.advance(50);
    }
    s.clock.fire(); assert.equal(s.complete(), true); s.receipt();
    assert.deepEqual(s.model.shown, expected); assert.equal(s.dirty(), false);
    // One possible redundant demand wake blocks; it must not create frame work.
    if (s.clock.timers.size) { s.clock.time = s.clock.due(); s.clock.fire(); }
    assert.equal(s.model.samples.length, busy ? 2 : 1);
    assert.equal(s.clock.timers.size, 0);
  }
});

test('reference simulation: wheel slot replaces sign/point/time, expires only locally and never deletes final pan', () => {
  const s = simulation(); const first = { column: 10.5, row: 10.5 };
  const last = { column: 40.5, row: 20.5 };
  s.release(9, 3); s.clock.fire();
  s.wheel('in', first); s.clock.advance(100); s.wheel('out', last);
  assert.deepEqual(s.model.wheel, { direction: 'out', point: last, at: 100 });
  assert.equal(isWheelExpired(s.model.wheel.at, 224.999, EXPIRY), false);
  assert.equal(isWheelExpired(s.model.wheel.at, 225, EXPIRY), true);
  assert.equal(s.complete(), true); s.receipt();
  const finalPan = s.model.shown;
  s.clock.advance(EXPIRY); s.clock.fire(); // Current slot now expired.
  assert.equal(s.model.wheel, null);
  assert.deepEqual(s.model.canonical, finalPan); assert.deepEqual(s.model.shown, finalPan);
  assert.equal(s.model.samples.length, 1); assert.equal(s.clock.timers.size, 0);
  s.wheel('out', first); s.clock.advance(10); s.wheel('in', last);
  s.clock.fire();
  assert.deepEqual(s.model.canonical, zoomViewportAt({ ...geometry, ...finalPan }, 'in', last));
  assert.equal(s.model.samples.length, 2); // One sign step, not magnitude/exponent accumulation.
});

test('reference simulation: busy wheel does not change/cancel admitted zoom; admitted work never expires', () => {
  const s = simulation(); s.pacer.request(); s.clock.fire(); s.complete(); s.receipt();
  const base = s.model.shown;
  s.wheel('in', { column: 20.5, row: 12.5 });
  s.clock.advance(IDLE); s.clock.fire();
  const admitted = s.model.admitted;
  s.wheel('out', { column: 30.5, row: 10.5 });
  s.clock.advance(1000); // Longer than expiry after admission.
  assert.equal(s.model.admitted, admitted);
  assert.deepEqual(s.model.canonical, admitted.state);
  assert.notEqual(admitted.state.zoomFactor, base.zoomFactor);
  assert.equal(s.complete(), true); s.receipt();
  s.clock.advance(IDLE); s.clock.fire();
  assert.deepEqual(s.model.canonical, admitted.state); // Only the deferred out slot expired.
  assert.equal(s.model.samples.length, 2);
});

test('reference simulation: canonical key aliases coalesce; changed key rejects held work', () => {
  const s = simulation(); s.pacer.request(); s.clock.fire();
  const sample = s.model.admitted;
  s.reducePan(0.001, -0.001);
  assert.equal(s.key(s.model.canonical), sample.key);
  assert.notDeepEqual(s.model.canonical, sample.state);
  assert.equal(s.complete(), true); s.receipt();
  assert.deepEqual(s.model.shown, s.model.canonical); // Latest subcell metadata retained.
  s.reducePan(10, 0); s.clock.advance(IDLE); s.clock.fire();
  s.reducePan(10, 0); assert.equal(s.complete(), false);
  assert.equal(s.clock.timers.size, 1);
});

test('pure alias evidence: equal mapped geometry must not replace canonical nominal/subcell metadata', () => {
  // This demonstrates reducer semantics only. Production wheel/press admission
  // and canonical-versus-ready ownership still require controller/host tests.
  const data = { image: { width: 640, height: 480 }, area: { columns: 36, rows: 10 },
    cells: { widthPx: 8, heightPx: 16 } };
  const mapping = (state) => {
    const v = computeViewport({ ...data, ...state });
    return { canvas: v.canvas, window: v.window, origin: v.origin,
      padding: v.padding, effectiveScale: v.effectiveScale };
  };
  const retained = { zoomFactor: 1.25, center: { x: 0.5, y: 0.5 } };
  const canonical = { ...retained, zoomFactor: 1.251 };
  assert.deepEqual(mapping(canonical), mapping(retained));
  const point = { column: 12.5, row: 5.5 };
  const fromCanonical = zoomViewportAt({ ...data, ...canonical }, 'in', point);
  const fromRetained = zoomViewportAt({ ...data, ...retained }, 'in', point);
  assert.equal(fromCanonical.zoomFactor, 1.5637499999999998);
  assert.equal(fromRetained.zoomFactor, 1.5625);
  assert.notEqual(fromCanonical.zoomFactor, fromRetained.zoomFactor);
  assert.deepEqual(mapping(fromCanonical), mapping(fromRetained));

  const oldCenter = { zoomFactor: 5, center: { x: 0.5001, y: 0.5001 } };
  const newCenter = { zoomFactor: 5, center: { x: 0.5002, y: 0.5002 } };
  assert.deepEqual(mapping(oldCenter), mapping(newCenter));
  const oldPan = panViewport({ ...data, ...oldCenter }, { xCells: 4, yCells: 4 });
  const newPan = panViewport({ ...data, ...newCenter }, { xCells: 4, yCells: 4 });
  near(oldPan.center.x, 0.5301); near(oldPan.center.y, 0.5801);
  near(newPan.center.x, 0.5302); near(newPan.center.y, 0.5802);
  assert.notDeepEqual(newPan.center, oldPan.center);
  assert.deepEqual(mapping(newPan), mapping(oldPan));
});

test('reference simulation: zero-motion and repeated outward edge pans generate no extra heavy sample', () => {
  const s = simulation(); s.reducePan(10000, -10000); s.clock.fire();
  assert.equal(s.complete(), true); s.receipt();
  const edge = s.model.canonical;
  for (let i = 0; i < 10000; i++) s.reducePan(i % 2 ? 0 : 4, i % 2 ? 0 : -4);
  s.release(0, 0);
  assert.deepEqual(s.model.canonical, edge);
  assert.equal(s.model.samples.length, 1); assert.equal(s.clock.timers.size, 0);
});

test('reference simulation: key returns to admitted geometry without pointless stale rejection', () => {
  const s = simulation(); s.pacer.request(); s.clock.fire();
  const admitted = s.model.admitted;
  s.reducePan(7, -3); s.reducePan(-7, 3);
  assert.equal(s.key(s.model.canonical), admitted.key);
  assert.equal(s.complete(), true); s.receipt();
  assert.equal(s.model.samples.length, 1);
  s.clock.advance(IDLE); s.clock.fire(); // Busy demand reconciles with a no-work block.
  assert.equal(s.model.samples.length, 1); assert.equal(s.clock.timers.size, 0);
});

test('reference simulation: keyboard/reset supersede mouse work but preserve discrete canonical state effects', () => {
  const s = simulation(); s.release(12, -4); s.clock.fire();
  s.wheel('out', { column: 30.5, row: 10.5 });
  let expected = s.model.canonical;
  for (const action of ['in', 'in', 'out']) {
    expected = zoomViewport({ ...geometry, ...expected }, action); s.keyAction(action);
  }
  assert.deepEqual(s.model.canonical, expected);
  assert.equal(s.model.wheel, null); assert.equal(s.model.grabbing, false);
  assert.equal(s.complete(), false); // Prior final pan cannot win over newer keys.
  s.keyAction('reset');
  assert.deepEqual(s.model.canonical, resetViewport(geometry));
  s.clock.advance(IDLE); s.clock.fire(); assert.equal(s.complete(), true); s.receipt();
  assert.deepEqual(s.model.shown, resetViewport(geometry));
});
