// Offline public SDK + public TUI test. All clipboard replies and tmux identity
// are synthetic; no active server, physical terminal, provider or clipboard.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';
import test from 'node:test';

const root = process.env.PI_TEST_HOST_ROOT;
const entry = root && join(root, 'dist/index.js');
const host = entry ? await import(pathToFileURL(entry).href) : undefined;
const tuiModule = entry ? await import(pathToFileURL(createRequire(entry).resolve('@earendil-works/pi-tui')).href) : undefined;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = { skip: !host && 'set PI_TEST_HOST_ROOT to installed coding-agent package root', timeout: 60000 };
const model = { id: 'clipboard-offline', name: 'Clipboard offline', api: 'offline', provider: 'offline', reasoning: false, input: ['text','image'], contextWindow: 100000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
function pngFixture(rgba = [255, 0, 0, 255]) {
  function chunk(type, data) {
    let crc = 0xffffffff;
    const named = Buffer.concat([Buffer.from(type), data]);
    for (const byte of named) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, named, tail]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const png = pngFixture(), secondPng = pngFixture([0, 255, 0, 255]), existingPng = pngFixture([0, 0, 255, 255]);
const packet = (id, status, payload, extra = '') => `\x1b]5522;type=read:status=${status}:id=${id}${extra}${payload === undefined ? '' : `;${payload}`}\x1b\\`;
const reads = (writes) => writes.filter((data) => data.includes('5522;type=read'));
const images = (messages) => messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((block) => block.type === 'image') : []);
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'offline test event did not arrive'); await delay(2); }
}

