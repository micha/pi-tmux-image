import { createHash } from "node:crypto";
import { GraphicsIdentityRegistry, geometryIdentity, payloadIdentity } from "./identity.mjs";
import { DEFAULT_CHUNK_SIZE, encodePngUpload, encodeVirtualPlacement, encodePlaceholderRows, encodeViewportRows, encodeOwnedVirtualRetirement } from "./kitty.mjs";
import { normalizeAttachment } from "./normalize.mjs";
import { GraphicsMetrics } from "./metrics.mjs";

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
export function createNativeRenderer({ convertToPng, identity = new GraphicsIdentityRegistry(), metrics = new GraphicsMetrics() } = {}) {
  const snapshots = new Map();
  let accountingErrors = 0;
  let lastAccountingError;
  // Diagnostics must never turn an already-written image into a failed display
  // or strand the serialized upload reservation. Incomplete accounting is explicit.
  function account(operation) {
    try { return operation(); }
    catch (error) {
      accountingErrors++;
      lastAccountingError = sanitizeDisplayText(error instanceof Error ? error.message : "Graphics accounting failed");
      return undefined;
    }
  }
  // Successful prototypes survive connection epochs. Kitty re-transmission of
  // an existing image ID deletes ALL of its placements, including old geometry
  // referenced by retained scrollback, so every known prototype must be replayed.
  const ownedPlacements = new Map();
  const resolvedPayloads = new WeakMap(), payloadRecords = new WeakSet();
  let current, viewer, retirement, retirementFailure, viewerGeneration = 0, viewerSlot, viewerWork, retirementWork;

  function epochState(epoch) {
    if (epoch === undefined || epoch === null) throw new TypeError("Image transport epoch is required");
    if (!current || current.epoch !== epoch) {
      current = { epoch, images: new Set(), placements: new Map(), tail: Promise.resolve(), privateRevision: 0 };
    }
    account(() => metrics.beginEpoch(epoch));
    return current;
  }

  /** One shared short write reservation. Abort never lets a successor overtake. */
  async function reservation(epoch, signal, valid = () => true, completed = () => {}) {
    signal?.throwIfAborted();
    const state = epochState(epoch), previous = state.tail;
    let release, entered = false, finished = false;
    state.tail = new Promise(resolve => { release = resolve; });
    const finish = (success, commit = () => {}) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      try {
        if (success && current === state && !signal?.aborted && valid()) commit(state);
      } finally {
        const drain = () => { release(); completed(); };
        if (entered) drain(); else previous.then(drain);
      }
    };
    const abort = () => finish(false);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await previous;
      entered = true;
      signal?.throwIfAborted();
      if (current !== state || !valid()) throw new Error("Image preparation superseded");
      return { state, finish, isCurrent: () => !finished && current === state && !signal?.aborted && valid() };
    } catch (error) { finish(false); throw error; }
  }

  // Residency outlives the short write reservation and a superseded request's
  // signal. The lease, epoch and committed canvas (including cell pixels) own it.
  function viewerResident(view, placement, state) {
    return current === state && viewer === view && !view.controller.signal.aborted &&
      view.prototype?.geometryKey === placement.geometryKey &&
      view.prototype?.placementKey === placement.placementKey &&
      state.images.has(placement.imageId) &&
      state.placements.get(placement.placementKey) === placement.geometryKey;
  }

  async function prepareSurface(image, activePlacement, context, view, viewerLines) {
    const { epoch, signal } = context;
    const validLease = () => !view || viewer === view && !view.controller.signal.aborted;
    const work = {};
    let reserved;
    reserved = await reservation(epoch, signal, validLease, () => {
      if (reserved?.state.privateWork === work) reserved.state.privateWork = undefined;
      if (view) { view.pending = undefined; viewerWork = undefined; }
    });
    const { state, finish } = reserved;
    try {
      // Only committed/live overlay prototypes are historical replay candidates.
      const privateView = viewer;
      const retainedViewer = privateView?.prototype;
      const imageUploaded = !state.images.has(activePlacement.imageId);
      let placementBatch = [];
      if (imageUploaded) {
        const all = new Map(ownedPlacements.get(activePlacement.imageId) || []);
        if (retainedViewer?.imageId === activePlacement.imageId) all.set(retainedViewer.placementKey, retainedViewer);
        all.set(activePlacement.placementKey, activePlacement);
        placementBatch = [...all.values()];
      } else if (state.placements.get(activePlacement.placementKey) !== activePlacement.geometryKey) {
        placementBatch = [activePlacement];
      }
      // Closing a viewer while an inline replay waits for post-prepare policy
      // must invalidate that captured batch, never resurrect its private tuple.
      const replayCurrent = () => validLease() && (!imageUploaded || viewer?.prototype === retainedViewer);
      const imageCommands = imageUploaded ? encodePngUpload(image.pngBytes, activePlacement.imageId) : [];
      const uploads = [...imageCommands, ...placementBatch.map(p => encodeVirtualPlacement({
        imageId: p.imageId, placementId: p.placementId, ...p.geometry,
      }))].join("");
      const privatePlacement = placementBatch.find(p => p.surface === "viewer");
      let privateRevision = state.privateRevision;
      if (privatePlacement) state.privateWork = work;
      let callbackSettled = false, uploadStarted = false;
      const transport = {
        epoch, image: { imageId: activePlacement.imageId, payloadKey: image.payloadKey,
          pngBytes: image.outputBytes, width: image.width, height: image.height },
        placements: placementBatch.map(p => ({ placementId: p.placementId, placementKey: p.placementKey,
          occurrenceKey: p.occurrenceKey, geometryKey: p.geometryKey, surface: p.surface, uploaded: true,
          operation: imageUploaded ? "restore" : p.surface === "viewer" && state.placements.has(p.placementKey) ? "replace" : "create" })),
        imageUploaded, wireBytes: Buffer.byteLength(uploads), uploadChunks: imageCommands.length,
        placementCommands: placementBatch.length,
      };
      return {
        uploads, geometry: activePlacement.geometry,
        lines: view ? viewerLines
          : encodePlaceholderRows({ imageId: activePlacement.imageId, placementId: activePlacement.placementId, ...activePlacement.geometry }),
        isCurrent: () => reserved.isCurrent() && replayCurrent(),
        ...(view ? { isResident: () => viewerResident(view, activePlacement, state) } : {}),
        onUploadStarted: () => {
          if (!uploads || uploadStarted || callbackSettled || !reserved.isCurrent() || !replayCurrent()) return;
          uploadStarted = true;
          // Final guards have passed, but a synchronous write can still throw
          // after partial effect. Revoke trust BEFORE the first byte, retaining
          // only a fixed-slot cleanup obligation, never a replay prototype.
          if (imageUploaded) state.images.delete(activePlacement.imageId);
          for (const p of placementBatch) state.placements.delete(p.placementKey);
          if (privatePlacement && viewer === privateView && privateView) {
            if (!privateView.prototype) privateView.attempted = privatePlacement;
            privateRevision = ++state.privateRevision;
          }
        },
        onUploaded: () => {
          if (callbackSettled) return;
          callbackSettled = true;
          if (!replayCurrent()) { finish(false); return; }
          finish(true, () => {
            state.images.add(activePlacement.imageId);
            if (view) view.prototype = activePlacement;
            if (view || privatePlacement) {
              state.privateRevision++;
              if (viewer === privateView && privateView) privateView.attempted = undefined;
            }
            if (!view) {
              let known = ownedPlacements.get(activePlacement.imageId);
              if (!known) ownedPlacements.set(activePlacement.imageId, known = new Map());
              known.set(activePlacement.placementKey, activePlacement);
            }
            for (const p of placementBatch) state.placements.set(p.placementKey, p.geometryKey);
            if (transport.wireBytes > 0) account(() => metrics.recordTransport(transport));
          });
        },
        onUploadFailed: () => {
          if (callbackSettled) return;
          callbackSettled = true;
          // A rejection can follow a partial write or a policy denial: neither
          // proves the old private cells still mean what they did. Also cover
          // inline PNG replay batches carrying this tuple. Do not let an old
          // callback revoke a later successful commit, lease or epoch.
          if (uploads && privatePlacement && current === state && viewer === privateView &&
              privateView && state.privateRevision === privateRevision) {
            state.placements.delete(privatePlacement.placementKey);
            if (imageUploaded) state.images.delete(activePlacement.imageId);
            state.privateRevision++;
          }
          finish(false);
        },
        metrics: { pngBytes: image.outputBytes, transportBytes: transport.wireBytes,
          uploadChunks: transport.uploadChunks, placementCommands: transport.placementCommands },
      };
    } catch (error) { finish(false); throw error; }
  }

  async function normalize(attachment, signal) {
    signal?.throwIfAborted();
    const key = snapshotKey(attachment);
    let pending = snapshots.get(key);
    if (!pending) {
      // Shared immutable normalization does not inherit one consumer's abort.
      // Capture primitive snapshot fields now, before the first await.
      pending = normalizeAttachment({ type: attachment.type, data: attachment.data, mimeType: attachment.mimeType }, { convertToPng }).then((image) => {
        const payloadKey = payloadIdentity(image.pngBytes);
        account(() => metrics.recordNormalization({ payloadKey, pngBytes: image.outputBytes, width: image.width, height: image.height }));
        return { ...image, payloadKey };
      });
      snapshots.set(key, pending);
      pending.catch(() => { if (snapshots.get(key) === pending) snapshots.delete(key); });
    }
    const result = await pending;
    signal?.throwIfAborted();
    return result;
  }

  return {
    normalize,
    async resolvePayload(attachment, signal) {
      const image = await normalize(attachment, signal);
      let payload = resolvedPayloads.get(image);
      if (!payload) {
        payload = Object.freeze({ ...image, ...identity.resolveImage(image.pngBytes) });
        resolvedPayloads.set(image, payload); payloadRecords.add(payload);
      }
      return payload;
    },
    reserveViewerPlacement({ payload, occurrence }) {
      if (viewer || retirement || viewerWork || retirementWork) throw new Error("Viewer slot is active, draining or retirement is unresolved");
      if (!payloadRecords.has(payload) || typeof occurrence !== "string" || !occurrence) throw new Error("Resolve a snapshot payload and occurrence before reserving viewer");
      viewerSlot ||= identity.reserveViewerPlacement();
      const lease = Object.freeze({ imageId: payload.imageId, payloadKey: payload.payloadKey,
        placementId: viewerSlot.placementId, occurrence, generation: ++viewerGeneration });
      viewer = { lease, image: payload, controller: new AbortController(), prototype: undefined, attempted: undefined, pending: undefined };
      return lease;
    },
    /** Rows only: no epoch creation, queue reservation or mutation on hit/miss. */
    reuseViewer({ lease, canvas, window }, { epoch, signal } = {}) {
      const view = viewer, state = current;
      if (epoch === undefined || epoch === null || !state || state.epoch !== epoch || signal?.aborted ||
          !view || view.lease !== lease || view.pending || viewerWork || retirement || retirementWork || state.privateWork) return undefined;
      const placement = view.prototype;
      if (!placement) return undefined;
      try {
        if (geometryIdentity(canvas) !== placement.geometryKey || !viewerResident(view, placement, state)) return undefined;
        // This single encoding validates the bounded window and canvas too.
        const lines = encodeViewportRows({ ...window, imageId: lease.imageId, placementId: lease.placementId,
          canvasColumns: placement.geometry.columns, canvasRows: placement.geometry.rows });
        const isResident = () => !signal?.aborted && viewerResident(view, placement, state);
        return { uploads: "", lines, geometry: placement.geometry, isResident,
          isCurrent: () => isResident() && !view.pending && !viewerWork && !retirement && !retirementWork && !state.privateWork,
          onUploaded() {}, onUploadFailed() {},
          metrics: { pngBytes: view.image.outputBytes, transportBytes: 0, uploadChunks: 0, placementCommands: 0 } };
      } catch { return undefined; }
    },
    async prepareViewer({ lease, canvas, window }, { epoch, signal } = {}) {
      const view = viewer;
      if (!view || view.lease !== lease) throw new Error("Viewer lease is not live");
      if (view.pending) throw new Error("Viewer preparation already pending; coalesce before preparing again");
      const geometryKey = geometryIdentity(canvas);
      const geometry = Object.freeze({ columns: canvas.columns, rows: canvas.rows,
        cellWidthPx: canvas.cellWidthPx, cellHeightPx: canvas.cellHeightPx });
      // Validate bounded canvas/window before taking any native reservation.
      const lines = encodeViewportRows({ ...window, imageId: lease.imageId, placementId: lease.placementId,
        canvasColumns: geometry.columns, canvasRows: geometry.rows });
      view.window = Object.freeze({ columns: window.columns, rows: window.rows,
        rowOffset: window.rowOffset ?? 0, columnOffset: window.columnOffset ?? 0 });
      const controller = new AbortController();
      view.pending = controller; viewerWork = controller;
      const combined = AbortSignal.any([controller.signal, view.controller.signal, ...(signal ? [signal] : [])]);
      const placement = Object.freeze({ imageId: lease.imageId, placementId: lease.placementId,
        placementKey: JSON.stringify(["viewer", lease.imageId, lease.placementId]),
        occurrenceKey: lease.occurrence, geometryKey, geometry, surface: "viewer" });
      try { return await prepareSurface(view.image, placement, { epoch, signal: combined }, view, lines); }
      catch (error) {
        if (view.pending === controller) view.pending = undefined;
        if (viewerWork === controller) viewerWork = undefined;
        throw error;
      }
    },
    releaseViewer(lease) {
      if (!viewer || viewer.lease !== lease) return false;
      const old = viewer; viewer = undefined;
      if (old.prototype || old.attempted) retirement = old.prototype || old.attempted;
      old.controller.abort();
      account(() => metrics.recordViewerRelease({ imageId: lease.imageId, placementId: lease.placementId }));
      return true;
    },
    async prepareViewerRetirement({ epoch, signal } = {}) {
      if (retirementWork) throw new Error("Viewer retirement already pending");
      const owned = retirement;
      if (!owned) {
        const state = epochState(epoch);
        return { uploads: "", lines: [], isCurrent: () => current === state && !retirement && !signal?.aborted,
          onUploaded() {}, onUploadFailed() {}, metrics: { transportBytes: 0, uploadChunks: 0, placementCommands: 0, retirementCommands: 0 } };
      }
      const work = {}; retirementWork = work;
      let reserved;
      try {
        reserved = await reservation(epoch, signal, () => retirement === owned && !viewer,
          () => { if (retirementWork === work) retirementWork = undefined; });
      } catch (error) { if (retirementWork === work) retirementWork = undefined; throw error; }
      let uploads, wireBytes;
      try { uploads = encodeOwnedVirtualRetirement(owned); wireBytes = Buffer.byteLength(uploads); }
      catch (error) { reserved.finish(false); throw error; }
      let uploadStarted = false, callbackSettled = false;
      return { uploads, lines: [], isCurrent: reserved.isCurrent,
        onUploadStarted: () => {
          if (uploadStarted || callbackSettled || !reserved.isCurrent()) return;
          uploadStarted = true;
          reserved.state.placements.delete(owned.placementKey);
        },
        onUploaded: () => {
          if (callbackSettled) return;
          callbackSettled = true;
          reserved.finish(true, state => {
            state.placements.delete(owned.placementKey); retirement = undefined; retirementFailure = undefined;
            account(() => metrics.recordRetirement({ epoch, imageId: owned.imageId, placementId: owned.placementId, wireBytes }));
          });
        },
        onUploadFailed: (error) => {
          if (callbackSettled) return;
          callbackSettled = true;
          if (current === reserved.state && retirement === owned) retirementFailure = sanitizeDisplayText(error?.message || "Retirement did not commit; terminal effect remains untrusted");
          reserved.finish(false);
        },
        metrics: { transportBytes: wireBytes, uploadChunks: 0, placementCommands: 0, retirementCommands: 1 },
      };
    },
    /** Local runtime accounting only; resetting trust never deletes terminal data. */
    stats(presentationEpoch) {
      if (presentationEpoch !== undefined) account(() => metrics.beginEpoch(presentationEpoch));
      const snapshot = account(() => metrics.snapshot());
      return { ...(snapshot || { scope: { terminalAcknowledged: false, evictionEnabled: false } }),
        viewer: { leased: Boolean(viewer), livePrototype: Boolean(viewer?.prototype), attempted: Boolean(viewer?.attempted), retirementPending: Boolean(retirement),
          slotAllocated: Boolean(viewerSlot), pending: Boolean(viewerWork), retirementWriting: Boolean(retirementWork),
          retirementFailure,
          allocatedIds: identity.allocatedIds },
        accounting: { errors: accountingErrors, lastError: lastAccountingError, unavailable: !snapshot } };
    },
    /** Validate local normalization before an attachment is appended by a tool. */
    async describe(attachment, limits, cells, signal) {
      const image = await normalize(attachment, signal);
      return { geometry: fitGeometry(image, limits, cells), pngBytes: image.outputBytes,
        uploadChunks: Math.ceil(4 * Math.ceil(image.outputBytes / 3) / DEFAULT_CHUNK_SIZE) };
    },
    async prepare({ attachment, occurrence, geometry, limits, cells }, context) {
      context.signal?.throwIfAborted();
      const image = await normalize(attachment, context.signal);
      geometry = geometry || fitGeometry(image, limits, cells);
      const ids = identity.resolve({ png: image.pngBytes, occurrenceKey: occurrence, geometry });
      const activePlacement = Object.freeze({ imageId: ids.imageId, placementId: ids.placementId,
        placementKey: ids.placementKey, occurrenceKey: occurrence, geometryKey: geometryIdentity(geometry),
        geometry: Object.freeze({ ...geometry }), surface: "inline" });
      return prepareSurface(image, activePlacement, context);
    },
  };
}
