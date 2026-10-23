// Optional actual-host integration: node --test test/host-integration.mjs
// Uses only public package exports. No physical Pi imports in the portable suite.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";
import test from "node:test";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
let entry;
if (process.env.PI_TEST_HOST_ROOT) {
  const root = resolve(process.env.PI_TEST_HOST_ROOT);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  entry = join(root, manifest.main || "dist/index.js");
} else {
  try { entry = require.resolve("@earendil-works/pi-coding-agent"); }
  catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
}
const host = entry ? await import(pathToFileURL(entry).href) : undefined;
const hostRoot = entry ? dirname(dirname(entry)) : undefined;
const tuiModule = entry ? await import(pathToFileURL(createRequire(entry).resolve("@earendil-works/pi-tui")).href) : undefined;
function pngFixture() {
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
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0,255,0,0,255]))), chunk("IEND", Buffer.alloc(0))]);
}
const png = pngFixture().toString("base64");
const placeholder = "\u{10eeee}";

// Self-contained two-page PDF; Poppler is exercised rather than stubbed.
function pdfFixture() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Contents 6 0 R >>",
    "<< /Length 25 >>\nstream\n1 0 0 rg 0 0 72 72 re f\n\nendstream",
    "<< /Length 25 >>\nstream\n0 0 1 rg 0 0 72 72 re f\n\nendstream",
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  data += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return data + `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const model = {
  id: "offline", name: "Offline test model", api: "offline-test", provider: "offline-test",
  baseUrl: "http://invalid.invalid", reasoning: false, input: ["text", "image"],
  contextWindow: 100000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function offlineRuntime(calls, requests) {
  // Public SDK modelRuntime boundary. There is deliberately no network client,
  // credential store, provider lookup, or real stream implementation in this mock.
  return {
    getModel: () => model,
    getPhysicalModel: () => model,
    getModels: () => [model],
    getAvailableSnapshot: () => [model],
    getError: () => undefined,
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    getAuth: async () => ({ apiKey: "offline-not-a-secret" }),
    streamSimple(_model, context) {
      requests.push(structuredClone(context));
      assert.ok(requests.length <= 2, "viewer messages triggered an extra model request");
      const first = requests.length === 1;
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: first ? "toolUse" : "stop",
        content: first ? calls : [{ type: "text", text: "Offline verification complete." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: { ...message, stopReason: "pending", content: [] } };
          yield { type: "done", reason: message.stopReason, message };
        },
        result: async () => message,
      };
    },
  };
}
const imageBlocks = (messages) => messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((c) => c.type === "image") : []);
function assertCleanModelContent(requests) {
  for (const request of requests) {
    for (const message of request.messages) {
      assert.equal(message.role === "custom", false);
      // Pi may retain harmless tool-result details at this boundary, but viewer
      // custom details are converted away and graphics must never be exposed.
      assert.equal(JSON.stringify(message.details || {}).includes(placeholder), false);
      assert.equal(JSON.stringify(message.details || {}).includes("Ptmux;"), false);
      const text = typeof message.content === "string" ? message.content : (message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      assert.equal(text.includes(placeholder), false, "placeholder leaked to model text");
      assert.equal(text.includes("\x1b"), false, "terminal transport leaked to model text");
      assert.equal(text.includes("Ptmux;"), false);
    }
  }
}

async function writeTmuxFixture(scratch, overrides = {}) {
  await writeFile(join(scratch, "tmux-fixture.json"), JSON.stringify({
    passthrough: "on", termtype: "ghostty 1.2.3", termname: "xterm-ghostty", ...overrides,
  }));
  await writeFile(join(scratch, "tmux-queries.log"), "");
}

async function waitCells(components, width) {
  for (let i = 0; i < 100; i++) {
    const output = components.map((component) => component.render(width));
    if (output.every((lines) => lines.some((line) => line.includes(placeholder)))) {
      for (const line of output.flat()) assert.ok(tuiModule.visibleWidth(line) <= width, "renderer exceeded actual host component width");
      return output.flat();
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`images did not prepare at width ${width}: ${components.flatMap((c) => c.render(width)).join(" ")}`);
}
function placements(writes) {
  return [...writes.join("").matchAll(/a=p,U=1,i=(\d+),p=(\d+),c=(\d+),r=(\d+)/g)]
    .map((match) => ({ imageId: Number(match[1]), placementId: Number(match[2]), columns: Number(match[3]), rows: Number(match[4]) }));
}
async function verifyLiveLayoutAndRefresh(h, component, before) {
  const cells = { ...tuiModule.getCellDimensions() };
  try {
    const initial = placements(h.writes)[0];
    const retained = new Map([[initial.placementId, initial]]);
    const initialLines = component.render(80);
    assert.deepEqual({ columns: initial.columns, rows: initial.rows }, { columns: 48, rows: 24 });
    async function change(width, rows, cellWidth, cellHeight, columns, expectedRows) {
      h.writes.length = 0;
      h.tui.terminal.columns = width;
      h.tui.terminal.rows = rows;
      tuiModule.setCellDimensions({ widthPx: cellWidth, heightPx: cellHeight });
      await waitCells([component], width);
      const actual = placements(h.writes);
      assert.equal(actual.length, 1, "layout should create one geometry-versioned placement");
      assert.deepEqual({ columns: actual[0].columns, rows: actual[0].rows }, { columns, rows: expectedRows });
      retained.set(actual[0].placementId, actual[0]);
      assert.equal(actual[0].imageId, initial.imageId, "resize changed payload identity");
      assert.notEqual(actual[0].placementId, initial.placementId, "resize redefined a retained placement");
      assert.equal(h.writes.join("").includes("a=t"), false, "geometry-only resize retransmitted PNG bytes");
      const count = h.writes.length;
      component.invalidate(); await waitCells([component], width);
      assert.equal(h.writes.length, count, "unchanged layout repeated transport");
    }
    await change(20, 40, 8, 16, 20, 10); // actual component width
    await change(80, 16, 8, 16, 16, 8); // height-only change
    await change(80, 40, 16, 16, 24, 24); // public host cell-pixel change
    h.writes.length = 0;
    h.tui.terminal.columns = 80; h.tui.terminal.rows = 40;
    tuiModule.setCellDimensions({ widthPx: 8, heightPx: 16 });
    await waitCells([component], 80);
    assert.deepEqual(component.render(80), initialLines, "resize reversal changed retained placement rows");
    assert.equal(h.writes.length, 0, "resize reversal did not reuse ready geometry");

    h.transport.writeFaults = 1;
    for (let i = 0; i < 100; i++) {
      const lines = component.render(19);
      if (lines.some((line) => line.includes("offline"))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const failure = component.render(19);
    assert.ok(failure.some((line) => line.includes("offline")), "failed transport should have a width-fitted readable error");
    assert.equal(failure.some((line) => line.includes(placeholder)), false, "failed upload exposed cells");
    assert.equal(h.writes.length, 0);
    const repaints = h.transport.repaints;
    await h.session.prompt("/tmux-image-refresh");
    assert.ok(h.transport.repaints > repaints, "refresh did not request repaint");
    await waitCells([component], 19);
    assert.ok(h.writes.join("").includes("a=t"), "refresh did not invalidate image residency");
    assert.equal([...h.writes.join("").matchAll(/a=t,f=100/g)].length, 1, "refresh retransmitted the same PNG more than once");
    const restored = placements(h.writes).filter((p) => p.imageId === initial.imageId);
    for (const [placementId, prototype] of retained) {
      assert.deepEqual(restored.find((p) => p.placementId === placementId), prototype,
        "same-ID PNG reupload deleted a retained scrollback prototype without restoring it");
    }
    assert.equal(h.requests.length, 2, "refresh triggered a model request");
    assert.equal(JSON.stringify(h.session.messages), before, "resize/refresh altered the conversation");
  } finally {
    h.tui.terminal.columns = 80; h.tui.terminal.rows = 40;
    tuiModule.setCellDimensions(cells);
  }
}
async function verifyLegacyResume(scratch, blockImages, viewer) {
  const manager = host.SessionManager.inMemory(join(scratch, "workspace"));
  manager.appendCustomMessageEntry("pi-tmux-image", viewer.content, true, {
    lines: ["stale-Chafa-ID-DO-NOT-REPLAY"], columns: 60, outputBytes: 1234, label: viewer.details.label,
  });
  const h = await makeSession(scratch, blockImages, "tui", manager);
  try {
    const before = JSON.stringify(h.session.messages);
    const message = h.session.messages.find((m) => m.role === "custom");
    const renderer = h.extension.messageRenderers.get("pi-tmux-image");
    const theme = { fg: (_color, text) => text };
    const component = renderer(message, { expanded: false }, theme);
    const lines = await waitCells([component], 30);
    assert.equal(lines.join("").includes("stale-Chafa-ID"), false);
    assert.ok(h.writes.join("").includes("a=t"), "resumed legacy snapshot did not upload");
    const count = h.writes.length;
    await waitCells([renderer(message, { expanded: false }, theme)], 30);
    assert.equal(h.writes.length, count, "legacy occurrence changed identity on rebuild");
    assert.equal(JSON.stringify(h.session.messages), before, "legacy migration rewrote persisted messages");
    assert.equal(h.requests.length, 0, "resuming legacy content triggered a request");
    assert.deepEqual(imageBlocks(await h.session.agent.convertToLlm(h.session.messages)), blockImages ? [] : imageBlocks([viewer]));
  } finally {
    h.session.dispose();
    for (const widget of h.widgets) widget.dispose?.();
  }
}

async function verifyDeniedReplayRecovery(scratch, blockImages, scenario = { fixture: { passthrough: "off" }, rejected: /passthrough.*off/i }) {
  const manager = host.SessionManager.inMemory(join(scratch, "workspace"));
  manager.appendCustomMessageEntry("pi-tmux-image", [{ type: "image", mimeType: "image/png", data: png }], true, {
    schema: "pi-tmux-image/native-v1", occurrence: "offline-restored", label: "Stored snapshot",
    geometry: { columns: 48, rows: 24, cellWidthPx: 8, cellHeightPx: 16 },
  });
  await writeTmuxFixture(scratch, scenario.fixture);
  const h = await makeSession(scratch, blockImages, "tui", manager);
  try {
    const before = JSON.stringify(h.session.messages);
    const message = h.session.messages.find((m) => m.role === "custom");
    const renderer = h.extension.messageRenderers.get("pi-tmux-image");
    const component = renderer(message, { expanded: false }, { fg: (_color, text) => text });
    for (let i = 0; i < 100; i++) {
      if (component.render(80).some((line) => scenario.rejected.test(line))) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(component.render(80).some((line) => scenario.rejected.test(line)));
    assert.equal(component.render(80).some((line) => line.includes(placeholder)), false);
    assert.equal(h.writes.length, 0, "denied replay emitted graphics");
    await writeTmuxFixture(scratch);
    await h.session.prompt("/tmux-image-refresh");
    await waitCells([component], 80);
    assert.ok(h.writes.join("").includes("a=t"));
    const probes = await readFile(join(scratch, "tmux-queries.log"), "utf8");
    assert.ok(probes.includes("display-message") && probes.includes("show-options") && probes.includes("list-clients"), "refresh did not re-probe the supported path");
    h.writes.length = 0;
    h.settingsManager.applyOverrides({ terminal: { showImages: false } });
    const disabled = component.render(80);
    assert.equal(disabled.some((line) => line.includes(placeholder)), false, "ready cells ignored changed public local-display policy");
    assert.equal(h.writes.length, 0);
    h.settingsManager.applyOverrides({ terminal: { showImages: true } });
    await waitCells([component], 80);
    assert.equal(h.writes.length, 0, "re-enabling unchanged ready cells repeated the upload");
    assert.equal(JSON.stringify(h.session.messages), before);
    assert.equal(h.requests.length, 0, "replay/refresh/disable started model work");
    assert.equal(imageBlocks(await h.session.agent.convertToLlm(h.session.messages)).length, blockImages ? 0 : 1);
  } finally {
    h.session.dispose();
    for (const widget of h.widgets) widget.dispose?.();
    await writeTmuxFixture(scratch);
  }
}

async function makeSession(scratch, blockImages, mode, restoredManager, policyOverrides = {}) {
  const cwd = join(scratch, "workspace");
  const agentDir = join(scratch, "agent");
  const settingsManager = host.SettingsManager.create(cwd, agentDir);
  const loader = new host.DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true });
  await loader.reload();
  // Resource reload reloads disk settings too; apply test-only model policy AFTER
  // discovery so it cannot be silently reset by the isolated installer settings.
  settingsManager.applyOverrides({ images: { blockImages }, compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off", ...policyOverrides });
  assert.equal(settingsManager.getBlockImages(), blockImages);
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], "package resource loading failed");
  assert.equal(loaded.extensions.length, 1, "isolated installed package must discover exactly one extension");
  const extension = loaded.extensions[0];
  for (const name of ["tmux-image", "tmux-pdf"]) assert.ok(extension.commands.has(name));
  for (const name of ["tmux_show_image", "tmux_show_pdf"]) {
    const tool = extension.tools.get(name)?.definition;
    assert.ok(tool, `missing preserved tool ${name}`);
    assert.equal(tool.executionMode, "sequential");
    assert.equal(tool.parameters.properties.path.type, "string");
    assert.ok(tool.parameters.required.includes("path"));
  }
  const calls = [
    { type: "toolCall", id: "image-call", name: "tmux_show_image", arguments: { path: "image.png" } },
    { type: "toolCall", id: "pdf-call", name: "tmux_show_pdf", arguments: { path: "two-pages.pdf" } },
  ];
  const requests = [], events = [], writes = [], errors = [], widgets = [];
  const transport = { writeFaults: 0, repaints: 0 };
  const tui = { terminal: { columns: 80, rows: 40, write(bytes) {
    if (transport.writeFaults > 0) { transport.writeFaults--; throw new Error("offline terminal write failure"); }
    writes.push(bytes);
  } }, requestRender() { transport.repaints++; } };
  const uiContext = {
    notify() {},
    setWidget(_key, factory) {
      assert.equal(mode, "tui", "non-TUI execution installed a terminal widget");
      if (typeof factory === "function") widgets.push(factory(tui));
    },
  };
  const manager = restoredManager || host.SessionManager.inMemory(cwd);
  const { session } = await host.createAgentSession({
    cwd, agentDir, model, modelRuntime: offlineRuntime(calls, requests), thinkingLevel: "off",
    settingsManager, sessionManager: manager, resourceLoader: loader,
    tools: ["tmux_show_image", "tmux_show_pdf"],
  });
  session.subscribe((event) => events.push(event));
  await session.bindExtensions({ mode, uiContext, onError: (error) => errors.push(error) });
  return { session, manager, extension, requests, events, writes, errors, widgets, loader, settingsManager, tui, transport };
}

async function verifySession(scratch, blockImages, mode = "tui", options = {}) {
  // Each subtest owns fresh source files so replay can delete them deliberately.
  await writeFile(join(scratch, "workspace", "image.png"), Buffer.from(png, "base64"));
  await writeFile(join(scratch, "workspace", "two-pages.pdf"), pdfFixture());
  const h = await makeSession(scratch, blockImages, mode, undefined, options.settings);
  if (options.missingSources) {
    await rm(join(scratch, "workspace", "image.png"));
    await rm(join(scratch, "workspace", "two-pages.pdf"));
  }
  try {
    await h.session.prompt("Run the two viewer tools in order, then finish.");
    await h.session.waitForIdle();
    assert.deepEqual(h.errors, []);
    assert.equal(h.requests.length, 2, "only tool-call request and ordinary follow-up are expected");
    const starts = h.events.filter((e) => e.type === "tool_execution_start");
    const ends = h.events.filter((e) => e.type === "tool_execution_end");
    assert.deepEqual(starts.map((e) => e.toolName), ["tmux_show_image", "tmux_show_pdf"]);
    assert.deepEqual(ends.map((e) => e.toolName), ["tmux_show_image", "tmux_show_pdf"]);
    assert.ok(h.events.indexOf(ends[0]) < h.events.indexOf(starts[1]), "sequential tools overlapped");
    const results = h.session.messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 2);
    const viewers = h.session.messages.filter((m) => m.role === "custom" && m.customType === "pi-tmux-image");
    if (mode !== "tui" || !process.env.TMUX || options.rejected) {
      assert.ok(results.every((m) => m.isError));
      const rejection = options.rejected || /interactive Pi inside tmux/;
      assert.ok(results.every((m) => m.content.some((b) => b.type === "text" && rejection.test(b.text))), `unexpected rejection: ${JSON.stringify(results)}`);
      assert.equal(viewers.length, 0);
      assert.equal(h.writes.join(""), "", "non-TUI invocation emitted terminal graphics");
      if (!options.rejected) assert.equal(h.widgets.length, 0);
    } else {
      assert.ok(results.every((m) => !m.isError), JSON.stringify(results));
      assert.equal(results[0].details.path, join(scratch, "workspace", "image.png"));
      assert.equal(results[1].details.path, join(scratch, "workspace", "two-pages.pdf"));
      assert.equal(viewers.length, 3, "one image and first two PDF pages are retained");
      assert.equal(imageBlocks(viewers).length, 3);
      assert.equal(imageBlocks(h.manager.buildSessionContext().messages).length, 3, "blocking is NOT a storage policy");
      const lastResult = Math.max(...results.map((m) => h.session.messages.indexOf(m)));
      assert.ok(viewers.every((m) => h.session.messages.indexOf(m) > lastResult), "viewer interrupted tool-call/result ordering");
      assert.equal(h.session.messages.filter((m) => m.role === "assistant").length, 2);
      assert.equal(h.session.messages.filter((m) => m.role === "user").length, 1, "viewer steered another user turn");
      assert.equal(imageBlocks(h.requests[1].messages).length, blockImages ? 0 : 3);
      assert.deepEqual(imageBlocks(h.requests[1].messages), blockImages ? [] : imageBlocks(viewers));
      const converted = await h.session.agent.convertToLlm(h.session.messages);
      assert.deepEqual(imageBlocks(converted), blockImages ? [] : imageBlocks(viewers), "public agent conversion must match the actual request");
      if (blockImages) assert.ok(h.requests[1].messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === "text" && b.text === "Image reading is disabled.")));
      // Exercise the loaded renderer with its standard stored snapshot. Native
      // asynchronous preparation must remain outside model/session content.
      const before = JSON.stringify(h.session.messages);
      const theme = { fg: (_color, text) => text };
      const renderer = h.extension.messageRenderers.get("pi-tmux-image");
      const unknown = renderer({ ...viewers[0], details: { ...viewers[0].details, schema: "pi-tmux-image/native-future" } }, { expanded: false }, theme);
      const missing = renderer({ ...viewers[0], content: [] }, { expanded: false }, theme);
      for (const fallback of [unknown, missing]) {
        const output = fallback.render(80).join("");
        assert.ok(/Image/.test(output));
        assert.equal(output.includes(placeholder), false, "invalid/future snapshots must not expose cells");
      }
      const labelAttack = { ...viewers[0], details: { ...viewers[0].details, label: "unsafe\n\x1b_Ga=t;attack\x1b\\\u009f\u2028label" } };
      const attackBefore = JSON.stringify(labelAttack);
      const safeLabel = renderer(labelAttack, { expanded: false }, theme).render(80)[0];
      assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(safeLabel), false, "label injected terminal controls");
      assert.equal(JSON.stringify(labelAttack), attackBefore, "label sanitation mutated stored details/content");
      const components = viewers.map((m) => renderer(m, { expanded: false }, theme));
      let lines;
      for (let i = 0; i < 100; i++) {
        lines = components.flatMap((c) => c.render(80));
        if (components.every((c) => c.render(80).some((line) => line.includes(placeholder)))) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(components.every((c) => c.render(80).some((line) => line.includes(placeholder))), "local display failed while model policy was independent");
      assert.ok(h.writes.some((bytes) => bytes.includes("\x1bPtmux;")), "renderer produced no tmux transport");
      assert.equal(JSON.stringify(h.session.messages), before, "rendering mutated stored attachments");
      const firstWrites = h.writes.length;
      for (const component of components) { component.invalidate(); component.render(80); }
      const rebuilt = viewers.map((m) => h.extension.messageRenderers.get("pi-tmux-image")(m, { expanded: false }, theme));
      for (const component of rebuilt) component.render(80);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(h.writes.length, firstWrites, "unchanged frames/rebuild retransmitted pixels");
      assert.equal(JSON.stringify(h.session.messages), before);

      // Public SDK /reload lifecycle recreates extension state. Old paths are
      // unavailable, including the PDF page scratch files already removed by the
      // real tool. Only standard immutable attachments can supply replay pixels.
      await rm(join(scratch, "workspace", "image.png"));
      await rm(join(scratch, "workspace", "two-pages.pdf"));
      h.writes.length = 0;
      await h.session.reload({ beforeSessionStart() {
        h.settingsManager.applyOverrides({ images: { blockImages }, compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
      } });
      const reloaded = h.loader.getExtensions();
      assert.deepEqual(reloaded.errors, []);
      const replayRenderer = reloaded.extensions[0].messageRenderers.get("pi-tmux-image");
      const replay = viewers.map((m) => replayRenderer(m, { expanded: false }, theme));
      for (let i = 0; i < 100; i++) {
        lines = replay.flatMap((c) => c.render(80));
        if (replay.every((c) => c.render(80).some((line) => line.includes(placeholder)))) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(replay.every((c) => c.render(80).some((line) => line.includes(placeholder))), "reload could not recover snapshots after source removal");
      assert.ok(h.writes.some((bytes) => bytes.includes("a=t")), "new renderer runtime reused stale residency");
      assert.equal(JSON.stringify(h.session.messages), before, "replay appended or changed session content");
      assert.equal(h.requests.length, 2, "reload/replay triggered model work");
      await verifyLiveLayoutAndRefresh(h, replay[0], before);
      await verifyLegacyResume(scratch, blockImages, viewers[0]);
      assert.deepEqual(imageBlocks(await h.session.agent.convertToLlm(h.session.messages)), blockImages ? [] : imageBlocks(viewers));
    }
    assertCleanModelContent(h.requests);
    return { blockImages, mode, requests: h.requests.length, attachments: viewers.length };
  } finally {
    h.session.dispose();
    for (const widget of h.widgets) widget.dispose?.();
  }
}

test("public Pi SDK: isolated install, sequential viewers, model conversion and non-TUI safety", {
  skip: !host && "Install Pi or set PI_TEST_HOST_ROOT to its package root", timeout: 60000,
}, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "pi-tmux-host-"));
  const oldTmux = process.env.TMUX;
  const oldPane = process.env.TMUX_PANE;
  const oldPath = process.env.PATH;
  const oldOffline = process.env.PI_OFFLINE;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldImageProtocol = process.env.PI_IMAGE_PROTOCOL;
  process.env.PI_IMAGE_PROTOCOL = "auto";
  process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
  const oldCapabilities = { ...tuiModule.getCapabilities() };
  const oldCells = { ...tuiModule.getCellDimensions() };
  tuiModule.setCellDimensions({ widthPx: 8, heightPx: 16 });
  tuiModule.setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  process.env.TMUX = "offline-test-only";
  process.env.TMUX_PANE = "%1";
  process.env.PI_OFFLINE = "1";
  try {
    await mkdir(join(scratch, "workspace"));
    await mkdir(join(scratch, "agent"));
    await mkdir(join(scratch, "bin"));
    // Capability fixtures only: never query or configure the active tmux server.
    // Image reads, normalization, encoding and Poppler remain real host paths.
    await writeTmuxFixture(scratch);
    await writeFile(join(scratch, "bin", "tmux"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(join(scratch, "tmux-fixture.json"))}, "utf8"));
fs.appendFileSync(${JSON.stringify(join(scratch, "tmux-queries.log"))}, args[0] + "\\n");
if (fixture.timeout) setTimeout(() => {}, 2000);
else if (args[0] === "display-message") process.stdout.write("%1\\t$1\\t1\\t0\\t1\\t0\\n");
else if (args[0] === "show-options") process.stdout.write(fixture.passthrough + "\\n");
else if (args[0] === "list-clients") process.stdout.write("offline-client\\t" + fixture.termtype + "\\t" + fixture.termname + "\\t0\\n");
else { process.stderr.write("unexpected offline tmux query"); process.exitCode = 1; }
`, { mode: 0o755 });
    process.env.PATH = join(scratch, "bin") + (process.platform === "win32" ? ";" : ":") + oldPath;
    await writeFile(join(scratch, "workspace", "image.png"), Buffer.from(png, "base64"));
    await writeFile(join(scratch, "workspace", "two-pages.pdf"), pdfFixture());
    await writeFile(join(scratch, "agent", "settings.json"), JSON.stringify({ enableInstallTelemetry: false, enableAnalytics: false }));
    const manifest = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
    const cli = join(hostRoot, typeof manifest.bin === "string" ? manifest.bin : manifest.bin.pi);
    // Minimal allowlist: never pass inherited provider keys, credentials or active
    // agent settings to the installer. Local-path install requires no download.
    const env = { PATH: process.env.PATH, HOME: scratch, PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", TERM: "dumb" };
    await run(process.execPath, [cli, "install", repo], { cwd: join(scratch, "workspace"), env, timeout: 20000, maxBuffer: 1024 * 1024 });
    const settings = JSON.parse(await readFile(join(scratch, "agent", "settings.json"), "utf8"));
    assert.ok(settings.packages.some((source) => resolve(join(scratch, "agent"), typeof source === "string" ? source : source.source) === repo), "isolated pi install did not register local package");
    for (const blocked of [true, false]) {
      await t.test(`images.blockImages=${blocked}`, async () => { t.diagnostic(JSON.stringify(await verifySession(scratch, blocked))); });
    }
    for (const mode of ["print", "json", "rpc"]) {
      await t.test(`${mode} rejects viewers with zero graphics`, async () => { await verifySession(scratch, true, mode); });
    }
    await t.test("TUI outside tmux rejects viewers with zero graphics", async () => {
      delete process.env.TMUX;
      try { await verifySession(scratch, true, "tui"); }
      finally { process.env.TMUX = "offline-test-only"; }
    });
    await t.test("forced host-native Kitty rejects viewers with zero graphics", async () => {
      await writeTmuxFixture(scratch);
      tuiModule.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
      try {
        await verifySession(scratch, true, "tui", { rejected: /forced Pi Kitty|native Kitty|host.*Kitty|host.*conflict/i, missingSources: true });
        assert.equal(await readFile(join(scratch, "tmux-queries.log"), "utf8"), "", "forced native policy ran a capability query");
      }
      finally { tuiModule.setCapabilities({ images: null, trueColor: true, hyperlinks: false }); }
    });
    await t.test("local disabled policy/precedence rejects before source reads or probes", async () => {
      const cases = [
        { settings: { terminal: { showImages: false } }, env: "auto" },
        { settings: { terminal: { images: false } }, env: "kitty" },
        { settings: { terminal: { images: "auto" } }, env: "none" },
      ];
      for (const scenario of cases) {
        await writeTmuxFixture(scratch);
        process.env.PI_IMAGE_PROTOCOL = scenario.env;
        try {
          await verifySession(scratch, true, "tui", { settings: scenario.settings, rejected: /disabled/i, missingSources: true });
          assert.equal(await readFile(join(scratch, "tmux-queries.log"), "utf8"), "", "disabled local policy ran a capability query");
        } finally { process.env.PI_IMAGE_PROTOCOL = "auto"; }
      }
    });
    await t.test("false truecolor gate rejects before reads/probes", async () => {
      await writeTmuxFixture(scratch);
      tuiModule.setCapabilities({ images: null, trueColor: false, hyperlinks: false });
      try {
        await verifySession(scratch, true, "tui", { rejected: /truecolor/i, missingSources: true });
        assert.equal(await readFile(join(scratch, "tmux-queries.log"), "utf8"), "");
      } finally { tuiModule.setCapabilities({ images: null, trueColor: true, hyperlinks: false }); }
    });
    await t.test("unsupported tmux paths reject before source reads with zero graphics", async () => {
      for (const scenario of [
        { fixture: { passthrough: "off" }, rejected: /passthrough.*off/i },
        { fixture: { termtype: "unknown-terminal", termname: "xterm-unknown" }, rejected: /recognized|unknown.*terminal/i },
        { fixture: { timeout: true }, rejected: /timed out|timeout/i },
      ]) {
        await writeTmuxFixture(scratch, scenario.fixture);
        await verifySession(scratch, true, "tui", { rejected: scenario.rejected, missingSources: true });
        assert.ok((await readFile(join(scratch, "tmux-queries.log"), "utf8")).length > 0);
      }
      await writeTmuxFixture(scratch);
    });
    await t.test("denied replay recovers through refresh without model turns or attachments", async () => {
      for (const blocked of [true, false]) {
        await verifyDeniedReplayRecovery(scratch, blocked);
        await verifyDeniedReplayRecovery(scratch, blocked, { fixture: { timeout: true }, rejected: /timed out|timeout/i });
      }
    });
  } finally {
    tuiModule.setCapabilities(oldCapabilities);
    tuiModule.setCellDimensions(oldCells);
    if (oldTmux === undefined) delete process.env.TMUX; else process.env.TMUX = oldTmux;
    if (oldPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = oldPane;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = oldOffline;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    if (oldImageProtocol === undefined) delete process.env.PI_IMAGE_PROTOCOL; else process.env.PI_IMAGE_PROTOCOL = oldImageProtocol;
    await rm(scratch, { recursive: true, force: true });
  }
});
