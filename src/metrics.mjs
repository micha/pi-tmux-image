// Measurement only: no terminal I/O, payload retention, budget or eviction policy.
import { randomUUID } from "node:crypto";

function key(value, name) {
  if (typeof value !== "string" || !value) throw new TypeError(`${name} must be a nonempty string`);
  return value;
}
function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
  return value;
}
function id(value, name) {
  integer(value,name,1);
  if (value > 0xffffff) throw new RangeError(`${name} exceeds the 24-bit image namespace`);
  return value;
}
function imageMetadata(image) {
  if (!image || typeof image !== "object") throw new TypeError("image metadata required");
  const result = {
    payloadKey: key(image.payloadKey,"payloadKey"),
    pngBytes: integer(image.pngBytes,"pngBytes",1),
    width: integer(image.width,"width",1),
    height: integer(image.height,"height",1),
  };
  result.estimatedRgbaBytes = integer(result.width * result.height * 4,"estimatedRgbaBytes",1);
  return Object.freeze(result);
}
function sameImage(a,b) {
  return a.payloadKey === b.payloadKey && a.pngBytes === b.pngBytes && a.width === b.width && a.height === b.height;
}
function assertSame(existing, incoming) {
  if (existing && !sameImage(existing,incoming)) throw new Error("Image identity metadata changed");
}
function counters() { return { wireBytes: 0, uploadChunks: 0, placementCommands: 0, successfulCommits: 0 }; }
function addCounters(current, delta) {
  return Object.fromEntries(Object.keys(current).map(name => [name,integer(current[name] + delta[name],name)]));
}
function sum(records, property) {
  let total = 0;
  for (const record of records) total = integer(total + record[property],property);
  return total;
}

/** Locally known residency, not acknowledged terminal residency or global memory.
 * One instance per native renderer runtime. Epoch tokens are the presentation
 * connection's tokens; reset loses local trust but does not delete terminal pixels.
 */
export class GraphicsMetrics {
  #runtimeId;
  #epoch;
  #epochNumber = 0;
  #normalized = new Map();
  #images = new Map();
  #placements = new Map();
  #transfer = counters();
  #runtimeTransfer = counters();
  #surfaceTransfer = { replacementCommands: 0, retirementCommands: 0 };
  #runtimeSurfaceTransfer = { replacementCommands: 0, retirementCommands: 0 };

  constructor({ runtimeId = randomUUID(), epoch = Symbol("graphics metrics epoch") } = {}) {
    this.#runtimeId = key(runtimeId,"runtimeId");
    this.beginEpoch(epoch);
  }

