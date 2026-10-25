// Standalone optional production PDF acceptance. Capture terminal/public SDK only.
// node --test test/host-pdf-integration.mjs (set PI_TEST_HOST_ROOT)
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, open as openFile, readFile, rm, writeFile } from "node:fs/promises";
import { constants, mkdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
const run = promisify(execFile);
const root = process.env.PI_TEST_HOST_ROOT && resolve(process.env.PI_TEST_HOST_ROOT);
const host = root ? await import(pathToFileURL(join(root, "dist/index.js"))) : undefined;
const ui = root ? await import(pathToFileURL(createRequire(join(root, "dist/index.js")).resolve("@earendil-works/pi-tui"))) : undefined;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PH = "\u{10eeee}", THRESHOLD = 33554432;
const sleep = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!await check()) { assert.ok(Date.now() < end, `${label} did not arrive`); await sleep(); }
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const imageBlocks = (messages) => messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "image") : []);
const pdfMessages = (h) => h.runtime.session.messages.filter((m) => m.role === "custom" && m.customType === "pi-tmux-image");
const graphics = (h) => h.terminal.writes.filter((s) => s.includes("\x1bPtmux;"));
const placements = (writes) => [...writes.join("").matchAll(/a=p,U=1,i=(\d+),p=(\d+),c=(\d+),r=(\d+)/g)]
  .map((m) => ({ imageId: +m[1], placementId: +m[2], columns: +m[3], rows: +m[4] }));
