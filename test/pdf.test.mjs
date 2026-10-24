import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import test from "node:test";
import { withPdfPages, runPdfCommand, readPdfPageCount, withPdfPage } from "../src/pdf.mjs";

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

 test("strict page counts and exact single-page arguments with private scratch cleanup", async () => {
  for (const stdout of ["", "Pages: 0\n", "Pages: -1\n", "Pages: 01\n", "Pages: 1.5\n", "Pages: 1 extra\n",
    "Pages: 9007199254740992\n", "Other Pages: 2\n", "Pages: 1\nPages: 2\n"]) {
    await assert.rejects(readPdfPageCount("example.pdf", { run: async () => ({ stdout }) }), /page count/);
  }
  assert.equal(await readPdfPageCount("example.pdf", { run: async (file, args) => {
    assert.equal(file, "pdfinfo"); assert.ok(args[0].endsWith("/example.pdf")); return { stdout: "Pages:\t3\r\n" };
  } }), 3);
  let dir;
  const result = await withPdfPage("example.pdf", 3, async (path, page) => {
    assert.equal(page, 3); assert.equal(path, join(dir, "page.png")); return "acquired";
  }, { run: async (file, args) => {
    assert.equal(file, "pdftoppm");
    assert.deepEqual(args.slice(0, 8), ["-f", "3", "-l", "3", "-singlefile", "-png", "-scale-to", "1200"]);
    dir = dirname(args.at(-1));
    await writeFile(`${args.at(-1)}.png`, "test PNG");
  } });
  assert.equal(result, "acquired"); assert.equal(existsSync(dir), false);
  await assert.rejects(withPdfPage("example.pdf", 0, () => {}), /page number/);
});

 test("real subprocess missing PATH, timeout, combined-output limit, cancellation and locale are bounded", async () => {
  for (const file of ["pdfinfo", "pdftoppm"]) {
    await assert.rejects(runPdfCommand(file, [], { env: { PATH: "/nonexistent-pdf-test-path" } }), /was not found.*Poppler/);
  }
  await assert.rejects(runPdfCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 10 }), /timed out/);
  await assert.rejects(runPdfCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(800));process.stderr.write('y'.repeat(800));setInterval(()=>{},1000)"],
    { maxOutputBytes: 1024 }), /output limit/);
  const controller = new AbortController();
  const request = runPdfCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
  controller.abort(); await assert.rejects(request, { name: "AbortError" });
  await assert.rejects(runPdfCommand(process.execPath, ["-e", "process.exit(2)"]), /could not process/);
  const result = await runPdfCommand(process.execPath, ["-e", "console.log(process.env.LC_ALL,process.env.LANG)"], { env: { LC_ALL: "invalid", LANG: "invalid" } });
  assert.equal(result.stdout.trim(), "C C");
  const preabort = new AbortController(); preabort.abort();
  assert.throws(() => runPdfCommand("pdfinfo", [], { signal: preabort.signal, spawn() { assert.fail("no spawn"); } }), { name: "AbortError" });
});

 test("actual inherited pipe close drains after parent exit; page scratch survives child cancellation until actual close", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-child-test-"));
  try {
    const marker = join(root, "drained");
    const grandchild = `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'closed');console.log('drained')},80)`;
    const parent = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore',1,2]}).unref()`;
    const output = await runPdfCommand(process.execPath, ["-e", parent]);
    assert.match(output.stdout, /drained/); assert.equal((await readFile(marker)).toString(), "closed");
    let dir;
    const controller = new AbortController();
    const request = withPdfPage("example.pdf", 2, () => assert.fail("no acquisition"), {
      tempRoot: root, signal: controller.signal,
      async run(_file, args, options) {
        dir = dirname(args.at(-1));
        const actual = runPdfCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], options);
        controller.abort();
        try { await actual; } finally { assert.equal(existsSync(dir), true); }
      },
    });
    await assert.rejects(request, { name: "AbortError" });
    assert.equal(existsSync(dir), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function centerRgb(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[24], 8); assert.equal(png[25], 2); // actual RGB8 Poppler output
  const compressed = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed)), stride = width * 3;
  let previous = Buffer.alloc(stride), position = 0;
  for (let row = 0; row <= Math.floor(height / 2); row++) {
    const filter = raw[position++], decoded = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? decoded[i - 3] : 0, up = previous[i], corner = i >= 3 ? previous[i - 3] : 0;
      const p = left + up - corner;
      const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
      const predictor = [0, left, up, Math.floor((left + up) / 2), pa <= pb && pa <= pc ? left : pb <= pc ? up : corner][filter];
      assert.notEqual(predictor, undefined);
      decoded[i] = (raw[position++] + predictor) & 255;
    }
    previous = decoded;
  }
  return [...previous.subarray(Math.floor(width / 2) * 3, Math.floor(width / 2) * 3 + 3)];
}

function labelledPdf(pageCount = 3) {
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`];
  for (const [index, [width, height, rotation, rgb]] of [[600, 900, 0, "1 0 0"], [1000, 500, 0, "0 1 0"], [400, 800, 90, "0 0 1"]].slice(0, pageCount).entries()) {
    const content = `${rgb} rg 0 0 ${width} ${height} re f`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotation} /Contents ${4 + index * 2} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  let output = "%PDF-1.4\n", offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(output + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

 test("real Poppler counts, single-page identity and rotated dimensions when available", async (t) => {
  try { execFileSync("pdfinfo", ["-v"], { stdio: "ignore" }); execFileSync("pdftoppm", ["-v"], { stdio: "ignore" }); }
  catch { t.skip("Poppler not available on PATH"); return; }
  const root = await mkdtemp(join(tmpdir(), "pdf-real-test-"));
  try {
    const path = join(root, "source.pdf");
    for (const count of [1, 2, 3]) {
      await writeFile(path, labelledPdf(count), { mode: 0o600 });
      assert.equal(await readPdfPageCount(path), count);
    }
    const pages = [];
    for (let page = 1; page <= 3; page++) {
      pages.push(await withPdfPage(path, page, async (png) => {
        assert.deepEqual(await readdir(dirname(png)), ["page.png"]);
        return readFile(png);
      }, { tempRoot: root }));
    }
    const sizes = pages.map((png) => [png.readUInt32BE(16), png.readUInt32BE(20)]);
    assert.deepEqual(sizes[0], [800, 1200]);
    assert.equal(sizes[1][0], 1200); assert.ok(Math.abs(sizes[1][1] - 600) <= 1);
    assert.deepEqual(sizes[2], [1200, 600]);
    assert.equal(new Set(pages.map((png) => png.toString("base64"))).size, 3);
    assert.deepEqual(pages.map(centerRgb), [[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    assert.deepEqual(await readdir(root), ["source.pdf"]);
    await writeFile(path, "invalid PDF bytes");
    await assert.rejects(readPdfPageCount(path), /could not process/);
    await assert.rejects(withPdfPage(path, 1, () => assert.fail("no acquisition"), { tempRoot: root }), /could not process/);
    assert.deepEqual(await readdir(root), ["source.pdf"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
