import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CLIPBOARD_SHORTCUT_FILE, readPasteShortcut, savePasteShortcut } from '../src/clipboard-shortcut.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-image-shortcuts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, CLIPBOARD_SHORTCUT_FILE) };
}

test('clipboard shortcut persistence defaults on missing file, saves atomically and refuses stale or parallel writers', (t) => {
  const { directory, path } = fixture(t);
  const defaults = readPasteShortcut(path);
  assert.deepEqual(defaults, { raw: null, paste: 'ctrl+v' });
  savePasteShortcut(path, defaults.raw, 'off');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => savePasteShortcut(path, defaults.raw, 'ctrl+alt+v'), /settings changed/);
  const saved = readPasteShortcut(path);
  assert.equal(saved.paste, 'off');
  writeFileSync(`${path}.lock`, 'another writer');
  assert.throws(() => savePasteShortcut(path, saved.raw, 'ctrl+alt+v'), { code: 'EEXIST' });
  assert.deepEqual(readPasteShortcut(path), saved);
  assert.deepEqual(readdirSync(directory).sort(), [CLIPBOARD_SHORTCUT_FILE, `${CLIPBOARD_SHORTCUT_FILE}.lock`]);
  rmSync(`${path}.lock`);
  savePasteShortcut(path, saved.raw, 'ctrl+alt+v');
  assert.equal(readPasteShortcut(path).paste, 'ctrl+alt+v');
  assert.deepEqual(readdirSync(directory), [CLIPBOARD_SHORTCUT_FILE]);
});

test('clipboard shortcut settings reject invalid, oversized, and symlinked files', (t) => {
  const { directory, path } = fixture(t);
  for (const raw of ['{', 'null', '[]', '{}', '{"paste":"ctrl+c"}', '{"paste":"off","extra":true}', ' '.repeat(4097)]) {
    writeFileSync(path, raw);
    assert.throws(() => readPasteShortcut(path));
    assert.throws(() => savePasteShortcut(path, null, 'off'));
  }
  rmSync(path);
  symlinkSync(join(directory, 'missing'), path);
  assert.throws(() => readPasteShortcut(path));
  assert.deepEqual(readdirSync(directory), [CLIPBOARD_SHORTCUT_FILE]);
});
