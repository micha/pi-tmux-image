// Synthetic subprocess worker: owns only a private pane and fake outer PTY.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const [directory, hostRoot, format] = process.argv.slice(2);
const entry = join(hostRoot, 'dist/index.js');
const host = await import(pathToFileURL(entry).href);
const tuiModule = await import(pathToFileURL(createRequire(entry).resolve('@earendil-works/pi-tui')).href);
process.env.PATH = `${join(directory, 'bin')}:${process.env.PATH}`;
process.env.PI_TMUX_IMAGE_PASTE_SHORTCUT = 'ctrl+v';
const keybindings = new tuiModule.KeybindingsManager({ ...tuiModule.TUI_KEYBINDINGS,
  'app.clipboard.pasteImage': { defaultKeys: 'ctrl+v' },
}, JSON.parse(await readFile(join(directory, 'agent/keybindings.json'), 'utf8')));
const terminal = new tuiModule.ProcessTerminal();
const tui = new tuiModule.TuiMainScreen(terminal);
let editorEvents = 0, altStarts = 0, altEnds = 0, requests = 0, session, shortcutWork, activations = 0, submissions = 0, nativePastes = 0;
class ObservedEditor extends host.CustomEditor {
  handleInput(data) { editorEvents++; super.handleInput(data); }
}
const editor = new ObservedEditor(tui, { borderColor: (s) => s, selectList: {} }, keybindings);
editor.onSubmit = () => { submissions++; };
editor.onPasteImage = () => { nativePastes++; }; // No physical clipboard helper.
editor.setText('private synthetic draft sentinel');
tui.addChild(editor); tui.setFocus(editor);
const beginMarker = format === 'csi-u' ? '\x1b[93;3u' : '\x1b[27;3;93~';
const endMarker = format === 'csi-u' ? '\x1b[92;3u' : '\x1b[27;3;92~';
tui.addInputListener((data) => {
  if (data === beginMarker) { assert.equal(tuiModule.parseKey(data), 'alt+]'); altStarts++; }
  if (data === endMarker) { assert.equal(tuiModule.parseKey(data), 'alt+\\'); altEnds++; }
});
const widgets = new Map(), notices = [];
const uiContext = {
  confirm: async () => true, notify: (message) => notices.push(message),
  onTerminalInput: (handler) => tui.addInputListener(handler),
  setWidget(key, content) {
    const old = widgets.get(key); old?.dispose?.(); if (old) tui.removeChild(old);
    if (typeof content === 'function') { const value = content(tui); widgets.set(key, value); tui.addChild(value); }
    else if (content) widgets.set(key, { render: () => content, invalidate() {} });
    else widgets.delete(key);
  },
};
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'private worker event deadline'); await delay(5); }
}
const model = { id: 'no-network', name: 'No network', api: 'offline', provider: 'offline', input: ['text','image'], reasoning: false, contextWindow: 10000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const modelRuntime = {
  getModel: () => model, getPhysicalModel: () => model, getModels: () => [model], getAvailableSnapshot: () => [model], getError: () => undefined,
  hasConfiguredAuth: () => true, isUsingOAuth: () => false, isUsingSubscription: () => false, getAuth: async () => ({ apiKey: 'offline' }),
  streamSimple() { requests++; throw new Error('No model turn is authorized by this synthetic test'); },
};
let result;
try {
  const cwd = join(directory, 'workspace'), agentDir = join(directory, 'agent');
  const settings = host.SettingsManager.create(cwd, agentDir);
  const loader = new host.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
    additionalExtensionPaths: [join(directory, 'package/extensions/tmux-image.ts')] });
  await loader.reload(); assert.equal(loader.getExtensions().errors.length, 0, 'fresh copied extension loads');
  settings.applyOverrides({ images: { blockImages: true }, terminal: { showImages: false, images: false }, cacheWarming: 'off', compaction: { enabled: false } });
  ({ session } = await host.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: host.SessionManager.inMemory(cwd), model, modelRuntime, noTools: 'all' }));
  tui.start();
  await session.bindExtensions({ mode: 'tui', uiContext });
  // Actual ProcessTerminal negotiates with private tmux, not a fake input buffer.
  await until(() => terminal.modifyOtherKeysActive);
  let triggered;
  const start = new Promise((resolve) => { triggered = resolve; });
  const shortcuts = session.extensionRunner.getShortcuts(keybindings.getResolvedBindings());
  assert.equal(shortcuts.size, 1);
  editor.onExtensionShortcut = (data) => {
    for (const [key, shortcut] of shortcuts) if (tuiModule.matchesKey(data, key)) {
      activations++; shortcutWork = Promise.resolve(shortcut.handler(session.extensionRunner.createContext()));
      triggered(); return true;
    }
    return false;
  };
  const before = editorEvents, original = editor.getText();
  terminal.write('CLIPBOARD_PRIVATE_WORKER_READY'); await start; await shortcutWork;
  assert.equal(activations, 1, 'actual outer-PTY Ctrl+V activated extension shortcut');
  assert.equal(nativePastes, 0); assert.equal(submissions, 0, 'no synthetic Enter/submission');
  assert.equal(requests, 0, 'no automatic model turn');
  assert.ok(editor.getText() === original, 'actual editor draft unchanged');
  assert.ok(editorEvents === before + 1, 'only activating Ctrl+V, no protocol or modal typing, reached editor');
  assert.ok(widgets.get('pi-tmux-image-clipboard')?.render().join('').includes('1 PNG pending'), 'PNG pending');
  assert.ok(altStarts > 0 && altEnds > 0, 'actual tmux inbound Alt-key encoding observed');
  assert.equal(tui.hasOverlay(), false, 'owned dialog removed after completion');
  let outsideUnsubscribe;
  const outside = new Promise((resolve) => {
    outsideUnsubscribe = tui.addInputListener((data) => { if (data === '\x1b[200~outside pasted\x1b[201~') resolve(); });
  });
  terminal.write('CLIPBOARD_PRIVATE_OUTSIDE_READY'); await outside; outsideUnsubscribe();
  assert.ok(editor.getText() === original + 'outside typedoutside pasted', 'outside Alt+] typing and bracketed paste preserve native editor semantics');
  const pending = await session.extensionRunner.emitInput('intentional next prompt', undefined, 'interactive');
  assert.equal(pending.action, 'transform'); assert.equal(pending.images.length, 1);
  assert.equal(pending.images[0].mimeType, 'image/png');
  assert.equal(session.messages.length, 0, 'handoff alone does not submit');
  result = { ok: true, format, modifyOtherKeys: terminal.modifyOtherKeysActive, encodedMarkersObserved: true,
    pendingImage: true, shortcutActivated: true, submissions, draftUnchanged: true, outsideInputPreserved: true, editorReceivedProtocolOrModalTyping: false, automaticTurns: requests, realClipboardRead: false };
} catch (error) {
  result = { ok: false, format, error: error.message };
} finally {
  if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
  for (const value of widgets.values()) value.dispose?.();
  await writeFile(join(directory, 'result.json'), JSON.stringify(result));
  terminal.write('CLIPBOARD_PRIVATE_WORKER_DONE'); tui.stop();
}
process.exit(result.ok ? 0 : 1);
