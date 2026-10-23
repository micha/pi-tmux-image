import { createHash, randomInt } from 'node:crypto';
import { MAX_ID, validateGrid, validateId } from './kitty.mjs';

/** No path-based identity: hash the exact immutable normalized PNG snapshot. */
export function payloadIdentity(png) {
  if (!(png instanceof Uint8Array) || png.byteLength === 0) {
    throw new TypeError('payload must be a nonempty Uint8Array');
  }
  return `png:sha256:${createHash('sha256').update(png).digest('hex')}`;
}

export function geometryIdentity(geometry) {
  const { columns, rows } = validateGrid(geometry);
  const { cellWidthPx = null, cellHeightPx = null } = geometry;
  for (const value of [cellWidthPx, cellHeightPx]) {
    if (value !== null && (!Number.isFinite(value) || value <= 0)) {
      throw new RangeError('cell pixel dimensions must be positive finite numbers or absent');
    }
  }
  return JSON.stringify(['kitty-u1-v1', columns, rows, cellWidthPx, cellHeightPx]);
}

/** Caller provides a durable occurrence key (e.g. message ID plus page index). */
export function placementIdentity(payloadKey, occurrenceKey, geometry) {
  for (const [name, value] of Object.entries({ payloadKey, occurrenceKey })) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} must be a nonempty string`);
  }
  return JSON.stringify([payloadKey, occurrenceKey, geometryIdentity(geometry)]);
}

/** Local collision checks, not coordination with other applications' terminal IDs. */
export class StableIdAllocator {
  #byKey = new Map();
  #used = new Set();
  #random;
  #maxAttempts;

  constructor({ random = () => randomInt(1, MAX_ID + 1), maxAttempts = 128 } = {}) {
    if (typeof random !== 'function') throw new TypeError('random must be a function');
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new RangeError('maxAttempts must be positive');
    this.#random = random;
    this.#maxAttempts = maxAttempts;
  }

  get size() { return this.#byKey.size; }

  allocate(key) {
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('key must be a nonempty string');
    if (this.#byKey.has(key)) return this.#byKey.get(key);
    if (this.#used.size === MAX_ID) throw new RangeError('24-bit ID namespace exhausted');
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const candidate = validateId(this.#random(), 'random ID');
      if (this.#used.has(candidate)) continue;
      this.#used.add(candidate);
      this.#byKey.set(key, candidate);
      return candidate;
    }
    throw new Error('Unable to allocate an unused ID within maxAttempts');
  }
}

/** Runtime-only registry. Reuse the instance for stable layouts; never persist it. */
export class GraphicsIdentityRegistry {
  #allocator;
  constructor(options) { this.#allocator = new StableIdAllocator(options); }

  /** Image-only lookup: an overlay must not allocate inline geometry history. */
  resolveImage(png) {
    const payloadKey = payloadIdentity(png);
    return Object.freeze({ payloadKey, imageId: this.#allocator.allocate(`image:${payloadKey}`) });
  }

  /** Exactly one private slot per runtime, never keyed by view/open/epoch. */
  reserveViewerPlacement() {
    const placementKey = "surface:viewer:slot:0";
    return Object.freeze({ placementKey, placementId: this.#allocator.allocate(placementKey) });
  }

  get allocatedIds() { return this.#allocator.size; }

  resolve({ png, occurrenceKey, geometry }) {
    const { payloadKey, imageId } = this.resolveImage(png);
    const placementKey = placementIdentity(payloadKey, occurrenceKey, geometry);
    return Object.freeze({
      payloadKey,
      placementKey,
      imageId,
      placementId: this.#allocator.allocate(`placement:${placementKey}`),
    });
  }
}

/** Tracking only: caller must upload successfully BEFORE marking and painting. */
export class ResidencyCache {
  #epoch = Symbol('graphics epoch');
  #images = new Set();
  #placements = new Set();

  get epoch() { return this.#epoch; }

  beginEpoch() {
    this.#epoch = Symbol('graphics epoch');
    this.#images.clear();
    this.#placements.clear();
    return this.#epoch;
  }

  hasImage(imageId) { return this.#images.has(validateId(imageId)); }

  markImage(imageId, epoch) {
    validateId(imageId);
    if (epoch !== this.#epoch) return false;
    this.#images.add(imageId);
    return true;
  }

  hasPlacement(imageId, placementId) {
    validateId(imageId);
    validateId(placementId, 'placementId');
    return this.#images.has(imageId) && this.#placements.has(`${imageId}:${placementId}`);
  }

  markPlacement(imageId, placementId, epoch) {
    validateId(imageId);
    validateId(placementId, 'placementId');
    if (epoch !== this.#epoch || !this.#images.has(imageId)) return false;
    this.#placements.add(`${imageId}:${placementId}`);
    return true;
  }
}
