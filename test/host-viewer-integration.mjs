// Standalone optional production acceptance: node --test test/host-viewer-integration.mjs
// Only installed Pi public entry points; no real tty/provider or physical host dependencies.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import { DIACRITICS } from "../src/kitty-diacritics.mjs";
import { withPdfPages } from "../src/pdf.mjs";

const run = promisify(execFile);
const root = process.env.PI_TEST_HOST_ROOT && resolve(process.env.PI_TEST_HOST_ROOT);
const host = root ? await import(pathToFileURL(join(root, "dist/index.js")).href) : undefined;
const ui = root ? await import(pathToFileURL(createRequire(join(root, "dist/index.js")).resolve("@earendil-works/pi-tui")).href) : undefined;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PH = "\u{10eeee}";
const sleep = (ms = 10) => new Promise((finish) => setTimeout(finish, ms));
async function until(check, label = "host frame", timeout = 5000) {
  const end = Date.now() + timeout;
  while (!(await check())) { assert.ok(Date.now() < end, `${label} did not arrive`); await sleep(); }
}
class CaptureTerminal {
  columns = 80; rows = 40; kittyProtocolActive = false; writes = []; failNextGraphics = false;
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write(bytes) {
    this.writes.push(bytes);
    if (this.failNextGraphics && bytes.includes("\x1bPtmux;")) {
      this.failNextGraphics = false;
      throw new Error("Injected uncertain graphics write after capture");
    }
    this.onWrite?.(bytes);
  }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
  get output() { return this.writes.join(""); }
  mouse(button, x, y, release = false) { this.input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`); }
  click(x, y) { this.mouse(0, x, y); this.mouse(0, x, y, true); }
}
// An actual, self-contained PNG, deliberately nonsquare for aspect/cell tests.
function pngFixture(width = 320, height = 160) {
  function chunk(type, payload) {
    const header = Buffer.alloc(8); header.writeUInt32BE(payload.length); header.write(type, 4);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([Buffer.from(type), payload])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, payload, checksum]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const start = y * (1 + width * 4) + 1 + x * 4;
    pixels[start] = x < width / 2 ? 255 : 0; pixels[start + 1] = y < height / 2 ? 255 : 0;
    pixels[start + 2] = x >= width / 2 ? 255 : 0; pixels[start + 3] = 255;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
function pdfFixture() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 6 0 R >>",
    "<< /Length 25 >>\nstream\n1 0 0 rg 0 0 72 72 re f\n\nendstream",
    "<< /Length 25 >>\nstream\n0 0 1 rg 0 0 72 72 re f\n\nendstream",
  ];
  let data = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 7\n0000000000 65535 f \n` + offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return data + `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
const model = { id: "offline", name: "Offline verification", api: "offline-test", provider: "offline-test", baseUrl: "http://invalid.invalid", reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function offlineRuntime() {
  const requests = []; let permitted = false, release;
  return {
    requests,
    allowBackground() { permitted = true; },
    finishBackground() { release?.(); },
    getModel: () => model, getPhysicalModel: () => model, getModels: () => [model], getAvailableSnapshot: () => [model], refresh: async () => {},
    getError: () => undefined, hasConfiguredAuth: () => true, isUsingOAuth: () => false, isUsingSubscription: () => false,
    getAuth: async () => ({ apiKey: "offline-not-a-secret" }),
    streamSimple(_model, context) {
      assert.ok(permitted, "viewer unexpectedly called the offline model boundary"); permitted = false;
      requests.push(structuredClone(context));
      const gate = new Promise((finish) => { release = finish; });
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
        content: [{ type: "text", text: "Controlled background output." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: { ...message, stopReason: "pending", content: [] } };
        await gate; yield { type: "done", reason: "stop", message };
      }, result: async () => { await gate; return message; } };
    },
  };
}
const images = (messages) => messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((c) => c.type === "image") : []);
const snapshots = (h) => h.runtime.session.messages.filter((m) => m.role === "custom" && m.customType === "pi-tmux-image");
const graphics = (terminal) => terminal.writes.filter((bytes) => bytes.includes("\x1bPtmux;"));
function placements(writes) {
  return [...writes.join("").matchAll(/a=p,U=1,i=(\d+),p=(\d+),c=(\d+),r=(\d+)/g)]
    .map((m) => ({ imageId: +m[1], placementId: +m[2], columns: +m[3], rows: +m[4] }));
}
const uploads = (writes) => [...writes.join("").matchAll(/a=t,f=100/g)].length;
function uploadedPayloads(writes) {
  const payloads = new Map(); let currentId, chunks = [];
  // Independent wire decode: tmux doubles inner ESCs; PNG continuation controls
  // intentionally omit image ID. This establishes selected pixels, not just label.
  const decoded = writes.join("").replaceAll("\x1b\x1b", "\x1b");
  for (const match of decoded.matchAll(/\x1b_G([^;\x1b]+);([A-Za-z0-9+/=]*)\x1b\\/g)) {
    const controls = Object.fromEntries(match[1].split(',').map((field) => field.split('=')));
    if (controls.a === 't') { currentId = Number(controls.i); chunks = []; }
    assert.ok(currentId, "PNG continuation has no preceding image ID"); chunks.push(match[2]);
    if (controls.m === '0') { payloads.set(Buffer.from(chunks.join(''), 'base64').toString('base64'), currentId); currentId = undefined; }
  }
  return payloads;
}
const retirements = (writes) => [...writes.join("").matchAll(/a=d,d=i,i=(\d+),p=(\d+),q=2/g)].map((m) => ({ imageId: +m[1], placementId: +m[2] }));
const plain = (lines) => lines.map(ui.stripTerminalSequences);
const screen = (h) => h.tui.getScreenLines(); // Exported concrete TuiAltScreen diagnostic, fullscreen only.
const placementColor = (id) => `58:2::${(id >>> 16) & 255}:${(id >>> 8) & 255}:${id & 255}`;
const imageColor = (id) => `38;2;${(id >>> 16) & 255};${(id >>> 8) & 255};${id & 255}`;
const privateCells = (lines, id) => lines.some((line) => line.includes(PH) && line.includes(placementColor(id)));
const viewportPending = (lines) => plain(lines).some((line) => /Updating viewport|Preparing viewport|Preparing stored image/.test(line));
const readyCells = (lines, id) => privateCells(lines, id) && !viewportPending(lines);
// Decode the actual composed private cells, not production viewport/controller
// internals. Kitty row/column marks expose the realized, cell-quantized mapping.
function mouseView(h, lines = screen(h)) {
  const canvas = placements(graphics(h.terminal)).findLast((placement) =>
    placement.imageId === h.viewerPair.imageId && placement.placementId === h.viewerPair.placementId);
  assert.ok(canvas, "no prototype for the selected private surface");
  const cells = [];
  lines.forEach((line, y) => {
    if (!line.includes(placementColor(h.viewerPair.placementId))) return;
    const text = ui.stripTerminalSequences(line);
    let x, previousIndex;
    for (const match of text.matchAll(/\u{10eeee}(.)(.)/gu)) {
      const row = DIACRITICS.indexOf(match[1]), column = DIACRITICS.indexOf(match[2]);
      assert.ok(row >= 0 && column >= 0, "compositor lost independently addressed cell marks");
      // Constant-size slices avoid quadratic width scans of long placeholder
      // rows, which would measure the oracle rather than production rendering.
      x = previousIndex === undefined ? ui.visibleWidth(text.slice(0, match.index))
        : x + ui.visibleWidth(text.slice(previousIndex, match.index));
      cells.push({ x, y, column, row }); previousIndex = match.index;
    }
  });
  assert.ok(cells.length, "no ready private cells in mouse acceptance frame");
  const percent = Number(/(\d+)% Fit/.exec(plain(lines).join("\n"))?.[1]);
  assert.ok(Number.isFinite(percent), "missing mouse zoom title");
  return { canvas, first: cells[0], last: cells.at(-1), percent };
}
async function mouseReady(h, target = () => true, label = "mouse viewport ready") {
  await Promise.resolve(); h.tui.renderNow();
  await until(() => {
    h.tui.renderNow();
    return readyCells(screen(h), h.viewerPair.placementId) && target(mouseView(h));
  }, label);
  return mouseView(h);
}
const atPercent = (percent) => (view) => view.percent === percent;
function panTarget(view, xCells = 0, yCells = 0) {
  return { column: Math.max(0, Math.min(view.canvas.columns - (view.last.column - view.first.column + 1), view.first.column + xCells)),
    row: Math.max(0, Math.min(view.canvas.rows - (view.last.row - view.first.row + 1), view.first.row + yCells)) };
}
const atWindow = (target) => (view) => view.first.column === target.column && view.first.row === target.row;
// Main-screen mode exposes no public screen-lines query. Decode the LAST full
// private-cell output frame, never an old retained write behind a pending frame.
function composedView(h) {
  if (h.tui instanceof ui.TuiAltScreen) return readyCells(screen(h), h.viewerPair.placementId) ? mouseView(h) : undefined;
  const bytes = h.terminal.writes.findLast((write) => privateCells([write], h.viewerPair.placementId));
  if (!bytes || viewportPending([bytes])) return undefined;
  const text = ui.stripTerminalSequences(bytes);
  const marks = [...text.matchAll(/\u{10eeee}(.)(.)/gu)].map((m) => ({ row: DIACRITICS.indexOf(m[1]), column: DIACRITICS.indexOf(m[2]) }));
  // Main-screen differential output can omit unchanged title rows during pan.
  // Keep the latest publicly emitted title separately from the latest cell rows.
  const titleWrite = h.terminal.writes.findLast((write) => /\d+% Fit/.test(ui.stripTerminalSequences(write)));
  const title = titleWrite && ui.stripTerminalSequences(titleWrite);
  const percent = Number(/(\d+)% Fit/.exec(title || "")?.[1]);
  if (!marks.length || !Number.isFinite(percent)) return undefined;
  return { percent, first: marks[0], last: marks.at(-1),
    canvas: placements(graphics(h.terminal)).findLast((p) => p.placementId === h.viewerPair.placementId), atLimit: title.includes("(limit)") };
}
function sourceAt(view, point, cells = { widthPx: 8, heightPx: 16 }) {
  // Fixture PNG dimensions and the Kitty full-image aspect-fit rule. Keep this
  // oracle independent of computeViewport/zoomViewportAt.
  const scale = Math.min(view.canvas.columns * cells.widthPx / 320, view.canvas.rows * cells.heightPx / 160);
  const padX = (view.canvas.columns * cells.widthPx - 320 * scale) / 2;
  const padY = (view.canvas.rows * cells.heightPx - 160 * scale) / 2;
  return { x: ((view.first.column + point.x - view.first.x + 0.5) * cells.widthPx - padX) / scale / 320,
    y: ((view.first.row + point.y - view.first.y + 0.5) * cells.heightPx - padY) / scale / 160,
    cellX: cells.widthPx / scale / 320, cellY: cells.heightPx / scale / 160 };
}
async function invariant(h) {
  return { messages: JSON.stringify(h.runtime.session.messages), entries: JSON.stringify(h.ctx.sessionManager.getEntries()),
    conversion: structuredClone(await h.runtime.session.agent.convertToLlm(h.runtime.session.messages)), requests: h.offline.requests.length };
}
async function unchanged(h, before) { assert.deepEqual(await invariant(h), before, "viewer changed session storage/model conversion or started model work"); }

async function fixture(scratch, values = {}) {
  await writeFile(join(scratch, "tmux-fixture.json"), JSON.stringify({ passthrough: "on", termtype: "ghostty 1.3.1", termname: "xterm-ghostty", delay: 0, ...values }));
  await writeFile(join(scratch, "tmux-queries.log"), "");
}
async function patchFixture(scratch, values) {
  const path = join(scratch, "tmux-fixture.json");
  await writeFile(path, JSON.stringify({ ...JSON.parse(await readFile(path, "utf8")), ...values }));
}
async function queries(scratch) {
  return (await readFile(join(scratch, "tmux-queries.log"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}
async function transportStats(h) {
  const extension = h.runtime.services.resourceLoader.getExtensions().extensions.find((e) => e.commands.has("tmux-image-stats"));
  let text;
  await extension.commands.get("tmux-image-stats").handler("", { ...h.ctx, ui: { ...h.ctx.ui, notify(message) { text = message; } } });
  assert.match(text, /Epoch transfer:/, "public stats command did not report transport accounting");
  return text.split("\n").filter((line) => /^(?:Epoch transfer:|Runtime transfer:|Viewer operations:)/.test(line));
}
async function executable(name, path) {
  for (const directory of path.split(":")) {
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  assert.fail(`${name} must already be available on PATH; this harness never installs dependencies`);
}
async function setup(scratch, originalPath) {
  await mkdir(join(scratch, "bin")); await mkdir(join(scratch, "agent"));
  await fixture(scratch);
  await writeFile(join(scratch, "bin", "tmux"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const f = JSON.parse(fs.readFileSync(${JSON.stringify(join(scratch, "tmux-fixture.json"))}, "utf8"));
fs.appendFileSync(${JSON.stringify(join(scratch, "tmux-queries.log"))}, JSON.stringify(args) + "\\n");
const ordinal = fs.readFileSync(${JSON.stringify(join(scratch, "tmux-queries.log"))}, "utf8").trim().split("\\n").length;
function reply() {
 if (args[0] === "display-message") process.stdout.write("%1\\t$1\\t" + (f.visible === false ? "0" : "1") + "\\t0\\t1\\t0\\n");
 else if (args[0] === "show-options") process.stdout.write(f.passthrough + "\\n");
 else if (args[0] === "list-clients") process.stdout.write("offline-client\\t" + f.termtype + "\\t" + f.termname + "\\t0\\n");
 else { process.stderr.write("Unexpected non-read-only tmux operation"); process.exitCode = 1; }
}
if (f.holdQueries?.includes(ordinal)) {
 const started = Date.now(), release = ${JSON.stringify(scratch)} + "/query-" + ordinal + ".release";
 const wait = () => {
  if (fs.existsSync(release) || Date.now() - started >= 200) reply(); else setTimeout(wait, 5);
 };
 wait();
} else if (f.delay) setTimeout(reply, f.delay); else reply();
`, { mode: 0o755 });
  const poppler = await executable("pdftoppm", originalPath);
  await writeFile(join(scratch, "bin", "pdftoppm"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(scratch, "pdf-queries.log"))}, JSON.stringify(args) + "\\n");
