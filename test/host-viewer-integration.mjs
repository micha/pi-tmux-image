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
  columns = 80; rows = 40; kittyProtocolActive = false; writes = [];
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write(bytes) { this.writes.push(bytes); }
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
async function invariant(h) {
  return { messages: JSON.stringify(h.runtime.session.messages), entries: JSON.stringify(h.ctx.sessionManager.getEntries()),
    conversion: structuredClone(await h.runtime.session.agent.convertToLlm(h.runtime.session.messages)), requests: h.offline.requests.length };
}
async function unchanged(h, before) { assert.deepEqual(await invariant(h), before, "viewer changed session storage/model conversion or started model work"); }

async function fixture(scratch, values = {}) {
  await writeFile(join(scratch, "tmux-fixture.json"), JSON.stringify({ passthrough: "on", termtype: "ghostty 1.3.1", termname: "xterm-ghostty", delay: 0, ...values }));
  await writeFile(join(scratch, "tmux-queries.log"), "");
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
function reply() {
 if (args[0] === "display-message") process.stdout.write("%1\\t$1\\t1\\t0\\t1\\t0\\n");
 else if (args[0] === "show-options") process.stdout.write(f.passthrough + "\\n");
 else if (args[0] === "list-clients") process.stdout.write("offline-client\\t" + f.termtype + "\\t" + f.termname + "\\t0\\n");
 else { process.stderr.write("Unexpected non-read-only tmux operation"); process.exitCode = 1; }
}
if (f.delay) setTimeout(reply, f.delay); else reply();
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
    await h.runtime.session.prompt("/tmux-pdf two-pages.pdf");
    assert.equal(snapshots(h).length, 3, "two-page PDF default changed");
  }
  const renderer = h.runtime.services.resourceLoader.getExtensions().extensions.find((e) => e.commands.has("tmux-image")).messageRenderers.get("pi-tmux-image");
  const components = snapshots(h).map((m) => renderer(m, { expanded: false, outputPad: 1 }, { fg: (_color, text) => text }));
  await until(() => { h.tui.renderNow(); return components.every((c) => c.render(80).some((line) => line.includes(PH))); }, "inline residency");
  const attachments = structuredClone(images(snapshots(h)));
  const transferred = uploadedPayloads(graphics(h.terminal));
  const imageIds = attachments.map((attachment) => transferred.get(attachment.data));
  assert.ok(imageIds.every(Boolean), "captured PNG upload bytes differ from the canonical PNG snapshots");
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
      if (!privateCells(lines, pair.placementId)) return false;
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
  const start = h.terminal.writes.length;
  h.terminal.input(data); h.tui.renderNow(); await Promise.resolve(); h.tui.renderNow();
  if (h.tui instanceof ui.TuiAltScreen) {
    await until(() => { h.tui.renderNow(); return privateCells(screen(h), h.viewerPair.placementId); }, `ready cells after ${JSON.stringify(data)}`);
  } else {
    // Main-screen host has no public screen-lines query. A changed intent first
    // removes its cells with Preparing viewport; wait for a later captured row.
    const changed = h.terminal.writes.slice(start).some((bytes) => ui.stripTerminalSequences(bytes).includes("Preparing viewport"));
    if (changed) await until(() => { h.tui.renderNow(); return privateCells(h.terminal.writes.slice(start), h.viewerPair.placementId); }, `regular ready cells after ${JSON.stringify(data)}`);
  }
}

import test from "node:test";
test("production viewer: isolated installed public SDK + InteractiveMode acceptance", {
  skip: !root && "set PI_TEST_HOST_ROOT to installed Pi package root", timeout: 120000,
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
            assert.equal(uploads(graphics(h.terminal)), 0); assert.ok(placements(graphics(h.terminal)).every((p) => p.placementId === privatePair.placementId));
          }
          assert.equal(await readFile(join(scratch, "pdf-queries.log"), "utf8"), seeded.pdfLog, "viewer rerasterized PDF sources");
          for (const component of seeded.components) assert.ok(component.render(80).some((line) => line.includes(PH)), "viewer retirement broke inline cells");
          await unchanged(h, before);
          h.terminal.input("X"); assert.equal(h.ctx.ui.getEditorText(), "untouched draftX", "editor focus was not restored");
        } finally { await h.cleanup(); }
      });
    }
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
          assert.equal(prepared.metrics.uploadChunks, 0); commit(prepared);
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
