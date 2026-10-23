import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createPresentation } from "../src/presentation.mjs";

// Optional primary-host test, not a bundled dependency. Set this to the installed
// coding-agent package root. Only public package entry points are imported.
const root = process.env.PI_TEST_HOST_ROOT;
const host = root ? await import(pathToFileURL(join(root, "dist/index.js")).href) : undefined;
const tuiModule = root ? await import(pathToFileURL(join(root, "node_modules/@earendil-works/pi-tui/dist/index.js")).href) : undefined;
const hostTest = (name, fn) => test(name, { skip: !root && "set PI_TEST_HOST_ROOT to run against installed Pi" }, fn);
const PLACEHOLDER = "\u{10eeee}";
const row = `\x1b[38;2;0;0;42m${PLACEHOLDER}\u0305\u0305\x1b[0m`;
const wrap = (apc) => `\x1bPtmux;${apc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const uploads = wrap(`\x1b_Ga=t,f=100,i=42,q=2;${png}\x1b\\`) + wrap("\x1b_Ga=p,i=42,p=1,U=1,c=1,r=1,q=2;\x1b\\");

class CaptureTerminal {
  columns = 20;
  rows = 8;
  kittyProtocolActive = false;
  writes = [];
  start(_input, resize) { this.resize = resize; }
  stop() {}
  async drainInput() {}
  write(bytes) { this.writes.push(bytes); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  get output() { return this.writes.join(""); }
}
async function until(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "host repaint did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function setup(TuiClass, images = null) {
  tuiModule.setCapabilities({ images, trueColor: true, hyperlinks: false });
  const terminal = new CaptureTerminal();
  const tui = new TuiClass(terminal);
  const presentation = createPresentation();
  let widget;
  const ctx = { mode: "tui", ui: { setWidget(_key, factory) { widget = factory(tui); } } };
  presentation.attach(ctx, true);
  return { terminal, tui, presentation, cleanup() { presentation.disconnect(); widget.dispose(); tui.stop(); } };
}

for (const mode of ["regular", "fullscreen"]) {
  hostTest(`actual Pi ${mode}: async upload precedes cells, repaint, rebuild and width resize`, async () => {
    const h = setup(mode === "regular" ? tuiModule.TuiMainScreen : tuiModule.TuiAltScreen);
    let finish;
    let preparations = 0;
    const message = { role: "custom", customType: "seam-test", content: [{ type: "image", mimeType: "image/png", data: png }], display: true, timestamp: 1 };
    const original = JSON.stringify(message);
    const renderer = () => h.presentation.component({
      key: "immutable-occurrence",
      prepare() { preparations++; return new Promise((resolve) => { finish = resolve; }); },
      fallback: () => ["Preparing image"],
    });
    const component = new host.CustomMessageComponent(message, renderer);
    h.tui.addChild(component);
    try {
      h.tui.start();
      h.tui.renderNow();
      await until(() => preparations === 1);
      assert.equal(h.terminal.output.includes(PLACEHOLDER), false);
      assert.equal(h.terminal.output.includes(uploads), false);
      finish({ uploads, lines: [row] });
      await until(() => h.terminal.output.includes(PLACEHOLDER));
      assert.ok(h.terminal.output.indexOf(uploads) < h.terminal.output.indexOf(PLACEHOLDER));
      assert.equal(h.terminal.output.split(uploads).length - 1, 1);
      assert.ok(h.terminal.output.includes(row), "Pi preserves the ID foreground and combining marks");
      component.invalidate(); // Actual Pi rebuild invokes the renderer again.
      h.tui.requestRender();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(preparations, 1);
      assert.equal(h.terminal.output.split(uploads).length - 1, 1);
      h.terminal.writes.length = 0;
      h.terminal.columns = 10;
      h.terminal.resize();
      await until(() => preparations === 2);
      assert.equal(h.terminal.output.includes(PLACEHOLDER), false);
      finish({ uploads, lines: [row] });
      await until(() => h.terminal.output.includes(PLACEHOLDER));
      assert.ok(h.terminal.output.indexOf(uploads) < h.terminal.output.indexOf(PLACEHOLDER));
      assert.equal(JSON.stringify(message), original, "repaint does not mutate content or add attachments");
      assert.equal(h.tui.children.length, 1);
    } finally { h.cleanup(); }
  });
}

hostTest("actual Pi width/slicing: SGR placeholders fit; nested tmux prefix is unsafe text", () => {
  const { visibleWidth, sliceByColumn, stripTerminalSequences } = tuiModule;
  assert.equal(visibleWidth(row), 1);
  assert.ok(sliceByColumn(row, 0, 1, true).includes(PLACEHOLDER));
  const prefixed = uploads + row;
  // Installed Pi recognizes the nested APC as an image line but its normal text
  // utilities do not parse the enclosing DCS. Do NOT use OMP's line-prefix seam.
  assert.notEqual(visibleWidth(prefixed), 1);
  assert.notEqual(stripTerminalSequences(prefixed), stripTerminalSequences(row));
  assert.equal(sliceByColumn(prefixed, 0, 1, true).includes(PLACEHOLDER), false);
});

hostTest("actual Pi fullscreen forced-native risk: height redraw globally deletes untracked uploads", async () => {
  const h = setup(tuiModule.TuiAltScreen, "kitty");
  const component = h.presentation.component({ key: "image", prepare: () => ({ uploads, lines: [row] }), fallback: () => ["Preparing"] });
  h.tui.addChild(component);
  try {
    h.tui.start();
    await until(() => h.terminal.output.includes(PLACEHOLDER));
    h.terminal.writes.length = 0;
    h.terminal.rows++;
    h.terminal.resize();
    await until(() => h.terminal.output.includes(PLACEHOLDER));
    const deletion = tuiModule.deleteAllKittyImages();
    assert.ok(h.terminal.output.includes(deletion));
    assert.ok(h.terminal.output.indexOf(deletion) < h.terminal.output.indexOf(PLACEHOLDER));
    assert.equal(h.terminal.output.includes(uploads), false, "extension cannot observe the host's graphics reset");
  } finally { h.cleanup(); }
});

hostTest("actual SDK package loading: reload/new/resume/quit lifecycle and non-TUI command guard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-image-seam-host-"));
  const events = [];
  const notifications = [];
  let runtime;
  const uiContext = {
    notify(message) { notifications.push(message); },
    setWidget() { assert.fail("non-TUI session must not attach terminal transport"); },
  };
  try {
    const modelRuntime = await host.ModelRuntime.create({
      authPath: join(directory, "auth.json"), modelsPath: null,
      modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await host.createAgentSessionServices({
        cwd, agentDir, modelRuntime,
        settingsManager: host.SettingsManager.inMemory({ images: { blockImages: true } }),
        resourceLoaderOptions: {
          noExtensions: true, noSkills: true, noPromptTemplates: true,
          noThemes: true, noContextFiles: true,
          additionalExtensionPaths: [new URL("../extensions/index.ts", import.meta.url).pathname],
          extensionFactories: [(pi) => {
            pi.on("session_start", (event) => { events.push([event.type, event.reason]); });
            pi.on("session_shutdown", (event) => { events.push([event.type, event.reason]); });
          }],
        },
      });
      const created = await host.createAgentSessionFromServices({
        services, sessionManager, sessionStartEvent,
        model: modelRuntime.getModels()[0], noTools: "all",
      });
      assert.equal(created.extensionsResult.errors.length, 0);
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const manager = host.SessionManager.create(directory, join(directory, "sessions"));
    manager.appendMessage({ role: "user", content: "Stored fixture, never submitted to a model", timestamp: 1 });
    const originalFile = manager.getSessionFile();
    runtime = await host.createAgentSessionRuntime(createRuntime, {
      cwd: directory, agentDir: join(directory, "agent"), sessionManager: manager,
    });
    const bind = (session) => session.bindExtensions({ mode: "json", uiContext });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    // An extension slash command, not a model prompt. Its guard runs before read
    // or conversion. No compatible model/credential/network call is required.
    await runtime.session.prompt("/tmux-image absent.png");
    assert.ok(notifications.some((text) => text.includes("requires interactive Pi inside tmux")));
    assert.equal(runtime.session.messages.length, 1);
    await runtime.session.reload();
    await runtime.newSession();
    await runtime.switchSession(originalFile);
    assert.equal(runtime.session.messages.length, 1);
    await runtime.dispose();
    runtime = undefined;
    assert.deepEqual(events, [
      ["session_start", "startup"], ["session_shutdown", "reload"],
      ["session_start", "reload"], ["session_shutdown", "new"],
      ["session_start", "new"], ["session_shutdown", "resume"],
      ["session_start", "resume"], ["session_shutdown", "quit"],
    ]);
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

hostTest("actual-host seam never touches terminal in print/JSON/RPC or outside tmux", () => {
  const terminal = new CaptureTerminal();
  const presentation = createPresentation();
  for (const mode of ["print", "json", "rpc"]) {
    const ctx = { mode, ui: { setWidget() { assert.fail("terminal factory reached"); } } };
    assert.equal(presentation.attach(ctx, true), false);
  }
  assert.equal(presentation.attach({ mode: "tui" }, false), false);
  assert.throws(() => presentation.write(uploads), /not connected/);
  assert.equal(terminal.output, "");
});
