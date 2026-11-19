import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export const CLIPBOARD_SHORTCUT_FILE = 'tmux-image-shortcuts.json';
export const DEFAULT_PASTE_SHORTCUT = 'ctrl+v';
export const SHORTCUT_COMMANDS = Object.freeze(['view', 'refresh', 'stats', 'paste', 'configure']);
const defaults = { paste: DEFAULT_PASTE_SHORTCUT };
const MAX_CONFIG_BYTES = 4096;
const modifiers = ['ctrl', 'alt', 'shift', 'super'];
const functionKeys = Array.from({ length: 12 }, (_, i) => `f${i + 1}`);
const typingKeys = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
const modifiedTyping = (parts) => parts.some((part) => part !== 'shift');
const validModifiers = (parts) => new Set(parts).size === parts.length && parts.every((part) => modifiers.includes(part));
const ordered = (parts) => modifiers.filter((part) => parts.includes(part));

export function normalizeShortcut(value) {
  const input = value.trim().toLowerCase();
  if (!input || input === 'off') return 'off';
  const parts = input.split('+');
  const key = parts.pop();
  if (!validModifiers(parts) || !(functionKeys.includes(key) || (typingKeys.includes(key) && modifiedTyping(parts)))) {
    throw new Error('Use F1–F12 or a letter/digit with Ctrl, Alt, or Super (optionally Shift).');
  }
  return [...ordered(parts), key].join('+');
}

// Legacy encodings can make these distinct names indistinguishable.
const aliases = new Map([
  ['tab', ['ctrl+i']], ['enter', ['ctrl+j', 'ctrl+m']], ['return', ['ctrl+j', 'ctrl+m']],
  ['backspace', ['ctrl+h']], ['alt+enter', ['ctrl+alt+m']], ['alt+return', ['ctrl+alt+m']],
]);

function piConflicts(action, effectiveKeys) {
  const reserved = new Set();
  for (const [id, value] of Object.entries(effectiveKeys)) {
    for (const candidate of Array.isArray(value) ? value : [value]) {
      if (typeof candidate !== 'string') continue;
      const raw = candidate.trim().toLowerCase();
      for (const key of aliases.get(raw) || []) reserved.add(key);
      let key;
      try { key = normalizeShortcut(raw); } catch { continue; }
      // Preserve the existing intentional override of Pi's native Ctrl+V paste.
      if (action === 'paste' && id === 'app.clipboard.pasteImage' && key === DEFAULT_PASTE_SHORTCUT) continue;
      reserved.add(key);
    }
  }
  return reserved;
}

function shortcutConflict(key, action, bindings, reserved) {
  const other = SHORTCUT_COMMANDS.find((name) => name !== action && bindings[name] === key);
  if (other) return `Already assigned to /tmux-image ${other}.`;
  if (reserved.has(key)) return 'That shortcut is already assigned to a Pi action. See /hotkeys.';
}

export function validateShortcut(value, action, bindings, effectiveKeys) {
  const key = normalizeShortcut(value);
  if (key === 'off') return key;
  const conflict = shortcutConflict(key, action, bindings, piConflicts(action, effectiveKeys));
  if (conflict) throw new Error(conflict);
  return key;
}

export function suggestShortcuts(input, action, bindings, effectiveKeys) {
  const parts = input.trim().toLowerCase().split('+');
  let prefix = parts.pop();
  if (modifiers.includes(prefix)) { parts.push(prefix); prefix = ''; }
  if (!validModifiers(parts)) return [];
  const reserved = piConflicts(action, effectiveKeys);
  return [...(modifiedTyping(parts) ? typingKeys : []), ...functionKeys]
    .filter((key) => key.startsWith(prefix))
    .map((key) => [...ordered(parts), key].join('+'))
    .filter((key) => !shortcutConflict(key, action, bindings, reserved));
}

function parseBindings(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid shortcut config');
  const bindings = { ...defaults };
  for (const [action, key] of Object.entries(data)) {
    if (!SHORTCUT_COMMANDS.includes(action) || typeof key !== 'string' || normalizeShortcut(key) !== key) {
      throw new Error('Invalid shortcut config entry');
    }
    bindings[action] = key;
  }
  const keys = Object.values(bindings).filter((key) => key !== 'off');
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate tmux-image shortcuts');
  return bindings;
}

export function readShortcuts(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT') return { raw: null, bindings: { ...defaults } };
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
    return { raw, bindings: parseBindings(JSON.parse(raw)) };
  } finally { closeSync(fd); }
}

