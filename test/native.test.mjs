import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { captureLayout, createNativeRenderer, fitGeometry, NATIVE_SCHEMA, readLegacyDetails, readNativeDetails, sanitizeDisplayText } from "../src/native.mjs";
import { GraphicsIdentityRegistry } from "../src/identity.mjs";
import { GraphicsMetrics } from "../src/metrics.mjs";
import { createPresentation } from "../src/presentation.mjs";
import { DIACRITICS, PLACEHOLDER } from "../src/kitty.mjs";

const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const attachment = { type: "image", mimeType: "image/png", data };
const geometry = { columns: 2, rows: 1, cellWidthPx: 10, cellHeightPx: 20 };
const fresh = () => { let id = 0; return createNativeRenderer({ identity: new GraphicsIdentityRegistry({ random: () => ++id }) }); };
const job = (occurrence = "one", size = geometry) => ({ attachment, occurrence, geometry: size });
const settle = () => new Promise((resolve) => setImmediate(resolve));

const hostRoot = process.env.PI_TEST_HOST_ROOT;
const hostTui = hostRoot ? await import(pathToFileURL(join(hostRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")).href) : undefined;

test("actual public Pi clipping preserves independent row/column marks and both ID colors", {
  skip: !hostTui && "set PI_TEST_HOST_ROOT for native placeholder clipping",
}, async () => {
  const native = fresh();
  const prepared = await native.prepare(job("one", { ...geometry, columns: 3, rows: 3 }), { epoch: Symbol() });
  prepared.onUploaded();
  // Simulate a partially visible image: top rows and the leftmost column are gone.
  const clipped = hostTui.sliceByColumn(prepared.lines[2], 1, 1, true);
  assert.equal(hostTui.visibleWidth(clipped), 1);
  assert.ok(clipped.includes("\x1b[38;2;0;0;1m"));
  assert.ok(clipped.includes("\x1b[58:2::0:0:2m"));
  assert.ok(clipped.includes(PLACEHOLDER + DIACRITICS[2] + DIACRITICS[1] + DIACRITICS[0]));
  assert.equal(clipped.includes("Ptmux;"), false);
});

test("live geometry aspect fits supported cell pixels within 60x24", () => {
  assert.deepEqual(fitGeometry({ width: 100, height: 100 }, { columns: 100, rows: 100 }, { widthPx: 10, heightPx: 20 }),
    { columns: 48, rows: 24, cellWidthPx: 10, cellHeightPx: 20 });
  const wide = fitGeometry({ width: 1000, height: 100 }, { columns: 20, rows: 10 }, { widthPx: 10, heightPx: 20 });
  assert.equal(wide.columns, 20); assert.equal(wide.rows, 1);
  const tall = fitGeometry({ width: 1, height: 1000 }, { columns: 20, rows: 10 }, { widthPx: 10, heightPx: 20 });
  assert.equal(tall.columns, 1); assert.equal(tall.rows, 10);
  assert.throws(() => fitGeometry({ width: 0, height: 1 }, { columns: 1, rows: 1 }, { widthPx: 10, heightPx: 20 }), /Invalid width/);
});

test("captured layout keys include usable height and cell pixels, not just width", () => {
  const cells = { widthPx: 10, heightPx: 20 };
  const original = captureLayout(80, 40, cells);
  assert.deepEqual(original.limits, { columns: 60, rows: 24 });
  assert.deepEqual(captureLayout(5, 10, cells).limits, { columns: 5, rows: 2 });
  assert.deepEqual(captureLayout(1, 1, cells).limits, { columns: 1, rows: 1 });
  assert.notEqual(captureLayout(80, 20, cells).key, original.key);
  assert.notEqual(captureLayout(80, 40, { widthPx: 11, heightPx: 20 }).key, original.key);
  assert.notEqual(captureLayout(80, 40, { widthPx: 10, heightPx: 21 }).key, original.key);
  assert.equal(captureLayout(100, 50, cells).key, original.key, "same capped geometry does not need new preparation");
  cells.widthPx = 100;
  assert.equal(original.cells.widthPx, 10, "layout captured atomically before async work");
});

test("legacy details migrate metadata only, with unknown/malformed schema fail closed", () => {
  const legacy = { label: "deleted.pdf\npage 1", columns: 40, lines: ["OLD ESC bytes"], outputBytes: 123 };
  const before = structuredClone(legacy);
  assert.deepEqual(readLegacyDetails(legacy, "runtime-occurrence"), { label: "deleted.pdf page 1", occurrence: "runtime-occurrence" });
  assert.deepEqual(legacy, before);
  assert.equal(readLegacyDetails({ ...legacy, schema: "future" }, "id"), undefined);
  assert.equal(readLegacyDetails({ ...legacy, lines: undefined }, "id"), undefined);
  assert.equal(readLegacyDetails({ ...legacy, columns: 0 }, "id"), undefined);
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

test("live height/cell geometry creates new placements without decoding or PNG retransmit", async () => {
  const native = fresh(), epoch = Symbol("connection");
  const original = await native.normalize(attachment);
  const prepare = (layout) => native.prepare({ attachment, occurrence: "one", ...layout }, { epoch });
  const first = await prepare(captureLayout(50, 40, { widthPx: 10, heightPx: 20 }));
  first.onUploaded();
  const short = await prepare(captureLayout(50, 12, { widthPx: 10, heightPx: 20 }));
  assert.ok(short.geometry.rows < first.geometry.rows);
  assert.equal(short.uploads.includes("a=t"), false); short.onUploaded();
  const changedCells = await prepare(captureLayout(50, 12, { widthPx: 10, heightPx: 10 }));
  assert.notEqual(changedCells.lines[0], short.lines[0]);
  assert.equal(changedCells.uploads.includes("a=t"), false); changedCells.onUploaded();
  assert.equal(await native.normalize({ ...attachment }), original);
  const restored = await prepare(captureLayout(50, 40, { widthPx: 10, heightPx: 20 }));
  assert.equal(restored.uploads, ""); assert.deepEqual(restored.lines, first.lines); restored.onUploaded();
});

// Tiny protocol-semantic terminal: a=t replaces image data AND erases all of
// that image's virtual prototypes, per Kitty spec. Quiet writes are simulated,
// never sent to a terminal. This checks lifecycle semantics, not just strings.
function virtualTerminal() {
  const images = new Map();
  let transmissions = 0;
  return {
    images,
    get transmissions() { return transmissions; },
    write(wire) {
      for (const match of wire.matchAll(/\x1b\x1b_G([^;\x1b]*)(?:;[^\x1b]*)?\x1b\x1b\\/g)) {
        const controls = Object.fromEntries(match[1].split(",").map((part) => part.split("=")));
        if (controls.a === "t") {
          transmissions++;
          images.set(Number(controls.i), new Map()); // destroys old prototypes
        } else if (controls.a === "p") {
          const imageId = Number(controls.i);
          assert.ok(images.has(imageId), "placement preceded image data");
          assert.equal(controls.U, "1");
          images.get(imageId).set(Number(controls.p), { columns: Number(controls.c), rows: Number(controls.r) });
        } else if (controls.a === "d") {
          assert.equal(controls.d, "i", "private retirement must not delete pixels or globally delete");
          assert.ok(Number(controls.p) > 0, "retirement must be placement scoped");
          images.get(Number(controls.i))?.delete(Number(controls.p));
        }
      }
    },
  };
}

test("same-ID refresh restores all committed occurrence/geometry prototypes after a=t clears them", async () => {
  const native = fresh(), terminal = virtualTerminal(), epoch = Symbol("original");
  const a = await native.prepare(job("one", { ...geometry, columns: 4 }), { epoch });
  terminal.write(a.uploads); a.onUploaded();
  const b = await native.prepare(job("one", { ...geometry, columns: 2 }), { epoch });
  terminal.write(b.uploads); b.onUploaded();
  const anotherOccurrence = await native.prepare(job("two", { ...geometry, columns: 1 }), { epoch });
  terminal.write(anotherOccurrence.uploads); anotherOccurrence.onUploaded();
  const retained = structuredClone(terminal.images.get(1));
  assert.equal(retained.size, 3);
  assert.equal(terminal.transmissions, 1);
  const refreshEpoch = Symbol("refresh");
  const refreshed = await native.prepare(job("one", { ...geometry, columns: 2 }), { epoch: refreshEpoch });
  assert.equal(refreshed.metrics.uploadChunks, 1, "prototype commands are not PNG chunks");
  assert.equal(refreshed.metrics.placementCommands, 3);
  terminal.write(refreshed.uploads); refreshed.onUploaded();
  assert.equal(terminal.transmissions, 2, "one payload upload for each epoch, not one per restored prototype");
  assert.deepEqual(terminal.images.get(1), retained, "old scrollback and current prototype IDs restored unchanged");
  assert.deepEqual(refreshed.lines, b.lines);
  const oldGeometry = await native.prepare(job("one", { ...geometry, columns: 4 }), { epoch: refreshEpoch });
  assert.equal(oldGeometry.uploads, "", "all restored prototypes are marked resident, not just current geometry");
  oldGeometry.onUploaded();
});

test("failed/cancelled prototypes never become historical replay candidates", async () => {
  const native = fresh(), epoch = Symbol("original");
  const good = await native.prepare(job("one"), { epoch }); good.onUploaded();
  const failed = await native.prepare(job("two"), { epoch }); failed.onUploadFailed();
  const refresh = await native.prepare(job("one"), { epoch: Symbol("refresh") });
  assert.equal(refresh.metrics.placementCommands, 1);
  const terminal = virtualTerminal(); terminal.write(refresh.uploads); refresh.onUploaded();
  assert.equal(terminal.images.get(1).size, 1);
});

test("integrated metrics separate normalization from successful wire and preserve cumulative totals across epochs", async () => {
  const native = fresh(), epoch = Symbol("first");
  await native.describe(attachment, { columns: 60, rows: 24 }, { widthPx: 10, heightPx: 20 });
  let stats = native.stats(epoch);
  assert.equal(stats.normalization.payloads, 1);
  assert.equal(stats.normalization.pngBytes, Buffer.from(data, "base64").length);
  assert.equal(stats.normalization.estimatedRgbaBytes, 4);
  assert.equal(stats.resident.imageIds, 0);
  const first = await native.prepare(job(), { epoch });
  assert.equal(native.stats().transfer.wireBytes, 0, "preparation is not a write");
  first.onUploadFailed();
  assert.equal(native.stats().transfer.successfulCommits, 0);
  const retry = await native.prepare(job(), { epoch }); retry.onUploaded();
  stats = native.stats();
  assert.equal(stats.resident.imageIds, 1); assert.equal(stats.placements.geometryVersions, 1);
  assert.equal(stats.transfer.wireBytes, Buffer.byteLength(retry.uploads));
  assert.equal(stats.transfer.uploadChunks, retry.metrics.uploadChunks);
  assert.equal(stats.transfer.placementCommands, 1);
  assert.equal(stats.transfer.successfulCommits, 1);
  assert.equal(stats.scope.terminalAcknowledged, false); assert.equal(stats.scope.evictionEnabled, false);
  assert.equal(stats.accounting.errors, 0);
  const reuse = await native.prepare(job(), { epoch }); reuse.onUploaded();
  assert.deepEqual(native.stats().transfer, stats.transfer, "zero-byte reuse is not an actual transport commit");
  const geometryB = await native.prepare(job("one", { ...geometry, columns: 1 }), { epoch }); geometryB.onUploaded();
  const total = native.stats().runtimeTransfer;
  assert.equal(total.uploadChunks, retry.metrics.uploadChunks);
  assert.equal(total.placementCommands, 2);
  const refreshEpoch = Symbol("refresh");
  stats = native.stats(refreshEpoch);
  assert.equal(stats.resident.imageIds, 0); assert.equal(stats.placements.geometryVersions, 0);
  assert.equal(stats.normalization.payloads, 1); assert.deepEqual(stats.runtimeTransfer, total);
  const restored = await native.prepare(job("one", { ...geometry, columns: 1 }), { epoch: refreshEpoch }); restored.onUploaded();
  stats = native.stats();
  assert.equal(stats.resident.imageIds, 1); assert.equal(stats.placements.geometryVersions, 2);
  assert.equal(stats.transfer.wireBytes, Buffer.byteLength(restored.uploads));
  assert.equal(stats.transfer.placementCommands, 2, "all replayed prototypes counted once in the batch");
  assert.equal(stats.runtimeTransfer.wireBytes, total.wireBytes + Buffer.byteLength(restored.uploads));
});

test("metrics ignores aborted/stale completions and failed writes even when PNG preparation succeeded", async () => {
  const native = fresh(), controller = new AbortController();
  const old = await native.prepare(job(), { epoch: Symbol("old"), signal: controller.signal });
  controller.abort(); old.onUploaded();
  assert.equal(native.stats().transfer.successfulCommits, 0);
  assert.equal(native.stats().normalization.payloads, 1);
  const epoch = Symbol("replacement");
  const next = await native.prepare(job(), { epoch }); next.onUploadFailed();
  assert.equal(native.stats().transfer.wireBytes, 0);
  assert.equal(native.stats().resident.imageIds, 0);
});

test("accounting exceptions after actual writes never poison rendered cells, residency or shared upload queue", async () => {
  class ThrowingMetrics extends GraphicsMetrics {
    recordTransport() { throw new Error("injected accounting fault"); }
  }
  let id = 0;
  const native = createNativeRenderer({ identity: new GraphicsIdentityRegistry({ random: () => ++id }), metrics: new ThrowingMetrics() });
  const presentation = createPresentation();
  const writes = [];
  const ctx = { mode: "tui", ui: { setWidget(_key, factory) { factory({ terminal: { write(bytes) { writes.push(bytes); } }, requestRender() {} }); } } };
  presentation.attach(ctx, true);
  const component = presentation.component({ key: "one", prepare: (_width, context) => native.prepare(job(), context), fallback: () => ["loading"] });
  component.render(10); await settle();
  assert.ok(component.render(10).some((line) => line.includes(PLACEHOLDER)));
  assert.equal(writes.length, 1);
  const epoch = presentation.epoch;
  const reuse = await native.prepare(job(), { epoch });
  assert.equal(reuse.uploads, "", "accounting failure did not erase committed native residency"); reuse.onUploaded();
  const second = await native.prepare(job("two"), { epoch });
  assert.equal(second.uploads.includes("a=t"), false, "accounting exception released serialized queue"); second.onUploaded();
  const stats = native.stats(epoch);
  assert.equal(stats.accounting.errors, 2); assert.equal(stats.accounting.lastError, "injected accounting fault");
  assert.equal(stats.accounting.unavailable, false);
  presentation.disconnect();
});

test("diagnostic failure is explicit without breaking normalization or upload completion", async () => {
  const native = createNativeRenderer({ metrics: {
    beginEpoch() { throw new Error("epoch accounting fault"); },
    recordNormalization() { throw new Error("normalization accounting fault"); },
    recordTransport() { throw new Error("transport accounting fault"); },
    snapshot() { throw new Error("snapshot accounting fault"); },
  } });
  const prepared = await native.prepare(job(), { epoch: Symbol() });
  assert.doesNotThrow(() => prepared.onUploaded());
  const stats = native.stats();
  assert.equal(stats.accounting.unavailable, true);
  assert.equal(stats.scope.evictionEnabled, false);
  assert.equal(stats.scope.terminalAcknowledged, false);
  assert.equal(stats.accounting.errors, 4);
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

const canvas = { columns: 4, rows: 3, cellWidthPx: 10, cellHeightPx: 20 };
const window = { columns: 2, rows: 1, columnOffset: 1, rowOffset: 1 };
const viewerJob = (lease, overrides = {}) => ({ lease, canvas, window, ...overrides });
async function openViewer(native, occurrence = "page") {
  const payload = await native.resolvePayload(attachment);
  return native.reserveViewerPlacement({ payload, occurrence });
}

test("production viewer shares inline PNG identity, distinct fixed slot, pan cells and zoom replacement", async () => {
  const native = fresh(), terminal = virtualTerminal(), epoch = Symbol();
  const inline = await native.prepare(job(), { epoch }); terminal.write(inline.uploads); inline.onUploaded();
  const payload = await native.resolvePayload({ ...attachment });
  assert.equal(payload.imageId, 1); assert.equal(await native.resolvePayload(attachment), payload);
  const lease = native.reserveViewerPlacement({ payload, occurrence: "page" });
  assert.notEqual(lease.placementId, 2);
  const first = await native.prepareViewer(viewerJob(lease), { epoch });
  assert.equal(first.metrics.uploadChunks, 0);
  terminal.write(first.uploads); first.onUploaded();
  const totals = native.stats().transfer;
  const pan = await native.prepareViewer(viewerJob(lease, { window: { ...window, columnOffset: 2 } }), { epoch });
  assert.equal(pan.uploads, ""); assert.notDeepEqual(pan.lines, first.lines);
  assert.ok(pan.lines[0].includes(PLACEHOLDER + DIACRITICS[1] + DIACRITICS[2])); pan.onUploaded();
  assert.deepEqual(native.stats().transfer, totals);
  const zoom = await native.prepareViewer(viewerJob(lease, { canvas: { ...canvas, columns: 5 } }), { epoch });
  assert.equal(zoom.metrics.uploadChunks, 0); assert.equal(zoom.metrics.placementCommands, 1);
  terminal.write(zoom.uploads); zoom.onUploaded();
  assert.equal(terminal.images.get(1).size, 2, "zoom overwrote private pair, not inline history");
  assert.deepEqual(terminal.images.get(1).get(2), { columns: 2, rows: 1 });
  assert.equal(native.stats().surfaceTransfer.replacementCommands, 1);
  assert.equal(native.stats().accounting.errors, 0);
});

test("production 10,000 pan/zoom/open cycles bound allocator, viewer prototypes and metrics", async () => {
  const native = fresh(), epoch = Symbol();
  const inline = await native.prepare(job(), { epoch }); inline.onUploaded();
  const payload = await native.resolvePayload(attachment);
  let lease = native.reserveViewerPlacement({ payload, occurrence: "page" });
  const baseline = native.stats().viewer.allocatedIds;
  for (let n = 0; n < 10000; n++) {
    const next = await native.prepareViewer(viewerJob(lease, { canvas: { ...canvas, columns: 4 + n % 2 },
      window: { ...window, columnOffset: n % 2 } }), { epoch }); next.onUploaded();
    if (n % 10 === 0) {
      native.releaseViewer(lease);
      const retire = await native.prepareViewerRetirement({ epoch }); retire.onUploaded();
      lease = native.reserveViewerPlacement({ payload, occurrence: "page" });
    }
  }
  const stats = native.stats();
  assert.equal(stats.viewer.allocatedIds, baseline);
  assert.equal(stats.placements.geometryVersions, 2); assert.equal(stats.surfaces.viewer, 1);
  assert.equal(stats.surfaces.liveViewer, 1); assert.equal(stats.transfer.uploadChunks, 1);
  assert.equal(stats.accounting.errors, 0);
  native.releaseViewer(lease); (await native.prepareViewerRetirement({ epoch })).onUploaded();
  assert.equal(native.stats().placements.geometryVersions, 1);
  assert.equal(native.stats().surfaces.viewer, 0);
});

test("shared epoch upload restores every inline grid and only the current live private canvas", async () => {
  const native = fresh(), epoch = Symbol(), terminal = virtualTerminal();
  for (const columns of [2, 3, 4]) {
    const p = await native.prepare(job("one", { ...geometry, columns }), { epoch }); terminal.write(p.uploads); p.onUploaded();
  }
  const lease = await openViewer(native), first = await native.prepareViewer(viewerJob(lease), { epoch });
  terminal.write(first.uploads); first.onUploaded();
  const retained = structuredClone(terminal.images.get(1));
  const replay = await native.prepare(job(), { epoch: Symbol("replay") });
  assert.equal(replay.metrics.placementCommands, 4); terminal.write(replay.uploads); replay.onUploaded();
  assert.deepEqual(terminal.images.get(1), retained);
  native.releaseViewer(lease);
  const closed = await native.prepare(job(), { epoch: Symbol("closed") });
  assert.equal(closed.metrics.placementCommands, 3); terminal.write(closed.uploads); closed.onUploaded();
  assert.equal(terminal.images.get(1).size, 3);
  assert.equal(native.stats().viewer.retirementPending, true, "epoch replay does not forget unresolved cleanup");
});

test("closing during captured inline replay prevents private resurrection and presentation retries current history", async () => {
  const native = fresh(), h = createPresentation(), writes = [];
  const tui = { terminal: { write(bytes) { writes.push(bytes); } }, requestRender() {} };
  h.attach({ mode: "tui", ui: { setWidget(_key, factory) { factory(tui); } } }, true);
  const lease = await openViewer(native);
  const first = await native.prepareViewer(viewerJob(lease), { epoch: h.epoch }); h.commit(first, { epoch: h.epoch });
  h.refresh();
  const prepared = await native.prepare(job(), { epoch: h.epoch });
  native.releaseViewer(lease);
  assert.equal(prepared.isCurrent(), false);
  const before = writes.length;
  assert.equal(h.commit(prepared, { epoch: h.epoch }), false); assert.equal(writes.length, before);
  const latest = await native.prepare(job(), { epoch: h.epoch });
  assert.equal(latest.metrics.placementCommands, 1);
  assert.equal(h.commit(latest, { epoch: h.epoch }), true);
  h.disconnect();
});

test("close immediately revokes pending viewer, safe lowercase retirement retains inline pixels", async () => {
  const native = fresh(), epoch = Symbol();
  const inline = await native.prepare(job(), { epoch }); inline.onUploaded();
  const payload = await native.resolvePayload(attachment), lease = native.reserveViewerPlacement({ payload, occurrence: "page" });
  const first = await native.prepareViewer(viewerJob(lease), { epoch }); first.onUploaded();
  const pending = await native.prepareViewer(viewerJob(lease, { canvas: { ...canvas, columns: 5 } }), { epoch });
  assert.equal(native.releaseViewer(lease), true); assert.equal(native.releaseViewer(lease), false);
  assert.equal(pending.isCurrent(), false); pending.onUploaded();
  assert.equal(native.stats().surfaces.liveViewer, 0);
  assert.throws(() => native.reserveViewerPlacement({ payload, occurrence: "other" }), /unresolved/);
  const failed = await native.prepareViewerRetirement({ epoch }); failed.onUploadFailed();
  assert.equal(native.stats().viewer.retirementPending, true);
  const retirement = await native.prepareViewerRetirement({ epoch: Symbol("reset") });
  assert.ok(retirement.uploads.includes(`a=d,d=i,i=${lease.imageId},p=${lease.placementId}`));
  assert.equal(retirement.uploads.includes("d=I"), false); assert.equal(retirement.uploads.includes("a=t"), false);
  retirement.onUploaded(); retirement.onUploaded();
  assert.equal(native.stats().viewer.retirementPending, false);
  assert.equal(native.stats().surfaceTransfer.retirementCommands, 1);
  const reopened = native.reserveViewerPlacement({ payload, occurrence: "reopened" });
  assert.equal(reopened.placementId, lease.placementId);
  assert.equal(native.releaseViewer(lease), false, "late old cleanup cannot close new lease");
});

test("viewer queue cancellation drains before rebind; inline successor cannot overtake held upload", async () => {
  const native = fresh(), epoch = Symbol();
  const payload = await native.resolvePayload(attachment), lease = native.reserveViewerPlacement({ payload, occurrence: "page" });
  const blocker = await native.prepare(job(), { epoch });
  const pending = native.prepareViewer(viewerJob(lease), { epoch });
  await settle();
  await assert.rejects(native.prepareViewer(viewerJob(lease), { epoch }), /already pending/);
  native.releaseViewer(lease);
  assert.throws(() => native.reserveViewerPlacement({ payload, occurrence: "new" }), /draining/);
  let finished = false;
  const inline = native.prepare(job("later"), { epoch }).then(p => { finished = true; return p; });
  await settle(); assert.equal(finished, false);
  blocker.onUploaded(); await assert.rejects(pending, /abort/i);
  const successor = await inline; assert.equal(successor.metrics.uploadChunks, 0); successor.onUploaded();
  const nextLease = native.reserveViewerPlacement({ payload, occurrence: "new" });
  assert.equal(nextLease.placementId, lease.placementId);
});

test("viewer preparation validation/failure and stale epochs never commit surfaces or strand queue", async () => {
  const native = fresh(), epoch = Symbol(), lease = await openViewer(native);
  await assert.rejects(native.prepareViewer(viewerJob(lease, { window: { ...window, columnOffset: 297 } }), { epoch }));
  const failed = await native.prepareViewer(viewerJob(lease), { epoch }); failed.onUploadFailed();
  assert.equal(native.stats().surfaces.viewer, 0);
  const stale = await native.prepareViewer(viewerJob(lease), { epoch });
  const inline = await native.prepare(job(), { epoch: Symbol("new") });
  stale.onUploaded(); inline.onUploaded();
  assert.equal(native.stats().surfaces.viewer, 0);
  native.releaseViewer(lease);
  assert.equal(native.stats().viewer.retirementPending, false, "uncommitted prototype never retained");
});

test("viewer accounting faults never break replacement, retirement or slot release", async () => {
  class Bad extends GraphicsMetrics {
    recordTransport() { throw new Error("bad transport accounting"); }
    recordViewerRelease() { throw new Error("bad release accounting"); }
    recordRetirement() { throw new Error("bad retirement accounting"); }
  }
  const native = createNativeRenderer({ metrics: new Bad() }), epoch = Symbol();
  const lease = await openViewer(native);
  (await native.prepareViewer(viewerJob(lease), { epoch })).onUploaded();
  const next = await native.prepareViewer(viewerJob(lease, { canvas: { ...canvas, columns: 5 } }), { epoch });
  assert.equal(next.metrics.uploadChunks, 0); next.onUploaded();
  assert.doesNotThrow(() => native.releaseViewer(lease));
  const retire = await native.prepareViewerRetirement({ epoch }); assert.doesNotThrow(() => retire.onUploaded());
  assert.equal(native.stats().viewer.retirementPending, false);
  assert.equal(native.stats().accounting.errors, 4);
  assert.ok(await openViewer(native, "again"));
});

function secondSnapshot() {
  // Add a valid ancillary text chunk: same pixels/dimensions, different exact PNG.
  const payload = Buffer.from("label\0other"), type = Buffer.from("tEXt");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, payload])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length); type.copy(chunk, 4); payload.copy(chunk, 8);
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, payload.length + 8);
  const png = Buffer.from(data, "base64");
  return { ...attachment, data: Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]).toString("base64") };
}

test("10,000 repeated opens across payloads reuse private allocator and delete only its proven tuple", async () => {
  const native = fresh(), epoch = Symbol(), terminal = virtualTerminal();
  const a = await native.resolvePayload(attachment), b = await native.resolvePayload(secondSnapshot());
  for (const [payload, snapshot] of [[a, attachment], [b, secondSnapshot()]]) {
    const inline = await native.prepare({ attachment: snapshot, occurrence: "inline", geometry }, { epoch });
    terminal.write(inline.uploads); inline.onUploaded();
    assert.equal(terminal.images.get(payload.imageId).size, 1);
  }
  let fixed;
  for (let n = 0; n < 10000; n++) {
    const payload = n % 2 ? a : b;
    const lease = native.reserveViewerPlacement({ payload, occurrence: `open:${n}` });
    fixed ??= lease.placementId; assert.equal(lease.placementId, fixed);
    const next = await native.prepareViewer(viewerJob(lease), { epoch });
    assert.equal(next.metrics.uploadChunks, 0); terminal.write(next.uploads); next.onUploaded();
    native.releaseViewer(lease);
    const retired = await native.prepareViewerRetirement({ epoch }); terminal.write(retired.uploads); retired.onUploaded();
    assert.equal(terminal.images.get(payload.imageId).size, 1);
  }
  const stats = native.stats();
  assert.equal(stats.viewer.allocatedIds, 5, "two payload+two inline IDs+one constant private slot");
  assert.equal(stats.surfaces.viewer, 0); assert.equal(stats.placements.geometryVersions, 2);
  assert.equal(stats.surfaceTransfer.retirementCommands, 10000); assert.equal(stats.transfer.uploadChunks, 2);
  assert.equal(stats.accounting.errors, 0);
  assert.equal(terminal.images.size, 2, "shared pixels survive every scoped retirement");
});

test("denied/partial retirement remains bounded across epoch and retry frees slot without invented residency", async () => {
  const native = fresh(), presentation = createPresentation(), writes = [];
  const tui = { terminal: { write(wire) { writes.push(wire); } }, requestRender() {} };
  presentation.attach({ mode: "tui", ui: { setWidget(_key, factory) { factory(tui); } } }, true);
  const payload = await native.resolvePayload(attachment), other = await native.resolvePayload(secondSnapshot());
  const lease = native.reserveViewerPlacement({ payload, occurrence: "page" });
  presentation.commit(await native.prepareViewer(viewerJob(lease), { epoch: presentation.epoch }), { epoch: presentation.epoch });
  native.releaseViewer(lease);
  const denied = await native.prepareViewerRetirement({ epoch: presentation.epoch });
  denied.onUploadFailed(new Error("post-preparation capability denied"));
  const before = writes.length;
  for (let n = 0; n < 10000; n++) assert.throws(() => native.reserveViewerPlacement({ payload: other, occurrence: "new" }), /unresolved/);
  assert.equal(writes.length, before);
  assert.ok(native.stats().viewer.retirementFailure.includes("denied"));
  presentation.refresh();
  const failed = await native.prepareViewerRetirement({ epoch: presentation.epoch });
  tui.terminal.write = () => { throw new Error("partial stream failure"); };
  assert.throws(() => presentation.commit(failed, { epoch: presentation.epoch }), /partial/);
  assert.equal(native.stats().viewer.retirementPending, true);
  assert.equal(native.stats().transfer.wireBytes, 0);
  assert.equal(native.stats().resident.imageIds, 0);
  tui.terminal.write = wire => writes.push(wire);
  const recovered = await native.prepareViewerRetirement({ epoch: presentation.epoch });
  assert.equal(presentation.commit(recovered, { epoch: presentation.epoch }), true);
  const stats = native.stats();
  assert.equal(stats.resident.imageIds, 0); assert.equal(stats.viewer.retirementPending, false);
  assert.equal(stats.viewer.retirementFailure, undefined);
  assert.equal(stats.transfer.wireBytes, Buffer.byteLength(recovered.uploads));
  assert.equal(stats.surfaceTransfer.retirementCommands, 1);
  assert.ok(native.reserveViewerPlacement({ payload: other, occurrence: "new" }));
  presentation.disconnect();
});

test("stale repeated viewer/retirement callbacks cannot clear a later pending slot or lease", async () => {
  const native = fresh(), epoch = Symbol(), payload = await native.resolvePayload(attachment);
  const oldLease = native.reserveViewerPlacement({ payload, occurrence: "old" });
  const old = await native.prepareViewer(viewerJob(oldLease), { epoch }); old.onUploaded();
  native.releaseViewer(oldLease);
  const retired = await native.prepareViewerRetirement({ epoch }); retired.onUploaded();
  const lease = native.reserveViewerPlacement({ payload, occurrence: "new" });
  const blocker = await native.prepare(job(), { epoch });
  const pending = native.prepareViewer(viewerJob(lease), { epoch }); await settle();
  old.onUploaded(); old.onUploadFailed(); retired.onUploaded(); retired.onUploadFailed();
  assert.equal(native.releaseViewer(oldLease), false);
  assert.equal(native.stats().viewer.leased, true); assert.equal(native.stats().viewer.pending, true);
  await assert.rejects(native.prepareViewer(viewerJob(lease), { epoch }), /already pending/);
  blocker.onUploaded(); const next = await pending; next.onUploaded();
  assert.equal(native.stats().viewer.livePrototype, true);
  assert.equal(native.stats().viewer.pending, false);
});

test("retirement no-op respects epoch/signal final guards and records no transport", async () => {
  const native = fresh(), epoch = Symbol(), controller = new AbortController();
  const empty = await native.prepareViewerRetirement({ epoch, signal: controller.signal });
  assert.equal(empty.uploads, ""); assert.equal(empty.isCurrent(), true);
  controller.abort(); assert.equal(empty.isCurrent(), false);
  const stale = await native.prepareViewerRetirement({ epoch });
  const next = await native.prepare(job(), { epoch: Symbol("replacement") }); next.onUploaded();
  assert.equal(stale.isCurrent(), false);
  assert.equal(native.stats().surfaceTransfer.retirementCommands, 0);
});
