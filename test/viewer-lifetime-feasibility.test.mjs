// Architecture concept only: no production imports, protocol/host/terminal claim.
// Fixed whole-canvas slot + cell-origin view, success-only replacement/retirement.
import test from "node:test";
import assert from "node:assert/strict";

class OneSlotConcept {
  allocatorKeys = new Set(["surface:viewer:slot:0"]);
  inline = new Map();
  live;
  retirement;
  desired;
  ready;
  generation = 0;
  epoch = 0;
  trustedImages = new Set();
  trustedPlacements = new Map();
  writes = 0;
  pngUploads = 0;
  prototypeCommands = 0;
  retirementCommands = 0;

  retainInline(imageId, placementId, canvas) {
    this.inline.set(`${imageId}:${placementId}`, { imageId, placementId, canvas });
  }
  open(imageId) {
    if (this.live) throw new Error("one open reservation");
    if (this.retirement) throw new Error("retirement unresolved; no rebind");
    this.live = { imageId, placementId: 999, generation: ++this.generation, committed: undefined };
    return this.live;
  }
  request(lease, canvas, origin) {
    if (lease !== this.live) throw new Error("stale lease");
    assert.ok(canvas.columns >= 1 && canvas.columns <= 297);
    assert.ok(canvas.rows >= 1 && canvas.rows <= 297);
    assert.ok(origin.x >= 0 && origin.x < canvas.columns);
    assert.ok(origin.y >= 0 && origin.y < canvas.rows);
    // Overwrite, never allocate/cache by motion or open generation.
    this.desired = { lease, canvas, origin, epoch: this.epoch, view: ++this.generation };
    return this.desired;
  }
  commit(candidate, { allowed = true, success = true } = {}) {
    if (!allowed || !success || candidate !== this.desired || candidate.lease !== this.live || candidate.epoch !== this.epoch) return false;
    const lease = this.live;
    const imageUploaded = !this.trustedImages.has(lease.imageId);
    const tuple = `${lease.imageId}:${lease.placementId}`;
    const key = JSON.stringify(candidate.canvas);
    const changed = this.trustedPlacements.get(tuple) !== key;
    if (imageUploaded || changed) {
      let batch;
      if (imageUploaded) {
        batch = [...this.inline.values()].filter(p => p.imageId === lease.imageId);
        // Same-pair live candidate replaces its previous canvas, not an extra key.
        batch.push({ ...lease, canvas: candidate.canvas });
        this.pngUploads++;
        this.trustedImages.add(lease.imageId);
        for (const slot of this.trustedPlacements.keys()) {
          if (slot.startsWith(`${lease.imageId}:`)) this.trustedPlacements.delete(slot);
        }
      } else batch = [{ ...lease, canvas: candidate.canvas }];
      this.writes++;
      this.prototypeCommands += batch.length;
      for (const p of batch) this.trustedPlacements.set(`${p.imageId}:${p.placementId}`, JSON.stringify(p.canvas));
    }
    lease.committed = { ...candidate.canvas };
    this.ready = { canvas: candidate.canvas, origin: candidate.origin };
    return true;
  }
  replay(imageId) {
    const prototypes = [...this.inline.values()].filter(p => p.imageId === imageId);
    if (this.live?.imageId === imageId && this.live.committed) {
      prototypes.push({ imageId, placementId: this.live.placementId, canvas: this.live.committed });
    }
    return prototypes;
  }
  close(lease) {
    if (lease !== this.live) return false;
    if (lease.committed) this.retirement = { imageId: lease.imageId, placementId: lease.placementId };
    this.live = this.desired = this.ready = undefined;
    this.generation++;
    return true;
  }
  retire({ allowed = true, success = true } = {}) {
    if (!this.retirement || !allowed || !success) return false;
    const { imageId, placementId } = this.retirement;
    this.trustedPlacements.delete(`${imageId}:${placementId}`);
    this.retirement = undefined;
    this.retirementCommands++;
    this.writes++;
    // Lowercase placement retirement intentionally retains shared image data.
    return true;
  }
  resetEpoch() {
    this.epoch++;
    this.desired = this.ready = undefined;
    this.trustedImages.clear();
    this.trustedPlacements.clear();
    // Retained inline and live committed prototypes survive; obligation survives.
  }
  viewerSizes() {
    return [this.allocatorKeys.size, this.live ? 1 : 0, this.retirement ? 1 : 0,
      this.desired ? 1 : 0, this.ready ? 1 : 0];
  }
}
const canvas = { columns: 200, rows: 150 };

