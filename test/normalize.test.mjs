import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAttachment, DEFAULT_NORMALIZE_LIMITS, NORMALIZE_MIME_TYPES } from "../src/normalize.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, payload) {
  const header = Buffer.alloc(8); header.writeUInt32BE(payload.length); header.write(type, 4);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), payload])));
  return Buffer.concat([header, payload, checksum]);
}
function png(width = 1, height = 1, extra = []) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), ...extra,
    chunk("IDAT", deflateSync(Buffer.from([0,255,0,0,255]))), chunk("IEND", Buffer.alloc(0))]);
}
function attachment(bytes, mimeType = "image/png") { return { type: "image", data: bytes.toString("base64"), mimeType }; }
const PNG = png();
const GIF_FRAME = Buffer.from([44,0,0,0,0,1,0,1,0,0,2,2,68,1,0]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.from([1,0,1,0,128,0,0,255,0,0,0,255,0]), GIF_FRAME, Buffer.from([59])]);
const secondFrame = Buffer.from(GIF_FRAME); secondFrame[12] = 76;
const ANIMATED_GIF = Buffer.concat([GIF.subarray(0, -1), secondFrame, Buffer.from([59])]);
const WEBP = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
const LOSSLESS_WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=", "base64");
function riffChunk(type, bytes) {
  const header = Buffer.alloc(8); header.write(type); header.writeUInt32LE(bytes.length, 4);
  return Buffer.concat([header, bytes, Buffer.alloc(bytes.length & 1)]);
}
function animatedWebp() {
  const extended = Buffer.alloc(10); extended[0] = 2;
  const frame = Buffer.alloc(16); frame.writeUIntLE(100, 12, 3);
  const payload = Buffer.concat([Buffer.from("WEBP"), riffChunk("VP8X", extended), riffChunk("ANIM", Buffer.alloc(6)),
    riffChunk("ANMF", Buffer.concat([frame, WEBP.subarray(12)])), riffChunk("ANMF", Buffer.concat([frame, WEBP.subarray(12)]))]);
  const header = Buffer.alloc(8); header.write("RIFF"); header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}
