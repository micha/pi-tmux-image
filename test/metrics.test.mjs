import test from "node:test";
import assert from "node:assert/strict";
import { GraphicsMetrics } from "../src/metrics.mjs";
import { createNativeRenderer } from "../src/native.mjs";
import { GraphicsIdentityRegistry } from "../src/identity.mjs";

const IMAGE = Object.freeze({ imageId: 1, payloadKey: "png:a", pngBytes: 100, width: 10, height: 20 });
function placement(overrides = {}) {
  return { placementId: 2, placementKey: "a/one/60x24", occurrenceKey: "one", geometryKey: "60x24", ...overrides };
}
function event(metrics, overrides = {}) {
  return { epoch: metrics.epoch, image: IMAGE, placement: placement(), imageUploaded: true, placementUploaded: true,
    wireBytes: 240, uploadChunks: 2, placementCommands: 1, ...overrides };
}
function reused(metrics, overrides = {}) {
  return event(metrics,{imageUploaded:false,placementUploaded:false,wireBytes:0,uploadChunks:0,placementCommands:0,...overrides});
}
function batch(metrics, placements, overrides = {}) {
  const { placement: _placement, placementUploaded: _uploaded, ...base } = event(metrics);
  return { ...base, placements, placementCommands: placements.filter(entry => entry?.uploaded === true).length, ...overrides };
}

