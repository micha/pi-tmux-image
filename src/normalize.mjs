// Local presentation only. The caller supplies Pi's PUBLIC root convertToPng export.
// No filesystem access, terminal writes, host-private imports or model policy here.
export const DEFAULT_NORMALIZE_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
  maxDimension: 8192,
  maxPixels: 16 * 1024 * 1024,
});
export const NORMALIZE_MIME_TYPES = Object.freeze([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function invalid(message = "Malformed image snapshot") { throw new Error(message); }
function need(bytes, offset, length) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) invalid();
}
function ascii(bytes, offset, length) { need(bytes, offset, length); return bytes.toString("ascii", offset, offset + length); }
function dimensions(width, height, limits) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid("Invalid image dimensions");
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) invalid("Image dimensions exceed local normalization limits");
  return { width, height };
}
function decodeBase64(data, maxBytes) {
  if (typeof data !== "string" || !data.length) invalid("Missing image snapshot data");
  // Bound before allocating or scanning; Pi uses canonical padded base64.
  if (data.length > 4 * Math.ceil(maxBytes / 3)) invalid("Image bytes exceed local normalization limit");
  if (data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) invalid("Invalid snapshot base64");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > maxBytes) invalid("Image bytes exceed local normalization limit");
  if (bytes.toString("base64") !== data) invalid("Noncanonical snapshot base64");
  return bytes;
}
function pngDimensions(bytes, limits) {
  need(bytes, 0, 33);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || ascii(bytes, 12, 4) !== "IHDR") invalid("Expected PNG snapshot");
  const result = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20), limits);
  let offset = 8, hasData = false;
  while (offset < bytes.length) {
    need(bytes, offset, 12);
    const length = bytes.readUInt32BE(offset), type = ascii(bytes, offset + 4, 4);
    need(bytes, offset + 8, length + 4);
    if (type === "IHDR" && offset !== 8) invalid();
    if (type === "IDAT") hasData = true;
    offset += length + 12;
    if (type === "IEND") {
      if (length || !hasData || offset !== bytes.length) invalid();
      return result;
    }
  }
  invalid("Incomplete PNG snapshot");
}
// APNG's ordinary IDAT stream is a valid default still image. Remove only
// animation chunks; retained PNG chunks keep their original bytes and CRCs.
function pngStill(bytes) {
  const retained = [bytes.subarray(0, 8)];
  let offset = 8, animated = false;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), type = ascii(bytes, offset + 4, 4);
    const end = offset + length + 12;
    if (["acTL", "fcTL", "fdAT"].includes(type)) animated = true;
    else retained.push(bytes.subarray(offset, end));
    offset = end;
  }
  return animated ? Buffer.concat(retained) : bytes;
}
function jpegDimensions(bytes, limits) {
  need(bytes, 0, 4);
  if (bytes[0] !== 255 || bytes[1] !== 216) invalid("Expected JPEG snapshot");
  let offset = 2, result;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    need(bytes, offset, 1);
    const marker = bytes[offset++];
    if (marker === 217 || marker === 218) break;
    if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
    need(bytes, offset, 2);
    const length = bytes.readUInt16BE(offset);
    if (length < 2) invalid();
    need(bytes, offset, length);
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) invalid();
      const next = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3), limits);
      if (result && (next.width !== result.width || next.height !== result.height)) invalid();
      result = next;
    }
    offset += length;
  }
  if (!result) invalid("JPEG snapshot has no dimensions");
  return result;
}
function gifDimensions(bytes, limits) {
  const signature = ascii(bytes, 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") invalid("Expected GIF snapshot");
  need(bytes, 6, 7);
  const result = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8), limits);
  let offset = 13 + ((bytes[10] & 128) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), frames = 0;
  function skipBlocks() {
    for (;;) {
      need(bytes, offset, 1);
      const size = bytes[offset++];
      if (!size) return;
      need(bytes, offset, size); offset += size;
    }
  }
  while (offset < bytes.length) {
    const type = bytes[offset++];
    if (type === 59) { if (!frames) invalid(); return result; }
    if (type === 33) { need(bytes, offset, 1); offset++; skipBlocks(); continue; }
    if (type !== 44) invalid();
    need(bytes, offset, 9);
    const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2);
    const frame = dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6), limits);
    if (left + frame.width > result.width || top + frame.height > result.height) invalid("GIF frame exceeds canvas");
    const flags = bytes[offset + 8]; offset += 9;
    if (flags & 128) offset += 3 * (1 << ((flags & 7) + 1));
    need(bytes, offset, 1); offset++; skipBlocks(); frames++;
  }
  invalid("Incomplete GIF snapshot");
}
function webpDimensions(bytes, limits, nested = false) {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") invalid("Expected WebP snapshot");
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let offset = 12, result;
  while (offset < bytes.length) {
    need(bytes, offset, 8);
    const type = ascii(bytes, offset, 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    need(bytes, start, length + (length & 1));
    let next;
    if (type === "VP8X") {
      if (nested || length !== 10) invalid();
      next = dimensions(1 + bytes.readUIntLE(start + 4, 3), 1 + bytes.readUIntLE(start + 7, 3), limits);
    } else if (type === "VP8 ") {
      if (length < 10 || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) invalid();
      next = dimensions(bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383, limits);
    } else if (type === "VP8L") {
      if (length < 5 || bytes[start] !== 47) invalid();
      const bits = bytes.readUInt32LE(start + 1);
      next = dimensions(1 + (bits & 16383), 1 + ((bits >>> 14) & 16383), limits);
    } else if (type === "ANMF") {
      if (nested || length < 16 || !result) invalid();
      const frame = dimensions(1 + bytes.readUIntLE(start + 6, 3), 1 + bytes.readUIntLE(start + 9, 3), limits);
      if (2 * bytes.readUIntLE(start, 3) + frame.width > result.width || 2 * bytes.readUIntLE(start + 3, 3) + frame.height > result.height) invalid("WebP frame exceeds canvas");
      // Inspect nested coded dimensions too, not just the animation envelope.
      const header = Buffer.alloc(12); header.write("RIFF"); header.writeUInt32LE(length - 16 + 4, 4); header.write("WEBP", 8);
      webpDimensions(Buffer.concat([header, bytes.subarray(start + 16, start + length)]), limits, true);
    }
    // Canvas and coded-image dimensions are independently bounded. Do not
    // impose equality: extended metadata/animation may describe a canvas.
    if (next && !result) result = next;
    offset = start + length + (length & 1);
  }
  if (!result) invalid("WebP snapshot has no dimensions");
  return result;
}
function bmpDimensions(bytes, limits) {
  if (ascii(bytes, 0, 2) !== "BM") invalid("Expected BMP snapshot");
  need(bytes, 0, 26);
  const size = bytes.readUInt32LE(14);
  if (size === 12) return dimensions(bytes.readUInt16LE(18), bytes.readUInt16LE(20), limits);
  if (size < 40 || size > 124) invalid("Unsupported BMP header");
  need(bytes, 14, size);
  return dimensions(bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22)), limits);
}
const readers = { "image/png": pngDimensions, "image/jpeg": jpegDimensions, "image/gif": gifDimensions, "image/webp": webpDimensions, "image/bmp": bmpDimensions };

