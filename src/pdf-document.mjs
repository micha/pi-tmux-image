import { constants } from "node:fs";
import { open, stat, mkdtemp, chmod, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE_SCHEMA, readNativeDetails, sanitizeDisplayText } from "./native.mjs";
import { readPdfPageCount, withPdfPage, runPdfCommand } from "./pdf.mjs";

export const PDF_SCHEMA = "pi-tmux-image/pdf-v1";
export const PDF_KEEP_THRESHOLD = 33554432;
const CHUNK = 65536;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const safeText = (s) => typeof s === "string" && s.length > 0 && sanitizeDisplayText(s) === s;

function readDocument(d) {
  if (!d || d.mimeType !== "application/pdf" || !["keep", "temporary"].includes(d.retention) ||
      !positive(d.byteLength) || !positive(d.pageCount) || d.previewPage !== 1 ||
      typeof d.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(d.sha256) ||
      d.render?.longestSide !== 1200 ||
      (d.retention === "keep" ? typeof d.data !== "string" : Object.hasOwn(d, "data"))) return undefined;
  return Object.freeze({ mimeType: d.mimeType, retention: d.retention, byteLength: d.byteLength,
    sha256: d.sha256, pageCount: d.pageCount, previewPage: 1,
    render: Object.freeze({ longestSide: 1200 }), ...(d.retention === "keep" ? { data: d.data } : {}) });
}

/** Preview-only adaptation never confers access to an original document. */
export function readPdfPreviewDetails(details) {
  if (details?.schema !== PDF_SCHEMA) return undefined;
  const preview = readNativeDetails({ schema: NATIVE_SCHEMA, occurrence: details.occurrence,
    label: details.label, geometry: details.geometry });
  return preview && Object.freeze({ ...preview, geometry: Object.freeze(preview.geometry) });
}

/** Small structural copies only; the potentially large immutable data string is not scanned. */
export function readPdfDetails(details) {
  const preview = readPdfPreviewDetails(details);
  const document = readDocument(details?.document);
  if (!preview || !document || !safeText(details.occurrence) || !safeText(details.label)) return undefined;
  return Object.freeze({ ...preview, schema: PDF_SCHEMA, document });
}

function imageSnapshot(image) {
  if (image?.type !== "image" || typeof image.data !== "string" || !image.data ||
      typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
    throw new Error("Missing standard PDF preview image");
  }
  return Object.freeze({ type: "image", data: image.data, mimeType: image.mimeType });
}

async function privateDirectory(root) {
  const dir = await mkdtemp(join(root, "pi-tmux-pdf-document-"));
  try { await chmod(dir, 0o700); return dir; }
  catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
}
const remove = (dir) => dir ? rm(dir, { recursive: true, force: true }) : Promise.resolve();
const sameSource = (a, b) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => a[key] === b[key]);
const keyFor = (occurrence, hash) => JSON.stringify([occurrence, hash]);

async function encodeOriginal(path, { signal }) {
  const file = await open(path, "r");
  const pieces = [];
  let carry = Buffer.alloc(0);
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = Buffer.allocUnsafe(CHUNK);
      const { bytesRead } = await file.read(chunk, 0, CHUNK, null);
      if (!bytesRead) break;
      const bytes = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const end = bytes.length - bytes.length % 3;
      pieces.push(bytes.subarray(0, end).toString("base64"));
      carry = Buffer.from(bytes.subarray(end));
    }
    if (carry.length) pieces.push(carry.toString("base64"));
    signal.throwIfAborted();
    return pieces.join("");
  } finally { await file.close(); }
}

async function materialize(document, path, signal) {
  const data = document.data;
  if (data.length !== 4 * Math.ceil(document.byteLength / 3) || data.length % 4) {
    throw new Error("Retained PDF length does not match metadata");
  }
  const file = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  let count = 0;
  try {
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      signal.throwIfAborted();
      const text = data.slice(offset, offset + CHUNK);
      const last = offset + CHUNK >= data.length;
      if (!(last ? /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/ : /^[A-Za-z0-9+/]+$/).test(text)) {
        throw new Error("Malformed retained PDF base64");
      }
      const bytes = Buffer.from(text, "base64");
      if (bytes.toString("base64") !== text) throw new Error("Noncanonical retained PDF base64");
      hash.update(bytes); count += bytes.length;
      await file.writeFile(bytes);
    }
    signal.throwIfAborted();
    if (count !== document.byteLength || hash.digest("hex") !== document.sha256) {
      throw new Error("Retained PDF hash or length mismatch");
    }
  } finally { await file.close(); }
}

