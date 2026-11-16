import { inflateSync } from 'node:zlib';

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const invalid = () => { throw new Error('Clipboard PNG is invalid or outside supported image limits.'); };
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

/** Strict bounded still PNG validation; no converter, path access or host import. */
export function validateClipboardPng(bytes, { maxBytes = 8 * 1024 * 1024, maxPixels = 16 * 1024 * 1024,
  maxDecodedBytes = 64 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > maxBytes || !bytes.subarray(0, 8).equals(signature)) invalid();
  let offset = 8, count = 0, width, height, depth, color, idatEnded = false, palette = false, paletteEntries = 0, ended = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (++count > 2048 || offset + 12 > bytes.length) invalid();
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || (bytes[offset + 6] & 32) ||
        crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    const data = bytes.subarray(offset + 8, end - 4);
    if (count === 1 && type !== 'IHDR') invalid();
    if (type === 'IHDR') {
      if (count !== 1 || size !== 13) invalid();
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width * height > maxPixels || !depths[color]?.includes(depth) ||
          data[10] || data[11] || data[12]) invalid(); // Noninterlaced still PNG only.
    } else if (type === 'PLTE') {
      if (palette || compressed.length || color === 0 || color === 4 || !size || size % 3 || size > 768 ||
          (color === 3 && size / 3 > 2 ** depth)) invalid();
      palette = true; paletteEntries = size / 3;
    } else if (type === 'IDAT') {
      if (idatEnded || (color === 3 && !palette)) invalid();
      compressed.push(data);
    } else if (type === 'IEND') {
      if (size || !compressed.length || end !== bytes.length) invalid();
      ended = true;
    } else {
      if (['acTL', 'fcTL', 'fdAT'].includes(type) || !(bytes[offset + 4] & 32)) invalid();
      if (compressed.length) idatEnded = true;
    }
    offset = end;
  }
  if (!ended) invalid();
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const rowBytes = Math.ceil(width * channels * depth / 8), decodedSize = (rowBytes + 1) * height;
  if (decodedSize > maxDecodedBytes) invalid();
  let decoded;
  try {
    const source = Buffer.concat(compressed);
    const result = inflateSync(source, { maxOutputLength: decodedSize, info: true });
    if (result.engine.bytesWritten !== source.length) invalid();
    decoded = result.buffer;
  } catch { invalid(); }
  if (decoded.length !== decodedSize) invalid();
  let previous = Buffer.alloc(color === 3 ? rowBytes : 0);
  for (let row = 0; row < height; row++) {
    const filter = decoded[row * (rowBytes + 1)];
    if (filter > 4) invalid();
    if (color !== 3) continue;
    const values = Buffer.from(decoded.subarray(row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1)));
    for (let index = 0; index < rowBytes; index++) {
      const left = values[index - 1] || 0, up = previous[index], upperLeft = previous[index - 1] || 0;
      const predictor = left + up - upperLeft;
      const a = Math.abs(predictor - left), b = Math.abs(predictor - up), c = Math.abs(predictor - upperLeft);
      const paeth = a <= b && a <= c ? left : b <= c ? up : upperLeft;
      values[index] = (values[index] + [0, left, up, Math.floor((left + up) / 2), paeth][filter]) & 255;
    }
    for (let x = 0; x < width; x++) {
      const bit = x * depth, value = (values[bit >>> 3] >>> (8 - depth - bit % 8)) & ((1 << depth) - 1);
      if (value >= paletteEntries) invalid();
    }
    previous = values;
  }
  return Object.freeze({ width, height });
}
