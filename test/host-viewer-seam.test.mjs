import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createViewerController, viewerTitle } from "../src/viewer.mjs";
import { createPresentation } from "../src/presentation.mjs";
import { createNativeRenderer, sanitizeDisplayText } from "../src/native.mjs";
import { encodePlaceholderRows, encodePlaceholderCell, encodePngUpload, encodeVirtualPlacement, PLACEHOLDER, DIACRITICS } from "../src/kitty.mjs";

// Optional Pi 1.0.3 feasibility evidence, public entry points only. No real tty.
const root = process.env.PI_TEST_HOST_ROOT;
const host = root ? await import(pathToFileURL(join(root, "dist/index.js")).href) : undefined;
const ui = root ? await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-tui/dist/index.js")).href) : undefined;
const hostTest = (name, fn) => test(name, { skip: !root && "set PI_TEST_HOST_ROOT to run installed Pi viewer seam", timeout: 10000 }, fn);
class CaptureTerminal {
  columns = 40; rows = 16; kittyProtocolActive = false; writes = [];
  start(input, resize) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write(bytes) { this.writes.push(bytes); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
  get output() { return this.writes.join(""); }
  mouse(button, x, y, release = false) { this.input(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`); }
  click(x, y) { this.mouse(0, x, y); this.mouse(0, x, y, true); }
}
const delay = () => new Promise((resolve) => setTimeout(resolve, 25));
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < end, "host event/frame did not arrive"); await delay(); }
}
function capabilities() {
  const saved = { ...ui.getCapabilities() };
  ui.setCapabilities({ images: null, trueColor: true, hyperlinks: true });
  return () => ui.setCapabilities(saved);
}
function message(id) { return { role: "custom", customType: "viewer-seam", content: id, details: { occurrence: id }, display: true, timestamp: 1 }; }

hostTest("viewer seam: actual custom-message click routing after scroll/clip/padding/rebuild preserves drag, wheel and OSC8", async () => {
  const restore = capabilities();
  const terminal = new CaptureTerminal(); terminal.rows = 8;
  const opened = [], events = [], urls = [], copies = [];
  const tui = new ui.TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 1, openUrl: (url) => urls.push(url), copySelection: async (text) => { copies.push(text); return true; } });
  const document = new ui.Container();
  document.addChild(new ui.Text("prefix\n".repeat(4), 0, 0));
  let builds = 0;
  const renderer = (m, { outputPad }) => {
    builds++;
    const rows = { render: () => ["PAGE0", "PAGE1", "\x1b]8;;https://example.invalid/\x07LINK\x1b]8;;\x07", "PAGE3"], invalidate() {} };
    const region = new ui.MouseRegion(rows, (event) => {
      events.push({ id: m.details.occurrence, ...event });
      // Only click is handled; press/drag/wheel pass through to native selection.
      if (event.type === "click" && event.button === "left") { opened.push({ id: m.details.occurrence, row: event.y, x: event.x }); return { handled: true, render: false }; }
    });
    const box = new ui.Box(outputPad + 1, 1); box.addChild(region); return box;
  };
  const first = new host.CustomMessageComponent(message("pdf-page-1"), renderer, undefined, 1);
  const second = new host.CustomMessageComponent(message("pdf-page-2"), renderer, undefined, 1);
  document.addChild(first); document.addChild(second);
  const scroll = new ui.ScrollView(document, { primary: true, follow: "none", scrollbar: "hidden" });
  tui.setLayoutRoot(scroll);
  try {
    tui.start(); tui.renderNow();
    scroll.scrollTo(8); tui.renderNow(); // PAGE1 at top: earlier message + border/padding clipped.
    const screen = tui.getScreenLines().map(ui.stripTerminalSequences);
    const y = screen.findIndex((line) => line.includes("PAGE1")); assert.equal(y, 0);
    terminal.click(2, y);
    assert.deepEqual(opened, [{ id: "pdf-page-1", row: 1, x: 0 }]);
    assert.ok(events.some((e) => e.type === "click" && e.screenY === 0 && e.y === 1));
    terminal.click(0, y); assert.equal(opened.length, 1, "horizontal padding is not the image target");
    terminal.mouse(0, 2, y); terminal.mouse(32, 5, y + 2); terminal.mouse(0, 5, y + 2, true);
    await delay();
    assert.equal(opened.length, 1, "selection drag opened viewer"); assert.ok(tui.hasActiveSelection()); assert.ok(copies.length > 0);
    const before = scroll.scrollTop;
    terminal.mouse(65, 3, 0); tui.renderNow(); assert.equal(scroll.scrollTop, before + 1, "unhandled wheel must scroll transcript");
    scroll.scrollTo(8); tui.renderNow();
    terminal.click(2, 1); assert.deepEqual(urls, ["https://example.invalid/"]); assert.equal(opened.length, 1, "OSC8 link must precede enclosing click region");
    first.invalidate(); tui.renderNow(); assert.ok(builds >= 3);
    terminal.click(2, 0); assert.equal(opened.at(-1).id, "pdf-page-1");
    scroll.scrollTo(13); tui.renderNow();
    const secondY = tui.getScreenLines().map(ui.stripTerminalSequences).findIndex((line) => line.includes("PAGE0"));
    terminal.click(2, secondY); assert.equal(opened.at(-1).id, "pdf-page-2", "exact page survives scroll and renderer rebuilding");
    const count = opened.length;
    const modal = tui.showOverlay({ render: () => Array.from({ length: terminal.rows }, () => " ".repeat(terminal.columns)), invalidate() {}, handleMouse() { return { handled: true, render: false }; } }, { row: 0, col: 0, width: "100%", maxHeight: "100%" });
    tui.renderNow(); const behindModal = scroll.scrollTop;
    terminal.click(2, secondY); terminal.mouse(65, 2, 0); tui.renderNow();
    assert.equal(opened.length, count); assert.equal(scroll.scrollTop, behindModal, "full-pane consuming mouse root protects hidden transcript");
    modal.hide(); // This is TUI.showOverlay, not a ctx.ui.custom handle.
  } finally { tui.stop(); restore(); }
});

// Public TUI.showOverlay owns its exact handle; disposal/promise belong to us.
function ownedOverlay(tui) {
  let handle, resolve, closed = false, disposed = 0;
  const keys = [], mouseEvents = [];
  const promise = new Promise((finish) => { resolve = finish; });
  const component = {
    focused: false,
    render: (width) => Array.from({ length: tui.terminal.rows }, (_, row) => row === 0 ? "OWNED-OVERLAY".slice(0, width) : " ".repeat(width)),
    invalidate() {}, handleMouse(event) { mouseEvents.push(event); return { handled: true, render: false }; },
    handleInput(data) { keys.push(data); if (ui.matchesKey(data, "escape")) close("escape"); },
    dispose() { disposed++; },
  };
  const close = (result) => {
    if (closed) return;
    closed = true; handle.hide(); component.dispose(); resolve(result);
  };
  handle = tui.showOverlay(component, { row: 0, col: 0, width: "100%", maxHeight: "100%" });
  return { promise, close, handle, component, keys, mouseEvents, get disposed() { return disposed; } };
}

// Candidate v1 policy authorized by coordinator: no overlay admission, and
// synchronous logical cancellation on public Focusable loss before deferred hide.
function guardedFocusOverlay(tui, onClosing = () => {}) {
  if (tui.hasOverlay()) return undefined;
  const abort = new AbortController();
  let handle, focused = false, everFocused = false, closing = false, disposed = 0, settle;
  const inputs = [], mouse = [];
  const promise = new Promise((resolve) => { settle = resolve; });
  const close = (reason) => {
    if (closing) return;
    closing = true; abort.abort(); onClosing(reason);
    queueMicrotask(() => { handle.hide(); component.dispose(); settle(reason); });
  };
  const component = {
    get focused() { return focused; },
    set focused(value) {
      focused = value;
      if (value) everFocused = true;
      else if (everFocused) close("focus-lost");
    },
    render: (width) => closing ? [] : Array.from({ length: tui.terminal.rows }, (_, y) => y === 0 ? "GUARDED-VIEWER".slice(0, width) : " ".repeat(width)),
    invalidate() {},
    handleInput(data) { if (closing) return; inputs.push(data); if (ui.matchesKey(data, "escape")) close("escape"); },
    handleMouse(event) { if (!closing) mouse.push(event); return { handled: true, render: false }; },
    dispose() { disposed++; },
  };
  handle = tui.showOverlay(component, { row: 0, col: 0, width: "100%", maxHeight: "100%" });
  return { handle, component, promise, close, inputs, mouse, signal: abort.signal, get closing() { return closing; }, get disposed() { return disposed; } };
}

const model = { id: "offline", name: "Offline", api: "offline-test", provider: "offline-test", baseUrl: "http://invalid.invalid", reasoning: false, input: ["text", "image"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function interactive(mode, configure = () => {}, ownedRoute = false, widgetDispose = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-viewer-public-"));
  const terminal = new CaptureTerminal();
  let ctx, tui, requests = 0, open;
  const modelRuntime = {
    getModel: () => model, getPhysicalModel: () => model, getModels: () => [model], getAvailableSnapshot: () => [model], refresh: async () => {},
    getError: () => undefined, hasConfiguredAuth: () => true, isUsingOAuth: () => false, isUsingSubscription: () => false,
    getAuth: async () => ({ apiKey: "offline-not-a-secret" }), streamSimple() { requests++; assert.fail("viewer called a model"); },
  };
  const settingsManager = host.SettingsManager.inMemory({ quietStartup: true, theme: "dark", cacheWarming: "off", enableInstallTelemetry: false, enableAnalytics: false, fullscreenExitOutput: "resume-hint", fullscreenScrollbar: "hidden", terminal: { images: "auto", trueColor: true }, compaction: { enabled: false }, retry: { enabled: false } });
  const manager = host.SessionManager.inMemory(directory);
  for (let n = 0; n < 20; n++) manager.appendCustomMessageEntry("viewer-seam", `TRANSCRIPT-${n}`, true, { occurrence: `${n}` });
  const factory = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await host.createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        configure(pi);
        pi.on("session_start", (_event, context) => {
          ctx = context;
          ctx.ui.setWidget("viewer-seam-transport", (injected) => { tui = injected; return { render: () => [], invalidate() {}, dispose: widgetDispose }; });
          // Public context closure routes renderer callbacks to current controller.
          open = ownedRoute ? () => ownedOverlay(tui).promise : () => ctx.ui.custom((_tui, _theme, _kb, done) => ({ render: () => ["CLICK-OVERLAY"], invalidate() {}, handleInput(data) { if (ui.matchesKey(data, "escape")) done(); } }), { overlay: true });
        });
        pi.registerMessageRenderer("viewer-seam", (m) => new ui.MouseRegion(new ui.Text(m.content, 1, 0), (event) => {
          if (event.type === "click" && event.button === "left") { void open(); return { handled: true }; }
        }));
        pi.registerCommand("viewer-seam-open", { handler: async () => { await open(); } });
      }],
    } });
    const created = await host.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, noTools: "all" });
    assert.deepEqual(created.extensionsResult.errors, []);
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await host.createAgentSessionRuntime(factory, { cwd: directory, agentDir: join(directory, "agent"), sessionManager: manager });
  const app = new host.InteractiveMode(runtime, { terminal, tuiMode: mode, initialThemeSetting: "dark" });
  await app.init();
  return { directory, terminal, runtime, app, get ctx() { return ctx; }, get tui() { return tui; }, get requests() { return requests; }, async cleanup() { app.stop(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

for (const mode of ["fullscreen", "regular"]) {
  hostTest(`viewer seam: actual InteractiveMode ${mode} custom overlay focus, completion, resize and transport`, async () => {
    const restore = capabilities(); const h = await interactive(mode);
    try {
      const before = JSON.stringify(h.runtime.session.messages), entries = JSON.stringify(h.ctx.sessionManager.getEntries());
      h.ctx.ui.setEditorText("draft remains"); h.tui.renderNow();
      if (mode === "fullscreen") { h.terminal.input("\x1b[5~"); h.tui.renderNow(); }
      const viewport = mode === "fullscreen" ? h.tui.viewportTop : undefined;
      let disposed = 0, handle, component, finish;
      const controls = [];
      const promise = h.ctx.ui.custom((tui, _theme, _kb, done) => {
        finish = done;
        component = { focused: false, render: (width) => ["OVERLAY".slice(0, width), "controls".slice(0, width)], invalidate() {},
          handleInput(data) { controls.push(data); if (ui.matchesKey(data, "escape")) done("closed"); }, dispose() { disposed++; } };
        assert.equal(tui, h.tui); return component;
      }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", margin: 1, anchor: "center" }, onHandle(value) { handle = value; } });
      await until(() => handle); h.tui.renderNow();
      assert.equal(handle.isFocused(), true); assert.equal(component.focused, true);
      for (const key of ["+", "-", "0", "h", "j", "k", "l", "\x1b[5~"]) h.terminal.input(key);
      h.terminal.mouse(65, 0, 0); h.tui.renderNow();
      assert.equal(h.ctx.ui.getEditorText(), "draft remains");
      if (mode === "fullscreen") assert.equal(h.tui.viewportTop, viewport, "focused overlay wheel/pageup changed hidden transcript");
      const bounds = handle.getBounds(); assert.ok(bounds.row >= 1 && bounds.col >= 1); assert.ok(bounds.width <= h.terminal.columns - 2);
      h.terminal.columns = 12; h.terminal.rows = 6; h.terminal.resize(); await delay(); h.tui.renderNow();
      const small = handle.getBounds(); assert.ok(small.col + small.width <= 11 && small.row + small.height <= 5);
      h.terminal.columns = 40; h.terminal.rows = 16; h.terminal.resize(); await delay(); h.tui.renderNow();
      h.terminal.input("\x1b"); assert.equal(await promise, "closed"); finish("again");
      assert.equal(disposed, 1); assert.equal(h.tui.hasOverlay(), false); assert.equal(component.focused, false);
      h.tui.renderNow(); assert.equal(h.ctx.ui.getEditorText(), "draft remains");
      if (mode === "fullscreen") assert.equal(h.tui.viewportTop, viewport);
      h.terminal.input("X"); assert.equal(h.ctx.ui.getEditorText(), "draft remainsX", "completion must restore editor keyboard focus");
      assert.ok(controls.includes("+") && controls.includes("\x1b"));
      assert.equal(JSON.stringify(h.runtime.session.messages), before); assert.equal(JSON.stringify(h.ctx.sessionManager.getEntries()), entries); assert.equal(h.requests, 0);

      // Real overlay composer + public Terminal.write, no graphics on actual tty.
      const rows = encodePlaceholderRows({ imageId: 0x123456, placementId: 0xabcdef, columns: 12, rows: 8 }).slice(2, 6);
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
      const wire = encodePngUpload(png, 0x123456).join("") + encodeVirtualPlacement({ imageId: 0x123456, placementId: 0xabcdef, columns: 12, rows: 8 });
      h.terminal.writes.length = 0;
      let ready = false, closeGraphics, graphicsHandle;
      const graphics = h.ctx.ui.custom((tui, _theme, _kb, done) => {
        closeGraphics = done;
        const c = { render: (width) => ready ? ["┌" + "─".repeat(Math.max(0, width - 2)) + "┐", ...rows.map((row) => "│" + ui.sliceByColumn(row, 3, Math.max(0, width - 2), true) + "│"), "└" + "─".repeat(Math.max(0, width - 2)) + "┘"] : ["preparing"], invalidate() {} };
        queueMicrotask(() => { tui.terminal.write(wire); ready = true; tui.requestRender(); }); return c;
      }, { overlay: true, overlayOptions: { col: 3, row: 2, width: 7, maxHeight: 4 }, onHandle(value) { graphicsHandle = value; } });
      await until(() => graphicsHandle); h.tui.renderNow(); await until(() => h.terminal.output.includes(PLACEHOLDER));
      assert.ok(h.terminal.output.indexOf(wire) < h.terminal.output.indexOf(PLACEHOLDER));
      assert.ok(h.terminal.output.includes(encodePlaceholderCell(2, 3)), "top/left subset cells retain independent nonzero row/column addresses");
      assert.ok(h.terminal.output.includes(encodePlaceholderCell(4, 7)), "rightmost bottom-visible cell retains its full-canvas address");
      assert.equal(h.terminal.output.includes(encodePlaceholderCell(2, 8)), false, "right width clip leaked a cell beyond usable image area");
      assert.equal(h.terminal.output.includes(encodePlaceholderCell(5, 3)), false, "bottom maxHeight clip leaked a hidden row");
      assert.ok(h.terminal.output.includes("38;2;18;52;86") && h.terminal.output.includes("58:2::171:205:239"), "compositing preserves both ID colors");
      assert.equal(h.terminal.output.includes(ui.deleteAllKittyImages()), false, "auto tmux-style capabilities must not reset untracked graphics");
      assert.equal(graphicsHandle.getBounds().height, 4, "maxHeight clips bottom rows");
      h.terminal.writes.length = 0; h.terminal.rows = 15; h.terminal.resize(); await delay(); h.tui.renderNow();
      assert.equal(h.terminal.output.includes(ui.deleteAllKittyImages()), false, "height redraw under automatic capabilities must not globally reset graphics");
      assert.equal(h.terminal.output.includes(wire), false, "geometry redraw must not retransmit resident PNG");
      closeGraphics(); await graphics;
    } finally { await h.cleanup(); restore(); }
  });
}

hostTest("viewer seam: actual InteractiveMode click controller and slash invocation preserve fullscreen scroll position", async () => {
  const restore = capabilities(); const h = await interactive("fullscreen", undefined, true);
  try {
    h.terminal.input("\x1b[5~"); h.tui.renderNow();
    const before = h.tui.viewportTop;
    const screen = h.tui.getScreenLines().map(ui.stripTerminalSequences);
    const y = screen.findIndex((line) => line.includes("TRANSCRIPT-")); assert.ok(y >= 0);
    h.ctx.ui.setEditorText("unsubmitted draft"); h.terminal.click(2, y);
    await until(() => h.tui.hasOverlay()); h.tui.renderNow();
    assert.equal(h.tui.viewportTop, before); h.terminal.input("\x1b"); await delay(); h.tui.renderNow();
    assert.equal(h.tui.viewportTop, before); assert.equal(h.ctx.ui.getEditorText(), "unsubmitted draft");
    // Exercise the interactive Enter path, not session.prompt(command) alone.
    h.ctx.ui.setEditorText("/viewer-seam-open"); h.tui.renderNow();
    const atInvocation = h.tui.viewportTop;
    const input = h.app.getUserInput();
    h.terminal.input("\r");
    assert.equal(await input, "/viewer-seam-open");
    const command = h.runtime.session.prompt("/viewer-seam-open");
    await until(() => h.tui.hasOverlay()); h.tui.renderNow();
    assert.equal(h.tui.viewportTop, atInvocation, "slash-command invocation snapped transcript to end");
    h.terminal.input("\x1b"); await command; await delay(); h.tui.renderNow();
    assert.equal(h.tui.viewportTop, atInvocation); assert.equal(h.requests, 0);
  } finally { await h.cleanup(); restore(); }
});

for (const mode of ["fullscreen", "regular"]) {
  hostTest(`viewer seam: ${mode} overlapping builtin dialog and programmatic shutdown close`, async () => {
    const restore = capabilities(); let close;
    const h = await interactive(mode, (pi) => pi.on("session_shutdown", () => close?.("shutdown")));
    let shutdown = false;
    try {
      let handle, disposed = 0;
      const viewer = h.ctx.ui.custom((_tui, _theme, _kb, done) => {
        close = done;
        return { render: () => ["VIEWER"], invalidate() {}, dispose() { disposed++; } };
      }, { overlay: true, onHandle(value) { handle = value; } });
      await until(() => handle); h.tui.renderNow();
      const controller = new AbortController();
      const dialog = h.ctx.ui.select("Concurrent host dialog", ["keep", "cancel"], { signal: controller.signal });
      h.tui.renderNow();
      // A session_shutdown handler is a supported place to call the supplied done.
      await h.runtime.dispose(); shutdown = true;
      assert.equal(await viewer, "shutdown"); assert.equal(disposed, 1); assert.equal(h.tui.hasOverlay(), false);
      controller.abort(); assert.equal(await dialog, undefined);
    } finally {
      h.app.stop(); if (!shutdown) await h.runtime.dispose(); await rm(h.directory, { recursive: true, force: true }); restore();
    }
  });
}

hostTest("viewer seam: regular mode rejects normalized mouse routing and supports keyboard open", async () => {
  const restore = capabilities(); const h = await interactive("regular");
  try {
    h.ctx.ui.setEditorText("draft"); h.terminal.click(2, 2); await delay();
    assert.equal(h.tui.hasOverlay(), false, "regular mode must not synthesize custom-message click");
    h.ctx.ui.setEditorText("/viewer-seam-open");
    const input = h.app.getUserInput(); h.terminal.input("\r");
    assert.equal(await input, "/viewer-seam-open");
    const command = h.runtime.session.prompt("/viewer-seam-open");
    await until(() => h.tui.hasOverlay()); h.terminal.input("+"); h.terminal.input("\x1b"); await command;
    assert.equal(h.tui.hasOverlay(), false); assert.equal(h.requests, 0);
  } finally { await h.cleanup(); restore(); }
});

hostTest("viewer seam BLOCKER: completing lower custom overlay pops unrelated upper overlay", async () => {
  const restore = capabilities(); const h = await interactive("fullscreen");
  try {
    let closeFirst, closeSecond, firstHandle, secondHandle, firstDisposed = 0, secondDisposed = 0;
    const first = h.ctx.ui.custom((_tui, _theme, _kb, done) => {
      closeFirst = done; return { render: () => ["LOWER"], invalidate() {}, dispose() { firstDisposed++; } };
    }, { overlay: true, onHandle(handle) { firstHandle = handle; } });
    await until(() => firstHandle);
    const second = h.ctx.ui.custom((_tui, _theme, _kb, done) => {
      closeSecond = done; return { render: () => ["UPPER"], invalidate() {}, dispose() { secondDisposed++; } };
    }, { overlay: true, onHandle(handle) { secondHandle = handle; } });
    await until(() => secondHandle); h.tui.renderNow();
    assert.ok(secondHandle.getBounds());
    closeFirst("programmatic-close"); await first; h.tui.renderNow();
    assert.equal(firstDisposed, 1); assert.equal(secondDisposed, 0);
    assert.ok(firstHandle.getBounds(), "disposed lower overlay unexpectedly remains mounted");
    assert.equal(secondHandle.getBounds(), undefined, "completion removed unrelated upper overlay");
    assert.equal(h.tui.hasOverlay(), true);
    closeSecond(); await second; assert.equal(secondDisposed, 1); assert.equal(h.tui.hasOverlay(), false);
  } finally { await h.cleanup(); restore(); }
});

hostTest("viewer seam BLOCKER: early completion of async custom factory skips returned component disposal", async () => {
  const restore = capabilities(); const h = await interactive("fullscreen");
  try {
    let resolveFactory, done, disposed = 0;
    const promise = h.ctx.ui.custom((_tui, _theme, _kb, finish) => {
      done = finish; return new Promise((resolve) => { resolveFactory = resolve; });
    }, { overlay: true });
    done("cancelled-before-factory"); assert.equal(await promise, "cancelled-before-factory");
    resolveFactory({ render: () => ["LATE"], invalidate() {}, dispose() { disposed++; } });
    await delay(); assert.equal(h.tui.hasOverlay(), false); assert.equal(disposed, 0, "Pi currently skips disposal of late factory result");
  } finally { await h.cleanup(); restore(); }
});

for (const mode of ["fullscreen", "regular"]) {
  hostTest(`viewer seam READY: ${mode} direct public overlay scoped close, focus, resize, shutdown and cell removal`, async () => {
    const restore = capabilities(); let live;
    const h = await interactive(mode, (pi) => pi.on("session_shutdown", () => live?.close("shutdown")), false, () => live?.close("widget-disposal"));
    let shutdown = false;
    try {
      const messages = JSON.stringify(h.runtime.session.messages), entries = JSON.stringify(h.ctx.sessionManager.getEntries());
      h.ctx.ui.setEditorText("saved draft");
      if (mode === "fullscreen") { h.terminal.input("\x1b[5~"); h.tui.renderNow(); }
      const top = mode === "fullscreen" ? h.tui.viewportTop : undefined;
      live = ownedOverlay(h.tui); h.tui.renderNow();
      assert.equal(live.handle.isFocused(), true);
      let customHandle, customDone, customDisposed = 0;
      const custom = h.ctx.ui.custom((_tui, _theme, _kb, done) => {
        customDone = done;
        return { render: () => ["UNRELATED-UPPER"], invalidate() {}, handleInput(data) { if (ui.matchesKey(data, "escape")) done("upper-escape"); }, dispose() { customDisposed++; } };
      }, { overlay: true, onHandle(handle) { customHandle = handle; } });
      await until(() => customHandle); h.tui.renderNow();
      assert.equal(customHandle.isFocused(), true);
      live.close("lower-programmatic"); assert.equal(await live.promise, "lower-programmatic"); h.tui.renderNow();
      assert.equal(live.disposed, 1); assert.equal(live.handle.getBounds(), undefined);
      assert.ok(customHandle.getBounds()); assert.equal(customHandle.isFocused(), true); assert.equal(customDisposed, 0);
      h.terminal.input("\x1b"); assert.equal(await custom, "upper-escape"); customDone("twice");
      assert.equal(customDisposed, 1); assert.equal(h.tui.hasOverlay(), false);
      h.terminal.input("X"); assert.equal(h.ctx.ui.getEditorText(), "saved draftX", "upper preFocus was correctly retargeted after lower removal");
      if (mode === "fullscreen") assert.equal(h.tui.viewportTop, top);

      live = ownedOverlay(h.tui); h.tui.renderNow();
      const row = encodePlaceholderRows({ imageId: 0x334455, placementId: 0x667788, columns: 3, rows: 1 })[0];
      const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
      const wire = encodePngUpload(bytes, 0x334455).join("") + encodeVirtualPlacement({ imageId: 0x334455, placementId: 0x667788, columns: 3, rows: 1 });
      h.terminal.writes.length = 0;
      h.tui.terminal.write(wire); // Existing widget-injected public transport, before publishing raw-overlay cells.
      live.component.render = (width) => [row + " ".repeat(Math.max(0, width - 3)), ...Array.from({ length: h.terminal.rows - 1 }, () => " ".repeat(width))];
      h.tui.renderNow();
      assert.ok(h.terminal.output.indexOf(wire) < h.terminal.output.indexOf(PLACEHOLDER));
      if (mode === "fullscreen") assert.ok(h.tui.getScreenLines().some((line) => line.includes(PLACEHOLDER)));
      h.terminal.input("+"); h.terminal.input("h"); h.terminal.mouse(65, 0, 0);
      h.terminal.columns = 12; h.terminal.rows = 6; h.terminal.resize(); await delay(); h.tui.renderNow();
      assert.deepEqual(live.handle.getBounds(), { row: 0, col: 0, width: 12, height: 6 });
      h.terminal.columns = 40; h.terminal.rows = 16; h.terminal.resize(); await delay(); h.tui.renderNow();
      h.terminal.writes.length = 0;
      live.close("refresh-like-cancel"); assert.equal(await live.promise, "refresh-like-cancel"); h.tui.renderNow();
      assert.equal(live.disposed, 1); assert.equal(h.terminal.output.includes(PLACEHOLDER), false, "closed surface cells must not be re-emitted");
      assert.ok(h.terminal.output.length > 0, "closing raw overlay must repaint underlying regular/fullscreen content");
      if (mode === "fullscreen") { assert.equal(h.tui.viewportTop, top); assert.equal(h.tui.getScreenLines().some((line) => line.includes(PLACEHOLDER)), false); }
      assert.equal(h.ctx.ui.getEditorText(), "saved draftX");
      assert.equal(JSON.stringify(h.runtime.session.messages), messages); assert.equal(JSON.stringify(h.ctx.sessionManager.getEntries()), entries); assert.equal(h.requests, 0);
      live = ownedOverlay(h.tui); h.tui.renderNow();
      const detached = live;
      h.ctx.ui.setWidget("viewer-seam-transport", undefined);
      assert.equal(await detached.promise, "widget-disposal"); assert.equal(detached.disposed, 1); assert.equal(h.tui.hasOverlay(), false);
      // Remount the supported zero-row transport owner before the next interaction.
      h.ctx.ui.setWidget("viewer-seam-transport", () => ({ render: () => [], invalidate() {}, dispose() { live?.close("widget-disposal"); } }));
      live = ownedOverlay(h.tui); h.tui.renderNow();
      const last = live;
      await h.runtime.dispose(); shutdown = true;
      assert.equal(await last.promise, "shutdown"); assert.equal(last.disposed, 1); assert.equal(h.tui.hasOverlay(), false);
      last.close("twice"); assert.equal(last.disposed, 1);
    } finally {
      live?.close("cleanup"); h.app.stop(); if (!shutdown) await h.runtime.dispose(); await rm(h.directory, { recursive: true, force: true }); restore();
    }
  });
}

hostTest("viewer seam BLOCKER: fullscreen hidden search mouse precedes owned modal and appended public input filters", async () => {
  const restore = capabilities(); const h = await interactive("fullscreen"); let viewer;
  try {
    h.terminal.input("\x1b[102;6u"); h.tui.renderNow();
    for (const char of "TRANSCRIPT") h.terminal.input(char);
    h.tui.renderNow();
    const screen = h.tui.getScreenLines().map(ui.stripTerminalSequences);
    const y = screen.findIndex((line) => line.includes("↓")); assert.ok(y >= 0, "public search key did not render navigation");
    const x = screen[y].indexOf("↑"); assert.ok(x >= 0);
    viewer = ownedOverlay(h.tui); h.tui.renderNow();
    const top = h.tui.viewportTop, editor = h.ctx.ui.getEditorText();
    for (const key of ["+", "-", "0", "h", "j", "k", "l"]) h.terminal.input(key);
    h.terminal.mouse(65, 0, 0); h.tui.renderNow();
    assert.deepEqual(viewer.keys, ["+", "-", "0", "h", "j", "k", "l"]);
    assert.equal(h.tui.viewportTop, top); assert.equal(h.ctx.ui.getEditorText(), editor);
    h.terminal.input("\x1b"); assert.equal(await viewer.promise, "escape"); h.tui.renderNow();
    assert.equal(h.tui.viewportTop, top); assert.equal(h.ctx.ui.getEditorText(), editor);
    assert.equal(h.tui.hasOverlay(), true, "closing viewer leaves the existing search overlay intact");
    viewer = ownedOverlay(h.tui); h.tui.renderNow();
    const filtered = [], extensionFiltered = [];
    const remove = h.tui.addInputListener((data) => {
      if (!viewer.handle.isFocused()) return;
      filtered.push(data); return { consume: true };
    });
    const unsubscribe = h.ctx.ui.onTerminalInput((data) => {
      if (!viewer.handle.isFocused()) return;
      extensionFiltered.push(data); return { consume: true };
    });
    try {
      for (let n = 0; n < 15; n++) { h.terminal.click(x, y); h.tui.renderNow(); }
      assert.equal(viewer.handle.isFocused(), true);
      assert.notEqual(h.tui.viewportTop, top, "hidden search navigation changed transcript under focused full-pane modal");
      assert.equal(viewer.mouseEvents.length, 15); assert.ok(viewer.mouseEvents.every((event) => event.type === "release"), "hidden search consumes press; owned modal sees only releases");
      assert.equal(filtered.length, 0); assert.equal(extensionFiltered.length, 0, "appended public terminal filter cannot intercept earlier host consumer");
      // Printable controls do reach the later listener while viewer is focused.
      h.terminal.input("+"); assert.deepEqual(filtered, ["+"]);
      // The host search shortcut is consumed before our listener too.
      h.terminal.input("\x1b[102;6u"); h.tui.renderNow();
      assert.deepEqual(filtered, ["+"]);
    } finally { remove(); unsubscribe(); }
    // Without a filter, ordinary viewer controls/Escape route normally even when
    // the lower search overlay exists; the specific blocker is earlier host paths.
    h.terminal.input("h"); h.terminal.input("\x1b"); assert.equal(await viewer.promise, "escape");
    assert.ok(viewer.keys.includes("h")); assert.equal(h.requests, 0);
  } finally { viewer?.close("cleanup"); await h.cleanup(); restore(); }
});

hostTest("viewer seam: public hasOverlay opening guard refuses existing search without private state", async () => {
  const restore = capabilities(); const h = await interactive("fullscreen"); let viewer;
  try {
    const refused = [];
    const open = () => {
      if (h.tui.hasOverlay()) { refused.push("Close the current dialog/search before opening the viewer."); return undefined; }
      return ownedOverlay(h.tui);
    };
    h.terminal.input("\x1b[102;6u"); h.tui.renderNow();
    const before = h.tui.getScreenLines(), top = h.tui.viewportTop;
    viewer = open(); assert.equal(viewer, undefined); assert.equal(refused.length, 1);
    assert.deepEqual(h.tui.getScreenLines(), before); assert.equal(h.tui.viewportTop, top);
    h.terminal.input("\x1b"); h.tui.renderNow(); assert.equal(h.tui.hasOverlay(), false);
    viewer = open(); assert.ok(viewer); h.tui.renderNow();
    assert.equal(viewer.handle.isFocused(), true);
    for (const key of ["+", "-", "0", "h", "j", "k", "l"]) h.terminal.input(key);
    h.terminal.mouse(65, 0, 0); h.tui.renderNow(); assert.equal(h.tui.viewportTop, top);
    h.terminal.input("\x1b"); assert.equal(await viewer.promise, "escape"); assert.equal(h.requests, 0);
  } finally { viewer?.close("cleanup"); await h.cleanup(); restore(); }
});

hostTest("viewer seam BLOCKER: user search shortcut is NOT deferred behind focused owned overlay", async () => {
  const restore = capabilities(); const h = await interactive("fullscreen"); let viewer;
  try {
    assert.equal(h.tui.hasOverlay(), false);
    // Positive control in this exact fixture/keybinding: key opens real search.
    h.terminal.input("\x1b[102;6u"); h.tui.renderNow();
    assert.ok(h.tui.getScreenLines().map(ui.stripTerminalSequences).some((line) => line.includes("Find in transcript")));
    h.terminal.input("\x1b"); h.tui.renderNow(); assert.equal(h.tui.hasOverlay(), false);
    viewer = ownedOverlay(h.tui); h.tui.renderNow(); assert.equal(viewer.handle.isFocused(), true);
    const laterInput = [];
    const unsubscribe = h.tui.addInputListener((data) => {
      if (!viewer.handle.isFocused()) return;
      laterInput.push(data); return { consume: true };
    });
    try {
      h.terminal.input("\x1b[102;6u"); h.tui.renderNow();
      assert.equal(viewer.handle.isFocused(), false, "host search shortcut creates a new higher focused search overlay");
      assert.ok(viewer.handle.getBounds(), "owned viewer remains mounted below new search");
      assert.equal(laterInput.length, 0, "earlier host search shortcut bypasses appended scoped filter");
      assert.ok(h.tui.getScreenLines().map(ui.stripTerminalSequences).some((line) => line.includes("Find in transcript")));
      h.terminal.input("\x1b"); h.tui.renderNow(); assert.equal(viewer.handle.isFocused(), true, "closing host search restores viewer without retaining hidden search");
    } finally { unsubscribe(); }
    h.terminal.input("\x1b"); assert.equal(await viewer.promise, "escape"); assert.equal(h.requests, 0);
  } finally { viewer?.close("cleanup"); await h.cleanup(); restore(); }
});

hostTest("viewer seam READY policy: admission plus public focused setter closes before user search/batched input", async () => {
  const restore = capabilities(); const h = await interactive("fullscreen"); let viewer;
  try {
    h.terminal.input("\x1b[102;6u"); h.tui.renderNow();
    assert.ok(h.tui.getScreenLines().map(ui.stripTerminalSequences).some((line) => line.includes("Find in transcript")));
    assert.equal(guardedFocusOverlay(h.tui), undefined);
    h.terminal.input("\x1b"); h.tui.renderNow(); assert.equal(h.tui.hasOverlay(), false);
    h.ctx.ui.setEditorText("protected draft"); h.terminal.input("\x1b[5~"); h.tui.renderNow();
    const top = h.tui.viewportTop, messages = JSON.stringify(h.runtime.session.messages), entries = JSON.stringify(h.ctx.sessionManager.getEntries());
    const closing = [];
    viewer = guardedFocusOverlay(h.tui, (reason) => closing.push({ reason, top: h.tui.viewportTop, editor: h.ctx.ui.getEditorText() }));
    h.tui.renderNow();
    for (const key of ["+", "-", "0", "h", "j", "k", "l"]) { h.terminal.input(key); h.tui.renderNow(); }
    h.terminal.mouse(65, 0, 0); h.terminal.click(2, 3); h.tui.renderNow();
    assert.equal(viewer.closing, false); assert.equal(h.tui.viewportTop, top); assert.equal(h.ctx.ui.getEditorText(), "protected draft");
    assert.deepEqual(viewer.inputs, ["+", "-", "0", "h", "j", "k", "l"]);
    h.terminal.input("\x1b[102;6u");
    assert.equal(viewer.closing, true); assert.equal(viewer.signal.aborted, true);
    assert.deepEqual(closing, [{ reason: "focus-lost", top, editor: "protected draft" }]);
    assert.equal(viewer.disposed, 0, "physical hide/disposal is deferred beyond focus transition");
    assert.equal(guardedFocusOverlay(h.tui), undefined, "cannot reopen during closing lease/upper search");
    for (const char of "TRANSCRIPT") h.terminal.input(char); // same batch, before cleanup microtask
    h.tui.renderNow();
    assert.ok(h.tui.getScreenLines().map(ui.stripTerminalSequences).some((line) => line.includes("TRANSCRIPT")));
    assert.equal(h.tui.getScreenLines().some((line) => line.includes("GUARDED-VIEWER")), false, "logically closed viewer cannot publish a stale frame");
    const beforeClosingInputs = viewer.inputs.length, beforeClosingMouse = viewer.mouse.length;
    await viewer.promise; h.tui.renderNow();
    assert.equal(viewer.disposed, 1); assert.equal(viewer.handle.getBounds(), undefined); assert.equal(h.tui.hasOverlay(), true, "host search remains visible and focused after scoped removal");
    const searchScreen = h.tui.getScreenLines().map(ui.stripTerminalSequences);
    const navY = searchScreen.findIndex((line) => line.includes("↑")); assert.ok(navY >= 0);
    h.terminal.click(searchScreen[navY].indexOf("↑"), navY); h.tui.renderNow();
    assert.equal(viewer.inputs.length, beforeClosingInputs); assert.equal(viewer.mouse.length, beforeClosingMouse);
    viewer.close("again"); assert.equal(viewer.disposed, 1);
    h.terminal.input("\x1b"); h.tui.renderNow(); assert.equal(h.tui.hasOverlay(), false);
    assert.equal(h.ctx.ui.getEditorText(), "protected draft");
    h.terminal.input("X"); assert.equal(h.ctx.ui.getEditorText(), "protected draftX", "search preFocus no longer references disposed viewer");
    assert.equal(JSON.stringify(h.runtime.session.messages), messages); assert.equal(JSON.stringify(h.ctx.sessionManager.getEntries()), entries); assert.equal(h.requests, 0);
  } finally { viewer?.close("cleanup"); await viewer?.promise; await h.cleanup(); restore(); }
});

for (const mode of ["fullscreen", "regular"]) {
  hostTest(`viewer seam READY policy: ${mode} upper dialog focus/preFocus and close races remain owned`, async () => {
    const restore = capabilities(); const h = await interactive(mode); let viewer, closeUpper;
    try {
      h.ctx.ui.setEditorText("dialog draft"); h.tui.renderNow();
      const top = mode === "fullscreen" ? h.tui.viewportTop : undefined;
      viewer = guardedFocusOverlay(h.tui); h.tui.renderNow();
      let upperHandle, upperDisposed = 0; const upperKeys = [];
      const upper = h.ctx.ui.custom((_tui, _theme, _kb, done) => {
        closeUpper = done;
        return { render: () => ["NEW-HOST-DIALOG"], invalidate() {}, handleInput(data) { upperKeys.push(data); if (ui.matchesKey(data, "escape")) done("escape"); }, dispose() { upperDisposed++; } };
      }, { overlay: true, onHandle(handle) {
        upperHandle = handle;
        assert.equal(viewer.closing, true); assert.equal(viewer.signal.aborted, true);
        assert.equal(h.ctx.ui.getEditorText(), "dialog draft");
        if (mode === "fullscreen") assert.equal(h.tui.viewportTop, top);
        h.terminal.input("Q"); viewer.close("shutdown-race"); viewer.close("refresh-race");
      } });
      await until(() => upperHandle); assert.equal(await viewer.promise, "focus-lost"); h.tui.renderNow();
      assert.equal(viewer.disposed, 1); assert.equal(viewer.handle.getBounds(), undefined);
      assert.equal(upperHandle.isFocused(), true); assert.ok(upperHandle.getBounds()); assert.deepEqual(upperKeys, ["Q"]); assert.equal(upperDisposed, 0);
      h.terminal.input("\x1b"); assert.equal(await upper, "escape"); assert.equal(upperDisposed, 1);
      assert.equal(h.tui.hasOverlay(), false); h.terminal.input("X"); assert.equal(h.ctx.ui.getEditorText(), "dialog draftX");
      if (mode === "fullscreen") assert.equal(h.tui.viewportTop, top);
      viewer = guardedFocusOverlay(h.tui); h.tui.renderNow(); h.terminal.input("\x1b");
      const rawUpper = h.tui.showOverlay({ render: () => ["RACE-UPPER"], invalidate() {} });
      assert.equal(await viewer.promise, "escape"); h.tui.renderNow();
      assert.equal(viewer.disposed, 1); assert.ok(rawUpper.getBounds()); assert.equal(rawUpper.isFocused(), true);
      rawUpper.hide(); assert.equal(h.tui.hasOverlay(), false);
      viewer = guardedFocusOverlay(h.tui); h.tui.renderNow();
      const dialog = h.ctx.ui.select("Builtin takes focus", ["one", "two"]);
      assert.equal(viewer.closing, true); assert.equal(viewer.signal.aborted, true);
      assert.equal(await viewer.promise, "focus-lost"); h.tui.renderNow();
      assert.equal(viewer.disposed, 1); assert.equal(viewer.handle.getBounds(), undefined);
      h.terminal.input("\r"); assert.equal(await dialog, "one", "builtin selector retains keyboard ownership after viewer closes");
      h.terminal.input("Y"); assert.equal(h.ctx.ui.getEditorText(), "dialog draftXY");
      assert.equal(h.requests, 0);
    } finally { viewer?.close("cleanup"); await viewer?.promise; closeUpper?.(); await h.cleanup(); restore(); }
  });
}

hostTest("production title: public CJK width fitting keeps Fit/limit and page identity at narrow widths", () => {
  for (const width of [20, 24, 40, 80]) for (const label of ["/absolute/path/".repeat(30) + "chart.pdf — page 2", "図像資料".repeat(100) + ".pdf — page 2"]) {
    const result = viewerTitle(label, { fitPercent: 29700, atZoomLimit: true }, width, ui);
    assert.ok(result.title.endsWith("29700% Fit (limit)")); assert.equal(result.pageHint, "page 2");
    assert.ok(ui.visibleWidth(result.title) <= width);
  }
});

for (const mode of ["fullscreen", "regular"]) {
  hostTest(`production viewer ${mode}: actual public TUI controls, ID chrome, shared native transport and cleanup recovery`, async () => {
    const restore = capabilities();
    const terminal = new CaptureTerminal();
    const tui = mode === "fullscreen" ? new ui.TuiAltScreen(terminal) : new ui.TuiMainScreen(terminal);
    const presentation = createPresentation(), native = createNativeRenderer({ convertToPng: host.convertToPng });
    const attachment = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
    const snapshot = { occurrence: "production-page-1", label: "/very/long/absolute/".repeat(15) + "図像文書".repeat(30) + ".pdf — page 1", attachment };
    let widget, denied = false, draft = "editor draft";
    const ctx = { mode: "tui", ui: { setWidget(_key, factory) { widget = factory(tui); } } };
    presentation.attach(ctx, true);
    const editor = { focused: false, render: () => [draft], invalidate() {}, handleInput(data) { draft += data; } };
    tui.addChild(new ui.Text("transcript\n".repeat(24), 0, 0)); tui.addChild(editor); tui.setFocus(editor);
    const failures = [];
    const viewer = createViewerController({ native, presentation, getContext: () => ctx,
      getSnapshots: () => [snapshot], getCells: ui.getCellDimensions, matchesKey: ui.matchesKey, parseKey: ui.parseKey,
      truncateToWidth: ui.truncateToWidth, visibleWidth: ui.visibleWidth, sanitizeText: sanitizeDisplayText,
      requireCapability: async (_ctx, signal) => { signal?.throwIfAborted(); if (denied) throw new Error("test path denied"); },
      readyPolicy: () => denied ? "test path denied" : undefined,
      style: (_kind, text) => `\x1b[35m${text}\x1b[0m`, notify: (message) => failures.push(message) });
    const before = JSON.stringify(snapshot);
    let done;
    try {
      tui.start(); tui.renderNow();
      if (mode === "fullscreen") { tui.scrollToTop(); tui.renderNow(); }
      const top = mode === "fullscreen" ? tui.viewportTop : undefined;
      terminal.writes.length = 0;
      done = viewer.open();
      await until(() => terminal.output.includes(PLACEHOLDER)); tui.renderNow();
      assert.ok(ui.stripTerminalSequences(terminal.output).includes("100% Fit"), "long CJK/path label must not truncate zoom chrome");
      if (mode === "fullscreen") {
        assert.ok(ui.stripTerminalSequences(tui.getScreenLines()[0]).includes("100% Fit"));
        assert.equal(ui.stripTerminalSequences(tui.getScreenLines()[1]).trim(), "page 1");
      }
      assert.ok(terminal.output.indexOf("a=t") < terminal.output.indexOf(PLACEHOLDER), "production native upload precedes raw-overlay cells");
      const pair = /a=p,U=1,i=(\d+),p=(\d+)/.exec(terminal.output); assert.ok(pair);
      const rgb = (id) => [id >>> 16, (id >>> 8) & 255, id & 255];
      const foreground = `38;2;${rgb(Number(pair[1])).join(";")}`;
      const underline = `58:2::${rgb(Number(pair[2])).join(":")}`;
      assert.ok(terminal.output.includes(foreground) && terminal.output.includes(underline));
      const prototypes = () => [...terminal.output.matchAll(/a=p,U=1,i=(\d+),p=(\d+),c=(\d+),r=(\d+)/g)].map((m) => ({ columns: +m[3], rows: +m[4] }));
      const initialCanvas = prototypes().at(-1);
      assert.equal(ui.matchesKey("+", "+"), false, "installed public matcher regression must be positively reproduced");
      for (const report of ["+", "\x1b[43u", "\x1b[61;2u"]) {
        const before = prototypes().length, canvas = prototypes().at(-1);
        terminal.input(report);
        await until(() => prototypes().length > before); tui.renderNow();
        const grown = prototypes().at(-1);
        assert.ok(grown.columns > canvas.columns || grown.rows > canvas.rows, "raw/Kitty/shift-equals plus report must enlarge private prototype");
        if (mode === "fullscreen") {
          const firstLine = tui.getScreenLines().find((line) => line.includes(PLACEHOLDER)); assert.ok(firstLine);
          const marks = Array.from(firstLine.slice(firstLine.indexOf(PLACEHOLDER)));
          assert.equal(DIACRITICS.indexOf(marks[1]), Math.round((grown.rows - Math.min(10, grown.rows)) / 2));
          assert.equal(DIACRITICS.indexOf(marks[2]), Math.round((grown.columns - Math.min(36, grown.columns)) / 2), "plus preserves source center through explicit window origins");
        }
      }
      terminal.input("0"); await until(() => JSON.stringify(prototypes().at(-1)) === JSON.stringify(initialCanvas));
      for (const report of ["-", "\x1b[45u"]) {
        const before = prototypes().length, canvas = prototypes().at(-1); terminal.input(report);
        await until(() => prototypes().length > before);
        const shrunk = prototypes().at(-1);
        assert.ok(shrunk.columns < canvas.columns || shrunk.rows < canvas.rows, "raw/Kitty minus report must shrink private prototype");
      }
      terminal.input("0"); await until(() => JSON.stringify(prototypes().at(-1)) === JSON.stringify(initialCanvas));
      for (const control of ["+", "-", "0", "h", "j", "k", "l", "Z"]) {
        terminal.input(control); await delay(); tui.renderNow();
        assert.equal(draft, "editor draft");
        if (mode === "fullscreen") {
          assert.equal(tui.viewportTop, top);
          for (const line of tui.getScreenLines().filter((line) => line.includes(PLACEHOLDER))) {
            assert.ok(line.includes(foreground) && line.includes(underline), "body retains foreground/colon underline IDs across all controls and themed chrome");
          }
        }
      }
      terminal.mouse(65, 0, 0); tui.renderNow(); if (mode === "fullscreen") assert.equal(tui.viewportTop, top);
      assert.equal(native.stats(presentation.epoch).transfer.uploadChunks, 1, "zoom/pan do not retransmit shared PNG");
      terminal.columns = 20; terminal.rows = 10; terminal.resize(); await delay(); tui.renderNow();
      assert.equal(draft, "editor draft");
      if (mode === "fullscreen") {
        assert.ok(ui.stripTerminalSequences(tui.getScreenLines()[0]).includes("% Fit"));
        assert.equal(ui.stripTerminalSequences(tui.getScreenLines()[1]).trim(), "page 1");
        assert.ok(tui.getScreenLines().every((line) => ui.visibleWidth(line) <= 20));
      }
      terminal.columns = 14; terminal.resize(); await delay(); tui.renderNow();
      if (mode === "fullscreen") {
        assert.equal(tui.getScreenLines().some((line) => line.includes(PLACEHOLDER)), false);
        assert.ok(tui.getScreenLines().every((line) => ui.visibleWidth(line) <= 14));
        assert.ok(tui.getScreenLines().map(ui.stripTerminalSequences).some((line) => line.includes("Pane too small")));
      }
      terminal.columns = 40; terminal.rows = 16; terminal.resize(); await delay(); tui.renderNow();
      if (mode === "fullscreen") {
        terminal.input("\x1b[102;6u"); await done; tui.renderNow();
        assert.equal(viewer.isOpen, false);
        assert.ok(tui.getScreenLines().map(ui.stripTerminalSequences).some((line) => line.includes("Find in transcript")));
        terminal.input("\x1b"); tui.renderNow();
      } else {
        const upper = tui.showOverlay({ focused: false, render: () => ["unrelated dialog"], invalidate() {} });
        await done; tui.renderNow(); assert.equal(upper.isFocused(), true); upper.hide();
      }
      assert.equal(draft, "editor draft"); assert.equal(native.stats(presentation.epoch).viewer.retirementPending, false);
      terminal.writes.length = 0; done = viewer.open(); await until(() => terminal.output.includes(PLACEHOLDER));
      denied = true; tui.renderNow(); await done;
      assert.equal(native.stats(presentation.epoch).viewer.retirementPending, true, "denied cleanup retains exactly one retirement obligation");
      assert.ok(failures.some((message) => message.includes("cleanup")));
      denied = false; terminal.writes.length = 0; done = viewer.open();
      await until(() => terminal.output.includes(PLACEHOLDER));
      const deleteIndex = terminal.output.indexOf("a=d,d=i"), uploadIndex = terminal.output.indexOf("a=t");
      assert.ok(deleteIndex >= 0 && uploadIndex > deleteIndex, "successful tombstone retirement precedes cached PNG reupload");
      assert.deepEqual([...terminal.output.matchAll(/a=d,d=i,i=(\d+),p=(\d+),q=2/g)].map((m) => m.slice(1)),
        [pair.slice(1)], "recovery retires exactly the old owned private tuple");
      assert.ok(uploadIndex < terminal.output.indexOf(PLACEHOLDER), "post-retirement reupload precedes new ready cells");
      assert.equal([...terminal.output.matchAll(/a=t,f=100/g)].length, 1, "reopen uploads the retired payload exactly once");
      const reopenedPair = /a=p,U=1,i=(\d+),p=(\d+)/.exec(terminal.output);
      assert.deepEqual(reopenedPair?.slice(1), pair.slice(1), "recovery preserves exact image ID and fixed private slot");
      terminal.input("\x1b"); await done; tui.renderNow();
      assert.equal(viewer.isOpen, false); assert.equal(tui.hasOverlay(), false); assert.equal(native.stats(presentation.epoch).viewer.retirementPending, false);
      assert.equal(JSON.stringify(snapshot), before); assert.equal(draft, "editor draft");
      terminal.input("X"); assert.equal(draft, "editor draftX");
    } finally { denied = false; await viewer.dispose(); await done; presentation.disconnect(); widget?.dispose(); tui.stop(); restore(); }
  });
}

for (const mode of ["fullscreen", "regular"]) {
  hostTest(`production close ${mode}: cached guards flush HOST-FRAME before private delete, preserving upper dialog`, async () => {
    const restore = capabilities(); const terminal = new CaptureTerminal();
    const tui = mode === "fullscreen" ? new ui.TuiAltScreen(terminal) : new ui.TuiMainScreen(terminal);
    const presentation = createPresentation(), native = createNativeRenderer({ convertToPng: host.convertToPng });
    let widget, done, upper;
    const ctx = { mode: "tui", ui: { setWidget(_key, factory) { widget = factory(tui); } } };
    presentation.attach(ctx, true); tui.addChild(new ui.Text("HOST-FRAME\n".repeat(24), 0, 0));
    const viewer = createViewerController({ native, presentation, getContext: () => ctx,
      getSnapshots: () => [{ occurrence: "ordering", label: "Ordering", attachment: { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" } }],
      getCells: ui.getCellDimensions, matchesKey: ui.matchesKey, parseKey: ui.parseKey,
      truncateToWidth: ui.truncateToWidth, visibleWidth: ui.visibleWidth, readyPolicy: () => undefined,
      requireCapability: async (_ctx, signal) => signal?.throwIfAborted(), sanitizeText: sanitizeDisplayText });
    try {
      tui.start(); tui.renderNow();
      for (const withUpper of [false, true]) {
        terminal.writes.length = 0; done = viewer.open();
        await until(() => { tui.renderNow(); return terminal.output.includes(PLACEHOLDER); });
        terminal.writes.length = 0;
        if (withUpper) upper = tui.showOverlay({ focused: false, render: () => ["UPPER-HOST-FRAME"], invalidate() {} });
        await viewer.close("programmatic"); await done;
        // Deliberately NO caller renderNow here: close must enforce the barrier.
        const frame = terminal.writes.findIndex((bytes) => bytes.includes("HOST-FRAME") && !bytes.includes("\x1bPtmux;"));
        const deletion = terminal.writes.findIndex((bytes) => bytes.includes("a=d,d=i"));
        assert.ok(frame >= 0 && deletion > frame, "physical host removal frame must precede scoped private deletion even with fully cached guards");
        if (withUpper) {
          assert.equal(upper.isFocused(), true); assert.ok(upper.getBounds());
          assert.ok(terminal.output.includes("UPPER-HOST-FRAME")); upper.hide(); upper = undefined;
        } else assert.equal(tui.hasOverlay(), false);
      }
    } finally { upper?.hide(); await viewer.dispose(); await done; presentation.disconnect(); widget?.dispose(); tui.stop(); restore(); }
  });
}