test("records metadata without buffers and separates normalized inventory from known residency", () => {
  const metrics = new GraphicsMetrics({runtimeId:"runtime-a"});
  metrics.recordNormalization({...IMAGE,pngBuffer:Buffer.alloc(100)});
  metrics.recordNormalization(IMAGE);
  const first = metrics.snapshot();
  assert.deepEqual(first.normalization,{payloads:1,pngBytes:100,estimatedRgbaBytes:800});
  assert.equal(first.resident.imageIds,0);
  assert.equal(first.scope.evictionEnabled,false);
  assert.equal(first.scope.terminalAcknowledged,false);
  assert.equal(metrics.recordTransport(event(metrics)),true);
  const result = metrics.snapshot();
  assert.deepEqual(result.resident,{imageIds:1,payloads:1,pngBytes:100,estimatedRgbaBytes:800,uniquePayloadPngBytes:100,uniquePayloadEstimatedRgbaBytes:800});
  assert.deepEqual(result.placements,{geometryVersions:1,occurrences:1});
  assert.deepEqual(result.transfer,{wireBytes:240,uploadChunks:2,placementCommands:1,successfulCommits:1});
});
test("repeated repaint commits add no bytes/chunks, duplicate successful upload adds transfer only", () => {
  const metrics = new GraphicsMetrics(); metrics.recordTransport(event(metrics));
  metrics.recordTransport(reused(metrics)); metrics.recordTransport(reused(metrics));
  const before = metrics.snapshot();
  metrics.recordTransport(event(metrics));
  const after = metrics.snapshot();
  assert.deepEqual(after.resident,before.resident);
  assert.deepEqual(after.placements,before.placements);
  assert.deepEqual(after.normalization,before.normalization);
  assert.equal(after.transfer.wireBytes,480); assert.equal(after.transfer.uploadChunks,4);
  assert.equal(after.transfer.successfulCommits,4);
});
test("shared payload occurrences and geometry changes count separately without retransmission", () => {
  const metrics = new GraphicsMetrics(); metrics.recordTransport(event(metrics));
  metrics.recordTransport(reused(metrics,{placementUploaded:true,wireBytes:60,placementCommands:1,
    placement:placement({placementId:3,placementKey:"a/two/60x24",occurrenceKey:"two"})}));
  metrics.recordTransport(reused(metrics,{placementUploaded:true,wireBytes:61,placementCommands:1,
    placement:placement({placementId:4,placementKey:"a/one/30x12",geometryKey:"30x12"})}));
  const result = metrics.snapshot();
  assert.equal(result.resident.imageIds,1); assert.equal(result.resident.payloads,1);
  assert.deepEqual(result.placements,{geometryVersions:3,occurrences:2});
  assert.equal(result.transfer.wireBytes,361); assert.equal(result.transfer.uploadChunks,2);
  assert.equal(result.transfer.placementCommands,3);
});
test("batch epoch replay restores all geometry prototypes and counts one wire transfer", () => {
  const metrics = new GraphicsMetrics();
  const versions = [
    {...placement(),uploaded:true},
    {...placement({placementId:3,placementKey:"a/one/30x12",geometryKey:"30x12"}),uploaded:true},
    {...placement({placementId:4,placementKey:"a/two/60x24",occurrenceKey:"two"}),uploaded:true},
  ];
  metrics.recordTransport(batch(metrics,versions,{wireBytes:500}));
  const first = metrics.snapshot();
  assert.deepEqual(first.placements,{geometryVersions:3,occurrences:2});
  assert.equal(first.transfer.wireBytes,500); assert.equal(first.transfer.uploadChunks,2);
  assert.equal(first.transfer.placementCommands,3); assert.equal(first.transfer.successfulCommits,1);
  metrics.beginEpoch(Symbol("reupload"));
  metrics.recordTransport(batch(metrics,versions,{wireBytes:500}));
  const replayed = metrics.snapshot();
  assert.deepEqual(replayed.resident,first.resident); assert.deepEqual(replayed.placements,first.placements);
  assert.equal(replayed.transfer.wireBytes,500); assert.equal(replayed.runtimeTransfer.wireBytes,1000);
  assert.equal(replayed.runtimeTransfer.uploadChunks,4); assert.equal(replayed.runtimeTransfer.placementCommands,6);
  metrics.recordTransport(batch(metrics,versions.map(entry=>({...entry,uploaded:false})),{
    imageUploaded:false,uploadChunks:0,wireBytes:0,
  }));
  assert.equal(metrics.snapshot().transfer.wireBytes,500,"reusing all restored prototypes has no wire cost");
});
test("same-ID retransmission invalidates old placements and restores only successful batch entries", () => {
  const metrics = new GraphicsMetrics();
  const versions = [{...placement(),uploaded:true},
    {...placement({placementId:3,placementKey:"a/two/30x12",occurrenceKey:"two",geometryKey:"30x12"}),uploaded:true}];
  metrics.recordTransport(batch(metrics,versions,{wireBytes:400}));
  const before = metrics.snapshot();
  assert.throws(()=>metrics.recordTransport(batch(metrics,[versions[0],{...versions[1],uploaded:false}],{
    wireBytes:300,
  })),/after image retransmission/);
  assert.deepEqual(metrics.snapshot(),before,"invalid restoration batch is atomic");
  metrics.recordTransport(batch(metrics,[versions[0]],{wireBytes:240}));
  const after = metrics.snapshot();
  assert.deepEqual(after.placements,{geometryVersions:1,occurrences:1});
  assert.equal(after.resident.imageIds,1); assert.equal(after.resident.pngBytes,100);
  assert.throws(()=>metrics.recordTransport(reused(metrics,{placement:versions[1]})),/not tracked/);
});
test("placement-only batches preserve existing prototypes, failure and stale batches count nothing", () => {
  const metrics = new GraphicsMetrics(); metrics.recordTransport(event(metrics));
  const additions = [{...placement({placementId:3,placementKey:"a/two/60x24",occurrenceKey:"two"}),uploaded:true},
    {...placement({placementId:4,placementKey:"a/one/30x12",geometryKey:"30x12"}),uploaded:true}];
  const pending = batch(metrics,additions,{imageUploaded:false,uploadChunks:0,wireBytes:120});
  const before = metrics.snapshot();
  assert.throws(()=>{ throw new Error("write failed"); metrics.recordTransport(pending); },/failed/);
  assert.deepEqual(metrics.snapshot(),before);
  metrics.recordTransport(pending);
  assert.deepEqual(metrics.snapshot().placements,{geometryVersions:3,occurrences:2});
  assert.equal(metrics.snapshot().transfer.wireBytes,360); assert.equal(metrics.snapshot().transfer.uploadChunks,2);
  const stale = pending.epoch; metrics.beginEpoch(Symbol("new"));
  assert.equal(metrics.recordTransport({...pending,epoch:stale}),false);
  assert.equal(metrics.snapshot().placements.geometryVersions,0);
});
test("batch duplicates, ambiguous shorthand and command-count mismatches fail atomically", () => {
  const metrics = new GraphicsMetrics(); metrics.recordTransport(event(metrics));
  const entry = {...placement(),uploaded:true}, before = metrics.snapshot();
  for (const invalid of [
    batch(metrics,[entry,entry]), batch(metrics,[entry],{placementCommands:2}),
    batch(metrics,[entry],{placement:placement()}), batch(metrics,[entry],{placementUploaded:true}),
    batch(metrics,[{...entry,uploaded:1}]), batch(metrics,[null]), batch(metrics,[],{imageUploaded:false,uploadChunks:0,wireBytes:10}),
  ]) {
    assert.throws(()=>metrics.recordTransport(invalid)); assert.deepEqual(metrics.snapshot(),before);
  }
  metrics.recordTransport(batch(metrics,[],{wireBytes:180}));
  assert.equal(metrics.snapshot().placements.geometryVersions,0,"image-only retransmission deletes every old prototype");
});
test("different image IDs sharing one payload expose encoded/RGBA duplicate estimates", () => {
  const metrics = new GraphicsMetrics(); metrics.recordTransport(event(metrics));
  metrics.recordTransport(event(metrics,{image:{...IMAGE,imageId:9},placement:placement({placementId:10,placementKey:"a/three/60x24",occurrenceKey:"three"})}));
  const result = metrics.snapshot();
  assert.equal(result.resident.imageIds,2); assert.equal(result.resident.payloads,1);
  assert.equal(result.resident.pngBytes,200); assert.equal(result.resident.uniquePayloadPngBytes,100);
  assert.equal(result.resident.estimatedRgbaBytes,1600); assert.equal(result.normalization.pngBytes,100);
});
test("different payloads sum independently and copied snapshots cannot mutate accounting", () => {
  const metrics = new GraphicsMetrics(); metrics.recordTransport(event(metrics));
  const other = {...IMAGE,imageId:5,payloadKey:"png:b",pngBytes:200,width:3,height:4};
  metrics.recordTransport(event(metrics,{image:other,placement:placement({placementId:6,placementKey:"b/two/60x24",occurrenceKey:"two"})}));
  other.pngBytes = 900;
  const snapshot = metrics.snapshot(); snapshot.transfer.wireBytes = -1;
  assert.equal(metrics.snapshot().resident.pngBytes,300);
  assert.equal(metrics.snapshot().resident.estimatedRgbaBytes,848);
  assert.equal(metrics.snapshot().transfer.wireBytes,480);
});
test("new epochs clear local residency but not normalization inventory/runtime transfer", () => {
  const metrics = new GraphicsMetrics({runtimeId:"runtime-a"}); metrics.recordTransport(event(metrics));
  const oldEpoch = metrics.epoch;
  const next = Symbol("reconnect"); metrics.beginEpoch(next);
  let result = metrics.snapshot();
  assert.equal(result.scope.epochNumber,2); assert.equal(result.resident.imageIds,0);
  assert.equal(result.placements.geometryVersions,0); assert.equal(result.transfer.wireBytes,0);
  assert.equal(result.normalization.pngBytes,100); assert.equal(result.runtimeTransfer.wireBytes,240);
  assert.equal(metrics.recordTransport(event(metrics,{epoch:oldEpoch})),false);
  assert.equal(metrics.recordTransport({epoch:oldEpoch,image:null}),false,"stale completion ignored before validation");
  assert.throws(()=>metrics.recordTransport(reused(metrics)),/not tracked/);
  metrics.recordTransport(event(metrics)); metrics.beginEpoch(next);
  result = metrics.snapshot();
  assert.equal(result.scope.epochNumber,2,"same token is idempotent");
  assert.equal(result.resident.imageIds,1); assert.equal(result.runtimeTransfer.wireBytes,480);
  const newRuntime = new GraphicsMetrics({runtimeId:"runtime-b",epoch:next});
  assert.equal(newRuntime.snapshot().runtimeTransfer.wireBytes,0);
  assert.equal(newRuntime.snapshot().normalization.payloads,0);
  assert.equal(newRuntime.snapshot().resident.imageIds,0,"new runtime cannot discover pixels left by old runtime");
});
test("write failure contributes no transport/residency; retry can commit successfully", () => {
  const metrics = new GraphicsMetrics(); metrics.recordNormalization(IMAGE);
  const write = () => { throw new Error("stream write failed"); };
  assert.throws(()=>{ write(); metrics.recordTransport(event(metrics)); },/failed/);
  assert.equal(metrics.snapshot().transfer.successfulCommits,0);
  assert.equal(metrics.snapshot().resident.imageIds,0);
  assert.equal(metrics.snapshot().normalization.payloads,1,"cached normalization is independent of upload failure");
  metrics.recordTransport(event(metrics));
  assert.equal(metrics.snapshot().resident.imageIds,1);
});
test("invalid/conflicting records fail atomically, including unsafe RGBA estimates", () => {
  const metrics = new GraphicsMetrics(); metrics.recordTransport(event(metrics));
  const before = metrics.snapshot();
  for (const value of [
    event(metrics,{image:{...IMAGE,imageId:0}}),
    event(metrics,{image:{...IMAGE,imageId:0x1000000}}),
    event(metrics,{image:{...IMAGE,width:Number.MAX_SAFE_INTEGER}}),
    event(metrics,{image:{...IMAGE,pngBytes:101}}),
    event(metrics,{placement:placement({geometryKey:"different"})}),
    event(metrics,{wireBytes:-1}), event(metrics,{wireBytes:0}), event(metrics,{uploadChunks:0}),
    event(metrics,{placementCommands:0}), event(metrics,{imageUploaded:1}),
  ]) {
    assert.throws(()=>metrics.recordTransport(value)); assert.deepEqual(metrics.snapshot(),before);
  }
  assert.throws(()=>metrics.recordNormalization({...IMAGE,height:21}),/changed/);
  assert.deepEqual(metrics.snapshot(),before);
  assert.throws(()=>metrics.beginEpoch(null),/token/);
});
test("cumulative transfer arithmetic rejects overflow without changing successful state", () => {
  const metrics = new GraphicsMetrics();
  metrics.recordTransport(event(metrics,{wireBytes:Number.MAX_SAFE_INTEGER}));
  const before = metrics.snapshot();
  assert.throws(()=>metrics.recordTransport(event(metrics,{wireBytes:1})),/safe integer/);
  assert.deepEqual(metrics.snapshot(),before);
});
test("deterministic long history stress stays measurement-only with no eviction", () => {
  const metrics = new GraphicsMetrics(); const count = 10000;
  for (let i = 0; i < count; i++) {
    metrics.recordTransport(event(metrics,{imageUploaded:i===0,uploadChunks:i===0?2:0,wireBytes:i===0?240:60,
      placement:placement({placementId:i+2,placementKey:`a/${i}/60x24`,occurrenceKey:`occurrence-${i}`})}));
  }
  const result = metrics.snapshot();
  assert.equal(result.resident.imageIds,1); assert.equal(result.resident.pngBytes,100);
  assert.equal(result.placements.occurrences,count); assert.equal(result.placements.geometryVersions,count);
  assert.equal(result.transfer.uploadChunks,2); assert.equal(result.transfer.placementCommands,count);
  assert.equal(result.transfer.wireBytes,240+(count-1)*60);
  assert.equal(result.scope.evictionEnabled,false);
});
test("integrated successful hooks emit exact restored batches once and ignore genuinely stale callbacks", async () => {
  class CapturingMetrics extends GraphicsMetrics {
    events = [];
    recordTransport(value) { this.events.push(structuredClone({ ...value, epoch: undefined })); return super.recordTransport(value); }
  }
  const metrics = new CapturingMetrics({runtimeId:"hook-review"});
  let nextId = 0;
  const native = createNativeRenderer({metrics,identity:new GraphicsIdentityRegistry({random:()=>++nextId})});
  const image = {type:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="};
  const job = (occurrence,columns) => ({attachment:image,occurrence,geometry:{columns,rows:1,cellWidthPx:10,cellHeightPx:20}});
  const epoch = Symbol("first");
  for (const input of [job("one",2),job("one",1),job("two",2)]) {
    const prepared = await native.prepare(input,{epoch}); prepared.onUploaded(); prepared.onUploaded();
  }
  assert.equal(metrics.events.length,3,"native finish is idempotent, not double accounted");
  const oldTotals = native.stats().runtimeTransfer;
  const stale = await native.prepare(job("uncommitted",2),{epoch});
  const newEpoch = Symbol("refresh");
  const restored = await native.prepare(job("one",1),{epoch:newEpoch});
  stale.onUploaded();
  assert.equal(metrics.events.length,3,"replaced-epoch callback without abort is still ignored");
  assert.equal(native.stats().transfer.wireBytes,0);
  restored.onUploaded();
  const event = metrics.events.at(-1);
  assert.equal(event.imageUploaded,true); assert.equal(event.uploadChunks,restored.metrics.uploadChunks);
  assert.equal(event.wireBytes,Buffer.byteLength(restored.uploads));
  assert.equal(event.placementCommands,3); assert.equal(event.placements.length,3);
  assert.ok(event.placements.every(entry=>entry.uploaded === true));
  assert.deepEqual(new Set(event.placements.map(entry=>entry.occurrenceKey)),new Set(["one","two"]));
  assert.equal(new Set(event.placements.map(entry=>entry.placementKey)).size,3);
  const result = native.stats();
  assert.equal(result.transfer.successfulCommits,1); assert.equal(result.transfer.wireBytes,event.wireBytes);
  assert.equal(result.runtimeTransfer.wireBytes,oldTotals.wireBytes+event.wireBytes);
  assert.deepEqual(result.placements,{geometryVersions:3,occurrences:2});
  assert.equal(result.accounting.errors,0);
  const reuse = await native.prepare(job("two",2),{epoch:newEpoch}); reuse.onUploaded();
  assert.equal(reuse.uploads,""); assert.equal(metrics.events.length,4,"zero-byte reuse omits accounting hook entirely");
  assert.equal(native.stats().transfer.successfulCommits,1);
});

test("many unique payloads remain resident; estimates grow rather than silently evict", () => {
  const metrics = new GraphicsMetrics(); const count = 1000;
  for (let i = 0; i < count; i++) {
    metrics.recordTransport(event(metrics,{image:{...IMAGE,imageId:i+1,payloadKey:`png:${i}`},
      placement:placement({placementId:i+1,placementKey:`${i}/occurrence/60x24`,occurrenceKey:`occurrence-${i}`})}));
  }
  const result = metrics.snapshot();
  assert.equal(result.resident.imageIds,count); assert.equal(result.resident.payloads,count);
  assert.equal(result.resident.pngBytes,count*100); assert.equal(result.resident.estimatedRgbaBytes,count*800);
  assert.equal(result.normalization.payloads,count); assert.equal(result.placements.occurrences,count);
  assert.equal(result.transfer.wireBytes,count*240); assert.equal(result.transfer.uploadChunks,count*2);
  assert.equal(result.scope.evictionEnabled,false);
});

test("explicit viewer replacements update one surface without mutating immutable inline contracts", () => {
  const metrics = new GraphicsMetrics(); metrics.recordTransport(event(metrics));
  const viewer = { ...placement({ placementId: 9, placementKey: "private", occurrenceKey: "page" }), surface: "viewer", operation: "create", uploaded: true };
  metrics.recordTransport(batch(metrics, [viewer], { imageUploaded: false, uploadChunks: 0, wireBytes: 60 }));
  for (let n = 0; n < 10000; n++) {
    metrics.recordTransport(batch(metrics, [{ ...viewer, operation: "replace", geometryKey: `canvas:${n % 2}`, occurrenceKey: `page:${n % 2}` }],
      { imageUploaded: false, uploadChunks: 0, wireBytes: 61 }));
  }
  let result = metrics.snapshot();
  assert.deepEqual(result.surfaces, { inline: 1, viewer: 1, liveViewer: 1 });
  assert.equal(result.placements.geometryVersions, 2);
  assert.equal(result.surfaceTransfer.replacementCommands, 10000);
  const before = metrics.snapshot();
  assert.throws(() => metrics.recordTransport(batch(metrics, [{ ...placement(), uploaded: true, operation: "replace", geometryKey: "different" }],
    { imageUploaded: false, uploadChunks: 0, wireBytes: 61 })), /viewer/);
  assert.deepEqual(metrics.snapshot(), before);
  metrics.recordViewerRelease({ imageId: 1, placementId: 9 });
  result = metrics.snapshot();
  assert.equal(result.surfaces.liveViewer, 0);
  assert.equal(result.surfaces.viewer, 1, "released is logically inactive, not proof of terminal deletion");
  assert.deepEqual(result.transfer, before.transfer);
});

test("successful owned retirement accounts exact wire once, removes private metadata and preserves shared image", () => {
  const metrics = new GraphicsMetrics();
  const viewer = { ...placement({ placementId: 9, placementKey: "private" }), surface: "viewer", uploaded: true };
  metrics.recordTransport(batch(metrics, [{ ...placement(), uploaded: true }, viewer], { wireBytes: 300 }));
  const before = metrics.snapshot();
  assert.throws(() => metrics.recordRetirement({ epoch: metrics.epoch, imageId: 1, placementId: 2, wireBytes: 55 }), /inline/);
  assert.deepEqual(metrics.snapshot(), before);
  metrics.recordRetirement({ epoch: metrics.epoch, imageId: 1, placementId: 9, wireBytes: 55 });
  const result = metrics.snapshot();
  assert.equal(result.surfaces.viewer, 0); assert.equal(result.placements.geometryVersions, 1);
  assert.deepEqual(result.resident, before.resident);
  assert.equal(result.transfer.wireBytes, 355); assert.equal(result.transfer.uploadChunks, 2);
  assert.equal(result.transfer.placementCommands, 2); assert.equal(result.surfaceTransfer.retirementCommands, 1);
  assert.equal(result.transfer.successfulCommits, 2);
});

test("retirement after epoch reset accepts owned old tuple without inventing image residency", () => {
  const metrics = new GraphicsMetrics();
  const epoch = metrics.epoch;
  metrics.beginEpoch(Symbol("new"));
  const before = metrics.snapshot();
  assert.equal(metrics.recordRetirement({ epoch, imageId: 1, placementId: 9, wireBytes: 55 }), false);
  assert.deepEqual(metrics.snapshot(), before);
  metrics.recordRetirement({ epoch: metrics.epoch, imageId: 1, placementId: 9, wireBytes: 55 });
  const result = metrics.snapshot();
  assert.equal(result.resident.imageIds, 0); assert.equal(result.normalization.payloads, 0);
  assert.equal(result.placements.geometryVersions, 0); assert.equal(result.surfaceTransfer.retirementCommands, 1);
  assert.equal(result.transfer.wireBytes, 55); assert.equal(result.transfer.uploadChunks, 0);
});

test("same-ID retransmission can restore changed live private canvas but not mutate inline identity", () => {
  const metrics = new GraphicsMetrics();
  const viewer = { ...placement({ placementId: 9, placementKey: "private" }), surface: "viewer", uploaded: true };
  metrics.recordTransport(batch(metrics, [{ ...placement(), uploaded: true }, viewer], { wireBytes: 300 }));
  metrics.recordTransport(batch(metrics, [{ ...placement(), uploaded: true, operation: "restore" },
    { ...viewer, geometryKey: "new canvas", operation: "restore" }], { wireBytes: 301 }));
  assert.equal(metrics.snapshot().surfaceTransfer.replacementCommands, 0, "restoration is not a user zoom command");
  assert.equal(metrics.snapshot().placements.geometryVersions, 2);
});