const deletions = (writes) => [...writes.join("").matchAll(/a=d,d=i,i=(\d+),p=(\d+),q=2/g)].map((m) => ({ imageId: +m[1], placementId: +m[2] }));
const color = (id, underline = false) => underline ? `58:2::${id >>> 16 & 255}:${id >>> 8 & 255}:${id & 255}` : `38;2;${id >>> 16 & 255};${id >>> 8 & 255};${id & 255}`;
function pngTransmissions(writes) {
  const result = []; let id, chunks = [];
  for (const m of writes.join("").replaceAll("\x1b\x1b", "\x1b").matchAll(/\x1b_G([^;\x1b]+);([A-Za-z0-9+/=]*)\x1b\\/g)) {
    const fields = Object.fromEntries(m[1].split(",").map((f) => f.split("=")));
    if (fields.a === "t") { id = +fields.i; chunks = []; }
    assert.ok(id, "orphan PNG continuation"); chunks.push(m[2]);
    if (fields.m === "0") { result.push({ imageId: id, bytes: Buffer.from(chunks.join(""), "base64") }); id = undefined; }
  }
  return result;
}
function payloads(writes) { return new Map(pngTransmissions(writes).map(({ imageId, bytes }) => [hash(bytes), imageId])); }
function assertReuploadSlice(h, start, expectedHash, inline = []) {
  const writes = h.terminal.writes.slice(start), batch = pngTransmissions(writes);
  const prior = pngTransmissions(h.terminal.writes.slice(0, start)).find(({ bytes }) => hash(bytes) === expectedHash);
  assert.ok(prior, "slice oracle needs independently witnessed earlier exact PNG");
  assert.equal(batch.length, 1, "post-retirement transition must emit exactly one complete target PNG");
  assert.equal(batch[0].imageId, h.pair.imageId);
  assert.equal(hash(batch[0].bytes), expectedHash);
  assert.deepEqual(batch[0].bytes, prior.bytes, "cached retransmission changed exact PNG bytes");
  const prototypes = placements(writes);
  assert.deepEqual(prototypes.filter((p) => p.placementId !== h.pair.placementId), inline,
    "reupload must restore complete inline prototypes, separately from the live private slot");
  assert.deepEqual(prototypes.filter((p) => p.placementId === h.pair.placementId), [h.pair],
    "reupload must include exactly the current private tuple");
}
class CaptureTerminal {
  columns = 80; rows = 40; kittyProtocolActive = false; writes = [];
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {}
  write(bytes) { this.writes.push(bytes); this.onWrite?.(bytes); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
  mouse(button, x, y, release = false) { this.input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`); }
  click(x, y) { this.mouse(0, x, y); this.mouse(0, x, y, true); }
}
const model = { id: "offline", name: "Offline PDF acceptance", api: "offline-test", provider: "offline-test", baseUrl: "http://invalid.invalid", reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function offlineRuntime() {
  let calls, pending = false;
  const requests = [];
  return { requests, tools(value) { calls = value; pending = true; },
    getModel: () => model, getPhysicalModel: () => model, getModels: () => [model], getAvailableSnapshot: () => [model], refresh: async () => {},
    getError: () => undefined, hasConfiguredAuth: () => true, isUsingOAuth: () => false, isUsingSubscription: () => false, getAuth: async () => ({ apiKey: "offline-fixture" }),
    streamSimple(_model, context) {
      assert.ok(pending || calls, "PDF viewer made an unexpected model request");
      requests.push(structuredClone(context));
      const first = pending; pending = false;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: first ? "toolUse" : "stop",
        content: first ? calls : [{ type: "text", text: "Offline completion." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      if (!first) calls = undefined;
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [], stopReason: "pending" } }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    },
  };
}
// Valid inert PDF with mixed sizes/rotation and page 4 deliberately identical to
// page 2. Padding is an unreferenced stream; threshold is ORIGINAL bytes.
async function writePdf(path, size) {
  const pages = [
    { width: 600, height: 900, rgb: "1 0 0", rotate: 0 },
    { width: 1000, height: 500, rgb: "0 1 0", rotate: 0 },
    { width: 400, height: 800, rgb: "0 0 1", rotate: 90 },
    { width: 1000, height: 500, rgb: "0 1 0", rotate: 0 },
  ];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>"];
  for (const [i, p] of pages.entries()) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.width} ${p.height}] /Rotate ${p.rotate} /Contents ${7 + i} 0 R >>`);
  for (const p of pages) { const stream = `${p.rgb} rg 0 0 ${p.width} ${p.height} re f\n`; objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`); }
  let prefix = "%PDF-1.4\n"; const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(prefix)); prefix += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const parts = (n) => {
    const head = prefix + `11 0 obj\n<< /Length ${n} >>\nstream\n`, end = "\nendstream\nendobj\n";
    const xref = Buffer.byteLength(head) + n + Buffer.byteLength(end);
    return { head, end, tail: `xref\n0 12\n0000000000 65535 f \n${[...offsets, Buffer.byteLength(prefix)].map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 12 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n` };
  };
  let padding = size ? size - 2000 : 0;
  for (let i = 0; size && i < 10; i++) { const p = parts(padding); padding = size - Buffer.byteLength(p.head + p.end + p.tail); }
  const p = parts(padding), fd = await openFile(path, "wx", 0o600);
  try { await fd.write(p.head); const block = Buffer.alloc(65536, 32); for (let n = padding; n > 0; n -= block.length) await fd.write(block.subarray(0, Math.min(n, block.length))); await fd.write(p.end + p.tail); }
  finally { await fd.close(); }
}
// Independently generated Standard Security Handler R2/40-bit RC4 PDF.
// Fixed passwords are disposable fixture data, never requested/stored by Pi.
function encryptedPdf() {
  const padding = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
  const md5 = (bytes) => createHash("md5").update(bytes).digest();
  const padded = (text) => Buffer.concat([Buffer.from(text), padding]).subarray(0, 32);
  function rc4(key, bytes) {
    const state = Array.from({ length: 256 }, (_, i) => i); let j = 0;
    for (let i = 0; i < 256; i++) { j = (j + state[i] + key[i % key.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
    const output = Buffer.alloc(bytes.length); let i = 0; j = 0;
    for (let n = 0; n < bytes.length; n++) { i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]]; output[n] = bytes[n] ^ state[(state[i] + state[j]) & 255]; }
    return output;
  }
  const fileId = md5(Buffer.from("PDF acceptance encrypted fixture"));
  const owner = rc4(md5(padded("owner-fixture")).subarray(0, 5), padded("acceptance-fixture"));
  const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
  const key = md5(Buffer.concat([padded("acceptance-fixture"), owner, permissions, fileId])).subarray(0, 5);
  const user = rc4(key, padding);
  const stream = rc4(md5(Buffer.concat([key, Buffer.from([4, 0, 0, 0, 0])])).subarray(0, 10), Buffer.from("1 0 0 rg 0 0 72 72 re f\n"));
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 4 0 R >>"),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")], offsets = []; let length = parts[0].length;
  for (const [i, object] of objects.entries()) { offsets.push(length); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]); parts.push(part); length += part.length; }
  parts.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R /ID [<${fileId.toString("hex")}> <${fileId.toString("hex")}>] >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}
async function executable(name, path) {
  for (const dir of path.split(":")) { const candidate = join(dir, name); try { await access(candidate, constants.X_OK); return candidate; } catch {} }
  assert.fail(`${name} must already be on PATH; acceptance never installs dependencies`);
}
async function setup(scratch, originalPath) {
  await mkdir(join(scratch, "agent")); await mkdir(join(scratch, "bin"));
  await writeFile(join(scratch, "tmux.json"), JSON.stringify({ passthrough: "all" }));
  await writeFile(join(scratch, "tmux.log"), ""); await writeFile(join(scratch, "pdf.log"), "");
  await writeFile(join(scratch, "bin", "tmux"), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(scratch, "tmux.log"))}, JSON.stringify(args) + '\\n');
const f = JSON.parse(fs.readFileSync(${JSON.stringify(join(scratch, "tmux.json"))}, 'utf8'));
if (args[0] === 'display-message') process.stdout.write('%1\\t$1\\t1\\t0\\t1\\t0\\n');
else if (args[0] === 'show-options') process.stdout.write(f.passthrough + '\\n');
else if (args[0] === 'list-clients') process.stdout.write('offline\\tghostty 1.3.1\\txterm-ghostty\\t0\\n');
else process.exitCode = 1;
`, { mode: 0o755 });
  const binaries = {};
  for (const name of ["pdfinfo", "pdftoppm"]) {
    binaries[name] = await executable(name, originalPath);
    // execve replaces the wrapper PID: SIGKILL targets actual Poppler, not a
    // wrapper with an orphaned child. Logs contain only scratch argv, never bytes.
    await writeFile(join(scratch, "bin", name), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(scratch, "pdf.log"))}, JSON.stringify({name:${JSON.stringify(name)},args,pid:process.pid}) + '\\n');
const gatePath = ${JSON.stringify(join(scratch, "raster-gate.json"))};
const gate = fs.existsSync(gatePath) ? JSON.parse(fs.readFileSync(gatePath, 'utf8')) : {};
const launch = () => process.execve(${JSON.stringify(binaries[name])}, [${JSON.stringify(binaries[name])}, ...args], process.env);
if (${JSON.stringify(name)} === 'pdftoppm' && args[args.indexOf('-f') + 1] === String(gate.page)) {
  const wait = () => { if (fs.existsSync(gate.release)) launch(); else setTimeout(wait, 5); }; wait();
} else launch();
`, { mode: 0o755 });
  }
  await writeFile(join(scratch, "agent", "settings.json"), JSON.stringify({ enableInstallTelemetry: false, enableAnalytics: false }));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const cli = join(root, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
  await run(process.execPath, [cli, "install", repo], { cwd: scratch, timeout: 20000, maxBuffer: 1048576,
    env: { PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", TERM: "dumb" } });
  return binaries;
}
async function interactive(scratch, blocked = true, mode = "fullscreen", manager) {
  const directory = await mkdtemp(join(scratch, "workspace-")), terminal = new CaptureTerminal(), offline = offlineRuntime();
  let ctx, tui;
  const settings = host.SettingsManager.create(directory, join(scratch, "agent"));
  const overrides = { quietStartup: true, theme: "dark", cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false,
    fullscreenExitOutput: "resume-hint", fullscreenScrollbar: "hidden", fullscreenCopyOnSelect: false, doubleEscapeAction: "none", outputPad: 1,
    terminal: { images: "auto", trueColor: true }, images: { blockImages: blocked }, compaction: { enabled: false }, retry: { enabled: false } };
  const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await host.createAgentSessionServices({ cwd, agentDir, settingsManager: settings, modelRuntime: offline, resourceLoaderOptions: {
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => pi.on("session_start", (_event, context) => { ctx = context; context.ui.setWidget("pdf-acceptance-observer", (injected) => { tui = injected; return { render: () => [], invalidate() {} }; }); })],
    } });
    settings.applyOverrides(overrides);
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const created = await host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", tools: ["tmux_show_pdf"] });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await host.createAgentSessionRuntime(factory, { cwd: directory, agentDir: join(scratch, "agent"), sessionManager: manager || host.SessionManager.inMemory(directory) });
  const app = new host.InteractiveMode(runtime, { terminal, tuiMode: mode, initialThemeSetting: "dark" });
  await app.init(); settings.applyOverrides(overrides); assert.equal(settings.getBlockImages(), blocked);
  tui.renderNow(); if (mode === "fullscreen") tui.setCopyOnSelect(false);
  return { directory, terminal, offline, runtime, app, settings, overrides, mode, get ctx() { return ctx; }, get tui() { return tui; },
    async cleanup() { app.stop(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
async function invariant(h) {
  return { entries: JSON.stringify(h.ctx.sessionManager.getEntries()), messages: JSON.stringify(h.runtime.session.messages),
    conversion: structuredClone(await h.runtime.session.agent.convertToLlm(h.runtime.session.messages)), requests: h.offline.requests.length };
}
async function unchanged(h, before) { assert.deepEqual(await invariant(h), before, "pagination changed exact entries/content/conversion or model calls"); }
const plain = (lines) => lines.map(ui.stripTerminalSequences);
function currentLines(h) {
  if (h.mode === "fullscreen") return h.tui.getScreenLines();
  // Differential regular output may omit title on a pan, but PAGE transitions
  // always change page chrome. Only writes after the most recent operation count.
  const writes = h.terminal.writes.slice(h.frameStart || 0);
  const latest = writes.findLast((s) => !s.includes("\x1bPtmux;") && (s.includes(PH) || /(?:Page \d+ of 4|Loading page|Error loading|Page:|Pane too small|not retained|unavailable|Injected scoped)/i.test(ui.stripTerminalSequences(s))));
  // Main-screen differential output can omit an unchanged fit title. Preserve
  // only the most recent emitted numeric title, never historical image cells.
  const title = h.terminal.writes.findLast((s) => /\d+% Fit/.test(ui.stripTerminalSequences(s)));
  const fit = title && /\d+% Fit(?: \(limit\))?/.exec(ui.stripTerminalSequences(title))?.[0];
  const unavailableWrite = writes.findLast((s) => /Original PDF was not retained[^\r\n]*/.test(ui.stripTerminalSequences(s)));
  const unavailable = unavailableWrite && /Original PDF was not retained[^\r\n]*/.exec(ui.stripTerminalSequences(unavailableWrite))?.[0];
  return latest ? [latest, ...(fit ? [fit] : []), ...(unavailable ? [unavailable] : [])] : [];
}
function ready(h, page, expectedId) {
  if (!h.tui.hasOverlay()) return false;
  const lines = currentLines(h), text = plain(lines).join("\n");
  const pair = placements(graphics(h)).at(-1);
  if (!pair || expectedId && pair.imageId !== expectedId || !new RegExp(`Page ${page} of 4`, "i").test(text)) return false;
  if (/Loading page|Preparing viewport|Preparing stored|Updating viewport/.test(text)) return false;
  if (!lines.some((line) => line.includes(PH) && line.includes(color(pair.placementId, true)) && line.includes(color(pair.imageId)))) return false;
  h.pair = pair; return true;
}
async function pageReady(h, page, id) {
  try { await until(() => { h.tui.renderNow(); return ready(h, page, id); }, `ready actual page ${page}`); }
  catch (error) { assert.fail(`${error.message}; last chrome: ${plain(currentLines(h)).join("\n").replace(/[^\n]*\u{10eeee}[^\n]*/gu, "[ID cells]").slice(-1200)}`); }
  return h.pair;
}
async function openViewer(h) {
  h.frameStart = h.terminal.writes.length;
  h.command = h.runtime.session.prompt("/tmux-image-view");
  await until(() => { h.tui.renderNow(); return h.tui.hasOverlay(); }, "PDF overlay");
  if (pdfMessages(h).length > 1) h.terminal.input("\r");
  await pageReady(h, 1);
}
async function closeViewer(h) {
  const pair = h.pair, start = h.terminal.writes.length;
  h.terminal.input("\x1b");
  if (h.command) await h.command;
  else {
    await until(() => !h.tui.hasOverlay(), "click-open owned close");
    await until(() => deletions(h.terminal.writes.slice(start)).some((p) => p.imageId === pair.imageId && p.placementId === pair.placementId), "click-open scoped retirement");
  }
  assert.equal(h.tui.hasOverlay(), false);
}
async function inputPage(h, key, page, expectedHash) {
  h.frameStart = h.terminal.writes.length; h.terminal.input(key);
  await pageReady(h, page);
  if (expectedHash) assert.equal(payloads(graphics(h)).get(expectedHash), h.pair.imageId, "ready native ID does not identify requested page PNG");
}
async function expectedPages(pdf, scratch, binaries) {
  const dir = await mkdtemp(join(scratch, "oracle-")), result = [];
  try {
    for (let p = 1; p <= 4; p++) {
      const prefix = join(dir, `page-${p}`);
      await run(binaries.pdftoppm, ["-f", String(p), "-l", String(p), "-singlefile", "-png", "-scale-to", "1200", pdf, prefix], { timeout: 30000, maxBuffer: 65536, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
      const acquired = await host.createReadTool(dir).execute("pdf-page-oracle", { path: prefix + ".png" });
      const image = imageBlocks([acquired])[0]; assert.ok(image);
      const normalized = await host.convertToPng(image.data, image.mimeType); assert.ok(normalized);
      result.push(hash(Buffer.from(normalized.data, "base64")));
    }
    assert.equal(new Set(result.slice(0, 3)).size, 3, "page oracle must distinguish actual pixels");
    assert.equal(result[1], result[3], "page 2/4 fixture must have identical PNG bytes");
    return result;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function pdfLog(scratch) { return (await readFile(join(scratch, "pdf.log"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
async function submit(h, path) {
  const count = pdfMessages(h).length;
  await h.runtime.session.prompt(`/tmux-pdf ${path}`);
  assert.equal(pdfMessages(h).length, count + 1, "new PDF import must create one document");
  const m = pdfMessages(h).at(-1); assert.equal(m.details.schema, "pi-tmux-image/pdf-v1"); assert.equal(imageBlocks([m]).length, 1);
  assert.equal(m.details.document.pageCount, 4); assert.equal(m.details.document.previewPage, 1);
  assert.match(JSON.stringify(m.content), /Page 1 of 4/i);
  return m;
}
async function choose(h, operation, option) {
  const started = h.terminal.writes.length;
  const promise = operation();
  await until(() => { h.tui.renderNow(); return plain(h.terminal.writes.slice(started)).join("\n").includes("Temporary"); }, "retention selector");
  if (option === undefined) h.terminal.input("\x1b");
  else { for (let n = 0; n < option; n++) h.terminal.input("\x1b[B"); h.terminal.input("\r"); }
  await promise;
}
function assertDetailsOnly(h, message, original) {
  const doc = message.details.document;
  assert.equal(doc.byteLength, original.length); assert.equal(doc.sha256, hash(original));
  assert.equal(doc.data, original.toString("base64"));
  assert.equal(JSON.stringify(message.content).includes(doc.data), false);
  assert.equal(JSON.stringify(h.runtime.session.messages).split(doc.data).length - 1, 1);
  for (const request of h.offline.requests) assert.equal(JSON.stringify(request).includes(doc.data), false, "original PDF leaked to actual model request");
}
async function noCallerTransition(h, expectedHash) {
  const old = h.pair, start = h.terminal.writes.length;
  h.frameStart = start; h.terminal.input("n");
  // Deliberately no caller renderNow until the production delete/new placement
  // have arrived: automatic host frames + controller removal flush own ordering.
  await until(() => placements(h.terminal.writes.slice(start)).some((p) => p.imageId !== old.imageId), "production cross-page placement without caller frame");
  const writes = h.terminal.writes.slice(start);
  const deletion = writes.findIndex((s) => s.includes(`a=d,d=i,i=${old.imageId},p=${old.placementId},`));
  const rebind = writes.findIndex((s) => /a=p,U=1/.test(s));
  assert.ok(deletion > 0, "private delete must follow an actual removal frame");
  const removal = writes.slice(0, deletion).findIndex((s) => !s.includes("\x1bPtmux;") && /Loading page/i.test(ui.stripTerminalSequences(s)) && !s.includes(PH));
  assert.ok(removal >= 0, "production did not emit loading-only no-old-cell removal frame before deletion");
  assert.ok(rebind > deletion, "fixed-slot rebound before old prototype retired");
  assert.equal(/a=d,d=[A-Z]|a=d,d=a/.test(writes.join("")), false, "global/pixel delete in page transition");
  const next = placements(writes).at(-1); assert.equal(next.placementId, old.placementId, "pagination allocated another private slot");
  assert.equal(payloads(writes).get(expectedHash), next.imageId, "transition uploaded wrong page bytes");
  await pageReady(h, 2, next.imageId);
}
// The fresh-process child uses the same production path, isolated settings and
// fail-closed fake model, not direct provider materialization in lieu of viewing.
async function restoreChild() {
  const scratch = process.env.PI_PDF_ACCEPTANCE_SCRATCH;
  const manager = host.SessionManager.open(process.env.PI_PDF_ACCEPTANCE_SESSION);
  const h = await interactive(scratch, true, "fullscreen", manager);
  try {
    const message = pdfMessages(h)[0], originalHash = process.env.PI_PDF_ACCEPTANCE_HASH;
    assert.equal(hash(Buffer.from(message.details.document.data, "base64")), originalHash);
    const before = await invariant(h); await openViewer(h); h.terminal.input("g");
    // g only enters field, so submit page number without readiness polling there.
    h.frameStart = h.terminal.writes.length; h.terminal.input("3"); h.terminal.input("\r"); await pageReady(h, 3);
    assert.equal(payloads(graphics(h)).get(process.env.PI_PDF_ACCEPTANCE_PAGE_HASH), h.pair.imageId);
    await closeViewer(h); await unchanged(h, before);
  } finally { await h.cleanup(); }
}
if (process.env.PI_PDF_ACCEPTANCE_CHILD === "restore") {
  ui.setCapabilities({ images: null, trueColor: true, hyperlinks: false }); ui.setCellDimensions({ widthPx: 8, heightPx: 16 });
  await restoreChild();
} else test("production PDF documents: isolated public host storage, pagination, retention and guards", {
  skip: !root && "set PI_TEST_HOST_ROOT to installed Pi package root", timeout: 240000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-pdf-acceptance-"));
  const keys = ["TMUX", "TMUX_PANE", "PATH", "PI_OFFLINE", "PI_CODING_AGENT_DIR", "PI_IMAGE_PROTOCOL", "DISPLAY", "WAYLAND_DISPLAY"];
  const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const caps = { ...ui.getCapabilities() }, cells = { ...ui.getCellDimensions() };
  process.env.TMUX = "offline-pdf-fixture"; process.env.TMUX_PANE = "%1"; process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = join(scratch, "agent"); process.env.PI_IMAGE_PROTOCOL = "auto";
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
  process.env.PATH = join(scratch, "bin") + ":" + old.PATH;
  ui.setCapabilities({ images: null, trueColor: true, hyperlinks: false }); ui.setCellDimensions({ widthPx: 8, heightPx: 16 });
  try {
    const binaries = await setup(scratch, old.PATH);
    for (const blocked of [true, false]) for (const mode of ["fullscreen", "regular"]) await t.test(`${mode}, blockImages=${blocked}: exact pages, keys/jump/tiny pane and immutable model storage`, async () => {
      const h = await interactive(scratch, blocked, mode);
      try {
        const path = join(h.directory, "document.pdf"); await writePdf(path);
        const original = await readFile(path), expected = await expectedPages(path, scratch, binaries);
        const message = await submit(h, path); assertDetailsOnly(h, message, original);
        const importLog = await pdfLog(scratch);
        const renders = importLog.filter((q) => q.name === "pdftoppm");
        assert.equal(renders.at(-1).args[renders.at(-1).args.indexOf("-f") + 1], "1", "import eagerly rasterized a later page");
        await rm(path);
        // Capture invocation invariants only AFTER immutable inline layout is
        // rendered-ready. Its asynchronous height growth may move host follow
        // position; our later click/command must not be blamed for that growth.
        await until(() => { h.tui.renderNow(); return h.mode === "fullscreen" ? h.tui.getScreenLines().some((s) => s.includes(PH)) : h.terminal.writes.some((s) => !s.includes("\x1bPtmux;") && s.includes(PH)); }, "settled inline preview before invocation");
        if (mode === "fullscreen") h.tui.scrollToBottom();
        h.ctx.ui.setEditorText("protected PDF draft"); h.tui.renderNow();
        const top = mode === "fullscreen" ? h.tui.viewportTop : undefined;
        const retainedInline = placements(graphics(h));
        assert.equal(retainedInline.length, 1, "settled canonical preview has one inline prototype");
        const before = await invariant(h);
        const conversionImages = imageBlocks(before.conversion);
        assert.equal(conversionImages.length, blocked ? 0 : 1, "public SDK image blocking was not applied");
        if (!blocked) assert.deepEqual(conversionImages, imageBlocks([message]));
        if (mode === "fullscreen" && blocked) {
          h.tui.scrollToBottom();
          await until(() => { h.tui.renderNow(); return h.tui.getScreenLines().some((s) => s.includes(PH)); }, "rendered-ready document preview cells");
          const lines = h.tui.getScreenLines(), rows = plain(lines);
          const label = rows.findIndex((s) => /Page 1 of 4/i.test(s)); assert.ok(label >= 0, "new document preview label missing");
          const y = rows.findIndex((s, row) => row > label && s.includes(PH)); assert.ok(y >= 0);
          const x = ui.visibleWidth(rows[y].slice(0, rows[y].indexOf(PH)));
          h.terminal.click(1, label); await sleep(20); assert.equal(h.tui.hasOverlay(), false, "document label admitted a preview click");
          h.frameStart = h.terminal.writes.length; h.command = undefined; h.terminal.click(x, y);
          await until(() => h.tui.hasOverlay(), "actual preview click overlay mount"); await pageReady(h, 1);
        } else await openViewer(h);
        assert.equal(payloads(graphics(h)).get(expected[0]), h.pair.imageId);
        const slot = h.pair.placementId, page1Log = await pdfLog(scratch);
        h.terminal.input("p"); h.terminal.input("\x1b[5~"); await sleep(30); h.tui.renderNow();
        assert.deepEqual(await pdfLog(scratch), page1Log, "page-one boundary rerasterized");
        await noCallerTransition(h, expected[1]);
        await inputPage(h, "\x1b[6~", 3, expected[2]);
        await inputPage(h, "\x1b[6;1~", 4, expected[3]);
        const atLast = await pdfLog(scratch); h.terminal.input("n"); await sleep(30); h.tui.renderNow(); assert.deepEqual(await pdfLog(scratch), atLast);
        const page3ReturnStart = h.terminal.writes.length;
        await inputPage(h, "\x1b[5;1~", 3, expected[2]);
        assertReuploadSlice(h, page3ReturnStart, expected[2]);
        // Jump errors stay editable, Escape cancels only the field; no hidden input.
        h.frameStart = h.terminal.writes.length; h.terminal.input("g"); h.terminal.input("0"); h.terminal.input("\r"); h.tui.renderNow();
        assert.match(plain(currentLines(h)).join("\n"), /Enter 1[–-]4/, "invalid jump needs an editable range error");
        assert.equal(h.tui.hasOverlay(), true); h.terminal.input("\x1b"); assert.equal(h.tui.hasOverlay(), true);
        const jumpLog = await pdfLog(scratch), jumpWire = graphics(h).length;
        h.terminal.input("g"); h.terminal.input("\r"); h.tui.renderNow();
        assert.match(plain(currentLines(h)).join("\n"), /Enter 1[–-]4/, "empty jump silently accepted");
        h.terminal.input("n"); h.terminal.input("p"); h.terminal.input("\x1b[200~999\x1b[201~");
        for (let n = 0; n < 3; n++) h.terminal.input("9");
        h.terminal.input("\r"); h.tui.renderNow();
        const jumpChrome = plain(currentLines(h)).join("\n");
        assert.match(jumpChrome, /Page: 9[^9]*Enter 1[–-]4/, "jump digits were unbounded or invalid input lost editable error");
        assert.equal(jumpChrome.includes("Page: 999"), false);
        h.terminal.input("\x7f"); h.terminal.input("3"); h.terminal.input("\r"); h.tui.renderNow();
        assert.deepEqual(await pdfLog(scratch), jumpLog, "same-page jump or n/p while editing rasterized");
        assert.equal(graphics(h).length, jumpWire);
        const page1ReturnStart = h.terminal.writes.length;
        h.terminal.input("\x1b[103u"); h.terminal.input("\x1b[49u"); h.terminal.input("\x1b[127u"); h.terminal.input("1"); h.terminal.input("\r");
        h.frameStart = h.terminal.writes.length; await pageReady(h, 1); assert.equal(h.pair.imageId, payloads(graphics(h)).get(expected[0]));
        assertReuploadSlice(h, page1ReturnStart, expected[0], retainedInline);
        const revisit = await pdfLog(scratch);
        const samePageGraphics = graphics(h).length;
        h.terminal.input("g"); h.terminal.input("1"); h.terminal.input("\r"); await sleep(30); h.tui.renderNow();
        assert.deepEqual(await pdfLog(scratch), revisit, "same-ready-page request rerasterized");
        assert.equal(graphics(h).length, samePageGraphics, "same page rebound the native slot");
        h.terminal.input("+");
        await until(() => { h.tui.renderNow(); return /125% Fit/.test(plain(currentLines(h)).join("\n")); }, "PDF zoom");
        h.terminal.input("l"); await sleep(220); h.tui.renderNow();
        h.terminal.columns = 70; h.frameStart = h.terminal.writes.length; h.terminal.resize();
        await pageReady(h, 1); assert.match(plain(currentLines(h)).join("\n"), /125% Fit/, "ordinary resize reset PDF zoom");
        h.terminal.columns = 80; h.terminal.resize(); await pageReady(h, 1);
        assert.deepEqual(await pdfLog(scratch), revisit, "pan/zoom/resize rerasterized current PDF page");
        h.frameStart = h.terminal.writes.length; h.terminal.input("n"); await pageReady(h, 2);
        assert.match(plain(currentLines(h)).join("\n"), /100% Fit/, "actual page change did not reset fit");
        assert.equal(h.pair.placementId, slot);
        h.terminal.columns = 12; h.terminal.rows = 6; h.terminal.resize(); h.tui.renderNow();
        const tinyLog = await pdfLog(scratch); h.terminal.input("n"); h.terminal.input("n"); h.terminal.input("p"); await sleep(40);
        assert.deepEqual(await pdfLog(scratch), tinyLog, "tiny pane launched PDF rendering");
        h.terminal.columns = 80; h.terminal.rows = 40; h.frameStart = h.terminal.writes.length; h.terminal.resize(); await pageReady(h, 3);
        assert.equal(payloads(graphics(h)).get(expected[2]), h.pair.imageId, "tiny n,n,p lost latest requested target");
        assert.equal(h.ctx.ui.getEditorText(), "protected PDF draft"); if (mode === "fullscreen") assert.equal(h.tui.viewportTop, top);
        await unchanged(h, before);
        // Resize can make inline preparation the first successor to renew page1
        // trust. Reopen protection is tested after retiring page1 itself again,
        // not by unconditionally invalidating an unrelated incoming target.
        h.frameStart = h.terminal.writes.length;
        h.terminal.input("g"); h.terminal.input("1"); h.terminal.input("\r"); await pageReady(h, 1);
        const allInline = [...new Map(placements(graphics(h)).filter((p) => p.imageId === h.pair.imageId && p.placementId !== slot)
          .map((p) => [p.placementId, p])).values()];
        for (const original of retainedInline) assert.deepEqual(allInline.find((p) => p.placementId === original.placementId), original);
        await closeViewer(h); await unchanged(h, before);
        const reopenStart = h.terminal.writes.length, reopenLog = await pdfLog(scratch);
        await openViewer(h); assertReuploadSlice(h, reopenStart, expected[0], allInline);
        assert.deepEqual(await pdfLog(scratch), reopenLog, "canonical reopen must not rasterize");
        await closeViewer(h); await unchanged(h, before);
        assert.equal(/a=d,d=[A-Z]|a=d,d=a/.test(graphics(h).join("")), false);
      } finally { await h.cleanup(); }
    });
    await t.test("production page child abort/drain, latest target, scoped retirement failure/retry and modal ownership", async () => {
      const h = await interactive(scratch, true);
      try {
        const path = join(h.directory, "races.pdf"); await writePdf(path);
        const expected = await expectedPages(path, scratch, binaries); await submit(h, path); await rm(path);
        const before = await invariant(h); await openViewer(h);
        const slot = h.pair.placementId;
        const gatePath = join(scratch, "raster-gate.json"), release = join(scratch, "raster.release");
        await writeFile(gatePath, JSON.stringify({ page: 2, release }));
        let logStart = (await pdfLog(scratch)).length;
        h.frameStart = h.terminal.writes.length; h.terminal.input("n");
        await until(async () => (await pdfLog(scratch)).slice(logStart).some((q) => q.name === "pdftoppm"), "held production page child");
        const held = (await pdfLog(scratch)).slice(logStart).find((q) => q.name === "pdftoppm");
        const transport = graphics(h).length;
        h.terminal.input("n"); // requested 2 -> 3 while page 2 actually runs
        await pageReady(h, 3); assert.equal(payloads(graphics(h)).get(expected[2]), h.pair.imageId);
        assert.throws(() => process.kill(held.pid, 0), { code: "ESRCH" }, "superseded page child still alive after successor ready");
        assert.equal(payloads(graphics(h)).has(expected[1]), false, "aborted page 2 published native pixels");
        assert.ok(graphics(h).length > transport); assert.equal(h.pair.placementId, slot);
        await rm(gatePath); await inputPage(h, "p", 2, expected[1]);
        // Same PNG/layout page 2 -> page 4 still needs a new page lease and
        // scoped retirement, not acceptance of an old ready label/payload alone.
        const duplicateStart = h.terminal.writes.length, duplicateLog = await pdfLog(scratch);
        h.frameStart = duplicateStart; h.terminal.input("g"); h.terminal.input("4"); h.terminal.input("\r"); await pageReady(h, 4);
        assert.equal(h.pair.imageId, payloads(graphics(h)).get(expected[1]));
        assert.equal(h.pair.placementId, slot);
        assert.equal(deletions(h.terminal.writes.slice(duplicateStart)).length, 1, "identical page payload bypassed page lease retirement");
        assertReuploadSlice(h, duplicateStart, expected[1]);
        const duplicateRasters = (await pdfLog(scratch)).slice(duplicateLog.length);
        assert.equal(duplicateRasters.length, 1, "repair added PDF work beyond one baseline requested later-page raster");
        assert.equal(duplicateRasters[0].name, "pdftoppm");
        assert.equal(duplicateRasters[0].args[duplicateRasters[0].args.indexOf("-f") + 1], "4");
        const duplicateWrites = h.terminal.writes.slice(duplicateStart);
        assert.ok(duplicateWrites.findIndex((s) => s.includes("a=t")) > duplicateWrites.findIndex((s) => s.includes("a=d,d=i")),
          "equal-PNG target retransmitted before retiring old lease");
        // Uncertain delete failure is captured but NOT treated as success. It
        // blocks new-page placement; a deliberate jump retries with a new flush.
        const oldPair = h.pair, faultStart = h.terminal.writes.length;
        let failed = false;
        h.terminal.onWrite = (s) => { if (!failed && s.includes(`a=d,d=i,i=${oldPair.imageId},p=${slot},`)) { failed = true; throw new Error("Injected scoped PDF retirement failure"); } };
        h.frameStart = faultStart; h.terminal.input("p");
        await until(() => { h.tui.renderNow(); return plain(currentLines(h)).join("\n").includes("Injected scoped PDF retirement failure"); }, "retirement failure chrome");
        assert.equal(placements(h.terminal.writes.slice(faultStart)).length, 0, "retirement failure allowed new slot binding");
        h.terminal.onWrite = undefined;
        const retryStart = h.terminal.writes.length;
        h.frameStart = retryStart; h.terminal.input("g"); h.terminal.input("3"); h.terminal.input("\r");
        await until(() => placements(h.terminal.writes.slice(retryStart)).length > 0, "production retry without caller renderNow");
        const retryWrites = h.terminal.writes.slice(retryStart), deleteIndex = retryWrites.findIndex((s) => s.includes("a=d,d=i"));
        assert.ok(deleteIndex > 0 && retryWrites.slice(0, deleteIndex).some((s) => !s.includes("\x1bPtmux;") && /Loading page/i.test(ui.stripTerminalSequences(s)) && !s.includes(PH)), "retry did not reflush a removal frame");
        await pageReady(h, 3); await closeViewer(h);
        // Escape drains a held child and never publishes after owned close.
        await openViewer(h); await writeFile(gatePath, JSON.stringify({ page: 2, release })); logStart = (await pdfLog(scratch)).length;
        h.terminal.input("n"); await until(async () => (await pdfLog(scratch)).slice(logStart).some((q) => q.name === "pdftoppm"), "Escape held child");
        const closeChild = (await pdfLog(scratch)).slice(logStart).find((q) => q.name === "pdftoppm");
        h.terminal.input("\x1b"); await h.command;
        assert.throws(() => process.kill(closeChild.pid, 0), { code: "ESRCH" });
        const afterClose = graphics(h).length; await sleep(50); h.tui.renderNow(); assert.equal(graphics(h).length, afterClose, "closed child published stale graphics");
        await rm(gatePath); await openViewer(h);
        let finish, handle;
        const upper = h.ctx.ui.custom((_tui, _theme, _keys, done) => { finish = done; return { render: () => ["UNRELATED PDF MODAL"], invalidate() {}, handleInput(data) { if (ui.matchesKey(data, "escape")) done("closed"); } }; }, { overlay: true, onHandle(value) { handle = value; } });
        await until(() => Boolean(handle), "upper modal"); await h.command;
        assert.ok(handle.getBounds() || (h.tui.renderNow(), handle.getBounds())); assert.equal(handle.isFocused(), true);
        h.terminal.input("\x1b"); assert.equal(await upper, "closed"); finish = undefined;
        await unchanged(h, before);
      } finally { h.terminal.onWrite = undefined; await rm(join(scratch, "raster-gate.json"), { force: true }); await h.cleanup(); }
    });
    await t.test("retained source-deleted reload and fresh-process fork/branch/copy independence", async () => {
      const sessions = join(scratch, "sessions"); await mkdir(sessions);
      const manager = host.SessionManager.create(scratch, sessions);
      manager.appendMessage({ role: "user", content: "Offline saved-session seed.", timestamp: Date.now() });
      const h = await interactive(scratch, false, "fullscreen", manager);
      try {
        const path = join(h.directory, "retained.pdf"); await writePdf(path); const original = await readFile(path);
        const expected = await expectedPages(path, scratch, binaries); const message = await submit(h, path); assertDetailsOnly(h, message, original);
        const before = await invariant(h); await rm(path);
        await h.runtime.session.reload({ beforeSessionStart: () => h.settings.applyOverrides(h.overrides) });
        await openViewer(h); await inputPage(h, "n", 2, expected[1]); await closeViewer(h); await unchanged(h, before);
        const parent = manager.getSessionFile(); assert.ok(parent && dirname(parent) === sessions);
        const fork = host.SessionManager.forkFrom(parent, scratch, sessions).getSessionFile();
        const copy = join(sessions, "copied.jsonl"); await copyFile(parent, copy);
        const branch = manager.createBranchedSession(manager.getLeafId()); assert.ok(branch);
        await rm(parent);
        for (const path of [fork, branch, copy]) {
          assert.ok(path);
          const env = { PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1", PI_IMAGE_PROTOCOL: "auto", TMUX: "offline-pdf-fixture", TMUX_PANE: "%1",
            PI_TEST_HOST_ROOT: root, PI_PDF_ACCEPTANCE_CHILD: "restore", PI_PDF_ACCEPTANCE_SCRATCH: scratch, PI_PDF_ACCEPTANCE_SESSION: path, PI_PDF_ACCEPTANCE_HASH: hash(original), PI_PDF_ACCEPTANCE_PAGE_HASH: expected[2] };
          await run(process.execPath, [fileURLToPath(import.meta.url)], { env, timeout: 30000, maxBuffer: 1048576 });
        }
      } finally { await h.cleanup(); }
    });
    await t.test("threshold selector choices, Temporary runtime lifetime and restored preview-only access", async () => {
      const path = join(scratch, "large.pdf"); await writePdf(path, THRESHOLD + 1);
      const h = await interactive(scratch, true);
      try {
        for (const option of [2, undefined]) {
          const before = await invariant(h); await choose(h, () => h.runtime.session.prompt(`/tmux-pdf ${path}`), option);
          await unchanged(h, before); assert.equal(pdfMessages(h).length, 0, "Cancel/Escape published preview");
        }
        await choose(h, () => h.runtime.session.prompt(`/tmux-pdf ${path}`), 1);
        const m = pdfMessages(h)[0]; assert.ok(m); assert.equal(m.details.document.retention, "temporary"); assert.equal("data" in m.details.document, false);
        const before = await invariant(h); await rm(path);
        await openViewer(h); await inputPage(h, "n", 2); await closeViewer(h);
        await openViewer(h); await inputPage(h, "n", 2); await closeViewer(h);
        await h.runtime.session.prompt("/tmux-image-refresh"); await openViewer(h); await inputPage(h, "n", 2); await closeViewer(h); await unchanged(h, before);
        // Public tree navigation excludes a custom target itself. Return by a
        // following user entry, preserving the same runtime Temporary registry.
        const manager = h.ctx.sessionManager; manager.appendMessage({ role: "user", content: "Branch anchor", timestamp: Date.now() });
        const anchor = manager.getLeafId(), pdfEntry = manager.getEntries().find((e) => e.type === "custom_message" && e.details?.occurrence === m.details.occurrence);
        await h.runtime.session.navigateTree(pdfEntry.id, { summarize: false }); assert.equal(pdfMessages(h).length, 0);
        await h.runtime.session.navigateTree(anchor, { summarize: false }); assert.equal(pdfMessages(h).length, 1);
        await openViewer(h); await inputPage(h, "n", 2); await closeViewer(h);
        const restored = await invariant(h);
        await h.runtime.session.reload({ beforeSessionStart: () => h.settings.applyOverrides(h.overrides) });
        await openViewer(h); const log = await pdfLog(scratch); h.terminal.input("n"); await sleep(60); h.tui.renderNow();
        assert.match(plain(currentLines(h)).join("\n"), /not retained|unavailable|temporary/i, "restored Temporary original absence must be explained");
        assert.deepEqual(await pdfLog(scratch), log, "restored Temporary probed/rasterized original path");
        h.terminal.input("+"); await sleep(220); h.tui.renderNow(); assert.match(plain(currentLines(h)).join("\n"), /125% Fit/);
        await closeViewer(h); await unchanged(h, restored);
      } finally { await h.cleanup(); await rm(path, { force: true }); }
    });
    await t.test("regular Temporary new/resume/fork replacement cannot reuse parent runtime originals", async () => {
      const sessionDir = join(scratch, "temporary-sessions"); await mkdir(sessionDir);
      const manager = host.SessionManager.create(scratch, sessionDir);
      manager.appendMessage({ role: "user", content: "Temporary replacement seed", timestamp: Date.now() });
      const h = await interactive(scratch, true, "regular", manager);
      try {
        const source = join(h.directory, "temporary.pdf"); await writePdf(source, THRESHOLD + 1);
        const start = (await pdfLog(scratch)).length;
        await choose(h, () => h.runtime.session.prompt(`/tmux-pdf ${source}`), 1);
        const message = pdfMessages(h)[0]; assert.equal(message.details.document.retention, "temporary");
        const saved = manager.getSessionFile(); assert.ok(saved);
        const captured = (await pdfLog(scratch)).slice(start).find((q) => q.name === "pdfinfo").args.at(-1);
        await rm(source); await openViewer(h); await inputPage(h, "n", 2); await closeViewer(h);
        const before = await invariant(h);
        const fork = host.SessionManager.forkFrom(saved, scratch, sessionDir).getSessionFile(); assert.ok(fork);
        await h.runtime.newSession();
        await assert.rejects(access(captured), { code: "ENOENT" }, "replaced Temporary runtime left immutable original scratch alive");
        for (const path of [saved, fork]) {
          await h.runtime.switchSession(path); h.settings.applyOverrides(h.overrides);
          assert.equal(pdfMessages(h)[0].details.document.retention, "temporary");
          assert.equal("data" in pdfMessages(h)[0].details.document, false);
          const restored = await invariant(h); await openViewer(h);
          const log = await pdfLog(scratch); h.terminal.input("n"); await sleep(60); h.tui.renderNow();
          assert.match(plain(currentLines(h)).join("\n"), /not retained|unavailable|temporary/i);
          assert.deepEqual(await pdfLog(scratch), log, "restored/forked Temporary borrowed parent runtime original");
          await closeViewer(h); await unchanged(h, restored);
          if (path === saved) assert.deepEqual(restored, before, "Temporary resume changed exact entries/model context");
        }
      } finally { await h.cleanup(); }
    });
    await t.test("original-byte threshold is exact; Keep/Temporary tool submissions are compact and policy-filtered", async () => {
      // Sequential fixtures avoid the Phase A benchmark's multiple large managers
      // and strings. This is functional consent coverage, not a memory benchmark.
      for (const size of [THRESHOLD - 1, THRESHOLD, THRESHOLD + 1]) {
        const path = join(scratch, `threshold-${size}.pdf`); await writePdf(path, size);
        const h = await interactive(scratch, true);
        try {
          const start = h.terminal.writes.length;
          if (size <= THRESHOLD) await submit(h, path);
          else await choose(h, () => h.runtime.session.prompt(`/tmux-pdf ${path}`), 0);
          const m = pdfMessages(h)[0]; assert.equal(m.details.document.byteLength, size); assert.equal(m.details.document.retention, "keep");
          if (size <= THRESHOLD) assert.equal(plain(h.terminal.writes.slice(start)).join("\n").includes("Temporary"), false, "threshold prompted based on base64 length");
          assert.equal(Buffer.from(m.details.document.data, "base64").length, size);
        } finally { await h.cleanup(); await rm(path); }
      }
      for (const mode of ["fullscreen", "regular"]) for (const option of [0, 1, 2]) {
        const path = join(scratch, "tool-large.pdf"); await writePdf(path, THRESHOLD + 1);
        const h = await interactive(scratch, false, mode);
        try {
          h.offline.tools([{ type: "toolCall", id: "pdf-call", name: "tmux_show_pdf", arguments: { path } }]);
          await choose(h, () => h.runtime.session.prompt("Offline PDF tool consent."), option);
          const result = h.runtime.session.messages.find((m) => m.role === "toolResult"); assert.ok(result);
          assert.equal(result.isError, option === 2); assert.equal(pdfMessages(h).length, option === 2 ? 0 : 1);
          assert.equal(h.offline.requests.length, 2, "submission added a model turn");
          if (option !== 2) {
            const m = pdfMessages(h)[0]; assert.equal(m.details.document.retention, option === 0 ? "keep" : "temporary");
            assert.match(JSON.stringify(result.content), /submitted/i); assert.ok(JSON.stringify(result).length < 2048, "tool result is not compact");
            assert.ok(h.runtime.session.messages.indexOf(result) < h.runtime.session.messages.indexOf(m), "display preceded tool result");
            assert.deepEqual(imageBlocks(h.offline.requests[1].messages), imageBlocks([m]));
            if (m.details.document.data) assert.equal(JSON.stringify(h.offline.requests).includes(m.details.document.data), false);
          }
        } finally { await h.cleanup(); await rm(path); }
      }
    });
    await t.test("submitted Temporary survives deferred persistence failure and post-handoff cancellation", async () => {
      for (const failure of ["persistence", "cancel"]) {
        const sessionDir = join(scratch, `publication-${failure}`); await mkdir(sessionDir);
        const manager = host.SessionManager.create(scratch, sessionDir);
        manager.appendMessage({ role: "user", content: "Publication boundary seed", timestamp: Date.now() });
        const h = await interactive(scratch, true, "fullscreen", manager);
        try {
          const source = join(h.directory, "submitted.pdf"); await writePdf(source, THRESHOLD + 1);
          let queuedAbsent = false, aborting, sabotaged = false;
          const unsubscribe = h.runtime.session.subscribe((event) => {
            if (event.type === "tool_execution_end" && event.toolName === "tmux_show_pdf") {
              queuedAbsent = manager.getEntries().every((e) => e.type !== "custom_message");
              if (failure === "cancel") aborting = h.runtime.session.abort();
            }
            if (failure === "persistence" && event.type === "turn_end" && !sabotaged) {
              // Public finalized turn boundary, persisted tool result already
              // present. Only this test's disposable JSONL is faulted; no host
              // method patch or production flag/setting is involved.
              sabotaged = true; const path = manager.getSessionFile(); unlinkSync(path); mkdirSync(path);
            }
          });
          h.offline.tools([{ type: "toolCall", id: "submitted-call", name: "tmux_show_pdf", arguments: { path: source } }]);
          const submission = choose(h, () => h.runtime.session.prompt("Offline deferred submission."), 1);
          if (failure === "persistence") await assert.rejects(submission, (e) => e.code === "EISDIR");
          else { await submission; await aborting; }
          unsubscribe(); assert.equal(queuedAbsent, true, "tool-time send unexpectedly implied immediate append");
          const entry = manager.getEntries().find((e) => e.type === "custom_message"); assert.ok(entry, "accepted preview was retracted");
          assert.equal(entry.details.document.retention, "temporary"); assert.equal("data" in entry.details.document, false);
          const result = manager.getEntries().find((e) => e.type === "message" && e.message.role === "toolResult").message;
          if (failure === "persistence") {
            assert.equal(result.isError, false); assert.match(JSON.stringify(result.content), /submitted/i, "tool result must not promise disk ACK");
            assert.equal(pdfMessages(h).length, 0, "failed deferred append should have no finalized display message");
          }
          await rm(source); const before = await invariant(h); await openViewer(h); await inputPage(h, "n", 2); await closeViewer(h); await unchanged(h, before);
        } finally { await h.cleanup(); }
      }
    });
    await t.test("actual selector concurrency, live-viewer admission and import cancellation/reload in both modes", async () => {
      for (const mode of ["fullscreen", "regular"]) {
        const h = await interactive(scratch, true, mode);
        try {
          const large = join(h.directory, "consent.pdf"); await writePdf(large, THRESHOLD + 1);
          const before = await invariant(h), log = await pdfLog(scratch);
          const start = h.terminal.writes.length, importing = h.runtime.session.prompt(`/tmux-pdf ${large}`);
          await until(() => { h.tui.renderNow(); return plain(h.terminal.writes.slice(start)).join("\n").includes("Temporary"); }, "active production selector");
          await h.runtime.session.prompt(`/tmux-pdf ${large}`);
          await h.runtime.session.prompt("/tmux-image-view");
          assert.equal(h.tui.hasOverlay(), false, "competing viewer displaced import selector");
          h.terminal.input("\x1b"); await importing; await unchanged(h, before); assert.deepEqual(await pdfLog(scratch), log);
          const toolStart = h.terminal.writes.length;
          h.offline.tools([{ type: "toolCall", id: "cancel-consent", name: "tmux_show_pdf", arguments: { path: large } }]);
          const tool = h.runtime.session.prompt("Offline abort consent.");
          await until(() => { h.tui.renderNow(); return plain(h.terminal.writes.slice(toolStart)).join("\n").includes("Temporary"); }, "tool selector before abort");
          await h.runtime.session.abort(); await tool;
          assert.equal(pdfMessages(h).length, 0, "tool cancellation before handoff submitted a preview");
          assert.equal(h.runtime.session.messages.find((m) => m.role === "toolResult").isError, true);
          const reloadBefore = await invariant(h), reloadStart = h.terminal.writes.length;
          const pending = h.runtime.session.prompt(`/tmux-pdf ${large}`);
          await until(() => { h.tui.renderNow(); return plain(h.terminal.writes.slice(reloadStart)).join("\n").includes("Temporary"); }, "slash selector before reload");
          await h.runtime.session.reload({ beforeSessionStart: () => h.settings.applyOverrides(h.overrides) }); await pending; await unchanged(h, reloadBefore);
          const small = join(h.directory, "small.pdf"); await writePdf(small); await submit(h, small); await rm(small);
          await openViewer(h); const liveBefore = await invariant(h), liveLog = await pdfLog(scratch), liveWire = graphics(h).length;
          await h.runtime.session.prompt("/tmux-pdf missing-source.pdf");
          assert.equal(h.tui.hasOverlay(), true, "PDF import stole live viewer focus"); assert.equal(graphics(h).length, liveWire);
          assert.deepEqual(await pdfLog(scratch), liveLog); await unchanged(h, liveBefore); await closeViewer(h);
        } finally { await h.cleanup(); }
      }
    });
    await t.test("corrupt retained originals and future/malformed schemas never probe provenance paths", async () => {
      const h = await interactive(scratch, false);
      try {
        const source = join(h.directory, "corrupt.pdf"); await writePdf(source); const message = await submit(h, source); await rm(source);
        const corrupt = { ...message.details, occurrence: "corrupt-retained-acceptance", label: "deleted/provenance-only.pdf",
          document: { ...message.details.document, sha256: "0".repeat(64) } };
        await h.runtime.session.sendCustomMessage({ customType: "pi-tmux-image", content: message.content, display: true, details: corrupt }, { triggerTurn: false });
        const before = await invariant(h); await openViewer(h);
        const log = await pdfLog(scratch); h.terminal.input("n");
        await until(() => { h.tui.renderNow(); return /hash|integrity|mismatch/i.test(plain(currentLines(h)).join("\n")); }, "corrupt-original error");
        assert.deepEqual(await pdfLog(scratch), log, "corrupt original reached Poppler or reread provenance path");
        assert.equal(currentLines(h).some((s) => s.includes(PH) && s.includes(color(h.pair.placementId, true))), false, "corrupt page retained private cells");
        await closeViewer(h); await unchanged(h, before);
        const renderer = h.runtime.services.resourceLoader.getExtensions().extensions.find((e) => e.commands.has("tmux-pdf")).messageRenderers.get("pi-tmux-image");
        const future = renderer({ ...message, details: { ...message.details, schema: "pi-tmux-image/pdf-future" } }, { expanded: false }, h.ctx.ui.theme);
        assert.equal(future.render(80).some((s) => s.includes(PH)), false);
        const malformed = renderer({ ...message, details: { ...message.details, document: { ...message.details.document, retention: "temporary" } } }, { expanded: false }, h.ctx.ui.theme);
        await until(() => malformed.render(80).some((s) => s.includes(PH)), "safe preview-only malformed document fallback");
        assert.deepEqual(await pdfLog(scratch), log, "schema fallback performed document work");
        await unchanged(h, before);
      } finally { await h.cleanup(); }
    });
    await t.test("genuine password-required PDF: production slash/tool reject with zero preview entries", async () => {
      const h = await interactive(scratch, true);
      try {
        const source = join(h.directory, "encrypted.pdf"); await writeFile(source, encryptedPdf(), { mode: 0o600 });
        // Positive control proves this is a valid encrypted PDF, not malformed
        // bytes that merely happen to trigger the same generic diagnostic.
        const control = await run(binaries.pdfinfo, ["-upw", "acceptance-fixture", source], { timeout: 10000, maxBuffer: 65536, env: { ...process.env, LC_ALL: "C", LANG: "C" } });
        assert.match(control.stdout, /^Pages:\s+1\s*$/m); assert.match(control.stdout, /^Encrypted:\s+yes\b/m);
        await assert.rejects(run(binaries.pdfinfo, [source], { timeout: 10000, maxBuffer: 65536 }), (e) => e.code === 1 && /password/i.test(e.stderr));
        const before = await invariant(h), wire = graphics(h).length, logStart = (await pdfLog(scratch)).length;
        await h.runtime.session.prompt(`/tmux-pdf ${source}`); await unchanged(h, before);
        assert.equal(pdfMessages(h).length, 0); assert.equal(graphics(h).length, wire);
        h.offline.tools([{ type: "toolCall", id: "encrypted-call", name: "tmux_show_pdf", arguments: { path: source } }]);
        await h.runtime.session.prompt("Offline encrypted rejection.");
        const result = h.runtime.session.messages.find((m) => m.role === "toolResult"); assert.ok(result?.isError);
        assert.match(JSON.stringify(result.content), /password/i); assert.equal(pdfMessages(h).length, 0);
        assert.equal(graphics(h).length, wire);
        assert.deepEqual((await pdfLog(scratch)).slice(logStart).map((q) => q.name), ["pdfinfo", "pdfinfo"], "password rejection reached raster/publication");
        assert.equal(JSON.stringify(h.runtime.session.messages).includes("acceptance-fixture"), false, "fixture password entered session");
        assert.equal(imageBlocks(h.offline.requests.flatMap((r) => r.messages)).length, 0);
      } finally { await h.cleanup(); }
    });
    await t.test("policy denial before sources and invalid PDFs append zero entries/graphics", async () => {
      const h = await interactive(scratch, true);
      try {
        h.settings.applyOverrides({ terminal: { showImages: false } });
        const before = await invariant(h), probes = await readFile(join(scratch, "tmux.log"), "utf8"), wire = graphics(h).length;
        await h.runtime.session.prompt("/tmux-pdf missing-source.pdf"); await unchanged(h, before);
        assert.equal(await readFile(join(scratch, "tmux.log"), "utf8"), probes); assert.equal(graphics(h).length, wire);
        h.settings.applyOverrides({ terminal: { showImages: true } });
        const path = join(h.directory, "invalid.pdf"); await writeFile(path, "not a PDF");
        await h.runtime.session.prompt(`/tmux-pdf ${path}`); assert.equal(pdfMessages(h).length, 0); await unchanged(h, before);
      } finally { await h.cleanup(); }
    });
    t.diagnostic("Production public SDK/capture stream only; no display ACK, human pixels, GPU bound or large-file latency guarantee. Detailed source races/child drain and held page generations remain provider/controller unit-owned.");
  } finally {
    ui.setCapabilities(caps); ui.setCellDimensions(cells);
    for (const k of keys) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    await rm(scratch, { recursive: true, force: true });
  }
});
