#!/usr/bin/env node
// Deliberately standalone: timings are never assertions in npm test.
// PI_OFFLINE=1 PI_TEST_HOST_ROOT=/installed/pi-package PI_PROFILE_MODE=trace node scripts/viewer-pacing-profile.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { availableParallelism, cpus, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pdfSnapshots } from './viewer-pacing-profile-pdf.mjs';
const sourceRoot = resolve(process.env.PI_PROFILE_SOURCE_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const fromSource = (name) => import(pathToFileURL(join(sourceRoot, 'src', name)).href);
const { createNativeRenderer } = await fromSource('native.mjs');
const { createPresentation } = await fromSource('presentation.mjs');
const { createViewerController, viewerArea } = await fromSource('viewer.mjs');
const { computeViewport, panViewport } = await fromSource('viewport.mjs');
const { PLACEHOLDER, DIACRITICS: uiMarks, encodeViewportRows } = await fromSource('kitty.mjs');
import { CaptureTerminal, FifoLedger, fifoSelfCheck, pngFixture, sgr, summary } from './viewer-pacing-profile-support.mjs';

const root = process.env.PI_TEST_HOST_ROOT && resolve(process.env.PI_TEST_HOST_ROOT);
if (!root) throw new Error('Set PI_TEST_HOST_ROOT to the installed Pi public package root. No dependencies are installed.');
if (process.env.PI_TUI_WRITE_LOG) throw new Error('Unset PI_TUI_WRITE_LOG: this capture benchmark must not enable raw owner-path logging.');
const host = await import(pathToFileURL(join(root, 'dist/index.js')).href);
const ui = await import(pathToFileURL(createRequire(join(root, 'dist/index.js')).resolve('@earendil-works/pi-tui')).href);
const traceMode = process.env.PI_PROFILE_MODE === 'trace';
const boundedMatrix = process.env.PI_PROFILE_TRACE_MATRIX === 'bounded';
const traceCases = boundedMatrix ? [
  { columns: 40, rows: 16, rate: 125, duration: 400, fixture: 'landscape' },
  { columns: 100, rows: 40, rate: 125, duration: 400, fixture: 'landscape' },
  { columns: 200, rows: 60, rate: 125, duration: 400, fixture: 'landscape' },
  ...[60, 125].map((rate) => ({ columns: 292, rows: 61, rate, duration: 1000, fixture: 'landscape' })),
  ...[1000, 3000, 6000].map((duration) => ({ columns: 292, rows: 61, rate: 250, duration, fixture: 'landscape' })),
  { columns: 292, rows: 61, rate: 1000, duration: 250, fixture: 'landscape' },
  ...['portrait', 'pdf-page-1', 'pdf-page-2'].map((fixture) => ({ columns: 100, rows: 40, rate: 125, duration: 400, fixture })),
] : [[40,16], [100,40], [200,60], [292,61]].map(([columns, rows]) => ({ columns, rows }));
let pdfFixtures;
if (traceMode && boundedMatrix) {
  const { withPdfPages } = await fromSource('pdf.mjs');
  pdfFixtures = await pdfSnapshots(withPdfPages);
}

if (process.env.PI_PROFILE_MODE && !['baseline', 'trace'].includes(process.env.PI_PROFILE_MODE)) throw new Error('PI_PROFILE_MODE must be baseline or trace');
const samples = Number(process.env.PI_PROFILE_SAMPLES || 16);
assert.ok(Number.isSafeInteger(samples) && samples >= 4 && samples <= 200);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(predicate) {
  const deadline = performance.now() + 10000;
  while (!predicate()) { assert.ok(performance.now() < deadline, 'capture viewer failed to become ready'); await sleep(5); }
}
const metadataCommandOptions = { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024, killSignal: 'SIGKILL' };
const git = (...args) => execFileSync('git', args, metadataCommandOptions).trim();
const context = () => ({ loadAverage: loadavg(), logicalCpus: cpus().length, availableParallelism: availableParallelism(),
  // Lifetime-average %CPU is context, not an instantaneous utilization measurement.
  processes: execFileSync('ps', ['-eo', 'comm,pcpu', '--sort=-pcpu'], metadataCommandOptions).trim().split('\n').slice(0, 9) });
const sourceHashes = async () => Object.fromEntries(await Promise.all(['src/viewer.mjs', 'src/native.mjs', 'src/presentation.mjs', 'src/viewport.mjs', 'src/viewer-pacing.mjs', 'src/pdf.mjs'].map(async (path) => {
  try { return [path, createHash('sha256').update(await readFile(join(sourceRoot, path))).digest('hex')]; }
  catch (error) { if (error.code !== 'ENOENT' || path !== 'src/viewer-pacing.mjs') throw error; return [path, null]; }
})));
const harnessRoot = dirname(fileURLToPath(import.meta.url));
const harnessHashes = async () => Object.fromEntries(await Promise.all([
  'viewer-pacing-profile.mjs', 'viewer-pacing-profile-support.mjs', 'viewer-pacing-profile-pdf.mjs', 'viewer-pacing-compare.mjs',
].map(async (path) => [path, createHash('sha256').update(await readFile(join(harnessRoot, path))).digest('hex')])));
const recordedHarnessHashes = await harnessHashes();
const recordedSourceHashes = await sourceHashes();
if (!traceMode) {
  assert.ok(process.env.PI_PROFILE_SOURCE_ROOT && /^1f00268(?:[0-9a-f]*)$/.test(process.env.PI_PROFILE_SOURCE_REVISION || ''),
    'Forced changed-frame mode is baseline-only: explicitly export 1f00268 and set PI_PROFILE_SOURCE_ROOT / PI_PROFILE_SOURCE_REVISION. Use PI_PROFILE_MODE=trace for the candidate.');
  const approvedBaseline = {
    'src/viewer.mjs': '56091474f57867876453de3f9c2bea3b93b0d75087b7765a02f0f72e6be62060',
    'src/native.mjs': 'c03cb3332eaa36500b3ed5eb536b1b4038359405311c840d2dc63bb06e09df06',
    'src/presentation.mjs': '12265f6f05c21dddc36f9bb5e91851c48418eb1dd9e60639d8988cd4322401a6',
    'src/viewport.mjs': '3f80c1e9fde2255bd8a22056fcf79cb2a1c9c9ce4e0545f274cca767a5fb476b',
  };
  for (const [path, hash] of Object.entries(approvedBaseline)) assert.equal(recordedSourceHashes[path], hash,
    `Forced changed-frame source differs from approved 1f00268 baseline: ${path}`);
}
fifoSelfCheck();
const saved = ui.getCapabilities();
ui.setCapabilities({ images: null, trueColor: true, hyperlinks: true }); // Isolated benchmark process only.
const cells = ui.getCellDimensions(); // No fabricated physical-terminal response.
const started = performance.now(), cpuStart = process.cpuUsage();
const report = { schema: 1, revision: git('rev-parse', 'HEAD'), sourceRoot,
  sourceRevisionLabel: process.env.PI_PROFILE_SOURCE_REVISION || 'working checkout; source hashes are authoritative',
  dirty: git('status', '--short'), sourceHashes: recordedSourceHashes, harnessHashes: recordedHarnessHashes,
  node: process.version, piVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
  hostRoot: root, fixtureGeneration: { pdfRasterizationPasses: pdfFixtures ? 1 : 0, pdfSnapshots: pdfFixtures?.size || 0 },
  profileMode: traceMode ? 'normal-scheduling matched trace' : 'baseline forced changed-frame plus normal trace', cells, samples, before: context(), limitations: [
    'Public TUI plus production controller/native, simplified background; not InteractiveMode/session SDK overhead.',
    'Injected supported capability guards count calls but do not run real tmux probes.',
    'Public default cell dimensions, not owner-measured cell pixels; no terminal ACK, real output path or GPU measurement.',
    'Input/commit revision values are harness ordinals at injected seams, not private canonical controller state.',
    'Synthetic cadence estimates are not a production pacing implementation or acceptance proof.',
  ], measurements: [], fifoComparisons: [] };

async function setup(columns, rows, shape, mode) {
  const png = pdfFixtures?.get(shape) || pngFixture(shape === 'landscape' ? 1200 : 600, shape === 'landscape' ? 600 : 1200);
  const dimensions = ui.getPngDimensions(png.toString('base64')); assert.ok(dimensions);
  const image = { width: dimensions.widthPx, height: dimensions.heightPx };
  const attachment = { type: 'image', mimeType: 'image/png', data: png.toString('base64') };
  const label = shape.startsWith('pdf-page-') ? `Generated coordinate PDF — page ${shape.at(-1)}` : `Generated ${shape} coordinate fixture`;
  const snapshot = Object.freeze({ occurrence: 'benchmark-snapshot', label, attachment });
  const terminal = new CaptureTerminal(columns, rows);
  const tui = mode === 'fullscreen' ? new ui.TuiAltScreen(terminal) : new ui.TuiMainScreen(terminal);
  let widget, ordinal = 0, lastPrepared, encodeTimes = [], reuseCalls = 0, prepareCalls = 0, guardCalls = 0, normalizationCalls = 0;
  const owner = createNativeRenderer({ convertToPng: host.convertToPng });
  // Instrument injected package interfaces, never mutate/patch host objects.
  const native = { ...owner,
    resolvePayload(...args) { normalizationCalls++; return owner.resolvePayload(...args); },
    async prepareViewer(...args) { prepareCalls++; const result = await owner.prepareViewer(...args); lastPrepared = { input: args[0], result, ordinal }; return result; },
    reuseViewer(...args) {
      const start = performance.now(), result = owner.reuseViewer(...args);
      encodeTimes.push(performance.now() - start); reuseCalls++;
      if (result) lastPrepared = { input: args[0], result, ordinal };
      return result;
    },
  };
  const presentation = createPresentation();
  const ctx = { mode: 'tui', ui: { setWidget(_key, factory) { widget = factory(tui); } } };
  presentation.attach(ctx, true);
  const editor = { focused: false, render: () => ['Benchmark draft'], invalidate() {}, handleInput() { throw new Error('viewer leaked input to editor'); } };
  tui.addChild(new ui.Text('Background transcript for public-host compositing\n'.repeat(rows), 0, 0));
  tui.addChild(editor); tui.setFocus(editor);
  const viewer = createViewerController({ native, presentation, getContext: () => ctx, getSnapshots: () => [snapshot],
    requireCapability: async (_ctx, signal) => { guardCalls++; signal?.throwIfAborted(); }, readyPolicy: () => undefined,
    getCells: ui.getCellDimensions, matchesKey: ui.matchesKey, parseKey: ui.parseKey,
    visibleWidth: ui.visibleWidth, truncateToWidth: ui.truncateToWidth,
    style: (_kind, text) => `\x1b[35m${text}\x1b[0m`,
    notify(message) { throw new Error(message); } });
  terminal.onWrite = (data) => {
    const index = data.indexOf(PLACEHOLDER);
    if (index >= 0 && lastPrepared?.result.isResident?.()) {
      terminal.lastCellWriteAt = performance.now(); terminal.lastCellWriteOrdinal = lastPrepared.ordinal;
      // Public emitted first-cell marks must match the committed subset origin.
      const marks = Array.from(data.slice(index));
      terminal.lastCellWriteWindowKey = undefined;
      if (marks[1] === uiMarks[lastPrepared.input.window.rowOffset] && marks[2] === uiMarks[lastPrepared.input.window.columnOffset]) {
        terminal.lastCellWriteWindowKey = JSON.stringify(lastPrepared.input.window);
        terminal.lastMatchingWriteAt = performance.now();
      }
    }
  };
  tui.start(); tui.renderNow();
  const done = viewer.open();
  await until(() => { tui.renderNow(); return Boolean(lastPrepared?.result.isResident?.()); });
  // Largest bounded canvas genuinely occupies both axes where the aspect permits.
  const area = viewerArea(columns, rows).area;
  const max = computeViewport({ image, area, cells, zoomFactor: 1 }).maxZoomFactor;
  let zoom = 1;
  while (zoom < max) {
    const previous = lastPrepared; terminal.send('+');
    await until(() => lastPrepared !== previous && lastPrepared.result.isResident?.() && terminal.lastCellWriteWindowKey === JSON.stringify(lastPrepared.input.window));
    zoom = Math.min(max, zoom * 1.25);
  }
  tui.renderNow();
  const baseStats = owner.stats(presentation.epoch);
  const view = computeViewport({ image, area, cells, zoomFactor: max });
  assert.deepEqual(lastPrepared.input.canvas.columns, view.canvas.columns);
  return { terminal, tui, owner, view, image, shape, fixtureSha256: createHash('sha256').update(png).digest('hex'), pngBytes: png.length,
    get lastPrepared() { return lastPrepared; },
    set ordinal(value) { ordinal = value; },
    counters() { return { reuseCalls, prepareCalls, guardCalls, normalizationCalls }; },
    reset() { encodeTimes = []; terminal.writes = []; },
    get encodeTimes() { return encodeTimes; }, baseStats,
    async close() { await viewer.close('benchmark'); await done; await viewer.dispose(); presentation.disconnect(); widget?.dispose(); tui.stop(); },
  };
}

function bytes(writes) {
  const graphics = writes.filter((write) => write.graphics), text = writes.filter((write) => !write.graphics);
  return { textBytes: text.reduce((n, w) => n + w.bytes, 0), textWrites: text.length,
    graphicsBytes: graphics.reduce((n, w) => n + w.bytes, 0), graphicsWrites: graphics.length };
}

function assertPublicWindow(lines, window) {
  const rows = lines.filter((line) => line.includes(PLACEHOLDER));
  assert.equal(rows.length, window.rows, 'public final frame has wrong occupied row count');
  rows.forEach((line, row) => {
    const text = ui.stripTerminalSequences(line);
    const encoded = Array.from(text.matchAll(/\u{10eeee}(.)(.)/gu));
    assert.equal(encoded.length, window.columns, 'public final frame has wrong occupied column count');
    encoded.forEach((match, column) => {
      assert.equal(match[1], uiMarks[window.rowOffset + row]);
      assert.equal(match[2], uiMarks[window.columnOffset + column]);
    });
  });
}

async function matchedTrace(h, columns, rows, offeredRate, offeredDuration) {
  const point = { x: Math.floor(columns / 2), y: Math.floor(rows / 2) };
  const rate = offeredRate ?? (columns === 292 ? 250 : 125), duration = offeredDuration ?? (columns === 292 ? 1200 : 400);
  const count = Math.floor(duration * rate / 1000), before = h.counters();
  let state = { zoomFactor: h.view.zoomFactor, center: h.view.center }, last = point;
  const input = () => ({ image: h.image, area: viewerArea(columns, rows).area, cells, ...state });
  const accept = (next, release = false) => {
    state = panViewport(input(), { xCells: last.x - next.x, yCells: last.y - next.y });
    last = next; h.terminal.mouse(release ? 0 : 32, next.x, next.y, release);
  };
  h.reset(); h.terminal.mouse(0, point.x, point.y);
  const started = performance.now(), late = [], handlers = [];
  for (let n = 0; n < count; n++) {
    const due = started + n * 1000 / rate;
    await sleep(Math.max(0, due - performance.now()));
    late.push(Math.max(0, performance.now() - due)); h.ordinal = n + 1;
    const triangle = (period) => Math.min(n % period, period - n % period) - period / 4;
    const next = { x: point.x + Math.round(triangle(12)), y: point.y + Math.round(triangle(20)) };
    const at = performance.now(); accept(next); handlers.push(performance.now() - at);
  }
  const releaseAt = performance.now(); h.ordinal = count + 1; accept({ x: point.x + 2, y: point.y + 2 }, true);
  const expected = computeViewport(input()), expectedKey = JSON.stringify(expected.window);
  // No forced render/adoption while waiting: final geometry and independently
  // addressed emitted first-cell marks must agree using normal host scheduling.
  await until(() => h.lastPrepared.result.isResident?.() && JSON.stringify(h.lastPrepared.input.window) === expectedKey &&
    h.terminal.lastCellWriteWindowKey === expectedKey);
  const settledAt = performance.now(), finalWriteAt = h.terminal.lastMatchingWriteAt;
  assertPublicWindow(h.tui.getScreenLines(), expected.window);
  const after = h.counters(), nativeStats = h.owner.stats();
  assert.equal(nativeStats.viewer.allocatedIds, h.baseStats.viewer.allocatedIds);
  assert.equal(after.prepareCalls, before.prepareCalls); assert.equal(after.guardCalls, before.guardCalls);
  const writesAtSettlement = h.terminal.writes.length;
  await sleep(200); // Observe a stop/idle tail without new input or renderNow.
  assert.deepEqual(h.counters(), after, 'idle tail performed new native reuse/prepare/guard/payload work');
  assert.deepEqual(h.lastPrepared.input.window, expected.window, 'idle tail produced a historical viewport');
  assertPublicWindow(h.tui.getScreenLines(), expected.window);
  const writes = h.terminal.writes.map((w) => ({ ...w, at: Math.max(0, w.at - started) }));
  assert.equal(bytes(writes).graphicsBytes, 0);
  const observationHorizon = performance.now() - started;
  const fifoComparisons = [4_000_000, 1_000_000, 250_000].map((capacity) => {
    const ledger = new FifoLedger({ bytesPerSecond: capacity, storageLimit: 1024 * 1024, stalls: [[200,300]] });
    for (const write of writes) ledger.write(write.bytes, write.at);
    ledger.advance(observationHorizon); const end = ledger.snapshot(), drainStart = ledger.now;
    while (ledger.pending) ledger.advance(ledger.now + 1);
    return { capacityBytesPerSecond: capacity, storageLimitBytes: 1024 * 1024, stallsMs: [[200,300]],
      observationHorizonMs: drainStart, end, idleDrainTailMs: ledger.now - drainStart, final: ledger.snapshot() };
  });
  return { pane: { columns, rows }, mode: 'fullscreen', shape: h.shape, image: h.image,
    fixtureSha256: h.fixtureSha256,
    gestureInvariants: { sourceReads: 0, modelRequests: 0, session: 'not instantiated',
      resolvedPayloadCalls: after.normalizationCalls, normalizedPayloadInventory: nativeStats.normalization.payloads,
      allocatedIds: nativeStats.viewer.allocatedIds },
    canvas: h.view.canvas, occupied: h.view.window, workload: 'matched triangular two-axis normal-scheduling drag and final release',
    offeredReportsPerSecond: rate, targetDurationMs: duration, reports: count, actualInputDurationMs: releaseAt - started,
    inputHandlerIncludingReferenceMathMs: summary(handlers), eventLoopLatenessMs: summary(late),
    residentReuses: after.reuseCalls - before.reuseCalls, prepares: 0, guards: 0,
    expectedFinalWindow: expected.window, observedFinalWindow: h.lastPrepared.input.window,
    finalAcceptedInputOrdinal: count + 1, finalSampleSeamOrdinal: h.lastPrepared.ordinal,
    finalReceiptAlreadySatisfiedBeforeRelease: finalWriteAt < releaseAt,
    finalMatchingPlaceholderWriteAfterReleaseMs: Math.max(0, finalWriteAt - releaseAt),
    finalSettleObservationAfterReleaseMs: settledAt - releaseAt,
    writesAfterFinalSettlementDuring200ms: writes.length - writesAtSettlement, output: bytes(writes),
    fifoComparisons,
    limits: 'sample ordinal is latest input ordinal at injected reuse; final mapping is compared with sequential production pure math, not an independent clamp proof' };
}

for (const { columns, rows, rate, duration, fixture } of traceCases) {
  for (const mode of traceMode ? ['fullscreen'] : ['fullscreen', 'regular']) {
    // Portrait first-pass comparison at 100x40 only; explicitly not full matrix.
    for (const shape of fixture ? [fixture] : columns === 100 && mode === 'fullscreen' && !traceMode ? ['landscape', 'portrait'] : ['landscape']) {
      const h = await setup(columns, rows, shape, mode);
      try {
        if (traceMode) {
          report.measurements.push(await matchedTrace(h, columns, rows, rate, duration));
          continue;
        }
        h.reset();
        const before = h.counters(), handlers = [], renders = [], frameBytes = [], frameWrites = [];
        const point = { x: Math.floor(columns / 2), y: Math.floor(rows / 2) };
        // Warm-up, then alternating resident pan changed frames. Keyboard is the
        // regular-mode equivalent; fullscreen traverses actual normalized capture.
        if (mode === 'fullscreen') h.terminal.mouse(0, point.x, point.y);
        for (let n = 0; n < samples + 3; n++) {
          h.ordinal = n + 1;
          const start = performance.now();
          if (mode === 'fullscreen') h.terminal.mouse(32, point.x + (n % 2), point.y + (n % 2));
          else h.terminal.send(n % 2 ? 'l' : 'h');
          const handler = performance.now() - start, index = h.terminal.writes.length;
          const renderStart = performance.now(); h.tui.renderNow(); const render = performance.now() - renderStart;
          if (n >= 3) { handlers.push(handler); renders.push(render); const output = bytes(h.terminal.writes.slice(index)); frameBytes.push(output.textBytes); frameWrites.push(output.textWrites); }
        }
        if (mode === 'fullscreen') h.terminal.mouse(0, point.x, point.y, true);
        const after = h.counters(), transport = h.owner.stats();
        assert.equal(after.prepareCalls, before.prepareCalls, 'resident pan unexpectedly prepared graphics');
        assert.equal(after.guardCalls, before.guardCalls, 'resident pan unexpectedly probed');
        assert.equal(bytes(h.terminal.writes).graphicsBytes, 0);
        assert.equal(transport.viewer.allocatedIds, h.baseStats.viewer.allocatedIds);
        const measured = { pane: { columns, rows }, mode, shape, image: h.image, pngBytes: h.pngBytes,
          canvas: h.view.canvas, occupied: h.view.window, bothAxesOccupied: h.view.window.columns === columns - 4 && h.view.window.rows === rows - 6,
          maxZoomFactor: h.view.zoomFactor, inputHandlerMs: summary(handlers), fullHostRenderMs: summary(renders),
          nativeReuseEncodingMs: summary(h.encodeTimes), changedFrameTextBytes: summary(frameBytes), changedFrameTextWrites: summary(frameWrites),
          counters: { reuseCalls: after.reuseCalls - before.reuseCalls, prepares: 0, guards: 0, normalizationCalls: after.normalizationCalls,
            sourceReads: 0, modelRequests: 0, sessionMessages: 'not instantiated', allocatedIds: transport.viewer.allocatedIds },
          setupTransport: h.baseStats.transfer, residentPanOutput: bytes(h.terminal.writes) };
        if (mode === 'fullscreen') {
          // Batched raw SGR -> exported StdinBuffer -> installed TUI input callback.
          const buffer = new ui.StdinBuffer(); buffer.on('data', (data) => h.terminal.send(data));
          const beforeBatch = h.counters(); h.reset(); h.terminal.mouse(0, point.x, point.y);
          const batch = Array.from({ length: 1000 }, (_, n) => sgr(32, point.x + n % 2, point.y + n % 2)).join('') + sgr(0, point.x + 1, point.y + 1, true);
          const batchStart = performance.now(); buffer.process(batch); const batchMs = performance.now() - batchStart;
          buffer.destroy(); h.tui.renderNow();
          measured.batched1000 = { wallMs: batchMs, reuses: h.counters().reuseCalls - beforeBatch.reuseCalls, ...bytes(h.terminal.writes) };
          // Separate-turn offered input, normal requestRender scheduling (no forced
          // per-report frame). Timers reflect local reception, not device time.
          const rate = columns === 292 ? 250 : 125, duration = columns === 292 ? 1200 : 400;
          h.reset(); h.tui.renderNow(); h.terminal.mouse(0, point.x, point.y);
          const offeredAt = performance.now(), late = [], ages = [], count = Math.floor(duration * rate / 1000);
          const beforeFlood = h.counters();
          for (let n = 0; n < count; n++) {
            const due = offeredAt + n * 1000 / rate;
            await sleep(Math.max(0, due - performance.now()));
            late.push(Math.max(0, performance.now() - due)); h.ordinal = n + 1;
            const triangle = (period) => Math.min(n % period, period - n % period) - period / 4;
            const accepted = performance.now(); h.terminal.mouse(32, point.x + Math.round(triangle(12)), point.y + Math.round(triangle(20)));
            ages.push(performance.now() - accepted); // Handler completion age, not receipt.
          }
          const releaseAt = performance.now(); h.ordinal = count + 1; h.terminal.mouse(0, point.x + 2, point.y + 2, true);
          await sleep(200);
          assert.equal(h.terminal.lastCellWriteOrdinal, count + 1, 'final release pose was not emitted by the capture host');
          assert.equal(h.counters().prepareCalls, beforeFlood.prepareCalls);
          assert.equal(h.counters().guardCalls, beforeFlood.guardCalls);
          const writes = h.terminal.writes.map((w) => ({ ...w, at: Math.max(0, w.at - offeredAt) }));
          const fifo = new FifoLedger({ bytesPerSecond: 1_000_000, storageLimit: 8 * 1024 * 1024, stalls: [[200, 300]] });
          for (const write of writes) fifo.write(write.bytes, write.at);
          const endAt = performance.now() - offeredAt; fifo.advance(endAt); const end = fifo.snapshot();
          const drainStart = endAt;
          while (fifo.pending) fifo.advance(fifo.now + 1);
          measured.separateTurns = { offeredReportsPerSecond: rate, targetDurationMs: duration, reports: count,
            actualInputDurationMs: releaseAt - offeredAt, eventLoopLatenessMs: summary(late), handlerCompletionAgeMs: summary(ages),
            finalAcceptedInputOrdinal: count + 1, finalNativeReuseOrdinal: h.lastPrepared.ordinal,
            finalPlaceholderWriteOrdinal: h.terminal.lastCellWriteOrdinal,
            finalCellWriteAfterReleaseMs: Math.max(0, h.terminal.lastCellWriteAt - releaseAt),
            reuses: h.counters().reuseCalls - beforeFlood.reuseCalls, output: bytes(writes),
            fifo: { capacityBytesPerSecond: 1_000_000, storageLimitBytes: 8 * 1024 * 1024, stallsMs: [[200,300]],
              observationHorizonMs: endAt, end, idleDrainTailMs: fifo.now - drainStart, final: fifo.snapshot() } };
          let mathState = { zoomFactor: h.view.zoomFactor, center: h.view.center };
          const mathTimes = [];
          for (let trial = 0; trial < samples; trial++) {
            const start = performance.now();
            for (let n = 0; n < 1000; n++) mathState = panViewport({ image: h.image,
              area: viewerArea(columns, rows).area, cells, ...mathState }, { xCells: n % 2 ? 1 : -1, yCells: n % 2 ? 1 : -1 });
            mathTimes.push((performance.now() - start) / 1000);
          }
          measured.cheapPurePanMathMsPerReport = { ...summary(mathTimes), batchSize: 1000 };
          if (columns === 292) {
            const beforeWheel = h.counters(), previousCanvas = JSON.stringify(h.lastPrepared.input.canvas);
            h.reset();
            const wheelBuffer = new ui.StdinBuffer(); wheelBuffer.on('data', (data) => h.terminal.send(data));
            const start = performance.now(); wheelBuffer.process(sgr(65, point.x, point.y).repeat(1000));
            const handlerMs = performance.now() - start; wheelBuffer.destroy();
            await until(() => { h.tui.renderNow(); return JSON.stringify(h.lastPrepared.input.canvas) !== previousCanvas && h.lastPrepared.result.isResident?.(); });
            measured.batched1000Wheel = { handlerMs, prepares: h.counters().prepareCalls - beforeWheel.prepareCalls,
              guards: h.counters().guardCalls - beforeWheel.guardCalls, settleMs: performance.now() - start, ...bytes(h.terminal.writes) };
          }
        }
        report.measurements.push(measured);
      } finally { await h.close(); }
    }
  }
}

// Protocol boundary: a genuinely occupied 297x297 window has no remaining pan
// origin range. This is encoder-only evidence, not a giant-host render claim.
const boundaryTimes = []; let boundaryRows;
for (let n = 0; n < samples; n++) {
  const start = performance.now();
  boundaryRows = encodeViewportRows({ imageId: 123456, placementId: 234567, columns: 297, rows: 297,
    canvasColumns: 297, canvasRows: 297, columnOffset: 0, rowOffset: 0 });
  boundaryTimes.push(performance.now() - start);
}
report.protocolBoundary = { occupied: { columns: 297, rows: 297 }, mode: 'encoder only; full canvas cannot pan',
  rowEncodingMs: summary(boundaryTimes), exactEncodedRowBytes: boundaryRows.reduce((n, row) => n + Buffer.byteLength(row), 0) };

// Synthetic completion-to-next-admission model. Exact measured public-host
// write sizes, but constant p95 cost, immutable latest ordinal selection and
// always-changed frames. It is neither the baseline host scheduler nor Phase B.
for (const measured of report.measurements.filter((m) => m.fullHostRenderMs && m.mode === 'fullscreen' && m.shape === 'landscape')) {
  for (const idleMs of [0, 50, 100, 150]) for (const capacity of [4_000_000, 1_000_000, 250_000]) {
    const runs = [];
    for (const horizon of [1000, 3000, 6000]) {
      const frameBytes = Math.ceil(measured.changedFrameTextBytes.p95), cost = measured.fullHostRenderMs.p95;
      const fifo = new FifoLedger({ bytesPerSecond: capacity, storageLimit: 1024 * 1024, stalls: [[200,300]] });
      const receipts = [], sampleAges = []; let admitted = 0, next = 0;
      while (next < horizon) {
        const receipt = next + cost, revision = Math.min(Math.floor(horizon / 4), Math.floor(next / 4));
        fifo.write(frameBytes, receipt); receipts.push(revision); sampleAges.push(receipt - revision * 4);
        admitted++; next = receipt + idleMs;
        assert.ok(admitted < 100000);
      }
      // Dirty final release has one fresh presentation, never a historical trail.
      const finalReceipt = Math.max(next, horizon) + cost;
      fifo.write(frameBytes, finalReceipt); fifo.advance(finalReceipt); const end = fifo.snapshot();
      while (fifo.pending) fifo.advance(fifo.now + 1);
      runs.push({ horizonMs: horizon, frames: admitted + 1, estimatedFrameBytes: frameBytes,
        finalLocalReceiptAfterReleaseMs: finalReceipt - horizon, sampledLocalAgeMs: summary(sampleAges), end,
        idleDrainTailMs: fifo.now - finalReceipt, final: fifo.snapshot() });
    }
    report.fifoComparisons.push({ pane: measured.pane, offeredReportsPerSecond: 250, idleAfterReceiptMs: idleMs,
      fixedHostCostMs: measured.fullHostRenderMs.p95, capacityBytesPerSecond: capacity, stallsMs: [[200,300]],
      storageLimitBytes: 1024 * 1024, model: 'synthetic always-changed latest-state; baseline idle=0 cost-limited negative comparison', runs });
  }
}
report.cpuUsage = process.cpuUsage(cpuStart); report.elapsedMs = performance.now() - started; report.after = context();
report.sourceHashesAfter = await sourceHashes(); report.harnessHashesAfter = await harnessHashes();
assert.deepEqual(report.harnessHashesAfter, report.harnessHashes, 'benchmark support changed during run; reject mixed harness profile');
assert.deepEqual(report.sourceHashesAfter, report.sourceHashes, 'production changed while baseline ran; reject mixed revision profile');
ui.setCapabilities(saved);
console.log(JSON.stringify(report, null, 2));