function extendedLosslessWebp(width = 1) {
  const extended = Buffer.alloc(10); extended.writeUIntLE(width - 1,4,3);
  const payload = Buffer.concat([Buffer.from("WEBP"),riffChunk("VP8X",extended),LOSSLESS_WEBP.subarray(12)]);
  const header = Buffer.alloc(8); header.write("RIFF"); header.writeUInt32LE(payload.length,4);
  return Buffer.concat([header,payload]);
}
function animatedPng() {
  const control = Buffer.alloc(8); control.writeUInt32BE(2);
  const frame = Buffer.alloc(26); frame.writeUInt32BE(1,4); frame.writeUInt32BE(1,8);
  const second = Buffer.from(frame); second.writeUInt32BE(1);
  const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
  return Buffer.concat([PNG.subarray(0,33),chunk("acTL",control),chunk("fcTL",frame),PNG.subarray(33,-12),
    chunk("fcTL",second),chunk("fdAT",Buffer.concat([sequence,deflateSync(Buffer.from([0,0,255,0,255]))])),PNG.subarray(-12)]);
}
function bmp() {
  const bytes = Buffer.alloc(62); bytes.write("BM"); bytes.writeUInt32LE(62, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(2, 18); bytes.writeInt32LE(1, 22);
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(8, 34);
  bytes[56] = 255; bytes[58] = 255;
  return bytes;
}
// Synthetic 2x1 red/green JPEG, generated in a disposable fixture environment.
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRQBAwQEBQQFCQUFCRQNCw0UFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFP/AABEIAAEAAgMBEQACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AOi8Gf8AIn6F/wBeEH/ota/i3Hf73V/xS/Nn8YeKP/Je5/8A9hmJ/wDT0z//2Q==", "base64");
const fixtures = [[PNG,"image/png",1], [JPEG,"image/jpeg",2], [GIF,"image/gif",1], [ANIMATED_GIF,"image/gif",1],
  [WEBP,"image/webp",1], [LOSSLESS_WEBP,"image/webp",1], [extendedLosslessWebp(),"image/webp",1], [animatedWebp(),"image/webp",1], [bmp(),"image/bmp",2]];

test("PNG snapshot is byte-identical, independent of original path and model setting", async () => {
  const image = Object.freeze({ ...attachment(PNG), path: "/deleted.png", blockImages: true });
  const result = await normalizeAttachment(image, { convertToPng() { assert.fail("PNG must not convert"); } });
  assert.deepEqual(result, { pngBytes: PNG, width: 1, height: 1, sourceMimeType: "image/png", inputBytes: PNG.length, outputBytes: PNG.length });
  result.pngBytes[0] = 0;
  assert.equal(image.data, PNG.toString("base64"));
});
test("all advertised input headers are bounded before the injected public converter", async () => {
  assert.deepEqual(NORMALIZE_MIME_TYPES, ["image/png","image/jpeg","image/gif","image/webp","image/bmp"]);
  for (const [bytes,mimeType] of fixtures) {
    let calls = 0;
    const image = Object.freeze(attachment(bytes,mimeType));
    const before = JSON.stringify(image);
    const result = await normalizeAttachment(image, { convertToPng(data,mime) {
      calls++; assert.equal(data,image.data); assert.equal(mime,mimeType); return attachment(PNG);
    }});
    assert.equal(calls, mimeType === "image/png" ? 0 : 1);
    assert.deepEqual(result.pngBytes, PNG);
    assert.equal(JSON.stringify(image), before);
    if (bytes === JPEG || mimeType === "image/bmp") {
      await assert.rejects(normalizeAttachment(image, { limits: { maxPixels: 1, maxDimension: 1 }, convertToPng() { assert.fail("over-limit images must not decode"); } }), /dimensions/);
    }
  }
});
test("APNG snapshot becomes its default still PNG without decoding or model mutation", async () => {
  const bytes = animatedPng(); const image = Object.freeze(attachment(bytes));
  const result = await normalizeAttachment(image,{convertToPng() { assert.fail("default IDAT needs no decoder"); }});
  assert.deepEqual(result.pngBytes,PNG);
  assert.equal(result.inputBytes,bytes.length); assert.equal(result.outputBytes,PNG.length);
  assert.equal(image.data,bytes.toString("base64"));
});
test("WebP canvas and coded dimensions are separately bounded, not forced equal", async () => {
  let calls = 0;
  await normalizeAttachment(attachment(extendedLosslessWebp(2),"image/webp"),{convertToPng() { calls++; return attachment(PNG); }});
  assert.equal(calls,1);
  await assert.rejects(normalizeAttachment(attachment(extendedLosslessWebp(8193),"image/webp"),{convertToPng() { assert.fail("oversize canvas must not decode"); }}),/dimensions/);
});
test("captured attachment primitives do not change while awaiting conversion", async () => {
  const image = attachment(GIF,"image/gif"); let resolve;
  const promise = normalizeAttachment(image, { convertToPng: () => new Promise(r => { resolve = r; }) });
  image.data = "changed"; image.mimeType = "image/png";
  resolve(attachment(PNG));
  assert.equal((await promise).sourceMimeType,"image/gif");
});
test("input and output byte ceilings, dimension and pixel ceilings", async () => {
  await assert.rejects(normalizeAttachment(attachment(PNG), { limits: { maxInputBytes: PNG.length - 1 } }), /bytes exceed/);
  await assert.rejects(normalizeAttachment(attachment(PNG), { limits: { maxOutputBytes: PNG.length - 1 } }), /bytes exceed/);
  for (const bytes of [png(8193,1), png(8192,8192)]) {
    await assert.rejects(normalizeAttachment(attachment(bytes)), /dimensions exceed/);
  }
  let calls = 0;
  const largeGif = Buffer.from(GIF); largeGif.writeUInt16LE(8193,6);
  await assert.rejects(normalizeAttachment(attachment(largeGif,"image/gif"), { convertToPng() { calls++; } }), /dimensions exceed/);
  assert.equal(calls,0);
  await assert.rejects(normalizeAttachment(attachment(GIF,"image/gif"), { convertToPng: () => attachment(png(8193,1)) }), /dimensions exceed/);
  assert.equal(Object.isFrozen(DEFAULT_NORMALIZE_LIMITS), true);
});
test("reject missing images, MIME mismatches, malformed base64 and invalid limits", async () => {
  for (const image of [null, {}, {type:"text"}, attachment(PNG,"image/svg+xml"), attachment(PNG,"image/jpeg")]) {
    await assert.rejects(normalizeAttachment(image));
  }
  for (const data of ["", "Zg", "Zg=", "Zg==\n", "Zh==", "!!!!", "AAAA===="]) {
    await assert.rejects(normalizeAttachment({type:"image",mimeType:"image/png",data}));
  }
  for (const limits of [{maxPixels:0},{maxDimension:NaN},{maxInputBytes:Infinity},{surprise:1}]) {
    await assert.rejects(normalizeAttachment(attachment(PNG),{limits}), /Invalid normalization limits/);
  }
});
test("truncated and hostile headers never enter the converter", async () => {
  let calls = 0;
  for (const [bytes,mimeType] of fixtures) {
    for (let length = 1; length < Math.min(bytes.length, 32); length++) {
      await assert.rejects(normalizeAttachment(attachment(bytes.subarray(0,length),mimeType), { convertToPng() { calls++; return null; } }));
    }
  }
  const wrongGif = Buffer.from(GIF); wrongGif.writeUInt16LE(2,25);
  const wrongWebp = Buffer.from(WEBP); wrongWebp.writeUInt32LE(0xffffffff,16);
  for (const image of [attachment(wrongGif,"image/gif"), attachment(wrongWebp,"image/webp")]) {
    await assert.rejects(normalizeAttachment(image,{convertToPng() { calls++; return null; }}));
  }
  assert.equal(calls,0);
});
test("decoder absence/failure and invalid converter output are explicit errors", async () => {
  const image = attachment(GIF,"image/gif");
  await assert.rejects(normalizeAttachment(image),/public convertToPng/);
  for (const result of [null,attachment(GIF,"image/gif"),attachment(GIF),{data:"!!!",mimeType:"image/png"}]) {
    await assert.rejects(normalizeAttachment(image,{convertToPng: () => result}));
  }
  await assert.rejects(normalizeAttachment(image,{convertToPng() { throw new Error("host failed"); }}),/host failed/);
});
test("cooperative cancellation before and after the host conversion", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(normalizeAttachment(attachment(PNG),{signal:controller.signal}),{name:"AbortError"});
  const during = new AbortController();
  await assert.rejects(normalizeAttachment(attachment(GIF,"image/gif"),{signal:during.signal,convertToPng() {
    during.abort(); return attachment(PNG);
  }}),{name:"AbortError"});
});

