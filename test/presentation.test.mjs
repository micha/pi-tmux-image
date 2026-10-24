import assert from "node:assert/strict";
import test from "node:test";
import { createPresentation } from "../src/presentation.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const presentation = createPresentation();
  const events = [];
  let widget;
  const tui = {
    terminal: { write(bytes) { events.push(["write", bytes]); } },
    requestRender() { events.push(["repaint"]); },
  };
  const ctx = { mode: "tui", ui: { setWidget(_key, factory) { widget?.dispose(); widget = factory(tui); } } };
  return { presentation, events, ctx, tui, get widget() { return widget; } };
}

test("only interactive tmux attaches a zero-row transport owner", () => {
  const h = harness();
  assert.equal(h.presentation.attach({ mode: "rpc" }, true), false);
  assert.equal(h.presentation.attach({ mode: "json" }, true), false);
  assert.equal(h.presentation.attach({ mode: "print" }, true), false);
  assert.equal(h.presentation.attach(h.ctx, false), false);
  assert.throws(() => h.presentation.write("upload"), /not connected/);
  assert.equal(h.presentation.attach(h.ctx, true), true);
  assert.deepEqual(h.widget.render(10), []);
  h.presentation.write("upload");
  assert.deepEqual(h.events, [["write", "upload"]]);
  h.widget.dispose();
  assert.throws(() => h.presentation.write("upload"), /not connected/);
});

test("nonempty commits revoke trust immediately before write; denied and rows-only commits do not", () => {
  const h = harness(); h.presentation.attach(h.ctx, true);
  const controller = new AbortController(), context = { epoch: h.presentation.epoch, signal: controller.signal };
  const prepared = { uploads: "graphics", isCurrent: () => true,
    onUploadStarted: () => h.events.push(["start"]),
    onUploaded: () => h.events.push(["success"]),
    onUploadFailed: () => h.events.push(["failure"]) };
  assert.equal(h.presentation.commit(prepared, context), true);
  assert.deepEqual(h.events, [["start"], ["write", "graphics"], ["success"]]);
  h.events.length = 0;
  assert.equal(h.presentation.commit({ ...prepared, uploads: "" }, context), true);
  assert.deepEqual(h.events, [["success"]]);
  h.events.length = 0;
  assert.equal(h.presentation.commit({ ...prepared, isCurrent: () => false }, context), false);
  assert.deepEqual(h.events, [["failure"]]);
  h.events.length = 0; controller.abort();
  assert.equal(h.presentation.commit(prepared, context), false);
  assert.deepEqual(h.events, [["failure"]]);
});

test("throwing write and throwing attempt notification fail without successful commit", () => {
  const h = harness(); h.presentation.attach(h.ctx, true);
  const context = { epoch: h.presentation.epoch, signal: new AbortController().signal };
  h.tui.terminal.write = () => { h.events.push(["partial-write"]); throw new Error("partial"); };
  const prepared = { uploads: "graphics", onUploadStarted: () => h.events.push(["start"]),
    onUploaded: () => h.events.push(["success"]), onUploadFailed: () => h.events.push(["failure"]) };
  assert.throws(() => h.presentation.commit(prepared, context), /partial/);
  assert.deepEqual(h.events, [["start"], ["partial-write"], ["failure"]]);
  h.events.length = 0;
  assert.throws(() => h.presentation.commit({ ...prepared, onUploadStarted() { throw new Error("attempt"); } }, context), /attempt/);
  assert.deepEqual(h.events, [["failure"]]);
});

test("async preparation hides cells, uploads before repaint, and reuses geometry across rebuild", async () => {
  const h = harness();
  h.presentation.attach(h.ctx, true);
  let resolve;
  let calls = 0;
  const options = {
    key: "occurrence",
    prepare() { calls++; return new Promise((done) => { resolve = done; }); },
    fallback: () => ["loading"],
  };
  const component = h.presentation.component(options);
  assert.deepEqual(component.render(10), ["loading"]);
  assert.equal(calls, 0, "no converter runs inside render");
  component.render(10);
  await settle();
  assert.equal(calls, 1);
  resolve({ uploads: "wrapped upload", lines: ["cells"] });
  await settle();
  assert.deepEqual(h.events, [["write", "wrapped upload"], ["repaint"]]);
  assert.deepEqual(component.render(10), ["cells"]);
  const rebuilt = h.presentation.component(options);
  assert.deepEqual(rebuilt.render(10), ["cells"]);
  component.invalidate();
  assert.deepEqual(component.render(10), ["cells"]);
  assert.equal(calls, 1);
  assert.deepEqual(component.render(5), ["loading"]);
  await settle();
  assert.equal(calls, 2);
});