export function saveShortcuts(path, expected, bindings) {
  parseBindings(bindings);
  const lock = `${path}.lock`;
  const temp = `${path}.${randomUUID()}.tmp`;
  // Serialize cooperating Pi processes, and never overwrite a newer selection.
  const lockFd = openSync(lock, 'wx', 0o600);
  try {
    if (readShortcuts(path).raw !== expected) throw new Error('Shortcut settings changed; run /tmux-image configure again.');
    const tempFd = openSync(temp, 'wx', 0o600);
    try {
      try { writeFileSync(tempFd, JSON.stringify(bindings, null, 2) + '\n'); }
      finally { closeSync(tempFd); }
      renameSync(temp, path);
    } finally {
      try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } finally {
    try { closeSync(lockFd); } finally { unlinkSync(lock); }
  }
}

export function registerImageShortcuts(pi, { path, env = process.env, invoke, promptShortcut,
  hasActiveDialog = () => false, hasPendingImages = () => false } = {}) {
  let controller, tuiSession = false;
  function warn(ctx) {
    ctx.ui.notify(`Could not read ${CLIPBOARD_SHORTCUT_FILE}. Repair or remove it, then run /reload. Slash commands still work.`, 'warning');
  }
  // Register only at factory time, without probing tmux. Pi applies its own
  // runtime conflict handling as well (e.g. after another extension loads).
  let badConfig = false;
  if (env.TMUX && /^%\d+$/.test(env.TMUX_PANE || '')) {
    let bindings;
    try { bindings = path ? readShortcuts(path).bindings : defaults; }
    catch { badConfig = true; }
    for (const [action, key] of Object.entries(bindings || {})) {
      if (key !== 'off') pi.registerShortcut(key, {
        description: `/tmux-image ${action}`,
        handler: (ctx) => { if (tuiSession && ctx.mode === 'tui') return invoke(action, ctx); },
      });
    }
  }
  const abort = () => { controller?.abort(); };
  pi.on('session_start', (_event, ctx) => {
    abort();
    tuiSession = ctx.mode === 'tui';
    if (tuiSession && badConfig) warn(ctx);
  });
  pi.on('session_shutdown', () => { tuiSession = false; abort(); });
  pi.on('session_tree', abort);
  pi.on('agent_start', abort);

  function check(ctx) {
    if (!tuiSession || ctx.mode !== 'tui' || !ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages()) {
      throw new Error('Configure shortcuts from an idle interactive Pi session.');
    }
    if (hasActiveDialog()) throw new Error('Finish any clipboard read and close the current dialog/viewer before configuring shortcuts.');
  }
  return {
    get isConfiguring() { return Boolean(controller); },
    async configure(ctx) {
      if (controller) throw new Error('The shortcut picker is already open.');
      check(ctx);
      const attempt = new AbortController();
      controller = attempt;
      const { signal } = attempt;
      try {
        while (!signal.aborted) {
          check(ctx);
          let saved;
          try { saved = readShortcuts(path); }
          catch { warn(ctx); return; }
          const { bindings } = saved;
          const labels = SHORTCUT_COMMANDS.map((action) => `${action} — ${!bindings[action] || bindings[action] === 'off' ? 'unbound' : bindings[action]}`);
          const choice = await ctx.ui.select('Configure a tmux-image shortcut', labels, { signal });
          if (signal.aborted || choice === undefined) return;
          check(ctx);
          const action = SHORTCUT_COMMANDS[labels.indexOf(choice)];
          if (!action) throw new Error('Unknown shortcut selection.');
          const key = await promptShortcut(ctx, { action, signal,
            suggest: (prefix, effective) => suggestShortcuts(prefix, action, bindings, effective),
            validate: (input, effective) => validateShortcut(input, action, bindings, effective),
          });
          if (signal.aborted) return;
          if (key === undefined) continue; // Escape goes back to the command picker.
          check(ctx);
          if (key === (bindings[action] ?? 'off')) continue;
          if (key === 'off' && action !== 'paste') delete bindings[action];
          else bindings[action] = key;
          saveShortcuts(path, saved.raw, bindings);
          ctx.ui.notify('Shortcut saved. Run /reload to apply it.' +
            (hasPendingImages() ? ' Submit or clear staged PNGs first.' : ''), 'info');
        }
      } finally { if (controller === attempt) controller = undefined; }
    },
  };
}
