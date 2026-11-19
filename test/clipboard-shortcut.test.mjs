import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CLIPBOARD_SHORTCUT_FILE, readShortcuts, saveShortcuts, suggestShortcuts, validateShortcut } from '../src/clipboard-shortcut.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-image-shortcuts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, CLIPBOARD_SHORTCUT_FILE) };
}

test('clipboard shortcut persistence defaults on missing file, saves atomically and refuses stale or parallel writers', (t) => {
  const { directory, path } = fixture(t);
  const defaults = readShortcuts(path);
  assert.deepEqual(defaults, { raw: null, bindings: { paste: 'ctrl+v' } });
  saveShortcuts(path, defaults.raw, { paste: 'off' });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => saveShortcuts(path, defaults.raw, { paste: 'ctrl+alt+v' }), /settings changed/);
  const saved = readShortcuts(path);
  assert.deepEqual(saved.bindings, { paste: 'off' });
  writeFileSync(`${path}.lock`, 'another writer');
  assert.throws(() => saveShortcuts(path, saved.raw, { view: 'f8' }), { code: 'EEXIST' });
  assert.deepEqual(readShortcuts(path), saved);
  assert.deepEqual(readdirSync(directory).sort(), [CLIPBOARD_SHORTCUT_FILE, `${CLIPBOARD_SHORTCUT_FILE}.lock`]);
  rmSync(`${path}.lock`);
  saveShortcuts(path, saved.raw, { view: 'f8', paste: 'ctrl+alt+v' });
  assert.deepEqual(readShortcuts(path).bindings, { view: 'f8', paste: 'ctrl+alt+v' });
  assert.deepEqual(readdirSync(directory), [CLIPBOARD_SHORTCUT_FILE]);
});

test('clipboard shortcut settings reject invalid, oversized, and symlinked files', (t) => {
  const { directory, path } = fixture(t);
  for (const raw of ['{', 'null', '[]', '{"paste":"shift+c"}', '{"view":"ctrl+v"}', '{"paste":"off","extra":true}', ' '.repeat(4097)]) {
    writeFileSync(path, raw);
    assert.throws(() => readShortcuts(path));
    assert.throws(() => saveShortcuts(path, null, { paste: 'off' }));
  }
  rmSync(path);
  symlinkSync(join(directory, 'missing'), path);
  assert.throws(() => readShortcuts(path));
  assert.deepEqual(readdirSync(directory), [CLIPBOARD_SHORTCUT_FILE]);
});

test('typed bindings and Tab suggestions reject the same Pi and tmux-image conflicts', () => {
  const bindings = { paste: 'ctrl+shift+v', stats: 'ctrl+r' };
  const effective = { 'app.clipboard.pasteImage': 'ctrl+v', 'app.other': ['CTRL+A', 'shift+ctrl+x', 'tab', 'enter', 'backspace', 'alt+return'] };
  for (const key of ['ctrl+a', 'ctrl+i', 'ctrl+j', 'ctrl+m', 'ctrl+h', 'ctrl+alt+m', 'ctrl+shift+x']) {
    assert.throws(() => validateShortcut(key, 'paste', bindings, effective), /Pi action/);
    assert.deepEqual(suggestShortcuts(key, 'paste', bindings, effective), []);
  }
  assert.throws(() => validateShortcut('ctrl+r', 'paste', bindings, effective), /tmux-image stats/);
  assert.deepEqual(suggestShortcuts('ctrl+r', 'paste', bindings, effective), []);
  assert.equal(validateShortcut(' Shift+CTRL+v ', 'paste', bindings, effective), 'ctrl+shift+v');
  assert.equal(validateShortcut('ctrl+v', 'paste', bindings, effective), 'ctrl+v');
  assert.throws(() => validateShortcut('ctrl+v', 'stats', bindings, effective), /Pi action/);
  assert.throws(() => validateShortcut('ctrl+v', 'paste', bindings, { ...effective, 'app.interrupt': 'ctrl+v' }), /Pi action/);
  assert.deepEqual(suggestShortcuts('CTRL+SHIFT+v', 'paste', bindings, effective), ['ctrl+shift+v']);
  assert.deepEqual(suggestShortcuts('f', 'view', bindings, { 'app.other': 'f1' }), ['f2','f3','f4','f5','f6','f7','f8','f9','f10','f11','f12']);
  assert.deepEqual(suggestShortcuts('ctrl+ctrl+', 'view', bindings, effective), []);
  assert.equal(validateShortcut('', 'paste', bindings, effective), 'off');
  assert.throws(() => validateShortcut('v', 'paste', bindings, effective), /F1–F12/);
});
