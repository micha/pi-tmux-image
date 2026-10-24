import { execFileSync, spawn as spawnChild } from "node:child_process";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// PNGs exist only during the callback. The viewer stores normal image data and
// placeholder rows in the Pi session, never a dependency on these scratch files.
export async function withPdfPages(path, visit, { run = execFileSync, signal } = {}) {
  signal?.throwIfAborted();
  const dir = mkdtempSync(join(tmpdir(), "pi-tmux-image-"));
  try {
    try {
      run("pdftoppm", [
        "-f", "1", "-l", "2", "-png", "-scale-to", "1200", path, join(dir, "page"),
      ], { timeout: 30000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error("pdftoppm was not found. Install the Poppler command-line tools and make pdftoppm available on PATH.");
      }
      throw error;
    }
    const files = readdirSync(dir).filter((name) => /^page-\d+\.png$/.test(name)).sort();
    if (!files.length) throw new Error("PDF renderer produced no pages");
    const pages = [];
    for (const name of files) {
      signal?.throwIfAborted();
      const page = Number(/^page-(\d+)\.png$/.exec(name)[1]);
      pages.push(await visit(join(dir, name), page));
    }
    return pages;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Bounded PATH child. Rejection waits for close, not merely exit/error. */
export function runPdfCommand(file, args, {
  signal, timeoutMs = 30000, maxOutputBytes = 65536, env, spawn = spawnChild,
} = {}) {
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error("Invalid PDF subprocess bounds");
  return new Promise((resolveResult, reject) => {
    let child, timer, failure, bytes = 0;
    const stdout = [], stderr = [];
    const stop = (error) => {
      if (failure) return;
      failure = error;
      child?.kill("SIGKILL");
    };
    const abort = () => stop(Object.assign(new Error("PDF operation cancelled"), { name: "AbortError" }));
    try {
      child = spawn(file, args, { shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env, LC_ALL: "C", LANG: "C" } });
    } catch {
      reject(new Error("Could not start PDF subprocess"));
      return;
    }
    const collect = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop(new Error("PDF subprocess output limit exceeded"));
      else if (!failure) chunks.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => {
      stop(new Error(error.code === "ENOENT"
        ? `${file} was not found. Install Poppler and make pdfinfo and pdftoppm available on PATH.`
        : "PDF subprocess failed to start"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${file} could not process the PDF (invalid, unreadable or password-protected document)`));
      else resolveResult({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
    timer = setTimeout(() => stop(new Error("PDF subprocess timed out")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function readPdfPageCount(path, { run = runPdfCommand, signal, ...bounds } = {}) {
  signal?.throwIfAborted();
  const { stdout } = await run("pdfinfo", [resolve(path)], { ...bounds, signal });
  signal?.throwIfAborted();
  const matches = [...stdout.matchAll(/^Pages:[ \t]+([1-9][0-9]*)[ \t]*\r?$/gm)];
  const count = matches.length === 1 ? Number(matches[0][1]) : NaN;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid PDF page count");
  return count;
}

/** Exactly one derived page, acquired before private scratch is removed. */
export async function withPdfPage(path, page, visit, {
  run = runPdfCommand, signal, tempRoot = tmpdir(), ...bounds
} = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid PDF page number");
  const dir = await mkdtemp(join(tempRoot, "pi-tmux-pdf-page-"));
  try {
    await chmod(dir, 0o700);
    await run("pdftoppm", ["-f", String(page), "-l", String(page), "-singlefile",
      "-png", "-scale-to", "1200", resolve(path), join(dir, "page")], { ...bounds, signal });
    signal?.throwIfAborted();
    const png = join(dir, "page.png");
    try { await chmod(png, 0o600); }
    catch { throw new Error("PDF renderer produced no readable page"); }
    signal?.throwIfAborted();
    return await visit(png, page);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