const r = require("node:child_process").spawnSync(${JSON.stringify(poppler)}, args, {stdio:"inherit"});
if (r.error) throw r.error; process.exitCode = r.status === null ? 1 : r.status;
`, { mode: 0o755 });
  await writeFile(join(scratch, "pdf-queries.log"), "");
  await writeFile(join(scratch, "clipboard-queries.log"), "");
  for (const name of ["pbcopy", "wl-copy", "xclip", "xsel", "clip.exe"]) {
    await writeFile(join(scratch, "bin", name), `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(join(scratch, "clipboard-queries.log"))}, ${JSON.stringify(name + "\n")});\n`, { mode: 0o755 });
  }
  await writeFile(join(scratch, "agent", "settings.json"), JSON.stringify({ enableInstallTelemetry: false, enableAnalytics: false }));
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const cli = join(root, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
  await run(process.execPath, [cli, "install", repo], { cwd: scratch, timeout: 20000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", TERM: "dumb" } });
  const installed = JSON.parse(await readFile(join(scratch, "agent", "settings.json"), "utf8"));
  assert.ok(installed.packages.some((p) => resolve(join(scratch, "agent"), typeof p === "string" ? p : p.source) === repo));
}
async function interactive(scratch, blocked, mode = "fullscreen", manager) {
  const directory = await mkdtemp(join(scratch, "workspace-"));
  const terminal = new CaptureTerminal(), offline = offlineRuntime();
  let ctx, tui;
  const settings = host.SettingsManager.create(directory, join(scratch, "agent"));
  const overrides = { quietStartup: true, theme: "dark", cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false,
    fullscreenExitOutput: "resume-hint", fullscreenScrollbar: "hidden", fullscreenCopyOnSelect: false, doubleEscapeAction: "none", outputPad: 1,
    terminal: { images: "auto", trueColor: true }, images: { blockImages: blocked }, compaction: { enabled: false }, retry: { enabled: false } };
  const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await host.createAgentSessionServices({ cwd, agentDir, settingsManager: settings, modelRuntime: offline, resourceLoaderOptions: {
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => pi.on("session_start", (_event, context) => {
        ctx = context;
        context.ui.setWidget("viewer-acceptance-observer", (injected) => { tui = injected; return { render: () => [], invalidate() {} }; });
      })],
    } });
    settings.applyOverrides(overrides);
    const loaded = services.resourceLoader.getExtensions(); assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions.find((e) => e.commands.has("tmux-image"));
    assert.ok(extension, "isolated installed package not discovered");
    for (const name of ["tmux-image", "tmux-pdf", "tmux-image-view", "tmux-image-refresh", "tmux-image-stats"]) assert.ok(extension.commands.has(name), `missing ${name}`);
    for (const name of ["tmux_show_image", "tmux_show_pdf"]) {
      const tool = extension.tools.get(name)?.definition; assert.ok(tool);
      assert.equal(tool.executionMode, "sequential"); assert.equal(tool.parameters.properties.path.type, "string"); assert.ok(tool.parameters.required.includes("path"));
    }
    const created = await host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", noTools: "all" });
    assert.deepEqual(created.extensionsResult.errors, []);
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await host.createAgentSessionRuntime(factory, { cwd: directory, agentDir: join(scratch, "agent"), sessionManager: manager || host.SessionManager.inMemory(directory) });
  const app = new host.InteractiveMode(runtime, { terminal, tuiMode: mode, initialThemeSetting: "dark" });
  await app.init(); tui.renderNow();
  if (mode === "fullscreen") {
    // This exported concrete-host API prevents automatic selection clipboard work
    // even if InteractiveMode initialization reapplied an inherited preference.
    tui.setCopyOnSelect(false); assert.equal(tui.getCopyOnSelect(), false);
  }
  return { directory, terminal, offline, runtime, app, settings, overrides, get ctx() { return ctx; }, get tui() { return tui; },
    async cleanup() { offline.finishBackground(); app.stop(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }); } };
}
async function seed(h, scratch, pdf = true) {
  await writeFile(join(h.directory, "image.png"), pngFixture());
  await h.runtime.session.prompt("/tmux-image image.png");
  assert.equal(snapshots(h).length, 1, "image source command failed");
  if (pdf) {
    await writeFile(join(h.directory, "two-pages.pdf"), pdfFixture());
    // Explicit pre-document legacy history: two independent native-v1 page
    // snapshots. New imports are tested separately in host-pdf-integration.mjs;
    // these entries must never acquire full-document navigation by filename.
    await withPdfPages(join(h.directory, "two-pages.pdf"), async (path, page) => {
      const result = await host.createReadTool(h.directory).execute("legacy-pdf-fixture", { path });
      await h.runtime.session.sendCustomMessage({ customType: "pi-tmux-image", content: result.content, display: true,
        details: { schema: "pi-tmux-image/native-v1", occurrence: `legacy-page-${page}`,
          label: `${join(h.directory, "two-pages.pdf")} — page ${page}`,
          geometry: { columns: 48, rows: 24, cellWidthPx: 8, cellHeightPx: 16 } } }, { triggerTurn: false });
    });
    assert.equal(snapshots(h).length, 3, "legacy pages must remain independent snapshots");
  }
  const renderer = h.runtime.services.resourceLoader.getExtensions().extensions.find((e) => e.commands.has("tmux-image")).messageRenderers.get("pi-tmux-image");
  const components = snapshots(h).map((m) => renderer(m, { expanded: false, outputPad: 1 }, { fg: (_color, text) => text }));
  await until(() => { h.tui.renderNow(); return components.every((c) => c.render(80).some((line) => line.includes(PH))); }, "inline residency");
  const attachments = structuredClone(images(snapshots(h)));
  const transferred = uploadedPayloads(graphics(h.terminal));
  const imageIds = attachments.map((attachment) => transferred.get(attachment.data));
  assert.ok(imageIds.every(Boolean), "captured PNG upload bytes differ from the canonical PNG snapshots");
  h.imageDimensions = new Map(imageIds.map((imageId, index) => {
    const png = Buffer.from(attachments[index].data, "base64");
    return [imageId, { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }];
  }));
  assert.deepEqual(images(await h.runtime.session.agent.convertToLlm(h.runtime.session.messages)), h.settings.getBlockImages() ? [] : attachments);
  await rm(join(h.directory, "image.png")); if (pdf) await rm(join(h.directory, "two-pages.pdf"));
  const rasterCalls = (await readFile(join(scratch, "pdf-queries.log"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const args of rasterCalls) {
    const prefix = args.at(-1);
    await assert.rejects(access(dirname(prefix)), { code: "ENOENT" }, "PDF scratch directory survived tool callback");
  }
  const pdfLog = await readFile(join(scratch, "pdf-queries.log"), "utf8");
  return { components, attachments, imageIds, pdfLog };
}
async function open(h, pickerIndex = 0) {
  h.viewerStart = h.terminal.writes.length;
  h.command = h.runtime.session.prompt("/tmux-image-view");
  await until(() => { h.tui.renderNow(); return h.tui.hasOverlay(); }, "production viewer/picker");
  if (snapshots(h).length > 1) {
    for (let n = 0; n < pickerIndex; n++) h.terminal.input("\x1b[B");
    h.terminal.input("\r");
  }
  await viewerReady(h);
}
async function viewerReady(h) {
  try {
    await until(() => {
      h.tui.renderNow();
      const pair = placements(graphics(h.terminal)).at(-1);
      if (!pair) return false;
      const lines = h.tui instanceof ui.TuiAltScreen ? screen(h) : h.terminal.writes.slice(h.viewerStart || 0);
      if (!(h.tui instanceof ui.TuiAltScreen ? readyCells(lines, pair.placementId) : privateCells(lines, pair.placementId))) return false;
      assert.ok(lines.some((line) => line.includes(PH) && line.includes(placementColor(pair.placementId)) && line.includes(imageColor(pair.imageId))), "host composition lost encoded PNG foreground or private underline ID");
      h.viewerPair = pair; return true;
    }, "production private viewport glyphs");
    await until(() => {
      h.tui.renderNow();
      const lines = h.tui instanceof ui.TuiAltScreen ? screen(h) : h.terminal.writes.slice(h.viewerStart || 0);
      return plain(lines).some((line) => line.includes('% Fit'));
    }, "required fit-relative zoom title");
  }
  catch (error) {
    const lines = h.tui instanceof ui.TuiAltScreen ? screen(h) : h.terminal.writes.slice(-10);
    const chrome = plain(lines).filter((line) => !line.includes(PH)).map((line) => line.slice(0, 120)).join(' | ');
    assert.fail(`${error.message}; overlay=${h.tui.hasOverlay()} placements=${JSON.stringify(placements(graphics(h.terminal)).slice(-3))}; chrome=${chrome}`);
  }
}
async function close(h) {
  h.terminal.input("\x1b");
  await until(() => { h.tui.renderNow(); return !h.tui.hasOverlay(); }, "owned viewer close");
  await sleep(80); h.tui.renderNow();
  await h.command;
}
async function key(h, data) {
  h.tui.renderNow();
  const before = composedView(h);
  assert.ok(before, "keyboard target must start from an actual ready composed frame");
  const atLimit = before.atLimit ?? plain(screen(h))[0].includes("(limit)");
  let zoomPercent;
  if (data === "+" || data === "-") {
    const image = h.imageDimensions.get(before.canvas.imageId), cells = ui.getCellDimensions();
    const area = { columns: Math.min(297, h.terminal.columns - 4), rows: Math.min(297, h.terminal.rows - 6) };
    const fit = Math.min(area.columns * cells.widthPx / image.width, area.rows * cells.heightPx / image.height);
    const maximum = Math.min(297 * cells.widthPx / image.width, 297 * cells.heightPx / image.height) / fit;
    // Recover the nominal factor from the allowed discrete step families, not
    // from quantized cells. Minimum and maximum clamps start new step families.
    const candidates = [0.25, maximum];
    for (let n = -6; n < 32; n++) {
      for (const factor of [1.25 ** n, 0.25 * 1.25 ** n, maximum * 1.25 ** -n]) {
        if (factor >= 0.25 && factor <= maximum && Math.round(100 * factor) === before.percent) candidates.push(factor);
      }
    }
    const factor = atLimit ? maximum : candidates.find((value) => Math.round(100 * value) === before.percent);
    assert.ok(factor, "public title cannot identify a valid nominal zoom-step family");
    zoomPercent = Math.round(100 * Math.max(0.25, Math.min(maximum, data === "+" ? factor * 1.25 : factor / 1.25)));
  }
  const pan = { h: [-4, 0], j: [0, 4], k: [0, -4], l: [4, 0] }[data];
  const target = pan && panTarget(before, ...pan);
  h.terminal.input(data); h.tui.renderNow();
  await until(() => {
    h.tui.renderNow(); const view = composedView(h);
    if (!view) return false;
    if (target) return atWindow(target)(view);
    if (zoomPercent !== undefined) return view.percent === zoomPercent;
    if (data === "0") return view.percent === 100 && view.first.column === 0 && view.first.row === 0;
    return view.percent === before.percent && atWindow({ column: before.first.column, row: before.first.row })(view);
  }, `exact ready target after ${JSON.stringify(data)}`);
}

// Deterministic application pacing over the installed public terminal/TUI seam.
// This explicit 100 ms TEST allowance is not a proposed production cadence.
function pacingClock() {
  let now = 0, sequence = 0;
  const timers = new Map(), continuations = [];
  return {
    idleMs: 100, wheelExpiryMs: null, now: () => now,
    schedule(callback, delay) {
      const handle = ++sequence;
      timers.set(handle, { callback, due: now + delay });
      assert.ok(timers.size <= 1, "viewer armed more than one pacing timer");
      return handle;
    },
    cancelScheduled(handle) { timers.delete(handle); },
    defer(callback) {
      continuations.push(callback);
      assert.ok(continuations.length <= 1, "viewer queued more than one pacing continuation");
    },
    flush() {
      const pending = continuations.splice(0);
      for (const callback of pending) callback();
    },
    advance(ms = 0) {
      now += ms;
      // Snapshot callbacks once: no catch-up loop or implicit repeated ticks.
      const due = [...timers].filter(([, timer]) => timer.due <= now);
      for (const [handle, timer] of due) {
        if (!timers.delete(handle)) continue;
        timer.callback();
      }
    },
    get timerCount() { return timers.size; },
    get continuationCount() { return continuations.length; },
    get nextDelay() { return timers.size ? Math.max(0, [...timers.values()][0].due - now) : undefined; },
  };
}
async function pacedPublicTui() {
  const { createNativeRenderer } = await import("../src/native.mjs");
  const { createPresentation } = await import("../src/presentation.mjs");
  const { createViewerController } = await import("../src/viewer.mjs");
  const terminal = new CaptureTerminal(), tui = new ui.TuiAltScreen(terminal);
  const native = createNativeRenderer({ convertToPng: host.convertToPng }), presentation = createPresentation();
  const clock = pacingClock(), counts = { reuse: 0, prepare: 0, guards: 0 };
  const attachment = { type: "image", mimeType: "image/png", data: pngFixture().toString("base64") };
  const snapshot = Object.freeze({ occurrence: "paced-public-snapshot", label: "Generated pacing PNG", attachment: Object.freeze(attachment) });
  let widget, done, held, holdPost = false, missReuse = false, denied = false;
  const ctx = { mode: "tui", ui: { setWidget(_name, factory) { widget = factory(tui); } } };
  presentation.attach(ctx, true);
  const editor = { focused: false, render: () => ["protected editor"], invalidate() {}, handleInput() { assert.fail("paced viewer forwarded input to editor"); } };
  tui.addChild(editor); tui.setFocus(editor);
  const counted = { ...native,
    reuseViewer(...args) {
      counts.reuse++;
      // Constructor-bound collaborator fault injection, never a production
      // runtime switch: exercise the guarded path after a read-only reuse miss.
      if (missReuse) { missReuse = false; return undefined; }
      return native.reuseViewer(...args);
    },
    async prepareViewer(...args) {
      counts.prepare++;
      const prepared = await native.prepareViewer(...args);
      if (holdPost) {
        holdPost = false;
        let release;
        const promise = new Promise((resolve) => { release = resolve; });
        held = { promise, release, prepared };
      }
      return prepared;
    },
  };
  const viewer = createViewerController({ native: counted, presentation, pacing: clock,
    getContext: () => ctx, getSnapshots: () => [snapshot], getCells: ui.getCellDimensions,
    matchesKey: ui.matchesKey, parseKey: ui.parseKey, truncateToWidth: ui.truncateToWidth, visibleWidth: ui.visibleWidth,
    readyPolicy: () => denied ? "test display policy disabled" : undefined,
    requireCapability: async (_ctx, signal) => {
      counts.guards++; signal?.throwIfAborted();
      if (held) {
        const gate = held;
        await gate.promise;
        if (held === gate) held = undefined;
      }
      signal?.throwIfAborted();
    },
  });
  const h = { terminal, tui, native, presentation, clock, counts, snapshot, ctx, viewer,
    holdPost() { holdPost = true; }, missNextReuse() { missReuse = true; }, get held() { return held; },
    set denied(value) { denied = value; },
    // Only bootstrap/explicit target waits advance fake pacing. Incidental
    // render assertions below NEVER call this helper, preventing false passes.
    async target(check, label) {
      await until(async () => {
        await Promise.resolve(); tui.renderNow();
        clock.flush();
        if (check()) return true;
        if (clock.nextDelay !== undefined) clock.advance(clock.nextDelay);
        return false;
      }, label);
      tui.renderNow(); clock.flush();
    },
    async zoom() {
      const percent = mouseView(h).percent;
      terminal.input("+");
      await h.target(() => readyCells(screen(h), h.viewerPair.placementId) && mouseView(h).percent > percent, "exact paced zoom target");
    },
    async cleanup() {
      held?.release();
      await viewer.close("test cleanup"); await done;
      await viewer.dispose(); widget.dispose(); tui.stop();
    },
  };
  try {
    tui.start(); tui.renderNow();
    // Same production owner: inline residency before viewer, not fake rows.
    const prepared = await native.prepare({ attachment, occurrence: "paced-inline", geometry: {
      columns: 40, rows: 10, cellWidthPx: 8, cellHeightPx: 16 } }, { epoch: presentation.epoch });
    assert.equal(presentation.commit(prepared, { epoch: presentation.epoch }), true);
    done = viewer.open();
    await h.target(() => {
      const pair = placements(graphics(terminal)).at(-1);
      if (!pair || pair.placementId === prepared.placementId || !readyCells(screen(h), pair.placementId)) return false;
      h.viewerPair = pair; return plain(screen(h))[0].includes("100% Fit");
    }, "initial paced public ready frame");
    for (let n = 0; n < 4; n++) await h.zoom();
    const view = mouseView(h);
    assert.equal(view.percent, 244);
    assert.ok(view.canvas.columns > 76 && view.canvas.rows > 34, "paced drag must occupy both axes");
    clock.advance(clock.idleMs);
    return h;
  } catch (error) { await h.cleanup(); throw error; }
}
function sameMapping(actual, expected) {
  return actual.percent === expected.percent && JSON.stringify(actual.canvas) === JSON.stringify(expected.canvas) &&
    actual.first.column === expected.first.column && actual.first.row === expected.first.row;
}

import test from "node:test";
test("production viewer: isolated installed public SDK + InteractiveMode acceptance", {
  skip: !root && "set PI_TEST_HOST_ROOT to installed Pi package root", timeout: 180000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-viewer-acceptance-"));
  const keys = ["TMUX", "TMUX_PANE", "PATH", "PI_OFFLINE", "PI_CODING_AGENT_DIR", "PI_IMAGE_PROTOCOL", "DISPLAY", "WAYLAND_DISPLAY"];
  const old = Object.fromEntries(keys.map((name) => [name, process.env[name]]));
  const caps = { ...ui.getCapabilities() }, cells = { ...ui.getCellDimensions() };
  process.env.TMUX = "offline-viewer-fixture"; process.env.TMUX_PANE = "%1"; process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = join(scratch, "agent"); process.env.PI_IMAGE_PROTOCOL = "auto";
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
  process.env.PATH = join(scratch, "bin") + ":" + old.PATH;
  ui.setCapabilities({ images: null, trueColor: true, hyperlinks: false }); ui.setCellDimensions({ widthPx: 8, heightPx: 16 });
  try {
    await setup(scratch, old.PATH);
    for (const blocked of [true, false]) for (const mode of ["fullscreen", "regular"]) {
      await t.test(`${mode}, blockImages=${blocked}: picker/keys/shared payload/10k pan/close/source-deleted snapshots`, async () => {
        await fixture(scratch); const h = await interactive(scratch, blocked, mode);
        try {
          const seeded = await seed(h, scratch), before = await invariant(h);
          if (mode === "regular") {
            h.terminal.click(2, 5); await Promise.resolve();
            assert.equal(h.tui.hasOverlay(), false, "regular mode synthesized a normalized transcript click");
          }
          const inline = placements(graphics(h.terminal)); assert.ok(inline.length >= 3);
          const count = uploads(graphics(h.terminal)); assert.equal(count, 3, "shared inline pixels uploaded more than once per payload");
          h.ctx.ui.setEditorText("untouched draft"); h.tui.renderNow();
          const top = mode === "fullscreen" ? h.tui.viewportTop : undefined;
          h.terminal.writes.length = 0;
          await open(h, 2); // newest-first picker: page2, page1, PNG.
          const viewport = placements(graphics(h.terminal)); assert.equal(viewport.length, 1);
          const privatePair = viewport[0]; assert.equal(uploads(graphics(h.terminal)), 0);
          assert.equal(privatePair.imageId, seeded.imageIds[0], "picker index2 did not select the original PNG snapshot");
          assert.ok(inline.some((p) => p.imageId === privatePair.imageId && p.placementId !== privatePair.placementId));
          const body = mode === "fullscreen" ? screen(h).join("") : h.terminal.output;
          assert.match(ui.stripTerminalSequences(body), /100%/);
          if (mode === "regular") {
            const graphicsBeforeMouse = graphics(h.terminal).length;
            for (const report of [64, 65, 72, 73]) h.terminal.mouse(report, 30, 12);
            h.terminal.mouse(0, 30, 12); h.terminal.mouse(32, 35, 15); h.terminal.mouse(0, 35, 15, true);
            await sleep(30); h.tui.renderNow();
            assert.equal(graphics(h.terminal).length, graphicsBeforeMouse, "regular mouse reports changed the keyboard-only viewport");
            assert.equal(h.ctx.ui.getEditorText(), "untouched draft");
            await unchanged(h, before);
          }
          const startWrites = graphics(h.terminal).length;
          await key(h, "+");
          await until(() => { h.tui.renderNow(); return graphics(h.terminal).length > startWrites; }, "zoom prototype replacement");
          assert.equal(uploads(graphics(h.terminal)), 0);
          const zoom = placements(graphics(h.terminal)).at(-1); assert.equal(zoom.placementId, privatePair.placementId);
          assert.equal(zoom.imageId, privatePair.imageId); assert.ok(graphics(h.terminal).length > startWrites);
          const commands = placements(graphics(h.terminal)).length;
          // Public terminal callback, 10,000 intents; frame rendering/runner must coalesce.
          for (let n = 0; n < 10000; n++) h.terminal.input(["h", "j", "k", "l"][n % 4]);
          await key(h, "l");
          assert.equal(placements(graphics(h.terminal)).length, commands, "pan emitted prototype uploads");
          assert.equal(uploads(graphics(h.terminal)), 0);
          assert.deepEqual(new Set(placements(graphics(h.terminal)).map((p) => p.placementId)), new Set([privatePair.placementId]));
          for (const control of ["-", "0", "h", "j", "k", "l", "Q", "\x1b[5~"]) await key(h, control);
          for (let n = 0; n < 12; n++) await key(h, "-");
          const minimum = mode === "fullscreen" ? screen(h).join("") : h.terminal.writes.findLast((bytes) => ui.stripTerminalSequences(bytes).includes('% Fit'));
          assert.match(ui.stripTerminalSequences(minimum), /25% Fit/, "viewer minimum is not 25% of fit");
          for (let n = 0; n < 20; n++) await key(h, "+");
          const limited = placements(graphics(h.terminal)).at(-1);
          assert.ok(limited.columns <= 297 && limited.rows <= 297, "zoom exceeded addressable canvas");
          const atLimit = placements(graphics(h.terminal)).length;
          await key(h, "+"); assert.equal(placements(graphics(h.terminal)).length, atLimit, "zoom at dynamic limit repeatedly replaced prototype");
          await key(h, "0");
          h.terminal.mouse(65, 0, 0); h.terminal.click(2, 3); h.tui.renderNow();
          assert.equal(h.ctx.ui.getEditorText(), "untouched draft");
          if (mode === "fullscreen") assert.equal(h.tui.viewportTop, top);
          await unchanged(h, before);
          await close(h);
          const retired = retirements(graphics(h.terminal)); assert.deepEqual(retired, [{ imageId: privatePair.imageId, placementId: privatePair.placementId }]);
          assert.equal(/a=d,d=[A-Z]|a=d,d=a/.test(graphics(h.terminal).join("")), false, "viewer deleted shared pixels/global resources");
          assert.equal(h.ctx.ui.getEditorText(), "untouched draft");
          if (mode === "fullscreen") assert.equal(h.tui.viewportTop, top);
          for (let n = 0; n < 3; n++) {
            h.terminal.writes.length = 0; await open(h, n);
            assert.equal(h.viewerPair.imageId, seeded.imageIds[2 - n], "picker selected different page bytes than its newest-first snapshot index");
            await close(h);
            assert.equal(uploads(graphics(h.terminal)), n === 2 ? 1 : 0,
              "only previously retired PNG is retransmitted; never-retired PDF first binds reuse inline pixels");
            const reopenedPlacements = placements(graphics(h.terminal));
            assert.deepEqual(reopenedPlacements.filter((p) => p.placementId === privatePair.placementId), [h.viewerPair]);
            assert.deepEqual(reopenedPlacements.filter((p) => p.placementId !== privatePair.placementId),
              n === 2 ? inline.filter((p) => p.imageId === h.viewerPair.imageId) : [],
              "post-retirement reupload restores exact inline prototypes separately from the live slot");
          }
          assert.equal(await readFile(join(scratch, "pdf-queries.log"), "utf8"), seeded.pdfLog, "viewer rerasterized PDF sources");
          for (const component of seeded.components) assert.ok(component.render(80).some((line) => line.includes(PH)), "viewer retirement broke inline cells");
          await unchanged(h, before);
          h.terminal.input("X"); assert.equal(h.ctx.ui.getEditorText(), "untouched draftX", "editor focus was not restored");
        } finally { await h.cleanup(); }
      });
    }
    await t.test("option on performance: rendered pan is query/transport-free; guarded zoom retains mapping and drains one latest wheel", async () => {
      await fixture(scratch); const h = await interactive(scratch, true);
      try {
        const seeded = await seed(h, scratch, false), before = await invariant(h);
        h.ctx.ui.setEditorText("performance draft"); h.tui.renderNow(); const top = h.tui.viewportTop;
        await open(h);
        for (let n = 0; n < 4; n++) await key(h, "+");
        let view = mouseView(h);
        assert.equal(view.percent, 244);
        assert.ok(view.canvas.columns > 76 && view.canvas.rows > 34, "performance fixture must pan in both axes");
        const panQueries = await queries(scratch), panGraphics = graphics(h.terminal).length;
        const panMetrics = await transportStats(h), started = performance.now();
        // Each report is offered only after its preceding exact target has been
        // produced. Pacing may intentionally retain old rows between reports;
        // the query/transport-free contract still applies to every settled pan.
        h.terminal.mouse(0, 40, 20);
        for (let n = 0; n < 32; n++) {
          const previous = view, delta = n % 2 ? -1 : 1;
          h.terminal.mouse(32, 40 + (n % 2 ? 0 : 1), 20 + (n % 2 ? 0 : 1));
          view = await mouseReady(h, atWindow(panTarget(previous, -delta, -delta)), "exact separately offered resident drag target");
          assert.ok(readyCells(screen(h), h.viewerPair.placementId), "rendered resident drag blanked or entered async preparation");
          assert.deepEqual(view.canvas, previous.canvas);
          assert.equal(view.first.column, previous.first.column - delta);
          assert.equal(view.first.row, previous.first.row - delta);
          await sleep(1); // Separate event-loop turn, not coalesced input.
        }
        h.terminal.mouse(0, 40, 20, true);
        for (const control of ["l", "h", "j", "k", "l", "h", "j", "k"]) {
          const previous = view;
          await key(h, control);
          assert.ok(readyCells(screen(h), h.viewerPair.placementId), "keyboard pan lost resident cells");
          view = mouseView(h);
          assert.equal(view.first.column, previous.first.column + (control === "l" ? 4 : control === "h" ? -4 : 0));
          assert.equal(view.first.row, previous.first.row + (control === "j" ? 4 : control === "k" ? -4 : 0));
          await sleep(1);
        }
        assert.deepEqual(await queries(scratch), panQueries, "same-layout resident pan ran fake tmux capability subprocesses");
        assert.equal(graphics(h.terminal).length, panGraphics, "resident pan transported PNG/prototype commands");
        assert.deepEqual(await transportStats(h), panMetrics, "rows-only reuse advanced successful transport metrics");
        t.diagnostic(`40 separately rendered resident pans: ${(performance.now() - started).toFixed(1)} ms capture time including pacing waits/decoding/assertions/timers; 0 tmux queries; 0 graphics writes (not a pure render benchmark or human FPS).`);

        const oldView = mouseView(h), base = (await queries(scratch)).length;
        const placementCount = placements(graphics(h.terminal)).length;
        await patchFixture(scratch, { holdQueries: [base + 1, base + 4] });
        const updating = () => {
          h.tui.renderNow();
          assert.deepEqual(mouseView(h), oldView, "pending zoom exposed desired canvas/title/origin rather than committed mapping");
          const lines = plain(screen(h));
          assert.match(lines.at(-2), /Updating viewport/, "pending status must be below border and above controls");
          assert.match(lines.at(-1), /Esc close/);
          assert.equal(lines.some((line) => /Preparing viewport|Preparing stored image/.test(line)), false, "guarded replacement blanked the resident image");
          assert.equal(placements(graphics(h.terminal)).length, placementCount, "prototype transported before post gate release");
        };
        const firstPoint = { x: 35, y: 18 }, latestPoint = { x: 44, y: 22 };
        h.terminal.mouse(64, firstPoint.x, firstPoint.y);
        await until(async () => (await queries(scratch)).length === base + 1, "delayed pre-prepare visibility check");
        // Reports on separate turns plus a burst overwrite ONE pending event.
        // Latest sign is out, so final state is 244%, not accumulated/min/max.
        h.terminal.mouse(64, 27, 16); await Promise.resolve();
        h.terminal.mouse(65, 33, 19); await Promise.resolve();
        for (let n = 0; n < 8; n++) h.terminal.mouse(n % 2 ? 65 : 64, 25 + n, 18);
        h.terminal.mouse(65, latestPoint.x, latestPoint.y);
        await Promise.resolve();
        assert.equal((await queries(scratch)).length, base + 1, "pending wheel spawned additional async probes");
        updating();
        await writeFile(join(scratch, `query-${base + 1}.release`), "release");
        await until(async () => (await queries(scratch)).length === base + 4, "delayed post-prepare visibility check");
        updating();
        let intermediate, intermediateCommands;
        // Observe the actual captured output frame, not a timer-polled cached
        // screen: Pi can render and consume the queued wheel within one turn.
        // Fullscreen changed-row writes have public terminal cursor addressing;
        // replay just those rows onto the previously captured screen.
        const composed = screen(h).slice();
        h.terminal.onWrite = (bytes) => {
          if (!bytes.startsWith("\x1b[?2026h")) return;
          for (const match of bytes.matchAll(/\x1b\[(\d+);1H\x1b\[2K([\s\S]*?)(?=\x1b\[\d+;\d+H|\x1b\[\?25|\x1b\[\?2026l)/g)) composed[Number(match[1]) - 1] = match[2];
          if (readyCells(composed, h.viewerPair.placementId) && /305% Fit/.test(plain(composed)[0])) {
            intermediate = mouseView(h, composed);
            intermediateCommands = placements(graphics(h.terminal)).length;
          }
        };
        await writeFile(join(scratch, `query-${base + 4}.release`), "release");
        await until(() => { h.tui.renderNow(); return intermediate; }, "new ready zoom rendered before retained wheel consumption");
        h.terminal.onWrite = undefined;
        assert.equal(intermediate.percent, 305);
        assert.equal(intermediateCommands, placementCount + 1, "latest wheel transported before the first new ready mapping rendered");
        assert.deepEqual(intermediate.canvas, { imageId: oldView.canvas.imageId, placementId: oldView.canvas.placementId, columns: 232, rows: 58 }, "first replacement changed IDs or fit-relative canvas");
        const firstBefore = sourceAt(oldView, firstPoint), firstAfter = sourceAt(intermediate, firstPoint);
        assert.ok(Math.abs(firstBefore.x - firstAfter.x) <= firstAfter.cellX / 2 + 1e-10, "first replacement lost rendered x anchor");
        assert.ok(Math.abs(firstBefore.y - firstAfter.y) <= firstAfter.cellY / 2 + 1e-10, "first replacement lost rendered y anchor");
        const anchorBefore = sourceAt(intermediate, latestPoint);
        const staleAnchor = sourceAt(oldView, latestPoint);
        assert.ok(Math.abs(staleAnchor.x - anchorBefore.x) > firstAfter.cellX / 2, "latest-point fixture cannot distinguish old and newly rendered mappings");
        view = await mouseReady(h, atPercent(244), "exact retained latest out-wheel target");
        assert.equal(view.percent, 244, "latest pending wheel sign was dropped or accumulated");
        assert.deepEqual(view.canvas, oldView.canvas, "latest out event did not restore exactly the prior canvas/IDs");
        assert.ok(view.first.column > 0 && view.last.column < view.canvas.columns - 1 &&
          view.first.row > 0 && view.last.row < view.canvas.rows - 1, "latest anchor fixture unexpectedly clamped");
        const anchorAfter = sourceAt(view, latestPoint);
        assert.ok(Math.abs(anchorBefore.x - anchorAfter.x) <= anchorAfter.cellX / 2 + 1e-10, "retained latest wheel x anchor did not use newly rendered mapping");
        assert.ok(Math.abs(anchorBefore.y - anchorAfter.y) <= anchorAfter.cellY / 2 + 1e-10, "retained latest wheel y anchor did not use newly rendered mapping");
        assert.equal(placements(graphics(h.terminal)).length, placementCount + 2, "pending wheel created more than one follow-up replacement");
        const zoomQueries = (await queries(scratch)).slice(base);
        assert.deepEqual(zoomQueries.map((q) => q[0]), Array.from({ length: 4 }, () => ["display-message", "show-options", "list-clients"]).flat(), "two zooms must preserve exact fresh pre/post on-path checks");
        await sleep(60); h.tui.renderNow();
        assert.equal((await queries(scratch)).length, base + 12, "wheel queue kept launching after latest event drained");
        assert.equal(uploads(h.terminal.writes.slice(h.viewerStart)), 0);
        assert.equal(h.ctx.ui.getEditorText(), "performance draft"); assert.equal(h.tui.viewportTop, top);
        await unchanged(h, before);
        assert.equal(await readFile(join(scratch, "pdf-queries.log"), "utf8"), seeded.pdfLog);
        t.diagnostic("Guarded zoom + latest wheel: exactly 12 fake tmux queries (two pre/post triplets), two resident prototype replacements, zero PNG uploads.");
        await patchFixture(scratch, { holdQueries: [] });

        // Negative control: pane layout changes may not borrow the old ready
        // mapping even if its private prototype is otherwise resident.
        const resizeBase = (await queries(scratch)).length;
        await patchFixture(scratch, { holdQueries: [resizeBase + 1] });
        h.terminal.columns = 70; h.terminal.resize(); h.tui.renderNow();
        await until(async () => (await queries(scratch)).length === resizeBase + 1, "resize requires fresh asynchronous guard");
        h.tui.renderNow();
        assert.equal(privateCells(screen(h), h.viewerPair.placementId), false, "pane change reused old-layout cells");
        await writeFile(join(scratch, `query-${resizeBase + 1}.release`), "release");
        await mouseReady(h);
        assert.equal((await queries(scratch)).length - resizeBase, 6, "resize bypassed pre/post on-path checks");
        await patchFixture(scratch, { holdQueries: [] });
        h.terminal.columns = 80; h.terminal.resize(); await mouseReady(h);

        // A partial/uncertain write invalidates retained rows and native trust.
        const uncertainBase = (await queries(scratch)).length, uncertainMetrics = await transportStats(h);
        h.terminal.failNextGraphics = true; h.terminal.input("+");
        await until(() => { h.tui.renderNow(); return plain(screen(h)).some((line) => line.includes("Injected uncertain graphics write")); }, "uncertain replacement failure");
        assert.equal(privateCells(screen(h), h.viewerPair.placementId), false, "uncertain transport retained unproven old cells");
        assert.equal((await queries(scratch)).length - uncertainBase, 6);
        assert.deepEqual(await transportStats(h), uncertainMetrics, "uncertain write counted successful transport");
        const policyBase = await queries(scratch), policyGraphics = graphics(h.terminal).length;
        h.settings.applyOverrides({ terminal: { showImages: false } });
        h.terminal.input("l"); h.tui.renderNow();
        assert.equal(privateCells(screen(h), h.viewerPair.placementId), false);
        assert.deepEqual(await queries(scratch), policyBase, "sync policy loss queried tmux");
        assert.equal(graphics(h.terminal).length, policyGraphics, "policy loss wrote graphics");
        await until(() => !h.tui.hasOverlay(), "policy cancellation after uncertain write"); await h.command;
        h.settings.applyOverrides({ terminal: { showImages: true } });
        const refreshBase = (await queries(scratch)).length;
        await h.runtime.session.prompt("/tmux-image-refresh");
        await open(h); assert.equal(mouseView(h).percent, 100, "refresh reopened with stale desired geometry");
        assert.ok((await queries(scratch)).length > refreshBase, "refresh failed to invalidate capability decisions");
        assert.ok(uploads(graphics(h.terminal)) > 1, "uncertain/refresh recovery incorrectly trusted old residency");
        await close(h); await unchanged(h, before);
      } finally { await fixture(scratch); await h.cleanup(); }
    });
    await t.test("fullscreen production mouse: anchored one-step wheel, bounded bursts, captured pan and gesture cancellation", async () => {
      await fixture(scratch); const h = await interactive(scratch, false);
      try {
        const seeded = await seed(h, scratch), before = await invariant(h);
        h.ctx.ui.setEditorText("mouse draft"); h.tui.renderNow(); const top = h.tui.viewportTop;
        const protectedState = async () => {
          assert.equal(h.ctx.ui.getEditorText(), "mouse draft", "mouse gesture reached hidden editor");
          assert.equal(h.tui.viewportTop, top, "mouse gesture scrolled hidden transcript");
          await unchanged(h, before);
          assert.equal(await readFile(join(scratch, "pdf-queries.log"), "utf8"), seeded.pdfLog, "mouse viewer reread/rasterized a deleted source");
        };
        h.viewerStart = h.terminal.writes.length;
        h.command = h.runtime.session.prompt("/tmux-image-view");
        await until(() => { h.tui.renderNow(); return h.tui.hasOverlay(); }, "mouse picker");
        const pickerGraphics = graphics(h.terminal).length;
        for (const button of [64, 65, 72, 73]) h.terminal.mouse(button, 30, 12);
        h.terminal.mouse(0, 30, 12); h.terminal.mouse(32, 34, 15); h.terminal.mouse(0, 34, 15, true);
        await sleep(20); h.tui.renderNow();
        assert.equal(graphics(h.terminal).length, pickerGraphics, "picker mouse prepared an image");
        assert.match(plain(screen(h)).join("\n"), /› 1\./, "picker mouse changed the selected snapshot");
        h.terminal.input("\x1b[B"); h.terminal.input("\x1b[B"); h.terminal.input("\r");
        // The production selection is asynchronous. Input before its first
        // ready rendered frame must be consumed rather than retained for later.
        h.terminal.mouse(64, 30, 16); h.terminal.mouse(0, 30, 16);
        h.terminal.mouse(32, 35, 19); h.terminal.mouse(0, 35, 19, true);
        await viewerReady(h); assert.equal(h.viewerPair.imageId, seeded.imageIds[0]);
        const initial = mouseView(h), privateId = h.viewerPair.placementId;
        assert.equal(initial.percent, 100, "not-ready input was applied after first frame");
        const noOp = async (reports, label) => {
          const oldView = mouseView(h), count = graphics(h.terminal).length;
          reports(); await Promise.resolve(); h.tui.renderNow(); await sleep(250); h.tui.renderNow();
          assert.deepEqual(mouseView(h), oldView, label);
          assert.equal(graphics(h.terminal).length, count, `${label}: unexpected transport`);
        };
        assert.ok(initial.first.y > 4, "fixture needs a centered blank margin");
        await noOp(() => {
          h.terminal.mouse(0, 30, 4); h.terminal.mouse(32, 35, 15); h.terminal.mouse(0, 35, 15, true);
        }, "centered blank margin started a grab");
        h.terminal.mouse(64, 30, 4);
        assert.equal((await mouseReady(h, atPercent(125))).percent, 125, "wheel in inner blank margin did not zoom");
        await key(h, "0");
        const point = { x: 30, y: 16 };
        h.terminal.mouse(64, point.x, point.y);
        let view = await mouseReady(h, atPercent(125));
        assert.equal(view.percent, 125, "negative host wheelDelta must zoom in exactly one 1.25x step");
        assert.ok(view.canvas.columns > initial.canvas.columns);
        h.terminal.mouse(65, point.x, point.y); view = await mouseReady(h, atPercent(100));
        assert.equal(view.percent, 100, "positive host wheelDelta must zoom out exactly one step");
        assert.deepEqual(view.canvas, initial.canvas);
        await key(h, "0");
        // Alt is a positive control for a different normalized host delta: Pi
        // multiplies it beyond its ordinary time-based transcript acceleration.
        h.terminal.mouse(72, point.x, point.y); view = await mouseReady(h, atPercent(125));
        assert.equal(view.percent, 125, "accelerated/Alt wheel magnitude became multiple zoom steps");
        const accelerated = view.canvas;
        await key(h, "0"); h.terminal.mouse(64, point.x, point.y); view = await mouseReady(h, atPercent(125));
        assert.deepEqual(view.canvas, accelerated, "same wheel sign depends on transcript acceleration magnitude");
        await key(h, "0");
        const burstStart = placements(graphics(h.terminal)).length;
        const burstPoint = { x: 47, y: 18 }, expectedAnchor = sourceAt(mouseView(h), burstPoint);
        for (let n = 0; n < 10000; n++) h.terminal.mouse(n % 2 ? 73 : 72, 25 + n % 20, 15);
        h.terminal.mouse(64, burstPoint.x, burstPoint.y);
        view = await mouseReady(h, atPercent(125));
        assert.equal(view.percent, 125, "synchronous wheel burst did not use only its latest direction");
        assert.equal(placements(graphics(h.terminal)).length - burstStart, 1, "wheel burst queued unbounded prototype work");
        let anchor = sourceAt(view, burstPoint);
        // Horizontal fit fills the area, and this point's ideal new offset is
        // interior (no clamp). The vertical axis remains fully visible here.
        assert.ok(view.first.column > 0 && view.last.column < view.canvas.columns - 1, "burst anchor fixture unexpectedly clamped horizontally");
        assert.ok(Math.abs(anchor.x - expectedAnchor.x) <= anchor.cellX / 2 + 1e-10, "burst ignored latest pointer anchor");
        await key(h, "0");
        for (let n = 0; n < 4; n++) await key(h, "+");
        view = mouseView(h); assert.ok(view.canvas.columns > 76 && view.canvas.rows > 34);
        const anchorPoint = { x: 44, y: 22 }, oldAnchor = sourceAt(view, anchorPoint);
        h.terminal.mouse(64, anchorPoint.x, anchorPoint.y); const anchored = await mouseReady(h, atPercent(305));
        anchor = sourceAt(anchored, anchorPoint);
        assert.equal(anchored.percent, 305, "separate event-loop turn must apply one further wheel step");
        assert.ok(anchored.first.column > 0 && anchored.last.column < anchored.canvas.columns - 1 &&
          anchored.first.row > 0 && anchored.last.row < anchored.canvas.rows - 1, "two-axis anchor fixture unexpectedly reached a clamp");
        const toleranceX = anchor.cellX / 2 + 1e-10, toleranceY = anchor.cellY / 2 + 1e-10;
        assert.ok(Math.abs(anchor.x - oldAnchor.x) <= toleranceX, "wheel source x anchor exceeded half a new displayed cell");
        assert.ok(Math.abs(anchor.y - oldAnchor.y) <= toleranceY, "wheel source y anchor exceeded half a new displayed cell");
        // Negative control: the old state is centered by reset + keyboard zoom.
        // A center-preserving replacement at the same new canvas MUST fail both
        // pointer assertions, rather than accidentally passing a loose tolerance.
        const centerBased = sourceAt({ ...anchored, first: { ...anchored.first,
          column: Math.round((anchored.canvas.columns - (anchored.last.x - anchored.first.x + 1)) / 2),
          row: Math.round((anchored.canvas.rows - (anchored.last.y - anchored.first.y + 1)) / 2) } }, anchorPoint);
        assert.ok(Math.abs(centerBased.x - oldAnchor.x) > toleranceX, "x anchor fixture cannot distinguish center-based zoom");
        assert.ok(Math.abs(centerBased.y - oldAnchor.y) > toleranceY, "y anchor fixture cannot distinguish center-based zoom");
        await noOp(() => {
          h.terminal.mouse(64, 0, 0); h.terminal.mouse(65, 1, 2);
          h.terminal.mouse(0, 2, 0); h.terminal.mouse(32, 8, 4); h.terminal.mouse(0, 8, 4, true);
          for (const button of [1, 2]) {
            h.terminal.mouse(button, 40, 20); h.terminal.mouse(32 + button, 45, 23); h.terminal.mouse(button, 45, 23, true);
          }
        }, "chrome/outside/other buttons changed viewport");
        const panStart = graphics(h.terminal).length, grabbed = mouseView(h);
        h.terminal.mouse(0, 40, 20); h.terminal.mouse(32, 43, 22);
        view = await mouseReady(h, atWindow(panTarget(grabbed, -3, -2)));
        assert.equal(view.first.column, grabbed.first.column - 3, "grab did not move image with horizontal pointer motion");
        assert.equal(view.first.row, grabbed.first.row - 2, "grab did not move image with vertical pointer motion");
        h.terminal.mouse(0, 43, 22, true); await mouseReady(h);
        await noOp(() => h.terminal.mouse(32, 46, 25), "motion after release continued pan");
        const outsideStart = mouseView(h);
        h.terminal.mouse(0, 40, 20); h.terminal.mouse(32, 0, 0);
        view = await mouseReady(h, atWindow(panTarget(outsideStart, 40, 20)));
        assert.ok(view.first.column > grabbed.first.column && view.first.row > grabbed.first.row, "captured two-axis drag stopped outside inner image area");
        assert.ok(view.last.column < view.canvas.columns && view.last.row < view.canvas.rows, "outside drag escaped canvas bounds");
        for (let n = 0; n < 2; n++) {
          const previous = mouseView(h);
          h.terminal.mouse(0, 0, 0, true); h.terminal.mouse(0, 40, 20); h.terminal.mouse(32, 0, 0);
          await mouseReady(h, atWindow(panTarget(previous, 40, 20)));
        }
        h.terminal.mouse(32, 0, 0); await mouseReady(h); // advance pointer at the clamped edge
        const clamped = mouseView(h);
        assert.equal(clamped.last.column, clamped.canvas.columns - 1, "drag did not reach horizontal canvas edge");
        assert.equal(clamped.last.row, clamped.canvas.rows - 1, "drag did not reach vertical canvas edge");
        h.terminal.mouse(32, 1, 1); view = await mouseReady(h, atWindow(panTarget(clamped, -1, -1)));
        assert.equal(view.first.column, clamped.first.column - 1, "edge reversal accumulated hidden horizontal movement");
        assert.equal(view.first.row, clamped.first.row - 1, "edge reversal accumulated hidden vertical movement");
        h.terminal.mouse(0, 3, 3, true); view = await mouseReady(h, atWindow(panTarget(clamped, -3, -3)));
        assert.equal(view.first.column, clamped.first.column - 3, "release dropped final horizontal displacement");
        assert.equal(view.first.row, clamped.first.row - 3, "release dropped final vertical displacement");
        await noOp(() => h.terminal.mouse(32, 20, 10), "outside release did not end capture");
        for (let n = 0; n < 100; n++) {
          h.terminal.mouse(0, 40, 20);
          for (let m = 0; m < 100; m++) h.terminal.mouse(32, 40 + m % 2, 20 + m % 2);
          h.terminal.mouse(0, 40, 20, true);
        }
        await mouseReady(h);
        assert.equal(graphics(h.terminal).length, panStart, "pure captured pan/bursts emitted PNG or prototype transport");
        assert.equal(uploads(h.terminal.writes.slice(h.viewerStart)), 0, "mouse zoom/pan retransmitted resident PNG");
        assert.deepEqual(new Set(placements(h.terminal.writes.slice(h.viewerStart)).map((p) => p.placementId)), new Set([privateId]), "mouse history allocated additional private placements");
        await protectedState();
        // Keyboard zoom/pan and live geometry changes invalidate old capture.
        h.terminal.mouse(0, 40, 20); await key(h, "h");
        await noOp(() => { h.terminal.mouse(32, 45, 23); h.terminal.mouse(0, 45, 23, true); }, "keyboard control left a stale drag");
        for (const kind of ["resize", "cells", "tiny"]) {
          h.terminal.mouse(0, 40, 20);
          if (kind === "cells") ui.setCellDimensions({ widthPx: 10, heightPx: 20 });
          else { h.terminal.columns = kind === "tiny" ? 12 : 30; h.terminal.rows = kind === "tiny" ? 6 : 16; h.terminal.resize(); }
          h.tui.renderNow(); await sleep(40); h.tui.renderNow();
          if (kind === "tiny") {
            assert.equal(privateCells(screen(h), privateId), false, "tiny fallback retained graphical cells");
            const count = graphics(h.terminal).length;
            h.terminal.mouse(64, 5, 3); h.terminal.mouse(32, 8, 4); h.terminal.mouse(0, 8, 4, true);
            await Promise.resolve(); h.tui.renderNow();
            assert.equal(graphics(h.terminal).length, count, "tiny fallback mouse changed graphical view");
          }
          h.terminal.columns = 80; h.terminal.rows = 40; ui.setCellDimensions({ widthPx: 8, heightPx: 16 }); h.terminal.resize();
          await mouseReady(h);
          await noOp(() => { h.terminal.mouse(32, 45, 23); h.terminal.mouse(0, 45, 23, true); }, `${kind} failed to cancel capture`);
        }
        await protectedState();
        h.terminal.mouse(0, 40, 20); await close(h); await open(h, 2);
        assert.equal(mouseView(h).percent, 100, "close mid-drag did not reopen fit/fresh");
        await noOp(() => { h.terminal.mouse(32, 45, 23); h.terminal.mouse(0, 45, 23, true); }, "close/reopen inherited old capture");
        h.terminal.mouse(0, 40, 20); h.terminal.input("\x1b[102;6u");
        await h.command; h.tui.renderNow();
        assert.match(plain(screen(h)).join("\n"), /Find in transcript/);
        assert.equal(privateCells(screen(h), privateId), false, "modal focus loss retained dragging viewer");
        h.terminal.input("\x1b"); h.tui.renderNow(); await open(h, 2);
        assert.equal(mouseView(h).percent, 100, "focus-loss reopen retained mouse state");
        await noOp(() => { h.terminal.mouse(32, 45, 23); h.terminal.mouse(0, 45, 23, true); }, "modal/reopen inherited capture");
        await close(h); await protectedState();
        for (const component of seeded.components) assert.ok(component.render(80).some((line) => line.includes(PH)), "mouse retirement broke inline history");
      } finally { ui.setCellDimensions({ widthPx: 8, heightPx: 16 }); await h.cleanup(); }
    });
    await t.test("fullscreen actual mouse cells open the exact PDF page; label/padding/drag/wheel do not open", async () => {
      await fixture(scratch); const h = await interactive(scratch, true);
      try {
        const seeded = await seed(h, scratch); const before = await invariant(h);
        h.ctx.ui.setEditorText("click draft"); h.tui.scrollToBottom(); h.tui.renderNow();
        let rows = plain(screen(h)); const labelY = rows.findIndex((line) => line.includes("page 2"));
        assert.ok(labelY >= 0, "page2 label not visible");
        const gridY = rows.findIndex((line, y) => y > labelY && line.includes(PH)); assert.ok(gridY >= 0);
        const gridX = [...rows[gridY]].findIndex((char) => char === PH); assert.ok(gridX >= 0);
        h.terminal.click(1, labelY); await sleep(30); assert.equal(h.tui.hasOverlay(), false, "label opened viewer");
        const lastCellX = ui.visibleWidth(screen(h)[gridY]);
        h.terminal.click(Math.min(79, lastCellX + 1), gridY); await sleep(30); assert.equal(h.tui.hasOverlay(), false, "padding opened viewer");
        h.terminal.mouse(0, gridX, gridY); h.terminal.mouse(32, gridX + 3, gridY + 1); h.terminal.mouse(0, gridX + 3, gridY + 1, true);
        await sleep(30); assert.equal(h.tui.hasOverlay(), false, "selection drag opened viewer");
        h.terminal.mouse(64, gridX, gridY); h.tui.renderNow(); assert.equal(h.tui.hasOverlay(), false, "wheel opened viewer");
        h.tui.scrollToBottom(); h.tui.renderNow(); rows = plain(screen(h));
        const page2 = rows.findIndex((line) => line.includes("page 2"));
        const y = rows.findIndex((line, index) => index > page2 && line.includes(PH)); assert.ok(y >= 0);
        h.terminal.click(gridX, y); await viewerReady(h); assert.equal(h.tui.hasOverlay(), true);
        assert.equal(h.viewerPair.imageId, seeded.imageIds[2], "actual page2 click resolved different snapshot PNG bytes");
        assert.match(plain(screen(h)).join("\n"), /page 2/); await close(h);
        assert.equal(h.ctx.ui.getEditorText(), "click draft"); await unchanged(h, before);
      } finally { await h.cleanup(); }
    });
    await t.test("fullscreen admission/search focus loss and pending-prepare close have no stale private graphics", async () => {
      await fixture(scratch); const h = await interactive(scratch, false);
      try {
        await seed(h, scratch, false); const before = await invariant(h);
        h.ctx.ui.setEditorText("protected draft"); h.tui.renderNow();
        h.terminal.input("\x1b[102;6u"); h.tui.renderNow(); assert.match(plain(screen(h)).join("\n"), /Find in transcript/);
        const prior = graphics(h.terminal).length;
        await h.runtime.session.prompt("/tmux-image-view"); h.tui.renderNow();
        assert.equal(graphics(h.terminal).length, prior, "admission over search emitted graphics");
        h.terminal.input("\x1b"); h.tui.renderNow(); await open(h);
        const top = h.tui.viewportTop, privateId = h.viewerPair.placementId;
        h.terminal.input("\x1b[102;6u"); // Host reserved key closes through public focus loss.
        h.terminal.input("Q"); h.tui.renderNow();
        assert.equal(h.ctx.ui.getEditorText(), "protected draft"); assert.equal(h.tui.viewportTop, top);
        await sleep(60); h.tui.renderNow();
        assert.match(plain(screen(h)).filter((line) => !line.includes(PH)).join("\n"), /Q\s+(?:\d+\/\d+|No matches)/, "new search must own the query after viewer focus loss");
        assert.equal(privateCells(screen(h), privateId), false, "focus-lost viewer published stale cells above host search");
        await h.command;
        h.terminal.input("\x1b"); h.tui.renderNow(); assert.equal(h.tui.hasOverlay(), false);
        // Delayed read-only probe blocks preparation; Escape races before its reply.
        await fixture(scratch, { delay: 150 });
        await h.runtime.session.prompt("/tmux-image-refresh");
        h.terminal.writes.length = 0;
        h.command = h.runtime.session.prompt("/tmux-image-view");
        await until(() => { h.tui.renderNow(); return h.tui.hasOverlay(); }, "mount before pending preparation close");
        h.terminal.input("\x1b"); await h.command; await sleep(350); h.tui.renderNow();
        assert.equal(h.tui.hasOverlay(), false);
        assert.equal(retirements(graphics(h.terminal)).length <= 1, true);
        await unchanged(h, before);
      } finally { await fixture(scratch); await h.cleanup(); }
    });
    for (const mode of ["fullscreen", "regular"]) {
      await t.test(`${mode}: upper custom/builtin dialog focus loss preserves owned modal and editor`, async () => {
        await fixture(scratch); const h = await interactive(scratch, true, mode); let done;
        try {
          await seed(h, scratch, false); const before = await invariant(h); h.ctx.ui.setEditorText("upper draft");
          await open(h); let handle, disposed = 0; const inputs = [];
          const upper = h.ctx.ui.custom((_tui, _theme, _keys, finish) => {
            done = finish; return { render: () => ["UPPER-HOST-DIALOG"], invalidate() {}, handleInput(data) { inputs.push(data); if (ui.matchesKey(data, "escape")) finish("closed"); }, dispose() { disposed++; } };
          }, { overlay: true, onHandle(value) { handle = value; h.terminal.input("Q"); } });
          await until(() => handle); await sleep(60); h.tui.renderNow();
          assert.ok(handle.getBounds()); assert.equal(handle.isFocused(), true); assert.equal(disposed, 0); assert.deepEqual(inputs, ["Q"]);
          h.terminal.input("\x1b"); assert.equal(await upper, "closed"); assert.equal(disposed, 1);
          await h.command;
          assert.equal(h.tui.hasOverlay(), false); assert.equal(h.ctx.ui.getEditorText(), "upper draft");
          await open(h); const select = h.ctx.ui.select("Builtin selector", ["one", "two"]); await sleep(40);
          h.terminal.input("\r"); assert.equal(await select, "one");
          assert.equal(h.tui.hasOverlay(), false); h.terminal.input("X"); assert.equal(h.ctx.ui.getEditorText(), "upper draftX");
          await unchanged(h, before);
        } finally { done?.(); await h.cleanup(); }
      });
    }
    await t.test("fullscreen resize/cell changes, ready policy hide, refresh/reload/widget/branch/new-session close", async () => {
      await fixture(scratch); const h = await interactive(scratch, false);
      try {
        await seed(h, scratch); const before = await invariant(h); await open(h); await key(h, "+");
        const privateId = placements(graphics(h.terminal)).at(-1).placementId;
        const pngCount = uploads(graphics(h.terminal));
        for (const [width, height, cw, ch] of [[30, 16, 8, 16], [12, 6, 16, 16], [80, 40, 8, 16]]) {
          h.terminal.columns = width; h.terminal.rows = height; ui.setCellDimensions({ widthPx: cw, heightPx: ch }); h.terminal.resize();
          await sleep(150); h.tui.renderNow();
          for (const line of screen(h)) assert.ok(ui.visibleWidth(line) <= width, "overlay overflow under actual host composite");
          assert.equal(h.tui.hasOverlay(), true, "small pane dropped Escape ownership");
        }
        assert.equal(uploads(graphics(h.terminal)), pngCount, "resize retransmitted resident PNG");
        const probes = await readFile(join(scratch, "tmux-queries.log"), "utf8"), writes = graphics(h.terminal).length;
        h.settings.applyOverrides({ terminal: { showImages: false } }); h.tui.renderNow();
        assert.equal(screen(h).some((line) => line.includes(PH)), false, "ready viewer cells ignored display policy");
        assert.equal(graphics(h.terminal).length, writes); assert.equal(await readFile(join(scratch, "tmux-queries.log"), "utf8"), probes, "ready frame queried tmux");
        h.settings.applyOverrides({ terminal: { showImages: true } });
        await until(() => !h.tui.hasOverlay(), "display-policy close");
        await h.command; await open(h);
        h.terminal.writes.length = 0;
        await h.runtime.session.prompt("/tmux-image-refresh"); await until(() => !h.tui.hasOverlay(), "refresh close");
        await sleep(150); h.tui.renderNow();
        assert.ok(placements(graphics(h.terminal)).every((p) => p.placementId !== privateId), "refresh resurrected an inactive viewer prototype");
        await open(h); await h.runtime.session.reload({ beforeSessionStart: () => h.settings.applyOverrides(h.overrides) });
        await until(() => !h.tui.hasOverlay(), "reload close"); await sleep(120); h.tui.renderNow(); await unchanged(h, before);
        await open(h); h.ctx.ui.setWidget("pi-tmux-image-transport", undefined);
        await until(() => !h.tui.hasOverlay(), "owning widget disposal close");
        await h.runtime.session.reload({ beforeSessionStart: () => h.settings.applyOverrides(h.overrides) }); await open(h);
        // Pi's public custom-message navigation selects BEFORE that entry, so
        // page1's parent retains the PNG while abandoning both PDF snapshots.
        const entry = h.ctx.sessionManager.getBranch().filter((e) => e.type === "custom_message" && e.customType === "pi-tmux-image")[1]; assert.ok(entry);
        await h.runtime.session.navigateTree(entry.id, { summarize: false }); await until(() => !h.tui.hasOverlay(), "branch navigation close");
        assert.equal(snapshots(h).length, 1, "public tree navigation did not select the intended PNG-only branch");
        await open(h); await h.runtime.newSession(); await until(() => !h.tui.hasOverlay(), "new-session close");
        assert.equal(h.offline.requests.length, 0);
      } finally { ui.setCellDimensions({ widthPx: 8, heightPx: 16 }); await h.cleanup(); }
    });
    await t.test("regular legitimate editor command loop opens keyboard fallback with no model request", async () => {
      await fixture(scratch); const h = await interactive(scratch, true, "regular");
      try {
        await seed(h, scratch, false); const before = await invariant(h);
        h.ctx.ui.setEditorText("/tmux-image-view"); h.tui.renderNow();
        const input = h.app.getUserInput(); h.terminal.input("\r"); assert.equal(await input, "/tmux-image-view");
        h.command = h.runtime.session.prompt("/tmux-image-view"); await viewerReady(h); await close(h); await unchanged(h, before);
      } finally { await h.cleanup(); }
    });
    await t.test("deliberate offline background model run: viewer adds no request/message/attachment", async () => {
      await fixture(scratch); const h = await interactive(scratch, false);
      try {
        await seed(h, scratch, false); h.offline.allowBackground();
        const background = h.runtime.session.prompt("Controlled background fixture.");
        await until(() => h.offline.requests.length === 1, "deliberate offline request");
        const before = await invariant(h);
        await open(h); await key(h, "+"); await key(h, "l"); await key(h, "0"); await close(h); await unchanged(h, before);
        h.offline.finishBackground(); await background; await h.runtime.session.waitForIdle();
        assert.equal(h.offline.requests.length, 1); assert.equal(images(snapshots(h)).length, 1);
      } finally { await h.cleanup(); }
    });
    await t.test("unsupported path and public policy reject snapshot open with zero graphics", async () => {
      for (const denied of [{ passthrough: "off" }, { termtype: "unknown", termname: "xterm-unknown" }]) {
        await fixture(scratch, denied);
        const manager = host.SessionManager.inMemory(scratch);
        manager.appendCustomMessageEntry("pi-tmux-image", [{ type: "image", mimeType: "image/png", data: pngFixture().toString("base64") }], true,
          { schema: "pi-tmux-image/native-v1", occurrence: "denied-stored", label: "Deleted source", geometry: { columns: 40, rows: 10, cellWidthPx: 8, cellHeightPx: 16 } });
        const h = await interactive(scratch, true, "fullscreen", manager);
        try {
          await h.runtime.session.prompt("/tmux-image-view"); await sleep(150); h.tui.renderNow();
          assert.equal(graphics(h.terminal).length, 0); assert.equal(h.offline.requests.length, 0);
          if (h.tui.hasOverlay()) await close(h);
        } finally { await h.cleanup(); }
      }
      await fixture(scratch);
    });
    await t.test("production native owner on public capture transport: 10k pan/open shapes stay bounded; live-only replay", async () => {
      await fixture(scratch); const h = await interactive(scratch, true);
      const { createNativeRenderer } = await import("../src/native.mjs");
      const native = createNativeRenderer({ convertToPng: host.convertToPng });
      let epoch = Symbol("native-owner-capture");
      const attachment = { type: "image", mimeType: "image/png", data: pngFixture().toString("base64") };
      const commit = (prepared) => {
        assert.equal(prepared.isCurrent(), true);
        if (prepared.uploads) h.tui.terminal.write(prepared.uploads);
        prepared.onUploaded();
      };
      const geometry = (columns, rows) => ({ columns, rows, cellWidthPx: 8, cellHeightPx: 16 });
      const inlinePrepare = (columns, rows) => native.prepare({ attachment, occurrence: "native-retained-inline", geometry: geometry(columns, rows) }, { epoch });
      try {
        const before = await invariant(h);
        commit(await inlinePrepare(40, 10)); commit(await inlinePrepare(20, 5));
        const retained = placements(graphics(h.terminal)); assert.equal(retained.length, 2);
        const payload = await native.resolvePayload(attachment);
        let lease = native.reserveViewerPlacement({ payload, occurrence: "native-viewer-snapshot" });
        const canvas = geometry(100, 50);
        const window = { columns: 30, rows: 10, columnOffset: 20, rowOffset: 15 };
        commit(await native.prepareViewer({ lease, canvas, window }, { epoch }));
        const privateId = lease.placementId; assert.ok(retained.every((p) => p.placementId !== privateId));
        const allocated = native.stats(epoch).viewer.allocatedIds;
        h.terminal.writes.length = 0;
        for (let n = 0; n < 10000; n++) {
          const prepared = await native.prepareViewer({ lease, canvas, window: { ...window, columnOffset: n % 71, rowOffset: n % 41 } }, { epoch });
          assert.equal(prepared.uploads, "", "resident pan emitted graphics transport"); commit(prepared);
          assert.equal(prepared.lines.length, 10);
        }
        assert.equal(graphics(h.terminal).length, 0);
        assert.deepEqual(native.stats(epoch).viewer.allocatedIds, allocated, "pan grew native identity allocation");
        // A same-ID retransmission really invokes production replay, not a protocol simulator.
        epoch = Symbol("live-retransmit"); commit(await inlinePrepare(40, 10));
        assert.equal(uploads(graphics(h.terminal)), 1);
        const liveReplay = placements(graphics(h.terminal));
        for (const p of retained) assert.deepEqual(liveReplay.find((q) => q.placementId === p.placementId), p);
        assert.equal(liveReplay.filter((p) => p.placementId === privateId).length, 1);
        native.releaseViewer(lease); commit(await native.prepareViewerRetirement({ epoch }));
        assert.deepEqual(retirements(graphics(h.terminal)), [{ imageId: payload.imageId, placementId: privateId }]);
        assert.equal(native.stats(epoch).viewer.livePrototype, false);
        // 10,000 actual acquire/replace/release/retire shapes reuse the fixed slot.
        h.terminal.writes.length = 0;
        for (let n = 0; n < 10000; n++) {
          lease = native.reserveViewerPlacement({ payload, occurrence: "native-viewer-snapshot" });
          assert.equal(lease.placementId, privateId);
          const shape = geometry(20 + n % 277, 20 + n % 70);
          const prepared = await native.prepareViewer({ lease, canvas: shape,
            window: { columns: 10, rows: 5, columnOffset: n % (shape.columns - 9), rowOffset: n % (shape.rows - 4) } }, { epoch });
          assert.equal(prepared.metrics.uploadChunks, 1, "each bind follows successful retirement");
          assert.equal(prepared.metrics.placementCommands, retained.length + 1);
          commit(prepared);
          const batch = placements([prepared.uploads]);
          assert.deepEqual(batch.filter((p) => p.placementId !== privateId), retained);
          assert.deepEqual(batch.filter((p) => p.placementId === privateId), [{ imageId: payload.imageId,
            placementId: privateId, columns: shape.columns, rows: shape.rows }]);
          native.releaseViewer(lease); commit(await native.prepareViewerRetirement({ epoch }));
          if (n % 100 === 0) h.terminal.writes.length = 0; // Bound the harness capture, not production state.
        }
        const after = native.stats(epoch);
        assert.deepEqual(after.viewer.allocatedIds, allocated, "open/geometry history grew the identity allocator");
        assert.equal(after.viewer.leased || after.viewer.pending || after.viewer.retirementPending || after.viewer.retirementWriting, false);
        assert.equal(after.placements.geometryVersions, 2, "viewer history leaked into retained inline prototypes");
        assert.equal(after.resident.payloads, 1, "viewer duplicated shared resident PNG accounting");
        h.terminal.writes.length = 0; epoch = Symbol("closed-retransmit"); commit(await inlinePrepare(40, 10));
        const closedReplay = placements(graphics(h.terminal)); assert.equal(uploads(graphics(h.terminal)), 1);
        assert.equal(closedReplay.length, 2); assert.ok(closedReplay.every((p) => p.placementId !== privateId), "retransmission resurrected inactive viewer");
        for (const p of retained) assert.deepEqual(closedReplay.find((q) => q.placementId === p.placementId), p);
        await unchanged(h, before);
      } finally { await h.cleanup(); }
    });
    await t.test("non-TUI command rejects with no widget/graphics/model work", async () => {
      for (const mode of ["print", "json", "rpc"]) {
        const directory = await mkdtemp(join(scratch, "non-tui-")); const offline = offlineRuntime();
        const settings = host.SettingsManager.create(directory, join(scratch, "agent"));
        const loader = new host.DefaultResourceLoader({ cwd: directory, agentDir: join(scratch, "agent"), settingsManager: settings, noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true }); await loader.reload();
        const { session } = await host.createAgentSession({ cwd: directory, agentDir: join(scratch, "agent"), resourceLoader: loader, settingsManager: settings, sessionManager: host.SessionManager.inMemory(directory), modelRuntime: offline, model, noTools: "all" });
        try {
          await session.bindExtensions({ mode, uiContext: { notify() {}, setWidget() { assert.fail("non-TUI installed viewer widget"); } } });
          const before = JSON.stringify(session.messages); await session.prompt("/tmux-image-view");
          assert.equal(JSON.stringify(session.messages), before); assert.equal(offline.requests.length, 0);
        } finally { session.dispose(); }
      }
    });
    // Every capability subprocess in this harness is the PATH fixture, never the active tmux server.
    for (const line of (await readFile(join(scratch, "tmux-queries.log"), "utf8")).trim().split("\n").filter(Boolean)) {
      assert.ok(["display-message", "show-options", "list-clients"].includes(JSON.parse(line)[0]));
    }
    assert.equal(await readFile(join(scratch, "clipboard-queries.log"), "utf8"), "", "selection test invoked a clipboard command");
    t.diagnostic("Captured streams/components only; no outer-terminal pixels, ACKs or regular terminal-scrollback observation.");
  } finally {
    ui.setCapabilities(caps); ui.setCellDimensions(cells);
    for (const name of keys) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
    await rm(scratch, { recursive: true, force: true });
  }
});

// A separate fast acceptance parent keeps deterministic deadlines independent of
// installed-extension production defaults. All input still traverses installed
// public Terminal.start callbacks and the real fullscreen mouse dispatcher.
test("paced viewer public TUI: deterministic collection, receipts, guards and reservation safety", {
  skip: !root && "set PI_TEST_HOST_ROOT to installed Pi package root", timeout: 30000,
}, async (t) => {
  const capabilities = { ...ui.getCapabilities() }, cells = { ...ui.getCellDimensions() };
  ui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  ui.setCellDimensions({ widthPx: 8, heightPx: 16 });
  try {
    await t.test("10k raw SGR reports defer encoding; incidental renders remain passive; release settles the exact sequential clamp target", async () => {
      const h = await pacedPublicTui();
      try {
        const initial = mouseView(h), before = { ...h.counts };
        const transfer = structuredClone(h.native.stats(h.presentation.epoch).transfer), graphicsBefore = graphics(h.terminal).length;
        const maxX = initial.canvas.columns - (initial.last.x - initial.first.x + 1);
        const maxY = initial.canvas.rows - (initial.last.y - initial.first.y + 1);
        let column = initial.first.column, row = initial.first.row, previous = { x: 40, y: 20 };
        const reference = (point) => {
          column = Math.max(0, Math.min(maxX, column + previous.x - point.x));
          row = Math.max(0, Math.min(maxY, row + previous.y - point.y));
          previous = point;
        };
        h.terminal.mouse(0, previous.x, previous.y);
        for (let n = 0; n < 10000; n++) {
          const point = [{ x: 0, y: 0 }, { x: 79, y: 39 }, { x: 40, y: 20 }][n % 3];
          reference(point); h.terminal.mouse(32, point.x, point.y);
          if (n % 1000 === 0) {
            h.tui.renderNow();
            assert.ok(sameMapping(mouseView(h), initial), "incidental host render adopted unsampled pan");
          }
        }
        const release = { x: 43, y: 22 };
        reference(release); h.terminal.mouse(0, release.x, release.y, true);
        h.terminal.mouse(32, 55, 30); // Public capture ended: cannot alter final target.
        h.tui.renderNow();
        assert.deepEqual(h.counts, before, "raw drag/release reports encoded rows or prepared transport");
        assert.equal(h.clock.timerCount, 1, "final release did not leave one dirty wake");
        assert.ok(column !== initial.first.column || row !== initial.first.row, "edge/reversal oracle must distinguish final pose");
        h.clock.advance(0); h.tui.renderNow();
        await until(() => {
          h.tui.renderNow(); const view = mouseView(h);
          return readyCells(screen(h), h.viewerPair.placementId) && view.first.column === column && view.first.row === row;
        }, "exact released pan target without subsequent input");
        assert.equal(h.counts.reuse - before.reuse, 1, "10k reports did not collapse to one eligible encoding");
        assert.equal(h.counts.prepare, before.prepare, "resident pan acquired async preparation");
        assert.equal(h.counts.guards, before.guards, "resident pan ran capability checks");
        assert.equal(graphics(h.terminal).length, graphicsBefore);
        assert.deepEqual(h.native.stats(h.presentation.epoch).transfer, transfer, "text-only pan advanced transport accounting");
        h.clock.flush(); h.clock.advance(10000); h.tui.renderNow(); h.clock.flush();
        assert.equal(h.counts.reuse - before.reuse, 1, "idle tail replayed historical pan poses");
        assert.equal(h.clock.timerCount, 0);
      } finally { await h.cleanup(); }
    });
    await t.test("busy latest wheel waits for its own produced mapping and deferred cooldown, not incidental host renders", async () => {
      const h = await pacedPublicTui();
      try {
        const original = mouseView(h), before = { ...h.counts }, prototypeCount = placements(graphics(h.terminal)).length;
        const firstPoint = { x: 35, y: 18 }, latestPoint = { x: 44, y: 22 };
        h.holdPost(); h.terminal.mouse(64, firstPoint.x, firstPoint.y); h.clock.advance(0);
        await until(() => Boolean(h.held), "held admitted zoom post-check");
        for (let n = 0; n < 16; n++) {
          h.terminal.mouse(n % 2 ? 65 : 64, 25 + n, 18);
          await Promise.resolve(); h.tui.renderNow();
        }
        h.terminal.mouse(65, latestPoint.x, latestPoint.y);
        assert.equal(h.counts.prepare - before.prepare, 1, "busy wheel reports spawned prepare waiters");
        assert.ok(sameMapping(mouseView(h), original), "held zoom exposed uncommitted mapping");
        assert.equal(placements(graphics(h.terminal)).length, prototypeCount);
        h.clock.advance(1000); h.tui.renderNow();
        assert.equal(h.counts.prepare - before.prepare, 1, "late timer bypassed outstanding preparation");
        h.held.release();
        await until(() => {
          h.tui.renderNow(); return /305% Fit/.test(plain(screen(h))[0]);
        }, "first zoom component-produced frame");
        const intermediate = mouseView(h);
        assert.equal(placements(graphics(h.terminal)).length, prototypeCount + 1);
        const anchor = sourceAt(intermediate, latestPoint), stale = sourceAt(original, latestPoint);
        assert.ok(Math.abs(anchor.x - stale.x) > anchor.cellX / 2, "wheel fixture cannot distinguish rendered and stale mappings");
        for (let n = 0; n < 8; n++) h.tui.renderNow();
        assert.equal(h.counts.prepare - before.prepare, 1, "receipt/incidental render consumed unpaced wheel");
        assert.equal(h.clock.continuationCount, 1);
        h.clock.flush(); h.clock.advance(h.clock.idleMs - 1); h.tui.renderNow();
        assert.equal(h.counts.prepare - before.prepare, 1, "wheel admitted before post-receipt cooldown");
        assert.ok(sameMapping(mouseView(h), intermediate));
        h.clock.advance(1);
        await until(() => {
          h.tui.renderNow(); return readyCells(screen(h), h.viewerPair.placementId) && mouseView(h).percent === 244;
        }, "exact latest busy wheel target");
        const final = mouseView(h), after = sourceAt(final, latestPoint);
        assert.ok(Math.abs(anchor.x - after.x) <= after.cellX / 2 + 1e-10, "latest wheel used stale x mapping");
        assert.ok(Math.abs(anchor.y - after.y) <= after.cellY / 2 + 1e-10, "latest wheel used stale y mapping");
        assert.equal(h.counts.prepare - before.prepare, 2, "wheel accumulated historical steps");
        assert.equal(placements(graphics(h.terminal)).length, prototypeCount + 2);
        h.clock.flush(); h.clock.advance(10000); h.tui.renderNow();
        assert.equal(h.counts.prepare - before.prepare, 2);
      } finally { await h.cleanup(); }
    });
    await t.test("superseded admitted key writes nothing; native inline successor drains before the next pacing opportunity", async () => {
      const h = await pacedPublicTui();
      try {
        const original = mouseView(h), prototypeCount = placements(graphics(h.terminal)).length;
        h.holdPost(); h.terminal.input("+"); h.clock.advance(0);
        await until(() => Boolean(h.held), "held superseded post-check");
        h.terminal.input("+"); h.tui.renderNow(); // Canonical changes without a new admission.
        assert.ok(sameMapping(mouseView(h), original));
        let successor;
        const prepared = h.native.prepare({ attachment: h.snapshot.attachment, occurrence: "paced-inline-successor", geometry: {
          columns: 30, rows: 8, cellWidthPx: 8, cellHeightPx: 16 } }, { epoch: h.presentation.epoch })
          .then((result) => { successor = result; });
        await Promise.resolve(); assert.equal(successor, undefined, "successor overtook held reservation");
        h.held.release(); await prepared;
        assert.equal(placements(graphics(h.terminal)).length, prototypeCount, "superseded candidate transported obsolete prototype");
        assert.equal(h.presentation.commit(successor, { epoch: h.presentation.epoch }), true);
        await until(() => h.clock.timerCount === 1, "rejected dirty target rearmed wake");
        const stats = h.native.stats(h.presentation.epoch);
        assert.equal(stats.viewer.pending, false, "pacing wait retained viewer reservation");
        h.clock.advance(h.clock.idleMs - 1); h.tui.renderNow();
        // Rejection can revoke native residency even before any bytes. Only
        // assert old geometry when its cells are still proven/published; text
        // fallback is safe, but obsolete candidate cells are never acceptable.
        if (privateCells(screen(h), h.viewerPair.placementId)) {
          assert.ok(sameMapping(mouseView(h), original), "rejection published obsolete candidate cells");
        }
        h.clock.advance(1);
        await until(() => {
          h.tui.renderNow(); return readyCells(screen(h), h.viewerPair.placementId) && mouseView(h).percent === 381;
        }, "latest canonical geometry after rejected candidate");
        assert.equal(placements(graphics(h.terminal)).length, prototypeCount + 2, "expected only inline successor and latest viewer prototype");
        h.clock.flush();
        h.terminal.mouse(0, 40, 20); h.terminal.mouse(32, 43, 22); h.terminal.mouse(0, 43, 22, true);
        assert.equal(h.clock.timerCount, 1);
        // No reservation is admitted while cadence waits: another inline
        // successor must finish without ticking the viewer clock at all.
        const inline = await h.native.prepare({ attachment: h.snapshot.attachment, occurrence: "cadence-inline-successor", geometry: {
          columns: 20, rows: 5, cellWidthPx: 8, cellHeightPx: 16 } }, { epoch: h.presentation.epoch });
        assert.equal(h.presentation.commit(inline, { epoch: h.presentation.epoch }), true);
        assert.equal(h.clock.timerCount, 1, "inline completion bypassed viewer eligibility");
      } finally { await h.cleanup(); }
    });
    await t.test("release during held guarded pan rejects the old candidate and settles final displacement without more input", async () => {
      const h = await pacedPublicTui();
      try {
        const original = mouseView(h), before = { ...h.counts }, bytesBefore = graphics(h.terminal).length;
        const target = panTarget(original, -5, -4);
        h.missNextReuse(); h.holdPost();
        h.terminal.mouse(0, 40, 20); h.terminal.mouse(32, 43, 22); h.clock.advance(0);
        await until(() => Boolean(h.held), "held guarded pan after read-only reuse miss");
        assert.ok(sameMapping(mouseView(h), original), "uncommitted guarded pan exposed candidate rows");
        h.terminal.mouse(0, 45, 24, true); // Additional two-cell release displacement.
        h.tui.renderNow();
        assert.equal(h.counts.prepare - before.prepare, 1, "release spawned a new prepare while old runner was held");
        h.clock.advance(1000);
        assert.equal(h.counts.prepare - before.prepare, 1, "late timer admitted another busy target");
        h.held.release();
        await until(() => h.clock.timerCount === 1, "rejected release target rearmed without pointer input");
        assert.equal(graphics(h.terminal).length, bytesBefore, "rejected pan wrote obsolete graphics");
        h.clock.advance(h.clock.idleMs);
        await until(() => {
          h.tui.renderNow();
          return readyCells(screen(h), h.viewerPair.placementId) && atWindow(target)(mouseView(h));
        }, "exact final release displacement after held rejection");
        const final = mouseView(h);
        assert.deepEqual(final.canvas, original.canvas);
        assert.equal(final.percent, original.percent);
        h.clock.flush(); h.clock.advance(10000); h.tui.renderNow(); h.clock.flush();
        assert.equal((h.counts.prepare - before.prepare) + (h.counts.reuse - before.reuse), 3,
          "release must have one forced reuse miss/guarded candidate and one latest reconciliation, not a historical retry chain");
        assert.ok(h.counts.prepare - before.prepare <= 2, "release repeated guarded preparation");
        assert.equal(graphics(h.terminal).length, bytesBefore, "same-canvas release transported pixels/prototypes");
        assert.equal(h.clock.timerCount, 0);
      } finally { await h.cleanup(); }
    });
    await t.test("Escape and public modal focus loss synchronously cancel timed work; stale continuations cannot affect reopen", async () => {
      for (const action of ["escape", "focus-loss"]) {
        const h = await pacedPublicTui();
        try {
          const before = { ...h.counts };
          h.terminal.mouse(0, 40, 20); h.terminal.mouse(32, 43, 22); h.terminal.mouse(0, 43, 22, true);
          assert.equal(h.clock.timerCount, 1);
          let modal;
          if (action === "escape") h.terminal.input("\x1b");
          else modal = h.tui.showOverlay({ focused: false, render: () => ["UNRELATED MODAL"], invalidate() {} });
          assert.equal(h.clock.timerCount, 0, `${action} left armed timer after logical cancellation`);
          h.clock.advance(10000); h.clock.flush();
          assert.equal(h.counts.reuse, before.reuse); assert.equal(h.counts.prepare, before.prepare);
          await h.viewer.close("already closing"); h.tui.renderNow();
          if (modal) { assert.equal(modal.isFocused(), true); assert.ok(modal.getBounds()); modal.hide(); }
          const reopen = h.viewer.open();
          await h.target(() => readyCells(screen(h), h.viewerPair.placementId) && mouseView(h).percent === 100, "fitted fresh reopen");
          assert.equal(mouseView(h).percent, 100);
          await h.viewer.close("close fresh reopen"); await reopen;
          // Also cancel an already queued post-receipt continuation, not just
          // an armed timer. It remains physically queued but must be inert.
          const next = h.viewer.open();
          await until(async () => {
            await Promise.resolve(); h.tui.renderNow();
            if (h.clock.nextDelay !== undefined) h.clock.advance(h.clock.nextDelay);
            return readyCells(screen(h), h.viewerPair.placementId) && /100% Fit/.test(plain(screen(h))[0]);
          }, "fresh frame with queued receipt continuation");
          h.tui.renderNow();
          assert.equal(h.clock.continuationCount, 1);
          h.terminal.input("\x1b"); const cancelled = { ...h.counts };
          h.clock.flush(); h.clock.advance(10000);
          assert.equal(h.clock.timerCount, 0); assert.deepEqual(h.counts, cancelled);
          await next;
        } finally { await h.cleanup(); }
      }
    });
    t.diagnostic("Real installed SGR dispatch and public component-produced frames; explicit fake 100 ms idle allowance/null wheel expiry. No simulated drain, outer-terminal display ACK, human latency or product-default claim.");
  } finally { ui.setCapabilities(capabilities); ui.setCellDimensions(cells); }
});
