import assert from "node:assert/strict";
import test from "node:test";
import { createNativeRenderer, fitInitialGeometry, NATIVE_SCHEMA, readNativeDetails, sanitizeDisplayText } from "../src/native.mjs";
import { GraphicsIdentityRegistry } from "../src/identity.mjs";
import { PLACEHOLDER } from "../src/kitty.mjs";

const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const attachment = { type: "image", mimeType: "image/png", data };
const geometry = { columns: 2, rows: 1, cellWidthPx: 10, cellHeightPx: 20 };
const fresh = () => { let id = 0; return createNativeRenderer({ identity: new GraphicsIdentityRegistry({ random: () => ++id }) }); };
const job = (occurrence = "one", size = geometry) => ({ attachment, occurrence, geometry: size });
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("fixed geometry aspect fits supported cell pixels within 60x24", () => {
  assert.deepEqual(fitInitialGeometry({ width: 100, height: 100 }, { columns: 100, rows: 100 }, { widthPx: 10, heightPx: 20 }),
    { columns: 48, rows: 24, cellWidthPx: 10, cellHeightPx: 20 });
  const wide = fitInitialGeometry({ width: 1000, height: 100 }, { columns: 20, rows: 10 }, { widthPx: 10, heightPx: 20 });
  assert.equal(wide.columns, 20); assert.equal(wide.rows, 1);
  const tall = fitInitialGeometry({ width: 1, height: 1000 }, { columns: 20, rows: 10 }, { widthPx: 10, heightPx: 20 });
  assert.equal(tall.columns, 1); assert.equal(tall.rows, 10);
  assert.throws(() => fitInitialGeometry({ width: 0, height: 1 }, { columns: 1, rows: 1 }, { widthPx: 10, heightPx: 20 }), /Invalid width/);
});

test("native schema persists only occurrence/label/geometry, rejecting legacy and malformed details", () => {
  assert.equal(readNativeDetails({ lines: ["old"], columns: 2 }), undefined);
  assert.equal(readNativeDetails({ schema: NATIVE_SCHEMA, occurrence: "one", label: "image", geometry: { columns: 61, rows: 1 } }), undefined);
  const details = { schema: NATIVE_SCHEMA, occurrence: "one", label: "image", geometry, data: "not copied", uploaded: true };
  assert.deepEqual(readNativeDetails(details), { schema: NATIVE_SCHEMA, occurrence: "one", label: "image", geometry });
  assert.equal(readNativeDetails({ ...details, schema: "future-v2" }), undefined);
  assert.equal(readNativeDetails({ ...details, geometry: null }), undefined);
  assert.equal(readNativeDetails({ ...details, label: "path\x1b[31m\npage\x9b" }).label, "path [31m page ");
  assert.equal(sanitizeDisplayText("label\r\n\x00\u2028"), "label    ");
});

test("snapshot normalization caches immutable bytes and failures do not poison retries", async () => {
  const native = fresh();
  const first = await native.normalize(attachment);
  assert.equal(await native.normalize({ ...attachment }), first);
  const metrics = await native.describe(attachment, { columns: 60, rows: 24 }, { widthPx: 10, heightPx: 20 });
  assert.equal(metrics.pngBytes, Buffer.from(data, "base64").length);
  assert.equal(metrics.uploadChunks, 1);
  await assert.rejects(native.normalize({ ...attachment, data: "broken" }));
  await assert.rejects(native.normalize({ ...attachment, data: "broken" }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(native.normalize(attachment, controller.signal), /abort/i);
});

test("residency commits only after successful write and keeps IDs/geometry stable", async () => {
  const native = fresh(), epoch = Symbol("connection");
  const first = await native.prepare(job(), { epoch });
  assert.ok(first.uploads.includes("a=t")); assert.ok(first.uploads.includes("U=1"));
  assert.ok(first.lines[0].includes(PLACEHOLDER));
  first.onUploadFailed(new Error("write failed"));
  const retry = await native.prepare(job(), { epoch });
  assert.equal(retry.uploads, first.uploads, "no residency mark before write");
  retry.onUploaded();
  const repaint = await native.prepare(job(), { epoch });
  assert.equal(repaint.uploads, ""); assert.deepEqual(repaint.lines, retry.lines);
  repaint.onUploaded();
  const occurrence = await native.prepare(job("two"), { epoch });
  assert.equal(occurrence.uploads.includes("a=t"), false); assert.ok(occurrence.uploads.includes("U=1"));
  assert.notEqual(occurrence.lines[0], repaint.lines[0], "occurrences have distinct placement IDs");
  occurrence.onUploaded();
  const resize = await native.prepare(job("one", { ...geometry, columns: 1 }), { epoch });
  assert.equal(resize.uploads.includes("a=t"), false); assert.ok(resize.uploads.includes("c=1"));
  resize.onUploaded();
});

test("concurrent occurrences share one payload upload per epoch", async () => {
  const native = fresh(), epoch = Symbol("connection");
  const first = await native.prepare(job("one"), { epoch });
  let completed = false;
  const pending = native.prepare(job("two"), { epoch }).then((prepared) => { completed = true; return prepared; });
  await settle(); assert.equal(completed, false);
  first.onUploaded();
  const second = await pending;
  assert.equal(second.uploads.includes("a=t"), false); second.onUploaded();
  const next = await native.prepare(job("one"), { epoch: Symbol("new connection") });
  assert.ok(next.uploads.includes("a=t"), "a new runtime connection cannot trust old residency");
  next.onUploaded();
});

test("cancelled queued job cannot let later jobs overtake an uncommitted payload", async () => {
  const native = fresh(), epoch = Symbol("connection");
  const first = await native.prepare(job("one"), { epoch });
  const controller = new AbortController();
  const cancelled = native.prepare(job("two"), { epoch, signal: controller.signal });
  await settle(); controller.abort();
  let completed = false;
  const third = native.prepare(job("three"), { epoch }).then((value) => { completed = true; return value; });
  await settle(); assert.equal(completed, false);
  first.onUploaded();
  await assert.rejects(cancelled, /abort/i);
  const prepared = await third;
  assert.equal(prepared.uploads.includes("a=t"), false); prepared.onUploaded();
});

test("aborted in-flight transport cannot mark residency after a replacement epoch", async () => {
  const native = fresh(), controller = new AbortController();
  const first = await native.prepare(job(), { epoch: Symbol("old"), signal: controller.signal });
  controller.abort();
  first.onUploaded();
  const next = await native.prepare(job(), { epoch: Symbol("new") });
  assert.ok(next.uploads.includes("a=t")); next.onUploaded();
});
