#!/usr/bin/env node
// Compare identical standalone normal-scheduling traces; no timing thresholds.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [baselinePath, candidatePath] = process.argv.slice(2);
if (!baselinePath || !candidatePath) throw new Error('Usage: node scripts/viewer-pacing-compare.mjs baseline.json candidate.json');
const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
for (const run of [baseline, candidate]) {
  assert.equal(typeof run.piVersion, 'string'); assert.equal(typeof run.node, 'string');
  assert.ok(run.harnessHashes && Object.keys(run.harnessHashes).length > 0, 'missing harness hashes');
  assert.equal(run.profileMode, 'normal-scheduling matched trace');
  assert.deepEqual(run.sourceHashesAfter, run.sourceHashes);
  assert.deepEqual(run.harnessHashesAfter, run.harnessHashes);
}
for (const key of ['cells', 'piVersion', 'node', 'profileMode', 'fixtureGeneration', 'harnessHashes']) {
  assert.deepEqual(candidate[key], baseline[key], `unmatched run assumption: ${key}`);
}
assert.equal(baseline.measurements.length, candidate.measurements.length);
const rows = baseline.measurements.map((before, index) => {
  const after = candidate.measurements[index];
  for (const key of ['pane', 'mode', 'workload', 'shape', 'image', 'fixtureSha256', 'canvas', 'occupied', 'offeredReportsPerSecond', 'targetDurationMs', 'reports', 'expectedFinalWindow']) {
    assert.deepEqual(after[key], before[key], `unmatched workload: ${key} at case ${index}`);
  }
  assert.equal(typeof before.mode, 'string'); assert.equal(typeof before.workload, 'string');
  assert.equal(after.fifoComparisons.length, before.fifoComparisons.length, `unmatched FIFO count at case ${index}`);
  before.fifoComparisons.forEach((f, fifoIndex) => {
    assert.ok(f.capacityBytesPerSecond > 0 && f.storageLimitBytes > 0 && Array.isArray(f.stallsMs), 'missing FIFO assumptions');
    for (const key of ['capacityBytesPerSecond', 'storageLimitBytes', 'stallsMs']) {
      assert.deepEqual(after.fifoComparisons[fifoIndex][key], f[key], `unmatched FIFO ${key} at case ${index}`);
    }
  });
  for (const m of [before, after]) {
    assert.deepEqual(m.observedFinalWindow, m.expectedFinalWindow);
    assert.equal(m.output.graphicsBytes, 0); assert.equal(m.prepares, 0); assert.equal(m.guards, 0);
    for (const f of m.fifoComparisons) {
      assert.equal(f.end.emittedBytes, f.end.drainedBytes + f.end.pendingBytes);
      assert.equal(f.final.emittedBytes, f.final.drainedBytes); assert.equal(f.final.pendingBytes, 0);
    }
  }
  return { pane: before.pane, shape: before.shape, rate: before.offeredReportsPerSecond, horizonMs: before.targetDurationMs,
    before: { reuses: before.residentReuses, textBytes: before.output.textBytes, acceptedInputDurationMs: before.actualInputDurationMs,
      ingressLatenessMs: before.eventLoopLatenessMs, finalReleaseToReceiptMs: before.finalMatchingPlaceholderWriteAfterReleaseMs,
      writesInIdleTail: before.writesAfterFinalSettlementDuring200ms, fifos: before.fifoComparisons },
    after: { reuses: after.residentReuses, textBytes: after.output.textBytes, acceptedInputDurationMs: after.actualInputDurationMs,
      ingressLatenessMs: after.eventLoopLatenessMs, finalReleaseToReceiptMs: after.finalMatchingPlaceholderWriteAfterReleaseMs,
      writesInIdleTail: after.writesAfterFinalSettlementDuring200ms, fifos: after.fifoComparisons },
    reuseReductionPercent: 100 * (1 - after.residentReuses / before.residentReuses),
    textReductionPercent: 100 * (1 - after.output.textBytes / before.output.textBytes) };
});
const horizons = rows.filter((r) => r.pane.columns === 292 && r.shape === 'landscape' && r.rate === 250).toSorted((a, b) => a.horizonMs - b.horizonMs);
const trends = ['before', 'after'].flatMap((side) => [4_000_000, 1_000_000, 250_000].map((capacity) => ({
  side, capacityBytesPerSecond: capacity,
  samples: horizons.map((r) => {
    const f = r[side].fifos.find((f) => f.capacityBytesPerSecond === capacity);
    return { offeredHorizonMs: r.horizonMs, actualObservationHorizonMs: f.observationHorizonMs,
      pendingBytes: f.end.pendingBytes, peakBytes: f.end.peakPendingBytes,
      oldestPendingAgeMs: f.end.oldestPendingAgeMs, overload: f.end.overload, idleDrainTailMs: f.idleDrainTailMs };
  }),
})));
console.log(JSON.stringify({ baselineSource: baseline.sourceHashes, candidateSource: candidate.sourceHashes, harnessHashes: baseline.harnessHashes,
  assumptions: { piVersion: baseline.piVersion, node: baseline.node, profileMode: baseline.profileMode, cells: baseline.cells },
  baselineCpuContext: [baseline.before, baseline.after], candidateCpuContext: [candidate.before, candidate.after],
  limitations: 'Fixed generated offered traces; actual acceptance horizons differ under overload. FIFO capacities conditional, not terminal ACKs. No automatic numerical performance pass threshold.', rows, trends }, null, 2));