// Optional actual-host check. Set to the package ROOT entry's file URL; no private
// modules, network calls, provider requests or added runtime/test dependencies.
test("actual installed Pi public convertToPng format parity and animated still frame", { skip: !process.env.PI_IMAGE_HOST_MODULE }, async () => {
  const { convertToPng } = await import(process.env.PI_IMAGE_HOST_MODULE);
  assert.equal(typeof convertToPng,"function");
  for (const [bytes,mimeType,width] of fixtures) {
    const image = Object.freeze(attachment(bytes,mimeType)); const before = JSON.stringify(image);
    const result = await normalizeAttachment(image,{convertToPng});
    assert.equal(result.width,width); assert.equal(result.height,1);
    assert.equal(JSON.stringify(image),before);
    assert.ok(result.pngBytes.subarray(1,4).equals(Buffer.from("PNG")));
  }
  const first = await normalizeAttachment(attachment(GIF,"image/gif"),{convertToPng});
  const animated = await normalizeAttachment(attachment(ANIMATED_GIF,"image/gif"),{convertToPng});
  assert.deepEqual(animated.pngBytes,first.pngBytes,"host selects first GIF frame, not last green frame");
  // Photon emits an unfiltered RGBA row for this small fixture.
  const idat = first.pngBytes.indexOf(Buffer.from("IDAT"));
  const size = first.pngBytes.readUInt32BE(idat - 4);
  assert.deepEqual(inflateSync(first.pngBytes.subarray(idat + 4,idat + 4 + size)),Buffer.from([0,255,0,0,255]));
  const still = await normalizeAttachment(attachment(WEBP,"image/webp"),{convertToPng});
  const animatedStill = await normalizeAttachment(attachment(animatedWebp(),"image/webp"),{convertToPng});
  assert.deepEqual(animatedStill.pngBytes,still.pngBytes);
});

test("actual Pi read attachments survive deleted source files, including BMP normalization", { skip: !process.env.PI_IMAGE_HOST_MODULE }, async () => {
  const { createReadTool, convertToPng } = await import(process.env.PI_IMAGE_HOST_MODULE);
  const scratch = await mkdtemp(join(tmpdir(),"pi-normalize-read-"));
  try {
    for (const [index,[bytes,mimeType,width]] of fixtures.entries()) {
      const path = join(scratch,`${index}.${mimeType.split("/")[1]}`);
      await writeFile(path,bytes);
      const result = await createReadTool(scratch).execute(`normalize-${index}`,{path});
      await rm(path);
      const image = result.content.find(block => block.type === "image");
      assert.ok(image,`Pi read must attach ${mimeType}`);
      if (mimeType === "image/bmp") assert.equal(image.mimeType,"image/png");
      const before = JSON.stringify(result);
      const normalized = await normalizeAttachment(image,{convertToPng});
      assert.equal(normalized.width,width); assert.equal(normalized.height,1);
      assert.equal(JSON.stringify(result),before);
    }
  } finally { await rm(scratch,{recursive:true,force:true}); }
});