async function setup(directory, blockImages, mode = 'regular', config = {}) {
  const checkout = join(directory, 'package'), cwd = join(directory, 'workspace'), agentDir = join(directory, 'agent'), bin = join(directory, 'bin');
  await mkdir(checkout); await mkdir(cwd); await mkdir(bin); await mkdir(agentDir);
  await writeFile(join(agentDir, 'keybindings.json'), JSON.stringify(config.keybindings || {}));
  const keybindings = new tuiModule.KeybindingsManager({ ...tuiModule.TUI_KEYBINDINGS,
    'app.clipboard.pasteImage': { defaultKeys: 'ctrl+v' }, 'app.interrupt': { defaultKeys: 'escape' },
  }, JSON.parse(await readFile(join(agentDir, 'keybindings.json'), 'utf8')));
  for (const name of ['src','extensions','package.json']) await cp(join(repo, name), join(checkout, name), { recursive: true });
  // A fresh absolute entry path avoids cached transforms masking relative imports.
  await writeFile(join(directory, 'early.ts'), `export default function(pi) { pi.on('input', e => e.text === 'early-handled' ? {action:'handled'} : undefined); }`);
  await writeFile(join(bin, 'tmux'), `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==='display-message') process.stdout.write('%7\\t$2\\t1\\t1\\t0\\t0\\t0\\n');
else if(a[0]==='show-options') process.stdout.write('on\\n');
else if(a[0]==='list-clients') process.stdout.write('/dev/fake\\tghostty 1.4.0\\txterm-ghostty\\t0\\tattached,focused,UTF-8\\n');
else process.exitCode=1;
`, { mode: 0o700 });
  const previous = Object.fromEntries(['TMUX','TMUX_PANE','PATH','PI_TMUX_IMAGE_PASTE_SHORTCUT'].map((key) => [key, process.env[key]]));
  if (config.shortcut === undefined) delete process.env.PI_TMUX_IMAGE_PASTE_SHORTCUT;
  else process.env.PI_TMUX_IMAGE_PASTE_SHORTCUT = config.shortcut;
  process.env.TMUX = 'synthetic,1,0'; process.env.TMUX_PANE = '%7'; process.env.PATH = `${bin}:${previous.PATH}`;
  if (config.tmuxEnv !== undefined) for (const key of ['TMUX', 'TMUX_PANE']) {
    if (config.tmuxEnv[key] === undefined) delete process.env[key]; else process.env[key] = config.tmuxEnv[key];
  }
  let later = 'continue', confirmations = 0, unsubscribeCount = 0, nativePastes = 0, reservedActions = 0, shortcutWork;
  const writes = [], keys = [], notices = [], requests = [], widgetMap = new Map();
  const input = new tuiModule.StdinBuffer();
  let terminalInput;
  const terminal = { columns: 80, rows: 24, kittyProtocolActive: false,
    start(callback) { terminalInput = callback; }, stop() {}, write(data) {
      if (data.includes('5522;type=read')) {
        assert.equal(tui.hasOverlay(), true, 'owned modal installed before read');
        assert.ok(writes.some((frame) => frame.includes('Reading clipboard')), 'modal flushed before read');
      }
      writes.push(data);
    },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, async drainInput() {} };
  const tui = new (mode === 'fullscreen' ? tuiModule.TuiAltScreen : tuiModule.TuiMainScreen)(terminal);
  class ObservedEditor extends host.CustomEditor {
    handleInput(data) { keys.push(data); super.handleInput(data); }
  }
  const editor = new ObservedEditor(tui, { borderColor: (text) => text, selectList: {} }, keybindings);
  editor.onPasteImage = () => { nativePastes++; }; // Never read the physical clipboard.
  editor.onEscape = () => { reservedActions++; };
  tui.addChild(editor); tui.setFocus(editor);
  input.on('data', (data) => terminalInput(data));
  input.on('paste', (data) => terminalInput(`\x1b[200~${data}\x1b[201~`));
  tui.start();
  const uiContext = {
    confirm: async () => { confirmations++; throw new Error('Extension confirmation must not be called'); },
    notify: (message, level) => notices.push({ message, level }),
    onTerminalInput: (listener) => { const unsubscribe = tui.addInputListener(listener); return () => { unsubscribeCount++; unsubscribe(); }; },
    setWidget(key, content) {
      const previous = widgetMap.get(key); previous?.dispose?.(); if (previous) tui.removeChild(previous);
      if (typeof content === 'function') { const widget = content(tui); widgetMap.set(key, widget); tui.addChild(widget); }
      else if (content) widgetMap.set(key, { render: () => content, invalidate() {} });
      else widgetMap.delete(key);
    },
  };
  const modelRuntime = {
    getModel: () => model, getPhysicalModel: () => model, getModels: () => [model], getAvailableSnapshot: () => [model], getError: () => undefined,
    hasConfiguredAuth: () => true, isUsingOAuth: () => false, isUsingSubscription: () => false, getAuth: async () => ({ apiKey: 'offline' }),
    streamSimple(_model, context) {
      requests.push(structuredClone(context));
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', content: [{ type: 'text', text: 'Offline.' }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', reason: 'stop', message }; }, result: async () => message };
    },
  };
  let session;
  try {
    const settings = host.SettingsManager.create(cwd, agentDir);
    const loader = new host.DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [join(directory, 'early.ts'), join(checkout, 'extensions/tmux-image.ts')],
      extensionFactories: [(pi) => pi.on('input', (event) => {
        if (later === 'throw') throw new Error('Synthetic later handler rejection');
        return later === 'handled' ? { action: 'handled' } : later === 'replace' ? { action: 'transform', text: event.text, images: [] } : undefined;
      })],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { commands } = loader.getExtensions().extensions.find(({ commands }) => commands.has('tmux-image'));
    assert.deepEqual([...commands.keys()].sort(), ['tmux-image', 'tmux-pdf']);
    settings.applyOverrides({ images: { blockImages, autoResize: false }, terminal: { showImages: false, images: false, trueColor: false }, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } });
    const created = await host.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: host.SessionManager.inMemory(cwd), model, modelRuntime, thinkingLevel: 'off', noTools: 'all' });
    session = created.session;
    await session.bindExtensions({ mode: 'tui', uiContext });
    const shortcuts = session.extensionRunner.getShortcuts(keybindings.getResolvedBindings());
    editor.onExtensionShortcut = (data) => {
      for (const [key, shortcut] of shortcuts) if (tuiModule.matchesKey(data, key)) {
        shortcutWork = Promise.resolve(shortcut.handler(session.extensionRunner.createContext()));
        return true;
      }
      return false;
    };
    assert.equal(reads(writes).length, 0); assert.equal(session.messages.length, 0); assert.equal(requests.length, 0);
    return { session, tui, writes, keys, notices, requests, input, widgetMap, editor, shortcuts, commands,
      get shortcutWork() { return shortcutWork; }, get nativePastes() { return nativePastes; }, get reservedActions() { return reservedActions; },
      set later(value) { later = value; },
      get confirmations() { return confirmations; }, get unsubscribeCount() { return unsubscribeCount; },
      async stage(data = png) {
        const count = reads(writes).length, command = session.prompt('/tmux-image paste');
        await until(() => reads(writes).length > count);
        const id = /id=([A-Za-z0-9_.+-]+);/.exec(reads(writes).at(-1))[1];
        input.process(packet(id, 'OK')); input.process(packet(id, 'DATA', data, ':mime=aW1hZ2UvcG5n')); input.process(packet(id, 'DONE'));
        await command; assert.equal(requests.length, 0);
        assert.match(notices.at(-1)?.message, /PNGs? ready for your next prompt/);
        assert.ok(widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('/tmux-image paste clear'));
        return id;
      },
      async cleanup() {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
        for (const widget of widgetMap.values()) widget.dispose?.(); input.destroy(); tui.stop();
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      },
    };
  } catch (error) {
    session?.dispose(); for (const widget of widgetMap.values()) widget.dispose?.(); input.destroy(); tui.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    throw error;
  }
}

