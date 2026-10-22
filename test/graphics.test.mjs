import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CHAFA_BYTES, renderPlaceholders, splitChafaOutput } from "../src/graphics.mjs";

const ESC = "\x1b";
const cell = "\u{10eeee}\u0305\u0305";
const color = `${ESC}[38;5;7m`;
const wrap = (text) => `${ESC}Ptmux;${text.replaceAll(ESC, ESC + ESC)}${ESC}\\`;
const upload = wrap(`${ESC}_Ga=T,U=1,i=7,m=0;YWJj${ESC}\\`);
const output = `${ESC}[?25l${upload}${ESC}\\${color}${cell}${ESC}[1D${ESC}D${color}${cell}${ESC}[39m\n${ESC}[?25h`;

test("separates complete uploads, including escaped inner terminators", () => {
  const parsed = splitChafaOutput(output);
  assert.equal(parsed.uploads, upload);
  assert.deepEqual(parsed.lines, [`${color}${cell}`, `${color}${cell}${ESC}[39m`]);
});

test("preserves chunked uploads and their ordering", () => {
  const continuation = wrap(`${ESC}_Gm=0;ZGVm${ESC}\\`);
  assert.equal(splitChafaOutput(upload + continuation + color + cell).uploads, upload + continuation);
});

test("removes cursor movement but preserves image-ID colors on every row", () => {
  for (const line of splitChafaOutput(output).lines) {
    assert.ok(line.startsWith(color));
    assert.ok(!line.replace(/\x1b\[[0-9;]*m/g, "").includes(ESC));
  }
});

test("rejects unexpected terminal controls in placeholder rows", () => {
  assert.throws(() => splitChafaOutput(`${color}${cell}${ESC}[2J`), /Unexpected terminal/);
});

test("invokes Chafa without a shell, using virtual tmux graphics and bounded capture", () => {
  const path = "/tmp/image with spaces;not-a-command.png";
  let called = false;
  const rendered = renderPlaceholders(path, 40, 20, (command, args, options) => {
    called = true;
    assert.equal(command, "chafa");
    assert.deepEqual(args.slice(-2), ["--", path]);
    assert.ok(args.includes("tmux"));
    assert.ok(args.includes("40x20"));
    assert.equal(options.maxBuffer, 64 * 1024 * 1024);
    assert.equal(options.timeout, 10000);
    return output;
  });
  assert.ok(called);
  assert.equal(rendered.outputBytes, Buffer.byteLength(output));
  assert.equal(MAX_CHAFA_BYTES, 64 * 1024 * 1024);
});

test("explains a missing Chafa executable", () => {
  assert.throws(() => renderPlaceholders("image.png", 20, 10, () => {
    throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
  }), /Chafa was not found/);
});

test("explains the per-image output limit", () => {
  assert.throws(() => renderPlaceholders("image.png", 20, 10, () => {
    throw Object.assign(new Error("overflow"), { code: "ENOBUFS" });
  }), /64 MiB/);
});

test("does not mistake symbol output for a Kitty image", () => {
  assert.throws(() => renderPlaceholders("image.png", 20, 10, () => "ASCII art"), /Unicode placeholders/);
});