test("disconnect cancels stale completion and a new epoch cannot trust residency", async () => {
  const h = harness();
  h.presentation.attach(h.ctx, true);
  const firstEpoch = h.presentation.epoch;
  let done;
  let signal;
  const component = h.presentation.component({
    key: "image",
    prepare(_width, context) { signal = context.signal; return new Promise((resolve) => { done = resolve; }); },
    fallback: () => ["loading"],
  });
  component.render(10);
  await settle();
  const stale = done;
  h.presentation.disconnect();
  h.presentation.disconnect();
  assert.equal(signal.aborted, true);
  h.presentation.attach(h.ctx, true);
  assert.notEqual(h.presentation.epoch, firstEpoch);
  stale({ uploads: "STALE", lines: ["STALE"] });
  await settle();
  assert.deepEqual(h.events, []);
  assert.deepEqual(component.render(10), ["loading"]);
  await settle();
  done({ uploads: "new upload", lines: ["new cells"] });
  await settle();
  assert.deepEqual(component.render(10), ["new cells"]);
  assert.deepEqual(h.events, [["write", "new upload"], ["repaint"]]);
});

test("refresh creates new epoch, clears failures and replays existing components under widget owner", async () => {
  const h = harness();
  h.presentation.attach(h.ctx, true);
  const owner = h.widget, oldEpoch = h.presentation.epoch;
  let calls = 0;
  const component = h.presentation.component({ key: "snapshot", prepare() {
    calls++; if (calls === 1) throw new Error("transient conversion error");
    return { uploads: "replay", lines: ["cells"] };
  }, fallback: (_width, error) => [error?.message || "preparing"] });
  component.render(10); await settle();
  assert.deepEqual(component.render(10), ["transient conversion error"]);
  h.presentation.refresh();
  assert.notEqual(h.presentation.epoch, oldEpoch);
  assert.deepEqual(component.render(10), ["preparing"]);
  await settle();
  assert.deepEqual(component.render(10), ["cells"]);
  assert.equal(calls, 2);
  owner.dispose();
  assert.equal(h.presentation.epoch, undefined, "same widget still owns refreshed connection teardown");
  assert.throws(() => h.presentation.refresh(), /not connected/);
});

test("captured height/cell layout coalesces obsolete preparation without publishing stale cells", async () => {
  const h = harness();
  h.presentation.attach(h.ctx, true);
  let height = 10, cells = 20, calls = 0;
  const finishes = [];
  const component = h.presentation.component({ key: "image",
    layout: (width) => ({ key: `${width}:${height}:${cells}`, width, height, cells }),
    prepare(_width, context, captured) {
      calls++;
      return new Promise((resolve) => { finishes.push({ resolve, context, captured }); });
    }, fallback: () => ["loading"],
  });
  component.render(10);
  height = 5;
  component.render(10); // Before the microtask: only latest captured inputs run.
  await settle();
  assert.equal(calls, 1); assert.equal(finishes[0].captured.height, 5);
  cells = 10;
  component.render(10);
  await settle();
  assert.equal(finishes[0].context.signal.aborted, true);
  let staleReleased = false;
  finishes[0].resolve({ uploads: "STALE", lines: ["STALE"], onUploadFailed() { staleReleased = true; } });
  finishes[1].resolve({ uploads: "CURRENT", lines: ["CURRENT"] });
  await settle();
  assert.equal(staleReleased, true);
  assert.deepEqual(component.render(10), ["CURRENT"]);
  assert.equal(h.events.some((event) => event.includes("STALE")), false);
  assert.equal(calls, 2);
});

test("upload callbacks commit after write; failures and stale completion release reservations", async () => {
  const h = harness();
  h.presentation.attach(h.ctx, true);
  const events = [];
  const component = h.presentation.component({
    key: "commit",
    prepare: () => ({ uploads: "bytes", lines: ["cells"],
      onUploaded() { events.push([...h.events]); }, onUploadFailed() { assert.fail("unexpected failed write"); } }),
    fallback: () => ["loading"],
  });
  component.render(10); await settle();
  assert.deepEqual(events, [[["write", "bytes"]]], "commit precedes ready repaint but follows transport write");
  const failed = h.presentation.component({
    key: "failure",
    prepare: () => ({ uploads: "bytes", lines: ["cells"],
      onUploaded() { assert.fail("failed write cannot commit"); }, onUploadFailed() { events.push("released"); } }),
    fallback: (_width, error) => [error?.message || "loading"],
  });
  h.tui.terminal.write = () => { throw new Error("broken transport"); };
  failed.render(10); await settle();
  assert.equal(events.at(-1), "released");
  assert.deepEqual(failed.render(10), ["broken transport"]);
});

