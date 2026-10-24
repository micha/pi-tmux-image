import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, open, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import test from "node:test";

// Actual public loader/SDK, ordinary injected UI/PATH fixtures. No private host
// imports, provider requests, tty output or production runtime test switches.
const root = process.env.PI_TEST_HOST_ROOT;
const host = root ? await import(pathToFileURL(join(root, "dist/index.js"))) : undefined;
const ui = root ? await import(pathToFileURL(createRequire(join(root, "dist/index.js")).resolve("@earendil-works/pi-tui"))) : undefined;
const extensionPath = fileURLToPath(new URL("../extensions/tmux-image/index.ts", import.meta.url));
function pngFixture() {
  const chunk = (type, payload) => {
    const header = Buffer.alloc(8); header.writeUInt32BE(payload.length); header.write(type, 4);
    let crc = 0xffffffff;
    for (const byte of Buffer.concat([Buffer.from(type), payload])) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([header, payload, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
}
const png = pngFixture().toString("base64");
const PDF_SCHEMA = "pi-tmux-image/pdf-v1", THRESHOLD = 33554432;
const model = { id: "offline", name: "Offline", api: "offline-test", provider: "offline-test", baseUrl: "http://invalid.invalid", reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const delay = () => new Promise((resolve) => setTimeout(resolve, 10));
async function until(predicate) { const end = Date.now() + 5000; while (!(await predicate())) { assert.ok(Date.now() < end, "fixture did not settle"); await delay(); } }
class CaptureTerminal {
  columns = 60; rows = 20; kittyProtocolActive = false; writes = [];
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write(bytes) { this.writes.push(bytes); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
// Valid inert PDF padded inside an unreferenced stream, not a huge JS literal.
async function pdfFile(path, size = 1024) {
  let prefix = "%PDF-1.4\n", offsets = [];
  for (const [i, body] of ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>"].entries()) {
    offsets.push(Buffer.byteLength(prefix)); prefix += `${i + 1} 0 obj\n${body}\nendobj\n`;
  }
  const parts = (n) => { const start = prefix + `4 0 obj\n<< /Length ${n} >>\nstream\n`, end = "\nendstream\nendobj\n";
    return { start, end, tail: `xref\n0 5\n0000000000 65535 f \n${[...offsets, Buffer.byteLength(prefix)].map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${Buffer.byteLength(start + end) + n}\n%%EOF\n` }; };
  let padding = size - 500;
  for (let n = 0; n < 8; n++) { const p = parts(padding); padding = size - Buffer.byteLength(p.start + p.end + p.tail); }
  const p = parts(padding), fd = await open(path, "wx", 0o600), chunk = Buffer.alloc(65536, 32);
  try { await fd.write(p.start); for (let n = padding; n > 0; n -= chunk.length) await fd.write(chunk.subarray(0, Math.min(n, chunk.length))); await fd.write(p.end + p.tail); }
  finally { await fd.close(); }
  assert.equal((await stat(path)).size, size);
}

test("PDF import: public production extension submission, policy, retention and lifecycle", { skip: !root && "set PI_TEST_HOST_ROOT", timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-pdf-import-test-"));
  const bin = join(directory, "bin"), statePath = join(directory, "state.json"), logPath = join(directory, "commands.jsonl");
  await mkdir(bin); await writeFile(logPath, "");
  let state = { passthrough: "all", holdInfo: false };
  const setState = async (patch) => { state = { ...state, ...patch }; await writeFile(statePath, JSON.stringify(state)); };
  await setState({});
  const script = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2), name = path.basename(process.argv[1]);
const state = () => JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({name,args})+'\\n');
if (name === 'tmux') {
 if (args[0] === 'display-message') process.stdout.write('%1\\t$1\\t1\\t0\\t1\\t0\\n');
 else if (args[0] === 'show-options') process.stdout.write(state().passthrough+'\\n');
 else if (args[0] === 'list-clients') process.stdout.write('fixture\\tghostty 1.3.1\\txterm-ghostty\\t0\\n');
 else process.exit(2);
} else if (name === 'pdfinfo') {
 const complete = () => process.stdout.write('Pages: 3\\n');
 if (state().holdInfo) { const timer = setInterval(() => { if (!state().holdInfo) { clearInterval(timer); complete(); } }, 10); } else complete();
} else fs.writeFileSync(args.at(-1)+'.png', Buffer.from(${JSON.stringify(png)}, 'base64'));
`;
  for (const name of ["tmux", "pdfinfo", "pdftoppm"]) await writeFile(join(bin, name), script, { mode: 0o700 });
  const savedEnv = { PATH: process.env.PATH, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
  const savedCaps = { ...ui.getCapabilities() };
  process.env.PATH = `${bin}:${process.env.PATH}`; process.env.TMUX = "fixture,1,0"; process.env.TMUX_PANE = "%1";
  ui.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const commands = async () => (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

  async function fixture({ choice = "Keep", blocked = false, sendFault, mode = "tui", persistent = false } = {}) {
    const cwd = await mkdtemp(join(directory, "runtime-")), terminal = new CaptureTerminal(), tui = new ui.TuiMainScreen(terminal);
    let ctx, afterSend, cleanupGate, requests = 0, plan, selector;
    const notifications = [], selections = [], probes = [], errors = [], widgets = [];
    const settings = host.SettingsManager.inMemory({ theme: "dark", quietStartup: true, cacheWarming: "off", enableInstallTelemetry: false, images: { blockImages: blocked }, terminal: { images: "auto", trueColor: true }, compaction: { enabled: false }, retry: { enabled: false } });
    const manager = persistent ? host.SessionManager.create(cwd, join(cwd, "sessions")) : host.SessionManager.inMemory(cwd);
    const seed = manager.appendMessage({ role: "user", content: "Offline seed", timestamp: 1 });
    // Faults live only in this disposable public extension API adapter.
    const wrapper = join(cwd, "extension.ts");
    await writeFile(wrapper, `import production from ${JSON.stringify(extensionPath)};
import { createPdfDocumentService } from ${JSON.stringify(fileURLToPath(new URL("../src/pdf-document.mjs", import.meta.url)))};
export default function(pi) { let sendCount = 0; production({...pi, sendMessage(message, options) {
 sendCount++;
 pi.events.emit('pdf-import-probe', {message,options,stage:'before'});
 ${sendFault === "before" ? "throw new Error('injected pre-send failure');" : sendFault === "beforeOnce" ? "if (sendCount === 1) throw new Error('injected pre-send failure');" : ""}
 pi.sendMessage(message,options);
 pi.events.emit('pdf-import-probe', {message,options,stage:'after'});
 ${sendFault === "after" ? "throw new Error('injected post-send failure');" : ""}
}}, {createDocumentService(options) {
 const service = createPdfDocumentService(options);
 return {...service, async discardTemporary(occurrence, hash) {
  const probe = {occurrence,hash}; pi.events.emit('pdf-import-cleanup-probe',probe);
  await probe.waitFor; return service.discardTemporary(occurrence,hash);
 }};
}}); }
`);
    const modelRuntime = { getModel: () => model, getPhysicalModel: () => model, getModels: () => [model], getAvailableSnapshot: () => [model], refresh: async () => {}, getError: () => undefined, hasConfiguredAuth: () => true, isUsingOAuth: () => false, isUsingSubscription: () => false, getAuth: async () => ({ apiKey: "offline-fixture" }), streamSimple() {
      requests++; const calls = plan; plan = undefined;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage, stopReason: calls ? "toolUse" : "stop", content: calls || [{ type: "text", text: "Done" }] };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [], stopReason: "pending" } }; yield { type: "done", reason: message.stopReason, message }; }, result: async () => message };
    } };
    const create = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await host.createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: settings, resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [wrapper], extensionFactories: [(pi) => {
          pi.on("session_start", (_event, context) => { ctx = context; });
          pi.events.on("pdf-import-probe", (probe) => { probes.push(probe); if (probe.stage === "after") afterSend?.(probe); });
          pi.events.on("pdf-import-cleanup-probe", (probe) => cleanupGate?.(probe));
        }],
      } });
      const created = await host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: ["tmux_show_pdf", "tmux_show_image"], thinkingLevel: "off" });
      assert.deepEqual(created.extensionsResult.errors, []);
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await host.createAgentSessionRuntime(create, { cwd, agentDir: join(cwd, "agent"), sessionManager: manager });
    const uiContext = { theme: { fg: (_kind, text) => text }, notify: (message, level) => notifications.push({ message, level }), select: async (title, options, { signal } = {}) => {
      selections.push({ title, options, signal }); return selector ? selector({ signal }) : choice;
    }, setWidget(_name, factory) { if (factory) { const widget = factory(tui); widgets.push(widget); tui.addChild(widget); } } };
    const bind = (session) => session.bindExtensions({ mode, uiContext, onError: (error) => errors.push(error) });
    runtime.setRebindSession(bind); await bind(runtime.session); tui.start();
    // Tool definition discovery uses the public resource loader result instead
    // of reaching into AgentSession's private extension runner.
    const tools = () => runtime.services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.values()].map((tool) => tool.definition));
    return { cwd, manager, runtime, terminal, tui, notifications, selections, probes, errors, settings, seed,
      get ctx() { return ctx; }, get requests() { return requests; }, setSelector(fn) { selector = fn; }, afterSend(fn) { afterSend = fn; },
      renderer(message) { return runtime.services.resourceLoader.getExtensions().extensions.find((extension) => extension.messageRenderers.has("pi-tmux-image")).messageRenderers.get("pi-tmux-image")(message, { expanded: false, outputPad: 0 }, { fg: (_kind, text) => text }); },
      holdCleanup(fn) { cleanupGate = fn; },
      async execute(path, signal, context = ctx) { return tools().find((tool) => tool.name === "tmux_show_pdf").execute("fixture", { path }, signal, undefined, context); },
      plan(path) { plan = [{ type: "toolCall", id: "pdf-call", name: "tmux_show_pdf", arguments: { path } }]; },
      messages() { return manager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "pi-tmux-image"); },
      async close() { await runtime.dispose(); tui.stop(); await rm(cwd, { recursive: true, force: true }); },
    };
  }

  try {
    await t.test("pre-source policy denial and pre-abort emit no preview/bytes", async () => {
      const h = await fixture(); try {
        await setState({ passthrough: "off" }); const before = (await commands()).length;
        await assert.rejects(h.execute("missing.pdf"), /passthrough/); assert.equal(h.messages().length, 0);
        assert.equal((await commands()).slice(before).some((c) => c.name === "pdfinfo" || c.name === "pdftoppm"), false);
        assert.equal(h.terminal.writes.join("").includes("\x1b_G"), false);
        const abort = new AbortController(); abort.abort(); await assert.rejects(h.execute("missing.pdf", abort.signal), (e) => e.name === "AbortError");
      } finally { await setState({ passthrough: "all" }); await h.close(); }
    });
    await t.test("slash PDF reports submission only; ordinary image read content and native schema remain unchanged", async () => {
      const h = await fixture(); try {
        const pdf = join(h.cwd, "slash.pdf"), image = join(h.cwd, "ordinary.png"); await pdfFile(pdf); await writeFile(image, Buffer.from(png, "base64"));
        await h.runtime.session.prompt(`/tmux-pdf ${pdf}`); assert.equal(h.messages().length, 1);
        assert.ok(h.notifications.some((notification) => /^PDF preview submitted: Page 1 of 3; keep/.test(notification.message)));
        const read = await host.createReadTool(h.cwd).execute("oracle", { path: image });
        await h.runtime.session.prompt(`/tmux-image ${image}`); assert.equal(h.messages().length, 2);
        assert.deepEqual(h.messages()[1].content, read.content); assert.equal(h.messages()[1].details.schema, "pi-tmux-image/native-v1");
        assert.equal(Object.hasOwn(h.messages()[1].details, "document"), false); assert.equal(h.requests, 0);
      } finally { await h.close(); }
    });
    await t.test("exact below/at threshold Keep needs no selector; one standard preview and details-only bytes", async () => {
      for (const size of [THRESHOLD - 1, THRESHOLD]) {
        const h = await fixture({ blocked: true }); try {
          const path = join(h.cwd, "threshold.pdf"); await pdfFile(path, size); const originalHash = createHash("sha256").update(await readFile(path)).digest("hex");
          const result = await h.execute(path); assert.equal(result.details.retention, "keep"); assert.equal(result.details.submitted, true);
          assert.equal(h.selections.length, 0); assert.equal(h.messages().length, 1);
          const message = h.messages()[0]; assert.equal(message.details.schema, PDF_SCHEMA); assert.equal(message.details.document.byteLength, size); assert.equal(message.details.document.sha256, originalHash);
          assert.equal(createHash("sha256").update(Buffer.from(message.details.document.data, "base64")).digest("hex"), originalHash);
          assert.equal(message.content.filter((block) => block.type === "image").length, 1); assert.match(message.content[0].text, /Page 1 of 3/);
          assert.equal(JSON.stringify(result).includes(message.details.document.data), false); assert.ok(JSON.stringify(result).length < 1024); assert.match(result.content[0].text, /^Submitted PDF preview/);
          assert.equal(h.probes.filter((p) => p.stage === "before").length, 1); assert.deepEqual(h.probes[0].options, { triggerTurn: false });
          const converted = await h.runtime.session.agent.convertToLlm(h.runtime.session.messages); assert.equal(JSON.stringify(converted).includes(message.details.document.data), false);
          assert.equal(h.settings.getBlockImages(), true); assert.equal(h.requests, 0);
        } finally { await h.close(); }
      }
    });
    await t.test("above threshold Keep/Temporary/Cancel/undefined/invalid never silently choose Keep", async () => {
      for (const choice of ["Keep", "Temporary", "Cancel", undefined, "unknown"]) {
        const h = await fixture({ choice }); try {
          // Explicit undefined differs from fixture's default parameter.
          h.setSelector(async () => choice);
          const path = join(h.cwd, "large.pdf"); await pdfFile(path, THRESHOLD + 1); const before = (await commands()).length;
          if (choice === "Keep" || choice === "Temporary") {
            const result = await h.execute(path); const d = h.messages()[0].details.document;
            assert.equal(h.messages().length, 1); assert.equal(result.details.retention, choice.toLowerCase());
            assert.equal(Object.hasOwn(d, "data"), choice === "Keep");
          } else { await assert.rejects(h.execute(path), /cancel/i); assert.equal(h.messages().length, 0); assert.equal((await commands()).slice(before).some((c) => c.name === "pdfinfo"), false); }
          assert.equal(h.selections.length, 1); assert.deepEqual(h.selections[0].options, ["Keep", "Temporary", "Cancel"]); assert.match(h.selections[0].title, /base64|save\/load/);
        } finally { await h.close(); }
      }
    });
    await t.test("one reserved import; modal/viewer admission and active cancellation clean source scratch", async () => {
      const h = await fixture({ choice: "Temporary" }); try {
        const path = join(h.cwd, "large.pdf"); await pdfFile(path, THRESHOLD + 1);
        let resolveChoice; h.setSelector(({ signal }) => new Promise((resolve) => { resolveChoice = resolve; signal.addEventListener("abort", () => resolve(undefined), { once: true }); }));
        const abort = new AbortController(), importing = h.execute(path, abort.signal); await until(() => h.selections.length);
        await assert.rejects(h.execute("missing.pdf"), /already in progress/);
        await h.runtime.session.prompt("/tmux-image-view"); assert.ok(h.notifications.some((n) => /import is in progress/.test(n.message)));
        abort.abort(); await assert.rejects(importing, (e) => e.name === "AbortError"); resolveChoice?.("Keep"); assert.equal(h.messages().length, 0);
        const modal = h.tui.showOverlay({ render: () => ["MODAL"], invalidate() {} });
        await assert.rejects(h.execute(path), /Close the image viewer|dialog/); modal.hide();
        h.setSelector(async () => "Temporary"); await setState({ holdInfo: true }); const before = (await commands()).length;
        const pendingAbort = new AbortController(), pending = h.execute(path, pendingAbort.signal);
        await until(async () => (await commands()).slice(before).some((c) => c.name === "pdfinfo")); const captured = (await commands()).slice(before).find((c) => c.name === "pdfinfo").args.at(-1);
        pendingAbort.abort(); await assert.rejects(pending, (e) => e.name === "AbortError"); assert.equal(existsSync(captured), false); assert.equal(h.messages().length, 0);
      } finally { await setState({ holdInfo: false }); await h.close(); }
    });
    await t.test("public tool execution preserves deferred/result ordering and compact submission under both model policies", async () => {
      for (const blocked of [false, true]) { const h = await fixture({ blocked }); try {
        const path = join(h.cwd, "small.pdf"); await pdfFile(path); h.plan(path); let entriesAtSend;
        h.afterSend(() => { entriesAtSend = h.messages().length; }); await h.runtime.session.prompt("Offline PDF call");
        assert.equal(entriesAtSend, 0); assert.equal(h.messages().length, 1); assert.equal(h.requests, 2);
        const entries = h.manager.getEntries(), resultIndex = entries.findIndex((e) => e.type === "message" && e.message.role === "toolResult"), displayIndex = entries.findIndex((e) => e.type === "custom_message");
        assert.ok(resultIndex >= 0 && displayIndex > resultIndex); assert.equal(entries[resultIndex].message.details.submitted, true);
        const pdf = h.messages()[0].details.document; const converted = await h.runtime.session.agent.convertToLlm(h.runtime.session.messages);
        assert.equal(JSON.stringify(converted).includes(pdf.data), false); assert.equal(JSON.stringify(entries[resultIndex]).includes(pdf.data), false);
        assert.equal(converted.flatMap((m) => Array.isArray(m.content) ? m.content.filter((b) => b.type === "image") : []).length, blocked ? 0 : 1);
        assert.equal(h.settings.getBlockImages(), blocked);
      } finally { await h.close(); } }
    });
    await t.test("synchronous send fault before/after append reconciles actual all-entry Temporary ownership", async () => {
      for (const fault of ["before", "after"]) { const h = await fixture({ choice: "Temporary", sendFault: fault }); try {
        const path = join(h.cwd, "large.pdf"); await pdfFile(path, THRESHOLD + 1); const before = (await commands()).length;
        await assert.rejects(h.execute(path), /injected/); assert.equal(h.messages().length, fault === "after" ? 1 : 0);
        const captured = (await commands()).slice(before).find((c) => c.name === "pdfinfo").args.at(-1);
        assert.equal(existsSync(captured), fault === "after"); assert.equal(h.probes.filter((p) => p.stage === "before").length, 1);
      } finally { await h.close(); } }
    });
    await t.test("real idle/deferred host persistence errors preserve actual occurrences without claiming an ACK or retry", async () => {
      for (const deferred of [false, true]) { const h = await fixture({ choice: "Temporary", persistent: true }); try {
        const path = join(h.cwd, "large.pdf"); await pdfFile(path, THRESHOLD + 1); const before = (await commands()).length;
        const breakStorage = async () => { const file = h.manager.getSessionFile(); await unlink(file); await mkdir(file); };
        if (!deferred) {
          await breakStorage(); const result = await h.execute(path); assert.equal(result.details.submitted, true);
          await until(() => h.errors.some((error) => error.event === "send_message"));
          assert.equal(h.runtime.session.messages.some((message) => message.role === "custom"), false);
        } else {
          const fs = await import("node:fs"); let broken = false;
          h.runtime.session.subscribe((event) => { if (event.type === "turn_end" && !broken) { broken = true; const file = h.manager.getSessionFile(); fs.unlinkSync(file); fs.mkdirSync(file); } });
          h.plan(path); await assert.rejects(h.runtime.session.prompt("Offline deferred persistence fault"), (error) => error.code === "EISDIR");
          const toolResult = h.manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult").message;
          assert.equal(toolResult.isError, false); assert.equal(toolResult.details.submitted, true);
        }
        assert.equal(h.messages().length, 1, "append-before-persist occurrence remains authoritative for runtime ownership");
        const captured = (await commands()).slice(before).find((c) => c.name === "pdfinfo").args.at(-1); assert.equal(existsSync(captured), true);
        assert.equal(h.probes.filter((probe) => probe.stage === "before").length, 1, "must not blindly retry");
      } finally { await h.close(); } }
    });
    await t.test("deferred Temporary survives queue acceptance and inactive branches; absent failed submission is discarded only at settlement", async () => {
      for (const fault of [undefined, "before", "after"]) { const h = await fixture({ choice: "Temporary", sendFault: fault }); try {
        const path = join(h.cwd, "large.pdf"); await pdfFile(path, THRESHOLD + 1); const before = (await commands()).length;
        h.plan(path); let entriesAtSubmission;
        h.afterSend(() => { entriesAtSubmission = h.messages().length; });
        // Navigate through the public manager before extension settlement. An
        // occurrence outside the active branch must retain its Temporary copy.
        h.runtime.session.subscribe((event) => { if (event.type === "agent_end") h.manager.branch(h.seed); });
        await h.runtime.session.prompt("Offline Temporary call");
        const captured = (await commands()).slice(before).find((c) => c.name === "pdfinfo").args.at(-1);
        assert.equal(h.messages().length, fault === "before" ? 0 : 1);
        assert.equal(existsSync(captured), fault !== "before");
        assert.equal(h.manager.getBranch().some((entry) => entry.type === "custom_message"), false);
        if (fault !== "before") assert.equal(entriesAtSubmission, 0, "void send must not be treated as immediate append");
        const result = h.manager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "toolResult").message;
        assert.equal(result.isError, Boolean(fault));
      } finally { await h.close(); } }
    });
    await t.test("cancellation after accepted queued submission cannot retract or discard its Temporary original", async () => {
      const h = await fixture({ choice: "Temporary" }); let aborting;
      try {
        const path = join(h.cwd, "large.pdf"); await pdfFile(path, THRESHOLD + 1); const before = (await commands()).length;
        h.plan(path); h.afterSend(() => { aborting = h.runtime.session.abort(); });
        await h.runtime.session.prompt("Offline cancelled submission"); await aborting;
        assert.equal(h.messages().length, 1); assert.equal(h.probes.filter((probe) => probe.stage === "before").length, 1);
        const captured = (await commands()).slice(before).find((command) => command.name === "pdfinfo").args.at(-1);
        assert.equal(existsSync(captured), true); assert.ok(h.requests <= 2);
      } finally { await aborting; await h.close(); }
    });
    await t.test("settlement cleanup snapshots candidates; later submitted Temporary is never tested against stale history", async () => {
      const h = await fixture({ choice: "Temporary", sendFault: "beforeOnce" }); let release;
      try {
        const first = join(h.cwd, "first.pdf"), second = join(h.cwd, "second.pdf");
        await pdfFile(first, THRESHOLD + 1); await pdfFile(second, THRESHOLD + 1);
        const marker = (await commands()).length;
        let heldOccurrence;
        h.holdCleanup((probe) => { if (!heldOccurrence) { heldOccurrence = probe.occurrence; probe.waitFor = new Promise((resolve) => { release = resolve; }); } });
        h.plan(first); const settling = h.runtime.session.prompt("Offline first import"); await until(() => heldOccurrence);
        assert.equal(h.messages().length, 0);
        // A concurrent queued/submission context must not run another idle
        // reconciliation. The send itself still goes through the real public SDK.
        await h.execute(second, undefined, { ...h.ctx, isIdle: () => false });
        assert.equal(h.messages().length, 1);
        const captured = (await commands()).slice(marker).filter((command) => command.name === "pdfinfo").map((command) => command.args.at(-1));
        assert.equal(captured.length, 2); assert.equal(existsSync(captured[1]), true);
        release(); await settling;
        assert.equal(existsSync(captured[0]), false);
        assert.equal(existsSync(captured[1]), true, "later occurrence survives old boundary cleanup");
        // A subsequent real public settlement reconciles its own newer candidate.
        await h.runtime.session.prompt("Offline second settlement"); assert.equal(existsSync(captured[1]), true);
      } finally { release?.(); await h.close(); }
    });
    await t.test("safe PDF preview fallback, unknown schema exclusion and active-branch-only document picker", async () => {
      const h = await fixture(); try {
        const source = join(h.cwd, "small.pdf"); await pdfFile(source); await h.execute(source);
        const imported = h.messages()[0], image = imported.content.find((block) => block.type === "image");
        const asMessage = (details, content = imported.content) => ({ role: "custom", customType: "pi-tmux-image", content, details, display: true, timestamp: 1 });
        const valid = h.renderer(asMessage(imported.details));
        assert.ok(valid.render(60).join("\n").includes("Page 1 of 3")); await until(() => valid.render(60).some((line) => line.includes("\u{10eeee}")));
        const invalidDetails = { ...imported.details, occurrence: "invalid-document", label: "SAFE PREVIEW", document: { ...imported.details.document, pageCount: 0 } };
        const invalid = h.renderer(asMessage(invalidDetails)); await until(() => invalid.render(60).some((line) => line.includes("\u{10eeee}")));
        const unknown = h.renderer(asMessage({ ...imported.details, schema: "future-pdf-v99" })); assert.match(unknown.render(60).join(""), /unsupported display schema/);
        h.manager.branch(h.seed);
        h.manager.appendCustomMessageEntry("pi-tmux-image", [image], true, invalidDetails);
        h.manager.appendCustomMessageEntry("pi-tmux-image", [image], true, { ...invalidDetails, occurrence: "unknown", label: "UNKNOWN EXCLUDED", schema: "future-pdf-v99" });
        const before = JSON.stringify(h.manager.getEntries()), commandsBefore = (await commands()).length;
        const viewing = h.runtime.session.prompt("/tmux-image-view"); await until(() => h.tui.hasOverlay()); h.tui.renderNow();
        await until(() => { h.tui.renderNow(); return h.terminal.writes.join("").includes("SAFE PREVIEW"); });
        assert.equal(h.terminal.writes.join("").includes("UNKNOWN EXCLUDED"), false);
        h.terminal.input("n"); h.tui.renderNow(); h.terminal.input("\x1b"); await viewing;
        assert.equal(JSON.stringify(h.manager.getEntries()), before); assert.equal((await commands()).slice(commandsBefore).some((c) => c.name === "pdfinfo" || c.name === "pdftoppm"), false);
      } finally { await h.close(); }
    });
    await t.test("runtime shutdown/reload drains import; refresh/branch retain committed Temporary", async () => {
      const h = await fixture({ choice: "Temporary" }); try {
        const path = join(h.cwd, "large.pdf"); await pdfFile(path, THRESHOLD + 1); const before = (await commands()).length;
        await h.execute(path); const captured = (await commands()).slice(before).find((c) => c.name === "pdfinfo").args.at(-1); await unlink(path);
        await h.runtime.session.prompt("/tmux-image-refresh"); assert.equal(existsSync(captured), true);
        h.manager.branch(h.seed); await h.runtime.session.prompt("/tmux-image-refresh"); assert.equal(existsSync(captured), true, "inactive branch occurrence still owns original");
        await h.runtime.session.reload(); assert.equal(existsSync(captured), false); assert.equal(h.messages().length, 1);
        const replacementPath = join(h.cwd, "replacement.pdf"); await pdfFile(replacementPath, THRESHOLD + 1); await setState({ holdInfo: true }); const marker = (await commands()).length;
        const pending = h.execute(replacementPath); const rejected = assert.rejects(pending, (e) => e.name === "AbortError");
        await until(async () => (await commands()).slice(marker).some((c) => c.name === "pdfinfo")); const partial = (await commands()).slice(marker).find((c) => c.name === "pdfinfo").args.at(-1);
        await h.runtime.newSession(); await rejected; assert.equal(existsSync(partial), false);
      } finally { await setState({ holdInfo: false }); await h.close(); }
    });
  } finally {
    ui.setCapabilities(savedCaps); for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});