/** One instance owns one session runtime, never a source locator or terminal resource. */
export function createPdfDocumentService({ acquireImage, tempRoot = tmpdir(), run = runPdfCommand,
  encodeKeep = encodeOriginal } = {}) {
  if (typeof acquireImage !== "function") throw new Error("PDF image acquisition is required");
  const runtime = new AbortController();
  const registry = new Map(), handles = new Map(), transactions = new Set(), operations = new Set();
  let importing = false, disposed = false, disposal;

  function track(promise) {
    operations.add(promise);
    promise.then(() => operations.delete(promise), () => operations.delete(promise));
    return promise;
  }

  function operation(signal, ownerSignal, work) {
    if (disposed) return Promise.reject(new Error("PDF document runtime is disposed"));
    const combined = AbortSignal.any([runtime.signal, ...(signal ? [signal] : []), ...(ownerSignal ? [ownerSignal] : [])]);
    // Start on a continuation so tracking precedes the first await and any disposal.
    const promise = Promise.resolve().then(() => { combined.throwIfAborted(); return work(combined); });
    return track(promise);
  }

  async function prepareImport(path, { occurrence, label, signal, chooseRetention } = {}) {
    if (!safeText(occurrence) || !safeText(label)) throw new Error("Invalid PDF import identity or label");
    if (importing) throw new Error("A PDF import is already in progress");
    importing = true;
    try {
      return await operation(signal, undefined, async (activeSignal) => {
        let source, dir;
        try {
          try { source = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
          catch { throw new Error("Could not open PDF source"); }
          const initial = await source.stat({ bigint: true });
          if (!initial.isFile()) throw new Error("PDF source must be a regular file");
          const size = Number(initial.size);
          if (!positive(size)) throw new Error("Invalid PDF source byte length");
          let retention = "keep";
          if (size > PDF_KEEP_THRESHOLD) {
            retention = await chooseRetention?.({ byteLength: size, base64Length: 4 * Math.ceil(size / 3),
              threshold: PDF_KEEP_THRESHOLD }, { signal: activeSignal });
            activeSignal.throwIfAborted();
            if (!["keep", "temporary"].includes(retention)) throw new Error("PDF import cancelled");
          }
          activeSignal.throwIfAborted();
          if (!sameSource(initial, await source.stat({ bigint: true }))) throw new Error("PDF source changed; retry import");
          dir = await privateDirectory(tempRoot);
          const captured = join(dir, "original.pdf");
          const target = await open(captured, "wx", 0o600);
          const hash = createHash("sha256");
          let count = 0;
          try {
            const chunk = Buffer.allocUnsafe(CHUNK);
            for (;;) {
              activeSignal.throwIfAborted();
              const { bytesRead } = await source.read(chunk, 0, CHUNK, null);
              if (!bytesRead) break;
              count += bytesRead;
              if (!Number.isSafeInteger(count) || count > size) throw new Error("PDF source changed; retry import");
              const bytes = chunk.subarray(0, bytesRead);
              hash.update(bytes);
              await target.writeFile(bytes);
            }
          } finally { await target.close(); }
          activeSignal.throwIfAborted();
          const finalPathStat = await stat(path, { bigint: true }).catch(() => undefined);
          if (count !== size || !sameSource(initial, await source.stat({ bigint: true })) ||
              !finalPathStat || !sameSource(initial, finalPathStat)) throw new Error("PDF source changed; retry import");
          await source.close(); source = undefined;
          const sha256 = hash.digest("hex");
          const pageCount = await readPdfPageCount(captured, { run, signal: activeSignal });
          const previewAttachment = imageSnapshot(await withPdfPage(captured, 1,
            (png) => acquireImage(png, { signal: activeSignal }), { run, signal: activeSignal, tempRoot }));
          let data;
          if (retention === "keep") {
            try { data = await encodeKeep(captured, { signal: activeSignal }); }
            catch (error) {
              activeSignal.throwIfAborted();
              throw new Error("Could not encode retained PDF; import failed (choose Temporary on retry)", { cause: error });
            }
            if (typeof data !== "string" || data.length !== 4 * Math.ceil(count / 3)) throw new Error("Could not encode retained PDF");
          }
          activeSignal.throwIfAborted();
          const document = readDocument({ mimeType: "application/pdf", retention, byteLength: count,
            sha256, pageCount, previewPage: 1, render: { longestSide: 1200 }, ...(retention === "keep" ? { data } : {}) });
          const record = { dir, path: captured, consumers: 0 };
          if (retention === "keep") { await remove(dir); dir = undefined; record.dir = undefined; }
          activeSignal.throwIfAborted();
          let state = "prepared", cleanup;
          const transaction = Object.freeze({ document, previewAttachment,
            details({ geometry }) {
              const details = readPdfDetails({ schema: PDF_SCHEMA, occurrence, label, geometry, document });
              if (!details) throw new Error("Invalid PDF preview geometry");
              return details;
            },
            commit() {
              activeSignal.throwIfAborted();
              if (disposed || state === "rolled-back") throw new Error("PDF import is no longer current");
              if (state === "committed") return;
              if (retention === "temporary") {
                const key = keyFor(occurrence, sha256);
                if (registry.has(key)) throw new Error("PDF occurrence is already staged");
                registry.set(key, record);
              }
              state = "committed"; transactions.delete(transaction);
            },
            rollback() {
              if (state === "committed") return Promise.resolve(); // staging belongs to runtime now
              if (cleanup) return cleanup;
              state = "rolled-back"; transactions.delete(transaction);
              cleanup = track(remove(record.dir));
              return cleanup;
            },
          });
          transactions.add(transaction);
          dir = undefined; // transaction owns unpublished scratch
          return transaction;
        } finally {
          try { await source?.close(); } finally { await remove(dir); }
        }
      });
    } finally { importing = false; }
  }

  async function openDocument(descriptor, { signal } = {}) {
    signal?.throwIfAborted();
    if (disposed) throw new Error("PDF document runtime is disposed");
    const document = readDocument(descriptor?.document);
    if (!document || !safeText(descriptor.occurrence) || !safeText(descriptor.label)) throw new Error("Invalid PDF document descriptor");
    const attachment = imageSnapshot(descriptor.attachment);
    const record = document.retention === "temporary" ? registry.get(keyFor(descriptor.occurrence, document.sha256)) : undefined;
    if (record) record.consumers++;
    const available = document.retention === "keep" || !!record;
    const handle = Object.freeze({ pageCount: document.pageCount, available,
      ...(!available ? { unavailableReason: "Original PDF was not retained; only the page-one preview is available after reload." } : {}) });
    handles.set(handle, { document, attachment, record, controller: new AbortController(), dir: undefined,
      path: undefined, runner: undefined, release: undefined });
    return handle;
  }

  function pageAttachment(handle, pageNumber, { signal } = {}) {
    const state = handles.get(handle);
    if (!state || state.release || disposed) return Promise.reject(new Error("PDF document handle is closed or belongs to another runtime"));
    if (!positive(pageNumber) || pageNumber > state.document.pageCount) return Promise.reject(new Error("Invalid PDF page number"));
    if (state.runner) return Promise.reject(new Error("A PDF page request is already in progress"));
    const promise = operation(signal, state.controller.signal, async (activeSignal) => {
      if (pageNumber === 1) return state.attachment;
      if (!handle.available) throw new Error(handle.unavailableReason);
      if (!state.record && !state.path) {
        const dir = await privateDirectory(tempRoot);
        try {
          const path = join(dir, "original.pdf");
          await materialize(state.document, path, activeSignal);
          activeSignal.throwIfAborted();
          state.dir = dir; state.path = path;
        } catch (error) { await remove(dir); throw error; }
      }
      const attachment = await withPdfPage(state.record?.path || state.path, pageNumber,
        (png) => acquireImage(png, { signal: activeSignal }), { run, signal: activeSignal, tempRoot });
      activeSignal.throwIfAborted();
      return imageSnapshot(attachment);
    });
    state.runner = promise;
    const clear = () => { if (state.runner === promise) state.runner = undefined; };
    promise.then(clear, clear);
    return promise;
  }

  function releaseDocument(handle) {
    const state = handles.get(handle);
    if (!state) return Promise.resolve();
    if (state.release) return state.release;
    state.controller.abort();
    state.release = (async () => {
      await Promise.allSettled(state.runner ? [state.runner] : []);
      await remove(state.dir);
      if (state.record) state.record.consumers--;
      handles.delete(handle);
    })();
    return state.release;
  }

  async function discardTemporary(occurrence, sha256) {
    const key = keyFor(occurrence, sha256), record = registry.get(key);
    if (!record || record.consumers) return false;
    registry.delete(key); // synchronous exclusion before async unlink; no racing handle acquisition
    await track(remove(record.dir));
    return true;
  }

  function dispose() {
    if (disposal) return disposal;
    disposed = true; runtime.abort();
    disposal = (async () => {
      await Promise.allSettled([...operations]);
      await Promise.all([...handles.keys()].map(releaseDocument));
      await Promise.all([...transactions].map((transaction) => transaction.rollback()));
      const records = [...registry.values()]; registry.clear();
      await Promise.all(records.map((record) => remove(record.dir)));
    })();
    return disposal;
  }
  return Object.freeze({ prepareImport, openDocument, pageAttachment, releaseDocument, discardTemporary, dispose });
}
