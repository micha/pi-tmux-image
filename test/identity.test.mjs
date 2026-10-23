import test from 'node:test';
import assert from 'node:assert/strict';
import {
  payloadIdentity, geometryIdentity, placementIdentity,
  StableIdAllocator, GraphicsIdentityRegistry, ResidencyCache,
} from '../src/identity.mjs';

const geometry = { columns: 3, rows: 2 };
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 42]);
function countingRandom() { let id = 0; return () => ++id; }

test('allocator retries forced collisions, is stable, and never aliases local keys', () => {
  const candidates = [42, 42, 42, 0xffffff];
  let calls = 0;
  const allocator = new StableIdAllocator({ random: () => { calls++; return candidates.shift(); } });
  assert.equal(allocator.allocate('one'), 42);
  assert.equal(allocator.allocate('one'), 42);
  assert.equal(calls, 1);
  assert.equal(allocator.allocate('two'), 0xffffff);
  assert.equal(calls, 4);
  assert.equal(allocator.allocate('two'), 0xffffff);
});

test('allocator collision exhaustion is bounded and does not poison prior keys', () => {
  let calls = 0;
  const allocator = new StableIdAllocator({ random: () => { calls++; return 7; }, maxAttempts: 3 });
  assert.equal(allocator.allocate('first'), 7);
  assert.throws(() => allocator.allocate('second'), /maxAttempts/);
  assert.equal(calls, 4);
  assert.equal(allocator.allocate('first'), 7);
  assert.throws(() => allocator.allocate(''), TypeError);
  for (const id of [0, -1, 0x1000000, 1.5, NaN]) {
    assert.throws(() => new StableIdAllocator({ random: () => id }).allocate('key'), RangeError);
  }
  assert.throws(() => new StableIdAllocator({ maxAttempts: 0 }), RangeError);
  assert.throws(() => new StableIdAllocator({ random: 1 }), TypeError);
});

test('default randomized allocation produces nonzero locally distinct 24-bit IDs', () => {
  const allocator = new StableIdAllocator();
  const ids = Array.from({ length: 1000 }, (_, index) => allocator.allocate(`key:${index}`));
  assert.equal(new Set(ids).size, 1000);
  assert.ok(ids.every((id) => Number.isInteger(id) && id > 0 && id <= 0xffffff));
});

test('payload identity is exact snapshot bytes, not buffer object or original path', () => {
  assert.equal(payloadIdentity(Buffer.from(bytes)), payloadIdentity(bytes));
  const other = Buffer.from(bytes); other[8]++;
  assert.notEqual(payloadIdentity(bytes), payloadIdentity(other));
  const larger = new Uint8Array(bytes.length + 8); larger.set(bytes, 4);
  assert.equal(payloadIdentity(larger.subarray(4, 4 + bytes.length)), payloadIdentity(bytes));
  for (const bad of ['', [], Buffer.alloc(0)]) assert.throws(() => payloadIdentity(bad), TypeError);
});

test('registry shares payload IDs but distinguishes occurrences, payloads and geometry versions', () => {
  const registry = new GraphicsIdentityRegistry({ random: countingRandom() });
  const resolve = (overrides = {}) => registry.resolve({ png: bytes, occurrenceKey: 'message:1/page:0', geometry, ...overrides });
  const first = resolve();
  assert.deepEqual(resolve({ png: Buffer.from(bytes), geometry: { rows: 2, columns: 3 } }), first);
  assert.ok(Object.isFrozen(first));
  const secondOccurrence = resolve({ occurrenceKey: 'message:2/page:0' });
  assert.equal(secondOccurrence.imageId, first.imageId);
  assert.notEqual(secondOccurrence.placementId, first.placementId);
  const resized = resolve({ geometry: { columns: 4, rows: 2 } });
  assert.equal(resized.imageId, first.imageId);
  assert.notEqual(resized.placementId, first.placementId);
  const changedPixels = resolve({ png: Buffer.concat([bytes, Buffer.from([1])]) });
  assert.notEqual(changedPixels.imageId, first.imageId);
  assert.notEqual(changedPixels.placementId, first.placementId);
  const cellGeometry = resolve({ geometry: { ...geometry, cellWidthPx: 8, cellHeightPx: 16 } });
  assert.notEqual(cellGeometry.placementId, first.placementId);
  const changedCellGeometry = resolve({ geometry: { ...geometry, cellWidthPx: 9, cellHeightPx: 16 } });
  assert.notEqual(changedCellGeometry.placementId, cellGeometry.placementId);
  // Revisiting old scrollback geometry keeps its prototype identity.
  assert.deepEqual(resolve(), first);
});

test('structured identity keys cannot alias delimiter-containing occurrences', () => {
  assert.notEqual(placementIdentity('a', 'b:c', geometry), placementIdentity('a:b', 'c', geometry));
  assert.notEqual(geometryIdentity({ columns: 2, rows: 3 }), geometryIdentity(geometry));
  assert.equal(geometryIdentity({ ...geometry, cellWidthPx: null }), geometryIdentity(geometry));
  assert.throws(() => placementIdentity('payload', '', geometry), TypeError);
  assert.throws(() => placementIdentity('', 'occurrence', geometry), TypeError);
  for (const value of [0, -1, NaN, Infinity, '8']) {
    assert.throws(() => geometryIdentity({ ...geometry, cellWidthPx: value }), RangeError);
  }
});

test('residency epoch tracks successful image/placement upload, rejecting stale async completion', () => {
  const cache = new ResidencyCache();
  const epoch = cache.epoch;
  assert.equal(cache.hasImage(1), false);
  assert.equal(cache.markPlacement(1, 2, epoch), false);
  assert.equal(cache.markImage(1, epoch), true);
  assert.equal(cache.hasImage(1), true);
  assert.equal(cache.hasPlacement(1, 2), false);
  assert.equal(cache.markPlacement(1, 2, epoch), true);
  assert.equal(cache.hasPlacement(1, 2), true);
  // Multiple prototypes can reuse the same resident payload.
  assert.equal(cache.markPlacement(1, 3, epoch), true);
  assert.equal(cache.hasPlacement(1, 3), true);
  const next = cache.beginEpoch();
  assert.notEqual(next, epoch);
  assert.equal(cache.hasImage(1), false);
  assert.equal(cache.hasPlacement(1, 2), false);
  assert.equal(cache.markImage(1, epoch), false);
  assert.equal(cache.markPlacement(1, 2, epoch), false);
  assert.equal(cache.hasImage(1), false);
  assert.equal(cache.markImage(1, next), true);
  assert.equal(cache.markPlacement(1, 2, next), true);
  assert.throws(() => cache.markImage(0, next), RangeError);
});
