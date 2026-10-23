import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  DIACRITICS, MAX_GRID_DIMENSION, PLACEHOLDER, DEFAULT_CHUNK_SIZE,
  encodePngUpload, encodeVirtualPlacement, encodePlaceholderCell,
  encodePlaceholderRows, validateId, validateGrid, wrapTmux,
} from '../src/kitty.mjs';

const ESC = '\x1b';
function pngBytes(length) {
  const bytes = Buffer.alloc(length);
  for (let index = 8; index < length; index++) bytes[index] = index % 256;
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
}

// Independent strict decoder: reject single inner ESCs, malformed terminators,
// or a single outer wrapper containing more than one APC.
function unwrap(wrapped) {
  assert.ok(wrapped.startsWith(`${ESC}Ptmux;`));
  assert.ok(wrapped.endsWith(`${ESC}\\`));
  const body = wrapped.slice(7, -2);
  let decoded = '';
  for (let index = 0; index < body.length; index++) {
    decoded += body[index];
    if (body[index] === ESC) assert.equal(body[++index], ESC);
  }
  assert.match(decoded, /^\x1b_G[^\x1b]*\x1b\\$/);
  return decoded;
}

function decodeUpload(wrapped) {
  const inner = unwrap(wrapped).slice(3, -2);
  const [header, payload] = inner.split(';');
  assert.notEqual(payload, undefined);
  assert.match(payload, /^[A-Za-z0-9+/]*={0,2}$/);
  const controls = Object.fromEntries(header.split(',').map((field) => field.split('=')));
  return { controls, payload };
}

test('tmux wrapper escapes EVERY inner ESC, exactly one layer', () => {
  const inner = `${ESC}_Gq=2${ESC}\\`;
  assert.equal(wrapTmux(inner), `${ESC}Ptmux;${ESC}${ESC}_Gq=2${ESC}${ESC}\\${ESC}\\`);
  assert.equal(unwrap(wrapTmux(inner)), inner);
  assert.equal(wrapTmux(`${ESC}${ESC}x`), `${ESC}Ptmux;${ESC}${ESC}${ESC}${ESC}x${ESC}\\`);
  assert.throws(() => wrapTmux(42), TypeError);
});

test('PNG chunks reconstruct bytes across default/max/small chunk and padding boundaries', () => {
  for (const chunkSize of [4, DEFAULT_CHUNK_SIZE, 4096]) {
    const boundary = chunkSize / 4 * 3;
    for (const length of new Set([9, 10, 11, boundary - 1, boundary, boundary + 1, boundary * 2 - 1, boundary * 2, boundary * 2 + 1, boundary * 3 + 2].filter((n) => n > 8))) {
      const original = pngBytes(length);
      const chunks = encodePngUpload(original, 0x123456, { chunkSize }).map(decodeUpload);
      assert.equal(chunks.length, Math.ceil(original.toString('base64').length / chunkSize));
      assert.deepEqual(chunks[0].controls, {
        a: 't', f: '100', t: 'd', i: String(0x123456), q: '2', m: chunks.length > 1 ? '1' : '0',
      });
      chunks.forEach(({ controls, payload }, index) => {
        assert.equal(controls.m, index === chunks.length - 1 ? '0' : '1');
        assert.equal(controls.q, '2');
        assert.ok(payload.length <= chunkSize && payload.length <= 4096);
        if (index !== chunks.length - 1) assert.equal(payload.length % 4, 0);
        if (index > 0) assert.deepEqual(Object.keys(controls).sort(), ['m', 'q']);
      });
      assert.deepEqual(Buffer.from(chunks.map((chunk) => chunk.payload).join(''), 'base64'), original);
    }
  }
});

test('PNG encoder respects typed-array offsets and input resource bounds', () => {
  const original = pngBytes(23);
  const backing = new Uint8Array(30);
  backing.set(original, 4);
  const input = backing.subarray(4, 27);
  assert.deepEqual(Buffer.from(encodePngUpload(input, 1).map(decodeUpload).map((chunk) => chunk.payload).join(''), 'base64'), original);
  for (const chunkSize of [0, 1, 5, 4097, 4096.5, NaN]) {
    assert.throws(() => encodePngUpload(original, 1, { chunkSize }), RangeError);
  }
  assert.throws(() => encodePngUpload(original, 1, { maxBytes: 22 }), RangeError);
  assert.throws(() => encodePngUpload(original, 1, { maxBytes: Infinity }), RangeError);
  for (const bad of [Buffer.alloc(20), original.subarray(0, 8), 'PNG', []]) {
    assert.throws(() => encodePngUpload(bad, 1), TypeError);
  }
});

