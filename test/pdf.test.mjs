import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { withPdfPages } from "../src/pdf.mjs";

function renderer(capture, names = ["02", "01"]) {
  return (command, args, options) => {
    assert.equal(command, "pdftoppm");
    assert.deepEqual(args.slice(0, 4), ["-f", "1", "-l", "2"]);
    assert.ok(args.includes("1200"));
    assert.equal(options.timeout, 30000);
    const prefix = args.at(-1);
    capture.dir = dirname(prefix);
    for (const name of names) writeFileSync(`${prefix}-${name}.png`, "fake PNG");
  };
}

test("visits the first two pages in order and removes scratch files", async () => {
  const capture = {};
  const pages = await withPdfPages("/tmp/example with spaces.pdf", async (path, page) => {
    assert.ok(existsSync(path));
    return page;
  }, { run: renderer(capture) });
  assert.deepEqual(pages, [1, 2]);
  assert.ok(!existsSync(capture.dir));
});

test("also handles single-page PDFs", async () => {
  const capture = {};
  assert.deepEqual(await withPdfPages("one.pdf", async (_path, page) => page, { run: renderer(capture, ["1"]) }), [1]);
  assert.ok(!existsSync(capture.dir));
});

test("cleans up after a viewer failure", async () => {
  const capture = {};
  await assert.rejects(() => withPdfPages("example.pdf", async () => {
    throw new Error("viewer failed");
  }, { run: renderer(capture) }), /viewer failed/);
  assert.ok(!existsSync(capture.dir));
});

test("explains missing Poppler and cleans up its temporary directory", async () => {
  let dir;
  await assert.rejects(() => withPdfPages("example.pdf", async () => {}, {
    run(_command, args) {
      dir = dirname(args.at(-1));
      throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
    },
  }), /pdftoppm was not found/);
  assert.ok(!existsSync(dir));
});

test("rejects a renderer that produced no pages", async () => {
  const capture = {};
  await assert.rejects(() => withPdfPages("example.pdf", async () => {}, { run: renderer(capture, []) }), /no pages/);
  assert.ok(!existsSync(capture.dir));
});

test("honors cancellation before invoking subprocesses", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => withPdfPages("example.pdf", async () => {}, {
    signal: controller.signal,
    run() { assert.fail("renderer must not run"); },
  }), { name: "AbortError" });
});

test("honors cancellation between pages and still cleans up", async () => {
  const controller = new AbortController();
  const capture = {};
  let visited = 0;
  await assert.rejects(() => withPdfPages("example.pdf", async () => {
    visited++;
    controller.abort();
  }, { signal: controller.signal, run: renderer(capture) }), { name: "AbortError" });
  assert.equal(visited, 1);
  assert.ok(!existsSync(capture.dir));
});
