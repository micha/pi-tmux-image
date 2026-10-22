import { execFileSync } from "node:child_process";

export const MAX_CHAFA_BYTES = 64 * 1024 * 1024;

// Inner ESC bytes are doubled; an inner terminator must not end the outer DCS.
export function splitChafaOutput(output) {
  const uploads = [];
  const text = output.replace(/\x1bPtmux;(?:[^\x1b]|\x1b\x1b)*\x1b\\/g, (sequence) => {
    uploads.push(sequence);
    return "";
  });
  // Chafa separates rows with cursor-left + IND. Pi must own row positioning.
  const lines = text
    .replace(/\x1b\[\d+D\x1bD/g, "\n")
    .replace(/\x1b\\/g, "")
    .replace(/\x1b\[\?25[hl]/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => line.includes("\u{10eeee}"));
  // Only SGR styling is allowed inside transcript rows. In particular, never
  // let raw uploads or cursor movement escape into Pi's component layout.
  if (lines.some((line) => line.replace(/\x1b\[[0-9;]*m/g, "").includes("\x1b"))) {
    throw new Error("Unexpected terminal control sequence in Chafa placeholder rows");
  }
  return { uploads: uploads.join(""), lines };
}

export function renderPlaceholders(path, columns, rows, run = execFileSync) {
  let output;
  try {
    output = run("chafa", [
      "--format", "kitty", "--passthrough", "tmux", "--probe", "off",
      "--animate", "off", "--polite", "on", "--relative", "off",
      "--size", `${columns}x${rows}`, "--scale", "max", "--", path,
    ], { encoding: "utf8", timeout: 10000, maxBuffer: MAX_CHAFA_BYTES });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Chafa was not found. Install chafa and make it available on PATH.");
    if (error.code === "ENOBUFS") throw new Error("Chafa output exceeded the 64 MiB per-image capture limit.");
    throw error;
  }
  const parsed = splitChafaOutput(output);
  if (!parsed.uploads || !parsed.lines.length) {
    throw new Error("Chafa did not produce tmux uploads and Kitty Unicode placeholders. Check your Chafa version.");
  }
  return { ...parsed, outputBytes: Buffer.byteLength(output, "utf8") };
}