test('virtual placement is quiet, explicitly identified, and never cursor positioned', () => {
  assert.equal(unwrap(encodeVirtualPlacement({ imageId: 42, placementId: 777, columns: 3, rows: 2 })),
    `${ESC}_Ga=p,U=1,i=42,p=777,c=3,r=2,q=2${ESC}\\`);
});

test('spec diacritics include full 297-entry bounds and supplementary marks', () => {
  assert.equal(DIACRITICS.length, 297);
  assert.equal(new Set(DIACRITICS).size, 297);
  assert.deepEqual(DIACRITICS.slice(0, 3), ['\u0305', '\u030d', '\u030e']);
  assert.equal(DIACRITICS[296], '\u{1d244}');
  assert.ok(Object.isFrozen(DIACRITICS));
  // SHA-256 of comma-separated decimal codepoints independently extracted from
  // Unicode 6.0.0 using the specification's filter (see protocol documentation).
  assert.equal(createHash('sha256').update(DIACRITICS.map((mark) => mark.codePointAt(0)).join(',')).digest('hex'),
    '18f1acc3adb9de8f88c66131efa8384d1a4f574ff4c7ac6f6c6335342afd5cc4');
  assert.equal(encodePlaceholderCell(296, 296), `${PLACEHOLDER}\u{1d244}\u{1d244}\u0305`);
});

test('each row restores style and each cell carries row/column/high byte independently', () => {
  const rows = encodePlaceholderRows({ imageId: 0x123456, placementId: 0xabcdef, columns: 3, rows: 2 });
  assert.equal(rows.length, 2);
  for (let row = 0; row < rows.length; row++) {
    assert.ok(rows[row].startsWith(`${ESC}[0m${ESC}[38;2;18;52;86m${ESC}[58:2::171:205:239m`));
    assert.ok(rows[row].endsWith(`${ESC}[0m`));
    const plain = rows[row].replace(/\x1b\[[0-9:;]*m/g, '');
    assert.ok(!plain.includes(ESC));
    assert.ok(!plain.includes('\n') && !plain.includes('\r'));
    const cells = plain.split(PLACEHOLDER).slice(1);
    assert.equal(cells.length, 3);
    cells.forEach((cell, column) => {
      // Decode even the last clipped cell with NO left neighbor.
      const marks = Array.from(cell);
      assert.deepEqual(marks.map((mark) => DIACRITICS.indexOf(mark)), [row, column, 0]);
    });
  }
});

test('helpers emit no stdout or stderr even when generating uploads, rows and identities', () => {
  const kittyUrl = new URL('../src/kitty.mjs', import.meta.url).href;
  const identityUrl = new URL('../src/identity.mjs', import.meta.url).href;
  const source = `
    import { encodePngUpload, encodeVirtualPlacement, encodePlaceholderRows } from ${JSON.stringify(kittyUrl)};
    import { GraphicsIdentityRegistry, ResidencyCache } from ${JSON.stringify(identityUrl)};
    const png = Buffer.from([137,80,78,71,13,10,26,10,42]);
    const geometry = { columns: 2, rows: 2 };
    const ids = new GraphicsIdentityRegistry().resolve({ png, occurrenceKey: 'test', geometry });
    encodePngUpload(png, ids.imageId);
    encodeVirtualPlacement({ ...ids, ...geometry });
    encodePlaceholderRows({ ...ids, ...geometry });
    const cache = new ResidencyCache();
    cache.markImage(ids.imageId, cache.epoch);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('IDs reject truncation/zero and grid/coordinate bounds match protocol table', () => {
  for (const id of [0, -1, 0x1000000, 1.5, NaN, Infinity, '42', null]) {
    assert.throws(() => validateId(id), RangeError);
    assert.throws(() => encodePngUpload(pngBytes(9), id), RangeError);
    assert.throws(() => encodePlaceholderRows({ imageId: 1, placementId: id, columns: 1, rows: 1 }), RangeError);
  }
  assert.equal(validateId(0xffffff), 0xffffff);
  assert.equal(validateId(1), 1);
  assert.deepEqual(validateGrid({ columns: 297, rows: 297 }), { columns: 297, rows: 297 });
  for (const bad of [0, -1, MAX_GRID_DIMENSION + 1, 1.5, NaN, '2']) {
    assert.throws(() => validateGrid({ columns: bad, rows: 1 }), RangeError);
    assert.throws(() => encodeVirtualPlacement({ imageId: 1, placementId: 2, columns: 1, rows: bad }), RangeError);
  }
  for (const bad of [-1, 297, 0.5, NaN, '0']) {
    assert.throws(() => encodePlaceholderCell(bad, 0), RangeError);
    assert.throws(() => encodePlaceholderCell(0, bad), RangeError);
  }
});