test("concept: 10,000 pan/zoom motions retain one private slot and no pan transport", () => {
  const owner = new OneSlotConcept();
  owner.retainInline(7, 1, { columns: 60, rows: 24 });
  const lease = owner.open(7);
  owner.commit(owner.request(lease, canvas, { x: 0, y: 0 }));
  const initialWrites = owner.writes;
  for (let n = 0; n < 10_000; n++) {
    owner.commit(owner.request(lease, canvas, { x: n % 190, y: n % 140 }));
    assert.deepEqual(owner.viewerSizes(), [1, 1, 0, 1, 1]);
  }
  assert.equal(owner.writes, initialWrites);
  for (let n = 0; n < 10_000; n++) {
    owner.commit(owner.request(lease, { columns: 180 + n % 100, rows: 150 }, { x: 0, y: 0 }));
  }
  assert.equal(owner.pngUploads, 1);
  assert.equal(owner.trustedPlacements.size, 2); // one history + one replacement
  assert.equal(owner.inline.size, 1);
  assert.deepEqual(owner.viewerSizes(), [1, 1, 0, 1, 1]);
});

test("concept: 10,000 opens across two resident payloads reuse slot without history alias", () => {
  const owner = new OneSlotConcept();
  owner.retainInline(7, 1, { columns: 60, rows: 24 });
  owner.retainInline(8, 2, { columns: 30, rows: 24 });
  for (let n = 0; n < 10_000; n++) {
    const lease = owner.open(n % 2 ? 7 : 8);
    assert.throws(() => owner.open(7), /one open/);
    owner.commit(owner.request(lease, canvas, { x: 0, y: 0 }));
    owner.close(lease);
    owner.retire();
    assert.deepEqual(owner.viewerSizes(), [1, 0, 0, 0, 0]);
    assert.equal(owner.trustedPlacements.has("7:999"), false);
    assert.equal(owner.trustedPlacements.has("8:999"), false);
  }
  assert.equal(owner.pngUploads, 2);
  assert.equal(owner.retirementCommands, 10_000);
  assert.equal(owner.inline.size, 2);
  assert.equal(owner.trustedPlacements.size, 2);
  assert.equal(owner.trustedImages.size, 2); // pixels never deleted
});

test("concept: epoch replay includes all retained inline history and only live viewer", () => {
  const owner = new OneSlotConcept();
  for (let id = 1; id <= 3; id++) owner.retainInline(7, id, { columns: 10 * id, rows: 8 });
  const lease = owner.open(7);
  owner.commit(owner.request(lease, canvas, { x: 0, y: 0 }));
  owner.resetEpoch();
  assert.deepEqual(owner.replay(7).map(p => p.placementId), [1, 2, 3, 999]);
  owner.commit(owner.request(lease, { columns: 210, rows: 160 }, { x: 0, y: 0 }));
  assert.equal(owner.trustedPlacements.size, 4);
  assert.equal(owner.pngUploads, 2);
  owner.close(lease);
  assert.deepEqual(owner.replay(7).map(p => p.placementId), [1, 2, 3]);
});

test("concept: cancellation/denial/stale work is bounded and cannot rebind unresolved tuple", () => {
  const owner = new OneSlotConcept();
  const lease = owner.open(7);
  const first = owner.request(lease, canvas, { x: 0, y: 0 });
  const latest = owner.request(lease, canvas, { x: 1, y: 0 });
  assert.equal(owner.commit(first), false);
  assert.equal(owner.commit(latest, { allowed: false }), false);
  assert.equal(owner.commit(latest, { success: false }), false);
  assert.equal(owner.writes, 0);
  owner.commit(latest);
  owner.close(lease);
  assert.equal(owner.commit(latest), false);
  assert.equal(owner.retire({ allowed: false }), false);
  assert.equal(owner.retire({ success: false }), false);
  owner.resetEpoch();
  for (let n = 0; n < 10_000; n++) assert.throws(() => owner.open(8), /retirement unresolved/);
  assert.deepEqual(owner.viewerSizes(), [1, 0, 1, 0, 0]);
  assert.equal(owner.retirementCommands, 0);
  owner.retire();
  const replacement = owner.open(8);
  assert.equal(owner.close(lease), false); // old disposal cannot close new lease
  assert.equal(owner.live, replacement);
  const pending = owner.request(replacement, canvas, { x: 0, y: 0 });
  owner.resetEpoch();
  assert.equal(owner.commit(pending), false);
  assert.equal(owner.writes, 2); // successful upload+prototype write, one retirement
});