test("failed upload never exposes placeholder rows or retries every frame", async () => {
  const h = harness();
  h.presentation.attach(h.ctx, true);
  let calls = 0;
  const component = h.presentation.component({
    key: "bad",
    prepare() { calls++; throw new Error("conversion failed"); },
    fallback: (_width, error) => [error ? error.message : "loading"],
  });
  component.render(10);
  await settle();
  assert.deepEqual(component.render(10), ["conversion failed"]);
  assert.equal(calls, 1);
  assert.deepEqual(h.events, [["repaint"]]);
});

test("public TUI binding closes before disconnect/refresh and stale widget disposal cannot detach replacement", () => {
  const h = harness(), events = [];
  const stop = h.presentation.bind({
    onConnect(value) { events.push(["connect", value]); },
    onDisconnect(value) {
      events.push(["disconnect", value]);
      assert.equal(h.presentation.commit({ uploads: "STALE", onUploadFailed() {} }, { epoch: value.epoch }), false);
    },
  });
  h.presentation.attach(h.ctx, true);
  assert.equal(h.presentation.connection.tui, h.tui);
  const original = h.widget, first = h.presentation.epoch;
  h.presentation.refresh();
  assert.notEqual(h.presentation.epoch, first);
  assert.deepEqual(events.map(e => e[0]), ["connect", "disconnect", "connect"]);
  original.dispose(); assert.equal(h.presentation.connection, undefined);
  h.presentation.attach(h.ctx, true);
  original.dispose(); assert.ok(h.presentation.connection, "old owner cannot detach newly attached widget");
  stop(); h.presentation.disconnect();
  assert.equal(events.length, 5);
});

test("bounded external viewer commit validates before writing and never publishes cells itself", () => {
  const h = harness(); h.presentation.attach(h.ctx, true);
  const epoch = h.presentation.epoch, events = [];
  let live = true;
  const prepared = { uploads: "wire", lines: ["private cells"], isCurrent: () => live,
    onUploaded() { events.push("success"); }, onUploadFailed() { events.push("failure"); } };
  assert.equal(h.presentation.commit(prepared, { epoch }), true);
  assert.deepEqual(h.events, [["write", "wire"]]); assert.deepEqual(events, ["success"]);
  live = false;
  assert.equal(h.presentation.commit(prepared, { epoch }), false);
  assert.equal(h.events.length, 1);
  assert.equal(h.presentation.commit(prepared, { epoch: Symbol() }), false);
  const controller = new AbortController(); controller.abort(); live = true;
  assert.equal(h.presentation.commit(prepared, { epoch, signal: controller.signal }), false);
  h.tui.terminal.write = () => { throw new Error("write failed"); };
  assert.throws(() => h.presentation.commit(prepared, { epoch }), /write failed/);
  assert.deepEqual(events, ["success", "failure", "failure", "failure", "failure"]);
});

test("invalidated inline replay retries without exposing stale rows or retaining a failed cache", async () => {
  const h = harness(); h.presentation.attach(h.ctx, true);
  let attempts = 0;
  const component = h.presentation.component({ key: "inline",
    prepare() { const n = ++attempts; return { uploads: n === 1 ? "STALE" : "CURRENT", lines: [n === 1 ? "STALE" : "CURRENT"], isCurrent: () => n !== 1 }; },
    fallback: () => ["waiting"],
  });
  component.render(10); await settle(); assert.deepEqual(component.render(10), ["waiting"]);
  await settle(); assert.deepEqual(component.render(10), ["CURRENT"]);
  assert.equal(h.events.filter(e => e[0] === "write").length, 1);
  assert.equal(h.events.some(e => e.includes("STALE")), false);
});

test("binding cleanup faults are explicit but cannot strand transport or other observers", () => {
  const h = harness(); let closed = 0;
  h.presentation.bind({ onConnect() { throw new Error("observer failed"); }, onDisconnect() { throw new Error("cleanup failed"); } });
  h.presentation.bind({ onDisconnect() { closed++; } });
  assert.equal(h.presentation.attach(h.ctx, true), true);
  h.presentation.disconnect();
  assert.equal(h.presentation.bindingErrors, 2); assert.equal(closed, 1);
  assert.equal(h.presentation.connection, undefined);
});
