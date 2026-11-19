import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export const CLIPBOARD_SHORTCUT_FILE = 'tmux-image-shortcuts.json';
export const DEFAULT_PASTE_SHORTCUT = 'ctrl+v';
export const PASTE_SHORTCUT_CHOICES = Object.freeze([DEFAULT_PASTE_SHORTCUT, 'ctrl+shift+v', 'ctrl+alt+v', 'off']);
const MAX_CONFIG_BYTES = 4096;

export function readPasteShortcut(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return { raw: null, paste: DEFAULT_PASTE_SHORTCUT };
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES) throw new Error('Expected a small regular shortcut file');
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_CONFIG_BYTES) throw new Error('Shortcut file is too large');
    const raw = bytes.toString('utf8', 0, length);
    const data = JSON.parse(raw);
    if (!data || Object.keys(data).length !== 1 || !PASTE_SHORTCUT_CHOICES.includes(data.paste)) throw new Error('Invalid paste shortcut');
    return { raw, paste: data.paste };
  } finally { closeSync(fd); }
}

export function savePasteShortcut(path, expected, paste) {
  if (!PASTE_SHORTCUT_CHOICES.includes(paste)) throw new Error('Invalid paste shortcut');
  const lock = `${path}.lock`;
  const temp = `${path}.${randomUUID()}.tmp`;
  // Serialize cooperating Pi processes, and never overwrite a newer selection.
  const lockFd = openSync(lock, 'wx', 0o600);
  try {
    if (readPasteShortcut(path).raw !== expected) throw new Error('Shortcut settings changed; run /tmux-image configure again.');
    const tempFd = openSync(temp, 'wx', 0o600);
    try {
      try { writeFileSync(tempFd, JSON.stringify({ paste }, null, 2) + '\n'); }
      finally { closeSync(tempFd); }
      renameSync(temp, path);
    } finally {
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } finally {
    try { closeSync(lockFd); } finally { unlinkSync(lock); }
  }
}
