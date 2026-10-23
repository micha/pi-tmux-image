import { createHash } from "node:crypto";
import { GraphicsIdentityRegistry, geometryIdentity } from "./identity.mjs";
import { DEFAULT_CHUNK_SIZE, encodePngUpload, encodeVirtualPlacement, encodePlaceholderRows } from "./kitty.mjs";
import { normalizeAttachment } from "./normalize.mjs";

export const NATIVE_SCHEMA = "pi-tmux-image/native-v1";

/** Labels are plain terminal text, never trusted ANSI or multiline content. */
export function sanitizeDisplayText(text) {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

/** Live grid: aspect fit in pixel space, capped at 60 x 24 cells. */
export function fitGeometry(image, limits, cells) {
  for (const [name, value] of Object.entries({ width: image.width, height: image.height,
    cellWidthPx: cells.widthPx, cellHeightPx: cells.heightPx })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`);
  }
  const maxColumns = Math.min(60, Math.max(1, Math.floor(limits.columns)));
  const maxRows = Math.min(24, Math.max(1, Math.floor(limits.rows)));
  if (!Number.isFinite(maxColumns) || !Number.isFinite(maxRows)) throw new Error("Invalid grid limits");
  const scale = Math.min(maxColumns * cells.widthPx / image.width, maxRows * cells.heightPx / image.height);
  return Object.freeze({
    columns: Math.min(maxColumns, Math.max(1, Math.ceil(image.width * scale / cells.widthPx))),
    rows: Math.min(maxRows, Math.max(1, Math.ceil(image.height * scale / cells.heightPx))),
    cellWidthPx: cells.widthPx, cellHeightPx: cells.heightPx,
  });
}

export function readNativeDetails(details) {
  if (details?.schema !== NATIVE_SCHEMA || typeof details.occurrence !== "string" || !details.occurrence ||
      typeof details.label !== "string") return undefined;
  try { geometryIdentity(details.geometry); } catch { return undefined; }
  if (details.geometry.columns > 60 || details.geometry.rows > 24) return undefined;
  const { columns, rows, cellWidthPx, cellHeightPx } = details.geometry;
  return { schema: NATIVE_SCHEMA, occurrence: details.occurrence, label: sanitizeDisplayText(details.label),
    geometry: { columns, rows, cellWidthPx, cellHeightPx } };
}

export function captureLayout(width, terminalRows, cells) {
  const limits = { columns: Math.min(60, Math.max(1, Math.floor(width))),
    rows: Math.min(24, Math.max(1, Math.floor(terminalRows) - 8)) };
  const capturedCells = { widthPx: cells.widthPx, heightPx: cells.heightPx };
  for (const value of [limits.columns, limits.rows, capturedCells.widthPx, capturedCells.heightPx]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid live image layout");
  }
  return { key: JSON.stringify([limits.columns, limits.rows, capturedCells.widthPx, capturedCells.heightPx]),
    limits, cells: capturedCells };
}

/** Only the known unversioned Chafa shape migrates; never trust its old cells. */
export function readLegacyDetails(details, occurrence) {
  if (!details || typeof details !== "object" || "schema" in details ||
      typeof details.label !== "string" || !Number.isInteger(details.columns) || details.columns < 1 ||
      details.columns > 297 || !Array.isArray(details.lines) || details.lines.length < 1 ||
      details.lines.length > 297 || !details.lines.every((line) => typeof line === "string") ||
      typeof occurrence !== "string" || !occurrence) return undefined;
  return { occurrence, label: sanitizeDisplayText(details.label) };
}

function snapshotKey(attachment) {
  if (attachment?.type !== "image" || typeof attachment.data !== "string" || typeof attachment.mimeType !== "string") {
    throw new Error("Missing standard Pi image snapshot");
  }
  return createHash("sha256").update(attachment.mimeType).update("\0").update(attachment.data).digest("hex");
}

/** Native runtime only. Never stores pixels/IDs/residency in message details. */
export function createNativeRenderer({ convertToPng, identity = new GraphicsIdentityRegistry() } = {}) {
  const snapshots = new Map();
  let current;

  async function normalize(attachment, signal) {
    signal?.throwIfAborted();
    const key = snapshotKey(attachment);
    let pending = snapshots.get(key);
    if (!pending) {
      // Shared immutable normalization does not inherit one consumer's abort.
      // Capture primitive snapshot fields now, before the first await.
      pending = normalizeAttachment({ type: attachment.type, data: attachment.data, mimeType: attachment.mimeType }, { convertToPng });
      snapshots.set(key, pending);
      pending.catch(() => { if (snapshots.get(key) === pending) snapshots.delete(key); });
    }
    const result = await pending;
    signal?.throwIfAborted();
    return result;
  }

  return {
    normalize,
    /** Validate local normalization before an attachment is appended by a tool. */
    async describe(attachment, limits, cells, signal) {
      const image = await normalize(attachment, signal);
      return { geometry: fitGeometry(image, limits, cells), pngBytes: image.outputBytes,
        uploadChunks: Math.ceil(4 * Math.ceil(image.outputBytes / 3) / DEFAULT_CHUNK_SIZE) };
    },
    async prepare({ attachment, occurrence, geometry, limits, cells }, { epoch, signal }) {
      signal?.throwIfAborted();
      const image = await normalize(attachment, signal);
      geometry = geometry || fitGeometry(image, limits, cells);
      const ids = identity.resolve({ png: image.pngBytes, occurrenceKey: occurrence, geometry });
      if (!current || current.epoch !== epoch) {
        current = { epoch, images: new Set(), placements: new Set(), tail: Promise.resolve() };
      }
      const state = current;
      // Serialize the short transport commit, not decoding. Concurrent occurrences
      // sharing a PNG wait for the first successful write before omitting its data.
      const previous = state.tail;
      let release;
      state.tail = new Promise((resolve) => { release = resolve; });
      let finished = false;
      const finish = (success) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        if (success && current === state && !signal?.aborted) {
          state.images.add(ids.imageId);
          state.placements.add(ids.placementKey);
        }
        // An aborted queued job must not let its successors overtake the job
        // ahead of it: preserve the chain even when cancellation precedes await.
        previous.then(release);
      };
      const abort = () => finish(false);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await previous;
        signal?.throwIfAborted();
        if (current !== state) throw new Error("Native image epoch changed during preparation");
        const commands = [];
        if (!state.images.has(ids.imageId)) commands.push(...encodePngUpload(image.pngBytes, ids.imageId));
        if (!state.placements.has(ids.placementKey)) commands.push(encodeVirtualPlacement({ ...ids, ...geometry }));
        return {
          uploads: commands.join(""), lines: encodePlaceholderRows({ ...ids, ...geometry }), geometry,
          onUploaded: () => finish(true), onUploadFailed: () => finish(false),
          metrics: { pngBytes: image.outputBytes, transportBytes: Buffer.byteLength(commands.join("")),
            uploadChunks: state.images.has(ids.imageId) ? 0 : commands.length - (state.placements.has(ids.placementKey) ? 0 : 1) },
        };
      } catch (error) { finish(false); throw error; }
    },
  };
}
