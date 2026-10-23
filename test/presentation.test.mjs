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
  return { presentation, events, ctx, get widget() { return widget; } };
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
