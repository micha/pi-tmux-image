import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, rm, stat, open, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { PDF_SCHEMA, PDF_KEEP_THRESHOLD, readPdfDetails, readPdfPreviewDetails, createPdfDocumentService } from "../src/pdf-document.mjs";

const geometry = { columns: 30, rows: 20, cellWidthPx: 8, cellHeightPx: 16 };
const attachment = Object.freeze({ type: "image", data: "cHJldmlldw==", mimeType: "image/png" });
const bytes = Buffer.from("immutable original document");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const document = { mimeType: "application/pdf", retention: "keep", byteLength: bytes.length,
  sha256, pageCount: 3, previewPage: 1, render: { longestSide: 1200 }, data: bytes.toString("base64") };
const details = { schema: PDF_SCHEMA, occurrence: "occurrence", label: "document.pdf", geometry, document };
const descriptor = (d = document) => ({ occurrence: "occurrence", label: "document.pdf", attachment, document: d });

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pdf-document-test-"));
  const source = join(root, "source.pdf");
  await writeFile(source, bytes);
  const calls = [], acquired = [];
  const service = createPdfDocumentService({ tempRoot: root,
    async run(file, args, { signal }) {
      signal.throwIfAborted();
      calls.push({ file, args });
      const pdf = file === "pdfinfo" ? args[0] : args.at(-2);
      assert.equal((await stat(dirname(pdf))).mode & 0o777, 0o700);
      assert.equal((await stat(pdf)).mode & 0o777, 0o600);
      if (file === "pdfinfo") return { stdout: "Pages: 3\n", stderr: "" };
      await writeFile(`${args.at(-1)}.png`, `page ${args[1]}`, { mode: 0o600 });
      return { stdout: "", stderr: "" };
    },
    async acquireImage(path, { signal }) {
      signal.throwIfAborted(); acquired.push(path);
      return { type: "image", data: (await readFile(path)).toString("base64"), mimeType: "image/png" };
    }, ...options });
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, source, calls, acquired, service };
}
const importOptions = { occurrence: "occurrence", label: "document.pdf" };

 test("strict cheap schema retains string and freezes only small selected records; fallback is preview only", () => {
  const read = readPdfDetails(details);
  assert.equal(read.document.data, document.data);
  assert.ok(Object.isFrozen(read) && Object.isFrozen(read.document) && Object.isFrozen(read.geometry));
  const malformed = [null, {}, { ...document, mimeType: "image/png" }, { ...document, byteLength: 0 },
    { ...document, pageCount: 1.5 }, { ...document, sha256: "A".repeat(64) }, { ...document, previewPage: 2 },
    { ...document, render: { longestSide: 2400 } }, { ...document, data: undefined },
    { ...document, retention: "temporary" }, { ...document, retention: "cancel" }];
  for (const d of malformed) {
    const invalid = { ...details, document: d };
    assert.equal(readPdfDetails(invalid), undefined);
    assert.equal(readPdfPreviewDetails(invalid).schema, "pi-tmux-image/native-v1");
    assert.equal(readPdfPreviewDetails(invalid).document, undefined);
  }
  // Malformed payload strings are intentionally not scanned by picker/render validation.
  assert.ok(readPdfDetails({ ...details, document: { ...document, data: "not base64" } }));
  for (const change of [{ schema: "unknown" }, { label: "bad\x1btext" }, { occurrence: "" },
    { geometry: { ...geometry, columns: 61 } }, { geometry: { ...geometry, rows: 25 } }]) {
    assert.equal(readPdfDetails({ ...details, ...change }), undefined);
  }
  assert.equal(readPdfPreviewDetails({ ...details, label: "bad\x1btext" }).label, "bad text");
  const { data, ...temporary } = document;
  assert.ok(readPdfDetails({ ...details, document: { ...temporary, retention: "temporary" } }));
  assert.equal(readPdfDetails({ ...details, document: { ...temporary, retention: "temporary", data: undefined } }), undefined);
});

 test("Keep import captures exact bytes once; canonical page1 needs no Poppler and viewing never rereads source", async (t) => {
  const f = await fixture(t);
  const transaction = await f.service.prepareImport(f.source, importOptions);
  assert.equal(transaction.document.data, bytes.toString("base64"));
  assert.equal(transaction.document.sha256, sha256);
  assert.equal(transaction.document.byteLength, bytes.length);
  assert.equal(transaction.details({ geometry }).document.data, transaction.document.data);
  assert.throws(() => transaction.details({ geometry: {} }), /geometry/);
  transaction.commit(); transaction.commit(); await transaction.rollback();
  await rm(f.source);
  assert.deepEqual(await readdir(f.root), []);
  const handle = await f.service.openDocument({ ...descriptor(transaction.document), attachment: transaction.previewAttachment });
  const callCount = f.calls.length;
  const page1 = await f.service.pageAttachment(handle, 1);
  assert.deepEqual(page1, transaction.previewAttachment);
  assert.equal(f.calls.length, callCount);
  assert.equal(handle.pageCount, 3); assert.equal(handle.available, true);
  assert.equal(Buffer.from((await f.service.pageAttachment(handle, 2)).data, "base64").toString(), "page 2");
  const retainedDirs = await readdir(f.root);
  assert.equal(retainedDirs.length, 1);
  await f.service.pageAttachment(handle, 3);
  assert.deepEqual(await readdir(f.root), retainedDirs); // no derived-page cache growth
  await f.service.releaseDocument(handle); await f.service.releaseDocument(handle);
  assert.deepEqual(await readdir(f.root), []);
  const reopened = await f.service.openDocument(descriptor(transaction.document));
  await f.service.pageAttachment(reopened, 2);
  assert.equal((await readdir(f.root)).length, 1);
  await f.service.releaseDocument(reopened);
  assert.deepEqual(await readdir(f.root), []);
});

 test("below/at threshold retain without consent; above requires exact choices and Temporary streams without encoding", async (t) => {
  let encodes = 0;
  const f = await fixture(t, { async encodeKeep(path, { signal }) {
    encodes++; signal.throwIfAborted();
    // Testing the real byte threshold without retaining another whole binary Buffer.
    return "A".repeat(4 * Math.ceil((await stat(path)).size / 3));
  } });
  for (const size of [PDF_KEEP_THRESHOLD - 1, PDF_KEEP_THRESHOLD]) {
    const source = await open(f.source, "w"); await source.truncate(size); await source.close();
    const tx = await f.service.prepareImport(f.source, { ...importOptions, chooseRetention() { assert.fail("no consent at/below threshold"); } });
    assert.equal(tx.document.retention, "keep"); assert.equal(tx.document.byteLength, size); await tx.rollback();
  }
  assert.equal(encodes, 2);
  const source = await open(f.source, "w"); await source.truncate(PDF_KEEP_THRESHOLD + 1); await source.close();
  for (const choice of ["cancel", undefined, "Keep", "invalid"]) {
    await assert.rejects(f.service.prepareImport(f.source, { ...importOptions, chooseRetention(info, { signal }) {
      assert.equal(info.byteLength, PDF_KEEP_THRESHOLD + 1);
      assert.equal(info.base64Length, 4 * Math.ceil(info.byteLength / 3));
      assert.equal(info.threshold, PDF_KEEP_THRESHOLD); assert.equal(signal.aborted, false);
      return choice;
    } }), /cancelled/);
  }
  await assert.rejects(f.service.prepareImport(f.source, importOptions), /cancelled/);
  const keep = await f.service.prepareImport(f.source, { ...importOptions, chooseRetention: () => "keep" });
  assert.equal(keep.document.retention, "keep"); await keep.rollback(); assert.equal(encodes, 3);
  const temporary = await f.service.prepareImport(f.source, { ...importOptions, chooseRetention: () => "temporary" });
  assert.equal(temporary.document.retention, "temporary"); assert.equal(Object.hasOwn(temporary.document, "data"), false);
  assert.equal(encodes, 3);
  assert.equal(temporary.document.sha256, createHash("sha256").update(Buffer.alloc(PDF_KEEP_THRESHOLD + 1)).digest("hex"));
  temporary.commit(); await temporary.rollback(); // must not delete staged runtime ownership
  await rm(f.source);
  const handle = await f.service.openDocument(descriptor(temporary.document));
  assert.equal(handle.available, true);
  assert.equal(await f.service.discardTemporary("occurrence", temporary.document.sha256), false); // page1-only handle holds original
  await f.service.pageAttachment(handle, 2);
  await f.service.releaseDocument(handle);
  const reopened = await f.service.openDocument(descriptor(temporary.document));
  assert.equal(reopened.available, true); await f.service.pageAttachment(reopened, 3); await f.service.releaseDocument(reopened);
  assert.equal(await f.service.discardTemporary("other", temporary.document.sha256), false);
  assert.equal(await f.service.discardTemporary("occurrence", "0".repeat(64)), false);
  const discarded = f.service.discardTemporary("occurrence", temporary.document.sha256);
  const racing = await f.service.openDocument(descriptor(temporary.document));
  assert.equal(racing.available, false); assert.equal(await discarded, true);
  assert.deepEqual(await f.service.pageAttachment(racing, 1), attachment);
  await assert.rejects(f.service.pageAttachment(racing, 2), /not retained/);
  await f.service.releaseDocument(racing);
  assert.deepEqual(await readdir(f.root), []);
});

 test("regular-file and source mutation/replacement gates fail before Poppler", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.service.prepareImport(f.root, importOptions), /regular file/);
  await writeFile(f.source, "");
  await assert.rejects(f.service.prepareImport(f.source, importOptions), /byte length/);
  const source = await open(f.source, "w"); await source.truncate(PDF_KEEP_THRESHOLD + 1); await source.close();
  await assert.rejects(f.service.prepareImport(f.source, { ...importOptions, async chooseRetention() {
    await writeFile(f.source, bytes); return "temporary";
  } }), /source changed/);
  const again = await open(f.source, "w"); await again.truncate(PDF_KEEP_THRESHOLD + 1); await again.close();
  await assert.rejects(f.service.prepareImport(f.source, { ...importOptions, async chooseRetention() {
    await rm(f.source); await writeFile(f.source, bytes); return "temporary";
  } }), /source changed/);
  assert.equal(f.calls.length, 0);
  const link = join(f.root, "linked.pdf"); await symlink(f.source, link);
  const transaction = await f.service.prepareImport(link, importOptions); await transaction.rollback();
});

 test("malformed canonical base64, length and hash fail lazy materialization before Poppler; preview still works", async (t) => {
  const f = await fixture(t);
  for (const change of [{ data: "!".repeat(document.data.length) }, { data: document.data.slice(0, -4) },
    { sha256: "0".repeat(64) }, { byteLength: document.byteLength + 3 },
    { data: document.data.slice(0, -4) + "Zh==" }]) {
    const handle = await f.service.openDocument(descriptor({ ...document, ...change }));
    assert.deepEqual(await f.service.pageAttachment(handle, 1), attachment);
    await assert.rejects(f.service.pageAttachment(handle, 2), /base64|length|hash/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(await readdir(f.root), ["source.pdf"]);
    await f.service.releaseDocument(handle);
  }
});

 test("Keep encoding failure never silently falls back or publishes resources; rollback/disposal idempotent", async (t) => {
  const f = await fixture(t, { encodeKeep() { throw new RangeError("string allocation failed"); } });
  await assert.rejects(f.service.prepareImport(f.source, importOptions), /Could not encode retained PDF/);
  assert.deepEqual(await readdir(f.root), ["source.pdf"]);
  await f.service.dispose(); await f.service.dispose();
  await assert.rejects(f.service.openDocument(descriptor()), /disposed/);
});

 test("abort/release/dispose drain actual injected page work before cleanup and disallow concurrent/cross-runtime requests", async (t) => {
  let started, drained;
  const start = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { async run(_file, args, { signal }) {
    const path = args.at(-2), dir = dirname(path);
    started();
    await new Promise((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 20), { once: true }));
    assert.equal((await stat(dir)).isDirectory(), true); drained = true;
    signal.throwIfAborted();
  } });
  const handle = await f.service.openDocument(descriptor());
  const controller = new AbortController();
  const request = f.service.pageAttachment(handle, 2, { signal: controller.signal });
  await start;
  await assert.rejects(f.service.pageAttachment(handle, 3), /already in progress/);
  const other = await fixture(t);
  await assert.rejects(other.service.pageAttachment(handle, 1), /another runtime/);
  const rejection = assert.rejects(request, { name: "AbortError" });
  const release = f.service.releaseDocument(handle);
  assert.equal(drained, undefined);
  await release; await rejection;
  assert.equal(drained, true);
  assert.deepEqual(await readdir(f.root), ["source.pdf"]);
  await f.service.dispose();
});

 test("abort before import/open/page1 does no work; disposal rejects prepared commit", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.prepareImport(f.source, { ...importOptions, signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(f.service.openDocument(descriptor(), { signal: controller.signal }), { name: "AbortError" });
  const handle = await f.service.openDocument(descriptor());
  await assert.rejects(f.service.pageAttachment(handle, 1, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.calls.length, 0);
  await f.service.releaseDocument(handle);
  const tx = await f.service.prepareImport(f.source, importOptions);
  await f.service.dispose(); assert.throws(() => tx.commit(), { name: "AbortError" });
  await tx.rollback(); await tx.rollback();
  assert.deepEqual(await readdir(f.root), ["source.pdf"]);
});

 test("default Keep encoding/materialization across chunk boundaries preserves exact immutable bytes", async (t) => {
  const f = await fixture(t);
  const original = Buffer.alloc(200003);
  for (let i = 0; i < original.length; i++) original[i] = i % 251;
  await writeFile(f.source, original);
  const tx = await f.service.prepareImport(f.source, importOptions);
  assert.deepEqual(Buffer.from(tx.document.data, "base64"), original);
  assert.equal(tx.document.data, original.toString("base64"));
  assert.equal(tx.document.sha256, createHash("sha256").update(original).digest("hex"));
  tx.commit(); await rm(f.source);
  const handle = await f.service.openDocument(descriptor(tx.document));
  await f.service.pageAttachment(handle, 2);
  const path = f.calls.at(-1).args.at(-2);
  assert.deepEqual(await readFile(path), original);
  await f.service.releaseDocument(handle);
  assert.deepEqual(await readdir(f.root), []);
});

 test("abort during selector, capture and metadata drains and cleans; concurrent imports refuse without second source access", async (t) => {
  const f = await fixture(t);
  const file = await open(f.source, "w"); await file.truncate(PDF_KEEP_THRESHOLD + 1); await file.close();
  let selected;
  const selecting = new Promise((resolve) => { selected = resolve; });
  const controller = new AbortController();
  const importPromise = f.service.prepareImport(f.source, { ...importOptions, signal: controller.signal,
    chooseRetention(_info, { signal }) {
      selected();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    } });
  await selecting;
  await assert.rejects(f.service.prepareImport("/does-not-exist.pdf", importOptions), /already in progress/);
  controller.abort(); await assert.rejects(importPromise, { name: "AbortError" });
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.root), ["source.pdf"]);

  const capturing = new AbortController();
  let observed = false;
  const pending = f.service.prepareImport(f.source, { ...importOptions, signal: capturing.signal,
    chooseRetention: () => "temporary" });
  // Private destination creation precedes asynchronous reads; observe it without test runtime flags.
  while (!observed) {
    observed = (await readdir(f.root)).some((name) => name.startsWith("pi-tmux-pdf-document-"));
    if (!observed) await new Promise((resolve) => setImmediate(resolve));
  }
  capturing.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(f.calls.length, 0); assert.deepEqual(await readdir(f.root), ["source.pdf"]);

  let began;
  const beganMetadata = new Promise((resolve) => { began = resolve; });
  const held = await fixture(t, { async run(_file, args, { signal }) {
    began();
    await new Promise((resolve) => signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }));
    assert.equal((await stat(args[0])).isFile(), true);
    signal.throwIfAborted();
  } });
  const preparing = held.service.prepareImport(held.source, importOptions);
  const rejects = assert.rejects(preparing, { name: "AbortError" });
  await beganMetadata;
  await held.service.dispose(); await rejects;
  assert.deepEqual(await readdir(held.root), ["source.pdf"]);
});

 test("mutation during streamed capture fails safely; committed Temporary disposal cleans while replacement stays preview-only", async (t) => {
  const f = await fixture(t);
  const file = await open(f.source, "w"); await file.truncate(PDF_KEEP_THRESHOLD + 1); await file.close();
  const pending = f.service.prepareImport(f.source, { ...importOptions, chooseRetention: () => "temporary" });
  let changed = false;
  while (!changed) {
    changed = (await readdir(f.root)).some((name) => name.startsWith("pi-tmux-pdf-document-"));
    if (!changed) await new Promise((resolve) => setImmediate(resolve));
  }
  await writeFile(f.source, bytes);
  await assert.rejects(pending, /source changed/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.root), ["source.pdf"]);
  const again = await open(f.source, "w"); await again.truncate(PDF_KEEP_THRESHOLD + 1); await again.close();
  const tx = await f.service.prepareImport(f.source, { ...importOptions, chooseRetention: () => "temporary" });
  tx.commit();
  const handle = await f.service.openDocument(descriptor(tx.document));
  await f.service.pageAttachment(handle, 2);
  const newRuntime = await fixture(t);
  const restored = await newRuntime.service.openDocument(descriptor(tx.document));
  assert.equal(restored.available, false);
  assert.deepEqual(await newRuntime.service.pageAttachment(restored, 1), attachment);
  await assert.rejects(newRuntime.service.pageAttachment(restored, 2), /not retained/);
  await f.service.dispose(); await f.service.releaseDocument(handle); await tx.rollback();
  assert.deepEqual(await readdir(f.root), ["source.pdf"]);
  await newRuntime.service.releaseDocument(restored);
});

 test("uncommitted Temporary rollback and disposal remove private scratch and cannot later commit", async (t) => {
  const f = await fixture(t);
  const source = await open(f.source, "w"); await source.truncate(PDF_KEEP_THRESHOLD + 1); await source.close();
  const options = { ...importOptions, chooseRetention: () => "temporary" };
  const tx = await f.service.prepareImport(f.source, options);
  assert.equal((await readdir(f.root)).length, 2);
  const rollback = tx.rollback();
  assert.throws(() => tx.commit(), /no longer current/);
  await f.service.dispose(); await rollback; await tx.rollback();
  assert.deepEqual(await readdir(f.root), ["source.pdf"]);
  const other = await fixture(t);
  const second = await open(other.source, "w"); await second.truncate(PDF_KEEP_THRESHOLD + 1); await second.close();
  const prepared = await other.service.prepareImport(other.source, options);
  await other.service.dispose();
  assert.throws(() => prepared.commit(), { name: "AbortError" });
  await prepared.rollback();
  assert.deepEqual(await readdir(other.root), ["source.pdf"]);
});