  get epoch() { return this.#epoch; }

  /** Idempotent for the same token. Runtime counters and cached normalization
   * inventory survive a connection reset; current-epoch tracked residency does not.
   */
  beginEpoch(epoch = Symbol("graphics metrics epoch")) {
    if (epoch === undefined || epoch === null) throw new TypeError("epoch token required");
    if (this.#epoch === epoch) return epoch;
    this.#epoch = epoch;
    this.#epochNumber++;
    this.#images.clear(); this.#placements.clear(); this.#transfer = counters();
    this.#surfaceTransfer = { replacementCommands: 0, retirementCommands: 0 };
    return epoch;
  }

  /** Call after successful cached normalization. Stores metadata only, not bytes.
   * Repeating a payload is free; same key with changed dimensions/bytes is rejected.
   */
  recordNormalization(image) {
    const metadata = imageMetadata(image);
    assertSame(this.#normalized.get(metadata.payloadKey),metadata);
    this.#normalized.set(metadata.payloadKey,metadata);
  }

  /** ONLY after a successful transport write / native onUploaded commit.
   * One event describes one write: image upload plus a batch of restored/new
   * placements. Wire totals are counted ONCE, never repeated per placement.
   * Singular placement + placementUploaded remains a compatibility shorthand.
   * Retransmitting an image removes ALL previous placements for that image ID;
   * only uploaded batch entries survive. No call on failed writes.
   * Returns false for stale epochs, without changing ANY counters or residency.
   */
  recordTransport({ epoch, image, placement, placements, imageUploaded, placementUploaded,
    wireBytes, uploadChunks, placementCommands } = {}) {
    if (epoch !== this.#epoch) return false;
    if (typeof imageUploaded !== "boolean") throw new TypeError("imageUploaded must be boolean");
    const metadata = imageMetadata(image);
    const imageId = id(image.imageId,"imageId");
    assertSame(this.#normalized.get(metadata.payloadKey),metadata);
    const resident = this.#images.get(imageId);
    assertSame(resident,metadata);
    if (!imageUploaded && !resident) throw new Error("Reused image is not tracked in this epoch");
    let entries;
    if (placements !== undefined) {
      if (!Array.isArray(placements) || placement !== undefined || placementUploaded !== undefined) throw new TypeError("Use either placements batch or singular placement fields");
      entries = placements;
    } else {
      if (typeof placementUploaded !== "boolean") throw new TypeError("placementUploaded must be boolean");
      entries = [{ ...placement, uploaded: placementUploaded }];
    }
    const incoming = new Map();
    let uploadedPlacements = 0, replacements = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.uploaded !== "boolean") throw new TypeError("Placement entry and boolean uploaded flag required");
      const placementId = id(entry.placementId,"placementId");
      const surface = entry.surface ?? "inline", operation = entry.operation ?? "create";
      if (!["inline", "viewer"].includes(surface) || !["create", "replace", "restore"].includes(operation)) throw new TypeError("Invalid surface/placement operation");
      if (operation === "replace" && (surface !== "viewer" || !entry.uploaded || imageUploaded)) throw new Error("Only resident viewer prototypes may be replaced");
      const metadata = Object.freeze({ imageId, placementId, surface, live: true,
        placementKey: key(entry.placementKey,"placementKey"),
        occurrenceKey: key(entry.occurrenceKey,"occurrenceKey"),
        geometryKey: key(entry.geometryKey,"geometryKey"),
      });
      const slot = `${imageId}:${placementId}`;
      if (incoming.has(slot)) throw new Error("Duplicate placement in transport batch");
      const prior = this.#placements.get(slot);
      const changed = prior && Object.keys(metadata).some(name => name !== "live" && metadata[name] !== prior[name]);
      const viewerReplacement = prior?.surface === "viewer" && surface === "viewer" &&
        entry.uploaded && (operation === "replace" || imageUploaded && operation === "restore") && prior.placementKey === metadata.placementKey;
      if (changed && !viewerReplacement) throw new Error("Placement identity metadata changed");
      if (operation === "replace" && !prior) throw new Error("Replaced viewer placement is not tracked");
      if (!entry.uploaded && (imageUploaded || !prior)) throw new Error("Reused placement is not tracked after image retransmission or in this epoch");
      if (entry.uploaded) uploadedPlacements++;
      if (operation === "replace") replacements++;
      incoming.set(slot,{ metadata, uploaded: entry.uploaded });
    }
    const delta = { wireBytes: integer(wireBytes,"wireBytes"), uploadChunks: integer(uploadChunks,"uploadChunks"),
      placementCommands: integer(placementCommands,"placementCommands"), successfulCommits: 1 };
    if (imageUploaded !== (uploadChunks > 0) || placementCommands !== uploadedPlacements) throw new Error("Command counts disagree with upload flags");
    if ((imageUploaded || uploadedPlacements > 0) !== (wireBytes > 0)) throw new Error("Wire bytes disagree with upload flags");
    const nextEpoch = addCounters(this.#transfer,delta), nextRuntime = addCounters(this.#runtimeTransfer,delta);
    const nextSurface = integer(this.#surfaceTransfer.replacementCommands + replacements, "replacementCommands");
    const nextRuntimeSurface = integer(this.#runtimeSurfaceTransfer.replacementCommands + replacements, "replacementCommands");
    // All validation/counter arithmetic above is atomic: failures change nothing.
    this.#normalized.set(metadata.payloadKey,metadata);
    if (imageUploaded) {
      this.#images.set(imageId,metadata);
      if (resident) {
        for (const [slot, prior] of this.#placements) {
          if (prior.imageId === imageId) this.#placements.delete(slot);
        }
      }
    }
    for (const [slot, entry] of incoming) {
      if (entry.uploaded) this.#placements.set(slot,entry.metadata);
    }
    this.#transfer = nextEpoch; this.#runtimeTransfer = nextRuntime;
    this.#surfaceTransfer.replacementCommands = nextSurface;
    this.#runtimeSurfaceTransfer.replacementCommands = nextRuntimeSurface;
    return true;
  }

  /** Logical release is not transport or proof that terminal storage was freed. */
  recordViewerRelease({ imageId, placementId } = {}) {
    id(imageId, "imageId"); id(placementId, "placementId");
    const slot = `${imageId}:${placementId}`, prior = this.#placements.get(slot);
    if (prior?.surface === "viewer") this.#placements.set(slot, Object.freeze({ ...prior, live: false }));
  }

  /** Successful lowercase scoped private-prototype deletion, never pixel eviction.
   * An epoch reset may have cleared local metadata while the terminal tuple remains.
   */
  recordRetirement({ epoch, imageId, placementId, wireBytes } = {}) {
    if (epoch !== this.#epoch) return false;
    id(imageId, "imageId"); id(placementId, "placementId");
    const slot = `${imageId}:${placementId}`, prior = this.#placements.get(slot);
    if (prior && prior.surface !== "viewer") throw new Error("Cannot retire inline history");
    const delta = { wireBytes: integer(wireBytes, "wireBytes", 1), uploadChunks: 0, placementCommands: 0, successfulCommits: 1 };
    const nextEpoch = addCounters(this.#transfer, delta), nextRuntime = addCounters(this.#runtimeTransfer, delta);
    const next = integer(this.#surfaceTransfer.retirementCommands + 1, "retirementCommands");
    const nextRuntimeCount = integer(this.#runtimeSurfaceTransfer.retirementCommands + 1, "retirementCommands");
    this.#placements.delete(slot);
    this.#transfer = nextEpoch; this.#runtimeTransfer = nextRuntime;
    this.#surfaceTransfer.retirementCommands = next;
    this.#runtimeSurfaceTransfer.retirementCommands = nextRuntimeCount;
    return true;
  }

  /** Copies aggregate measurements. PNG bytes count binary encoded data, never
   * base64/wrapping. ID totals reflect duplicates if one payload has multiple IDs.
   */
  snapshot() {
    const images = [...this.#images.values()];
    const payloads = [...new Map(images.map(image => [image.payloadKey,image])).values()];
    const placements = [...this.#placements.values()];
    return {
      scope: { runtimeId: this.#runtimeId, epochNumber: this.#epochNumber,
        residency: "locally-tracked-successful-writes", terminalAcknowledged: false, evictionEnabled: false },
      normalization: { payloads: this.#normalized.size,
        pngBytes: sum(this.#normalized.values(),"pngBytes"),
        estimatedRgbaBytes: sum(this.#normalized.values(),"estimatedRgbaBytes") },
      resident: { imageIds: this.#images.size, payloads: payloads.length,
        pngBytes: sum(images,"pngBytes"), estimatedRgbaBytes: sum(images,"estimatedRgbaBytes"),
        uniquePayloadPngBytes: sum(payloads,"pngBytes"), uniquePayloadEstimatedRgbaBytes: sum(payloads,"estimatedRgbaBytes") },
      placements: { geometryVersions: placements.length,
        occurrences: new Set(placements.map(placement => placement.occurrenceKey)).size },
      surfaces: { inline: placements.filter(p => p.surface === "inline").length,
        viewer: placements.filter(p => p.surface === "viewer").length,
        liveViewer: placements.filter(p => p.surface === "viewer" && p.live).length },
      surfaceTransfer: { ...this.#surfaceTransfer }, runtimeSurfaceTransfer: { ...this.#runtimeSurfaceTransfer },
      transfer: { ...this.#transfer }, runtimeTransfer: { ...this.#runtimeTransfer },
    };
  }
}
