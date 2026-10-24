// Standalone benchmark support, not imported by production or the normal test suite.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

export function summary(values) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
  return { samples: sorted.length, p50: at(.5), p95: at(.95), max: sorted.at(-1) ?? 0 };
}

// Exact ordered byte-range ledger: payloads are unnecessary for a FIFO service
// calculation. Every write owns [start,end); partial progress never replaces data.
export class FifoLedger {
  constructor({ bytesPerSecond, storageLimit, stalls = [] }) {
    assert.ok(bytesPerSecond > 0 && Number.isFinite(bytesPerSecond));
    assert.ok(Number.isSafeInteger(storageLimit) && storageLimit > 0);
    this.capacity = bytesPerSecond; this.limit = storageLimit; this.stalls = stalls;
    this.now = 0; this.emitted = 0; this.drained = 0; this.peak = 0;
    this.queue = []; this.head = 0; this.credit = 0; this.overloadAt = undefined;
    this.completedAges = []; this.partialAdvances = 0;
  }
  advance(time) {
    assert.ok(time >= this.now, 'FIFO clock must be monotonic');
    let duration = time - this.now;
    for (const [start, end] of this.stalls) duration -= Math.max(0, Math.min(time, end) - Math.max(this.now, start));
    assert.ok(duration >= -1e-8, 'stall intervals must not overlap');
    let service = Math.floor(duration * this.capacity / 1000 + this.credit);
    this.credit = duration * this.capacity / 1000 + this.credit - service;
    while (service > 0 && this.head < this.queue.length) {
      const entry = this.queue[this.head], remaining = entry.end - this.drained;
      const consumed = Math.min(service, remaining);
      this.drained += consumed; service -= consumed;
      if (consumed < remaining) this.partialAdvances++;
      else { this.completedAges.push(time - entry.at); this.head++; }
    }
    // Unused service is not banked across idle periods.
    if (this.head === this.queue.length) this.credit = 0;
    this.now = time; this.check();
  }
  write(bytes, time = this.now) {
    this.advance(time);
    assert.ok(Number.isSafeInteger(bytes) && bytes >= 0);
    if (bytes) this.queue.push({ start: this.emitted, end: this.emitted + bytes, at: time });
    this.emitted += bytes; this.peak = Math.max(this.peak, this.pending);
    // Retain bytes even on overload: it is an explicit failed finite-buffer model,
    // not a void-interface backpressure signal and not implicit frame dropping.
    if (this.pending > this.limit && this.overloadAt === undefined) this.overloadAt = time;
    this.check();
  }
  get pending() { return this.emitted - this.drained; }
  check() {
    assert.equal(this.emitted, this.drained + this.pending);
    if (this.head < this.queue.length) {
      const entry = this.queue[this.head];
      assert.ok(this.drained >= entry.start && this.drained < entry.end);
    } else assert.equal(this.pending, 0);
  }
  snapshot() {
    return { emittedBytes: this.emitted, drainedBytes: this.drained, pendingBytes: this.pending,
      peakPendingBytes: this.peak, oldestPendingAgeMs: this.pending ? this.now - this.queue[this.head].at : 0,
      partialAdvances: this.partialAdvances, overload: this.overloadAt !== undefined,
      overloadAtMs: this.overloadAt, completedWriteAgeUpperBoundMs: summary(this.completedAges), conservation: true };
  }
}

export function fifoSelfCheck() {
  const fifo = new FifoLedger({ bytesPerSecond: 1000, storageLimit: 15, stalls: [[5, 10]] });
  fifo.write(10, 0); fifo.advance(4); assert.equal(fifo.pending, 6);
  fifo.write(20, 4); assert.equal(fifo.overloadAt, 4);
  fifo.advance(15); assert.equal(fifo.drained, 10); assert.equal(fifo.pending, 20);
  fifo.advance(35); assert.equal(fifo.pending, 0); assert.equal(fifo.emitted, 30);
  assert.ok(fifo.partialAdvances > 0);
}

export function pngFixture(width, height) {
  function chunk(type, payload) {
    const header = Buffer.alloc(8); header.writeUInt32BE(payload.length); header.write(type, 4);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([Buffer.from(type), payload])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, payload, checksum]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  // Asymmetric quadrants, coordinate ruler stripes and binary coordinate labels.
  // No fixture files or pixels are retained in the benchmark JSON.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * (1 + width * 4) + 1 + x * 4;
    const ruler = x % 64 < 2 || y % 48 < 2;
    const label = y % 48 < 10 && x % 64 < 32 && ((Math.floor(x / 64) + 3 * Math.floor(y / 48)) >> Math.floor(x % 64 / 4) & 1);
    pixels[p] = ruler || label ? 255 : x < width / 3 ? 220 : 30;
    pixels[p + 1] = ruler || label ? 255 : y < height / 2 ? 180 : 20;
    pixels[p + 2] = ruler || label ? 255 : (x + y) % 180;
    pixels[p + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export class CaptureTerminal {
  kittyProtocolActive = false; writes = []; inputCalls = 0;
  constructor(columns, rows) { this.columns = columns; this.rows = rows; }
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {}
  write(data) {
    // Exact bytes, write order and receipt time, not display acknowledgement.
    this.writes.push({ at: performance.now(), bytes: Buffer.byteLength(data), graphics: data.includes('\x1bPtmux;') });
    this.onWrite?.(data);
  }
  send(data) { this.inputCalls++; this.input(data); }
  mouse(button, x, y, release = false) { this.send(sgr(button, x, y, release)); }
  moveBy(n) { if (n) this.write(`\x1b[${Math.abs(n)}${n > 0 ? 'B' : 'A'}`); }
  hideCursor() { this.write('\x1b[?25l'); } showCursor() { this.write('\x1b[?25h'); }
  clearLine() { this.write('\x1b[2K'); } clearFromCursor() { this.write('\x1b[J'); }
  clearScreen() { this.write('\x1b[2J\x1b[H'); }
  setTitle(title) { this.write(`\x1b]0;${title}\x07`); } setProgress() {}
}
export const sgr = (button, x, y, release = false) => `\x1b[<${button};${x + 1};${y + 1}${release ? 'm' : 'M'}`;