/** Normalize an immutable standard Pi ImageContent snapshot for local Kitty f=100.
 * Supply convertToPng imported from @earendil-works/pi-coding-agent (public root).
 * Cancellation is cooperative: the host's synchronous WASM decode is NOT preemptible.
 */
export async function normalizeAttachment(attachment, { convertToPng, limits: overrides = {}, signal } = {}) {
  signal?.throwIfAborted();
  // Capture primitives before the first await; never retain the caller's mutable object.
  const { type, data, mimeType } = attachment ?? {};
  if (type !== "image" || !NORMALIZE_MIME_TYPES.includes(mimeType)) invalid("Unsupported standard Pi image attachment");
  const limits = { ...DEFAULT_NORMALIZE_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_NORMALIZE_LIMITS) || !Number.isSafeInteger(value) || value < 1) invalid("Invalid normalization limits");
  }
  const bytes = decodeBase64(data, limits.maxInputBytes);
  readers[mimeType](bytes, limits); // reject dimensions before host decoder allocation
  let pngBytes = mimeType === "image/png" ? pngStill(bytes) : bytes;
  if (mimeType !== "image/png") {
    if (typeof convertToPng !== "function") invalid("Pi's public convertToPng is required for non-PNG snapshots");
    const result = await convertToPng(data, mimeType);
    signal?.throwIfAborted();
    if (!result || result.mimeType !== "image/png") invalid("Pi could not normalize this image snapshot to PNG");
    pngBytes = decodeBase64(result.data, limits.maxOutputBytes);
  }
  signal?.throwIfAborted();
  if (pngBytes.length > limits.maxOutputBytes) invalid("PNG bytes exceed local normalization limit");
  const { width, height } = pngDimensions(pngBytes, limits);
  return { pngBytes, width, height, sourceMimeType: mimeType, inputBytes: bytes.length, outputBytes: pngBytes.length };
}