test('public SDK: tmux-image subcommand usage, completion and validation are local', options, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-tmux-image-command-')); let h;
  try {
    h = await setup(directory, true);
    const complete = h.commands.get('tmux-image').getArgumentCompletions;
    assert.deepEqual(complete('').map((item) => item.value), ['view', 'refresh', 'stats', 'paste']);
    assert.deepEqual(complete('vi').map((item) => item.value), ['view']);
    assert.deepEqual(complete('paste ').map((item) => item.value), ['paste clear', 'paste cancel']);
    assert.deepEqual(complete('paste cl').map((item) => item.value), ['paste clear']);
    assert.equal(complete('image with spaces.png'), null);

    await h.session.prompt('/tmux-image');
    for (const subcommand of ['view', 'refresh', 'stats', 'paste [clear|cancel]']) {
      assert.ok(h.notices.at(-1).message.includes(`/tmux-image ${subcommand}`));
    }
    for (const subcommand of ['view', 'refresh', 'stats', 'paste']) {
      await h.session.prompt(`/tmux-image ${subcommand} unexpected`);
      assert.ok(h.notices.at(-1).message.startsWith(`Usage: /tmux-image ${subcommand}`));
    }
    for (const subcommand of ['view', 'refresh']) {
      await h.session.prompt(`/tmux-image ${subcommand}`);
      assert.match(h.notices.at(-1).message, /Local images are disabled.*\/tmux-image refresh/);
    }
    await h.session.prompt('/tmux-image  stats');
    assert.match(h.notices.at(-1).message, /Graphics: this runtime only/);
    assert.equal(h.tui.hasOverlay(), false);
    assert.equal(reads(h.writes).length, 0);
    assert.equal(h.session.messages.length, 0);
    assert.equal(h.requests.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('public SDK/actual CustomEditor: off/outside/invalid pane preserves native paste dispatch and ordinary text paste', options, async () => {
  for (const config of [{ shortcut: 'off' }, { tmuxEnv: {} }, { tmuxEnv: { TMUX: 'present', TMUX_PANE: 'invalid' } }, { shortcut: 'ctrl+alt+v', tmuxEnv: {} }]) {
    const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-shortcut-off-')); let h;
    try {
      h = await setup(directory, true, 'regular', config); assert.equal(h.shortcuts.size, 0); assert.equal(h.notices.length, 0);
      h.editor.setText('draft'); h.input.process('\x16'); assert.equal(h.nativePastes, 1);
      h.input.process('\x1b]'); h.input.process('\x1b[200~ text paste\x1b[201~'); h.input.process(' typed');
      assert.equal(h.editor.getText(), 'draft text paste typed'); assert.equal(reads(h.writes).length, 0);
      assert.equal(h.requests.length, 0); assert.equal(h.confirmations, 0);
    } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('public SDK/actual CustomEditor: default/custom shortcuts, native conflict/unbind/remap and attachment preservation', options, async (t) => {
  for (const config of [
    {}, { shortcut: '' }, { shortcut: 'ctrl+v' },
    { shortcut: 'ctrl+v', keybindings: { 'app.clipboard.pasteImage': [] } },
    { shortcut: 'ctrl+v', keybindings: { 'app.clipboard.pasteImage': 'alt+v' } },
    { shortcut: 'ctrl+shift+v' }, { shortcut: 'ctrl+alt+v' },
  ]) await t.test(JSON.stringify(config), async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-shortcut-')); let h;
    try {
      h = await setup(directory, true, 'regular', config); assert.equal(h.shortcuts.size, 1); assert.equal(h.notices.length, 0, 'no routine startup notice');
      const shortcutKey = config.shortcut || 'ctrl+v';
      const encoded = { 'ctrl+v': '\x16', 'ctrl+shift+v': '\x1b[118;6u', 'ctrl+alt+v': '\x1b[118;7u' }[shortcutKey];
      assert.equal(tuiModule.matchesKey(encoded, shortcutKey), true);
      h.editor.setText('existing unsent draft');
      const diagnostics = h.session.extensionRunner.getShortcutDiagnostics();
      if (shortcutKey === 'ctrl+v' && !config.keybindings) assert.ok(diagnostics.some((d) => /app.clipboard.pasteImage.*Using/.test(d.message)));
      async function stageShortcut(data) {
        const count = reads(h.writes).length; h.input.process(encoded);
        await until(() => reads(h.writes).length > count);
        const id = /id=([A-Za-z0-9_.+-]+);/.exec(reads(h.writes).at(-1))[1];
        h.input.process(encoded); // Focused modal deliberately captures repeats.
        h.input.process(packet(id, 'OK') + packet(id, 'DATA', data, ':mime=aW1hZ2UvcG5n') + packet(id, 'DONE'));
        await h.shortcutWork; assert.equal(reads(h.writes).length, count + 1);
      }
      await stageShortcut(png); await stageShortcut(secondPng);
      assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('2 PNGs pending'));
      assert.equal(h.confirmations, 0); assert.equal(h.nativePastes, 0);
      const existing = { type: 'image', mimeType: 'image/png', data: existingPng }, attachments = [existing];
      const handed = await h.session.extensionRunner.emitInput(h.editor.getText(), attachments, 'interactive');
      assert.equal(handed.text, 'existing unsent draft');
      assert.deepEqual(handed.images.map((image) => image.data), [existingPng, png, secondPng]);
      assert.equal(handed.images[0], existing); assert.equal(attachments.length, 1);
      assert.equal(h.editor.getText(), 'existing unsent draft'); assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
      if (config.keybindings?.['app.clipboard.pasteImage'] === 'alt+v') { h.input.process('\x1bv'); assert.equal(h.nativePastes, 1); }
      const other = { render: () => ['other dialog'], handleInput() {}, invalidate() {} }, handle = h.tui.showOverlay(other);
      const before = reads(h.writes).length; h.input.process(encoded); assert.equal(reads(h.writes).length, before); assert.equal(handle.isFocused(), true);
      handle.hide();
      h.input.process(encoded); await until(() => reads(h.writes).length > before);
      h.input.process('\x03'); await h.shortcutWork; assert.equal(h.tui.hasOverlay(), true);
      await h.shortcuts.get(shortcutKey).handler(h.session.extensionRunner.createContext());
      assert.equal(reads(h.writes).length, before + 1, 'unresolved blocks even direct repeat');
      const id = /id=([A-Za-z0-9_.+-]+);/.exec(reads(h.writes).at(-1))[1]; h.input.process(packet(id, 'DONE'));
    } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('public SDK/actual CustomEditor: invalid opt-in and user-reserved collision fail without clipboard read', options, async () => {
  for (const config of [ { shortcut: 'ctrl+c' }, { shortcut: 'ctrl+v', keybindings: { 'app.clipboard.pasteImage': [], 'app.interrupt': 'ctrl+v' } } ]) {
    const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-shortcut-invalid-')); let h;
    try {
      h = await setup(directory, true, 'regular', config); assert.equal(h.shortcuts.size, 0);
      h.editor.setText('unchanged'); h.input.process('\x16'); assert.equal(reads(h.writes).length, 0);
      if (config.shortcut === 'ctrl+c') assert.ok(h.notices.some((n) => /Invalid PI_TMUX_IMAGE_PASTE_SHORTCUT/.test(n.message)));
      else { assert.equal(h.reservedActions, 1); assert.ok(h.session.extensionRunner.getShortcutDiagnostics().some((d) => /Skipping/.test(d.message))); }
      await h.stage(); assert.equal(h.editor.getText(), 'unchanged'); assert.equal(h.confirmations, 0);
      await h.session.prompt('/tmux-image paste clear');
      const count = reads(h.writes).length;
      await writeFile(join(directory, 'bin/tmux'), '#!/usr/bin/env node\nprocess.exit(1);\n');
      await h.session.prompt('/tmux-image paste');
      assert.equal(reads(h.writes).length, count, 'failed topology must not emit a read'); assert.equal(h.tui.hasOverlay(), false);
    } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('public SDK clipboard extension: intact request/staging/interactive submission respects model policy', options, async (t) => {
  for (const blocked of [false, true]) await t.test(`blockImages=${blocked}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-host-')); let h;
    try {
      h = await setup(directory, blocked);
      await h.stage(); await h.stage(secondPng); assert.equal(h.confirmations, 0);
      assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('2 PNGs pending'));
      h.input.process('normal typing'); h.input.process('\x1b[200~plain text paste\x1b[201~');
      assert.ok(h.keys.join('').includes('normal typing')); assert.ok(h.keys.at(-1).includes('plain text paste'));
      const existing = { type: 'image', data: existingPng, mimeType: 'image/png' };
      await h.session.prompt('Intentional user prompt', { source: 'interactive', images: [existing] });
      const expected = [existingPng, png, secondPng];
      assert.deepEqual(images(h.session.messages).map((image) => image.data), expected);
      assert.equal(h.requests.length, 1);
      assert.deepEqual(images(h.requests[0].messages).map((image) => image.data), blocked ? [] : expected);
      assert.equal(h.session.messages.find((message) => message.role === 'user').content.find((block) => block.type === 'text').text, 'Intentional user prompt');
      assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
      assert.equal(JSON.stringify(h.notices).includes(png), false);
      assert.equal(JSON.stringify(h.session.messages).includes('5522;'), false);
    } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
  });
});

test('public SDK clipboard: pending handoff semantics for earlier/later handlers, image replacement, clear and reload', options, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-chain-')); let h;
  try {
    h = await setup(directory, true); await h.stage(); await h.stage(secondPng);
    assert.equal((await h.session.extensionRunner.emitInput('rpc input', undefined, 'rpc')).action, 'continue');
    assert.equal((await h.session.extensionRunner.emitInput('early-handled', undefined, 'interactive')).action, 'handled');
    assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('2 PNGs pending'), 'earlier handler keeps all pending images');
    h.later = 'handled';
    assert.equal((await h.session.extensionRunner.emitInput('later handles', undefined, 'interactive')).action, 'handled');
    assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false, 'later handling does not restore consumed handoff');
    h.later = 'continue'; assert.equal((await h.session.extensionRunner.emitInput('next', undefined, 'interactive')).action, 'continue');
    await h.stage(); h.later = 'replace';
    assert.deepEqual((await h.session.extensionRunner.emitInput('replace', undefined, 'interactive')).images, []);
    h.later = 'continue'; assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    await h.stage(); h.later = 'throw';
    const rejected = await h.session.extensionRunner.emitInput('handler throws', undefined, 'interactive');
    assert.equal(rejected.action, 'transform'); assert.equal(rejected.images.length, 1);
    h.later = 'continue'; assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    await h.stage(); await h.stage(secondPng);
    await h.session.prompt('/tmux-image paste clear'); assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    assert.equal((await h.session.extensionRunner.emitInput('next', undefined, 'interactive')).action, 'continue');
    await h.stage(); await h.stage(secondPng); await h.session.reload();
    assert.ok(h.unsubscribeCount > 0); assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('public SDK clipboard: visible modal assembles delayed fragments without editor input', options, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-fragment-')); let h;
  try {
    h = await setup(directory, true);
    const command = h.session.prompt('/tmux-image paste'); await until(() => reads(h.writes).length === 1);
    const id = /id=([A-Za-z0-9_.+-]+);/.exec(reads(h.writes)[0])[1];
    const data = packet(id, 'DATA', png, ':mime=aW1hZ2UvcG5n'), split = data.indexOf(png) + 4;
    h.input.process(packet(id, 'OK'));
    h.input.process('typing deliberately captured by visible modal');
    h.input.process(data.slice(0, split)); await delay(100); h.input.process(data.slice(split));
    h.input.process(packet(id, 'DONE'));
    await command;
    assert.equal(h.keys.length, 0, 'dialog owns all reply fragments, not the editor');
    assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('1 PNG pending'));
    assert.equal(h.notices.some((n) => /outside the paste dialog/.test(n.message)), false);
    await h.session.prompt('/tmux-image paste clear');
    const keyCount = h.keys.length;
    h.input.process(packet(id, 'DATA', png, ':mime=aW1hZ2UvcG5n')); assert.equal(h.keys.length, keyCount, 'intact late issued response consumed');
    h.input.process('\x1b]'); await delay(100); h.input.process('plain text'); assert.ok(h.keys.join('').endsWith('\x1b]plain text'));
    h.input.process('\x1b[200~normal paste\x1b[201~'); assert.ok(h.keys.at(-1).includes('normal paste'));
    h.input.process(packet('not-owned-1', 'DONE')); assert.ok(h.keys.at(-1).includes('not-owned-1'));
    assert.equal((await h.session.extensionRunner.emitInput('ordinary input', undefined, 'interactive')).action, 'continue');
    assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('public SDK clipboard: cancel/drain, explicit leave, outside native input and late encoded completion', options, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-modal-leave-')); let h;
  try {
    h = await setup(directory, true);
    const command = h.session.prompt('/tmux-image paste'); await until(() => reads(h.writes).length === 1);
    const id = /id=([A-Za-z0-9_.+-]+);/.exec(reads(h.writes)[0])[1];
    h.input.process('\x03'); await command; assert.equal(h.tui.hasOverlay(), true);
    h.input.process('captured while draining'); assert.equal(h.keys.length, 0);
    h.input.process('\x11'); assert.equal(h.tui.hasOverlay(), true, 'first Ctrl+Q only warns');
    h.input.process('\x11'); assert.equal(h.tui.hasOverlay(), false, 'second Ctrl+Q leaves knowingly');
    assert.ok(h.notices.some((n) => /dialog left explicitly/.test(n.message)));
    await h.session.prompt('/tmux-image paste'); assert.equal(reads(h.writes).length, 1);
    h.input.process('\x1b[93;3u'); h.input.process('normal typing');
    h.input.process('\x1b[200~normal paste\x1b[201~');
    assert.ok(h.keys.join('').includes('normal typing')); assert.ok(h.keys.at(-1).includes('normal paste'));
    h.input.process(packet(id, 'DONE').replace('\x1b]', '\x1b[93;3u').replace('\x1b\\', '\x1b[92;3u'));
    assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false, 'clean late encoded completion drains quarantine');
    assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('public SDK clipboard: other overlays are respected; focus loss keeps drain ownership visible and reload cleans up', options, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-modal-focus-')); let h;
  try {
    h = await setup(directory, true);
    const other = h.tui.showOverlay({ render: () => ['other dialog'], invalidate() {}, handleInput() {} });
    await h.session.prompt('/tmux-image paste'); assert.equal(reads(h.writes).length, 0, 'existing modal blocks read'); other.hide();
    let command = h.session.prompt('/tmux-image paste'); await until(() => reads(h.writes).length === 1);
    const id = /id=([A-Za-z0-9_.+-]+);/.exec(reads(h.writes)[0])[1];
    const covering = h.tui.showOverlay({ render: () => ['covering dialog'], invalidate() {}, handleInput() {} });
    h.input.process('ordinary input in covering modal'); await command;
    assert.equal(covering.isFocused(), true, 'clipboard must not reclaim another modal focus');
    assert.ok(h.notices.some((n) => /lost TUI input focus/.test(n.message)));
    covering.hide(); assert.equal(h.tui.hasOverlay(), true, 'clipboard drain dialog was not silently closed');
    h.input.process(packet(id, 'DONE')); assert.equal(h.tui.hasOverlay(), false);
    command = h.session.prompt('/tmux-image paste'); await until(() => reads(h.writes).length === 2);
    await h.session.reload(); await command;
    assert.equal(h.tui.hasOverlay(), false); assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    assert.ok(h.notices.some((n) => /leaving a runtime/.test(n.message)));
    assert.equal(reads(h.writes).length, 2, 'reload never triggers a read');
    assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('public SDK clipboard: fullscreen owned dialog and cancellation preserve editor input', options, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-modal-fullscreen-')); let h;
  try {
    h = await setup(directory, true, 'fullscreen');
    const command = h.session.prompt('/tmux-image paste'); await until(() => reads(h.writes).length === 1);
    const id = /id=([A-Za-z0-9_.+-]+);/.exec(reads(h.writes)[0])[1];
    h.input.process('modal typing'); h.input.process('\x03'); await command;
    assert.equal(h.keys.length, 0); assert.equal(h.tui.hasOverlay(), true);
    h.input.process(packet(id, 'DONE')); assert.equal(h.tui.hasOverlay(), false);
    h.input.process('outside typing'); assert.ok(h.keys.join('').includes('outside typing'));
    assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('public SDK clipboard: cancellation, late denial, missing/invalid PNG and branch cleanup', options, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-errors-')); let h;
  try {
    h = await setup(directory, true);
    let count = 0;
    async function begin() {
      const done = h.session.prompt('/tmux-image paste'); await until(() => reads(h.writes).length > count);
      count = reads(h.writes).length;
      return { done, id: /id=([A-Za-z0-9_.+-]+);/.exec(reads(h.writes).at(-1))[1] };
    }
    const first = await begin();
    await h.session.prompt('/tmux-image paste cancel'); await first.done;
    assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('UNRESOLVED'));
    h.input.process(packet(first.id, 'DONE', 'YQ=='));
    h.input.process(packet(first.id, 'EPERM', undefined, ':mime=aW1hZ2UvcG5n'));
    assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('UNRESOLVED'), 'malformed terminal packets must not clear quarantine');
    await h.session.prompt('/tmux-image paste'); assert.equal(reads(h.writes).length, count);
    h.input.process(packet(first.id, 'EPERM')); assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    await h.stage(); count = reads(h.writes).length;
    for (const kind of ['EPERM', 'missing', 'badpng', 'oversize']) {
      const request = await begin();
      if (kind === 'EPERM') h.input.process(packet(request.id, 'EPERM'));
      else {
        h.input.process(packet(request.id, 'OK'));
        if (kind !== 'missing') h.input.process(packet(request.id, 'DATA', kind === 'oversize' ? 'A'.repeat(9000) : 'YmFk', ':mime=aW1hZ2UvcG5n'));
        h.input.process(packet(request.id, 'DONE'));
      }
      await request.done;
      assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('1 PNG pending'), kind);
    }
    await h.stage(secondPng);
    await h.session.extensionRunner.emit({ type: 'session_tree', newLeafId: null, oldLeafId: null });
    assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
