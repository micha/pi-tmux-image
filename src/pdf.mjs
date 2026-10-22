import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
