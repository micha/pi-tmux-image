// Offline public SDK + public TUI test. All clipboard replies and tmux identity
// are synthetic; no active server, physical terminal, provider or clipboard.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
function pngFixture() {
  function chunk(type, data) {
    let crc = 0xffffffff;
    const named = Buffer.concat([Buffer.from(type), data]);
    for (const byte of named) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4); head.writeUInt32BE(data.length); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, named, tail]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255]))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
const png = pngFixture();
const packet = (id, status, payload, extra = '') => `\x1b]5522;type=read:status=${status}:id=${id}${extra}${payload === undefined ? '' : `;${payload}`}\x1b\\`;
const reads = (writes) => writes.filter((data) => data.includes('5522;type=read'));
const images = (messages) => messages.flatMap((m) => Array.isArray(m.content) ? m.content.filter((block) => block.type === 'image') : []);
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'offline test event did not arrive'); await delay(2); }
}

async function setup(directory, blockImages) {
  const checkout = join(directory, 'package'), cwd = join(directory, 'workspace'), agentDir = join(directory, 'agent'), bin = join(directory, 'bin');
  await mkdir(checkout); await mkdir(cwd); await mkdir(bin);
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
  const previous = Object.fromEntries(['TMUX','TMUX_PANE','PATH'].map((key) => [key, process.env[key]]));
  process.env.TMUX = 'synthetic,1,0'; process.env.TMUX_PANE = '%7'; process.env.PATH = `${bin}:${previous.PATH}`;
  let later = 'continue', consent = true, confirmations = 0, unsubscribeCount = 0;
  const writes = [], keys = [], notices = [], requests = [], widgetMap = new Map();
  const input = new tuiModule.StdinBuffer();
  let terminalInput;
  const terminal = { columns: 80, rows: 24, kittyProtocolActive: false,
    start(callback) { terminalInput = callback; }, stop() {}, write(data) { writes.push(data); },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, async drainInput() {} };
  const tui = new tuiModule.TuiMainScreen(terminal);
  const editor = { render() { return []; }, invalidate() {}, handleInput(data) { keys.push(data); } };
  tui.addChild(editor); tui.setFocus(editor);
  input.on('data', (data) => terminalInput(data));
  input.on('paste', (data) => terminalInput(`\x1b[200~${data}\x1b[201~`));
  tui.start();
  const uiContext = {
    confirm: async (_title, message) => { confirmations++; assert.match(message, /Timeout\/cancel/); return consent; },
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
    settings.applyOverrides({ images: { blockImages, autoResize: false }, terminal: { showImages: false, images: false, trueColor: false }, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } });
    const created = await host.createAgentSession({ cwd, agentDir, settingsManager: settings, resourceLoader: loader, sessionManager: host.SessionManager.inMemory(cwd), model, modelRuntime, thinkingLevel: 'off', noTools: 'all' });
    session = created.session;
    await session.bindExtensions({ mode: 'tui', uiContext });
    assert.equal(reads(writes).length, 0); assert.equal(session.messages.length, 0); assert.equal(requests.length, 0);
    return { session, writes, keys, notices, requests, input, widgetMap,
      set later(value) { later = value; }, set consent(value) { consent = value; },
      get confirmations() { return confirmations; }, get unsubscribeCount() { return unsubscribeCount; },
      async stage() {
        const count = reads(writes).length, command = session.prompt('/tmux-image-paste');
        await until(() => reads(writes).length > count);
        const id = /id=([A-Za-z0-9_.+-]+);/.exec(reads(writes).at(-1))[1];
        input.process(packet(id, 'OK')); input.process(packet(id, 'DATA', png, ':mime=aW1hZ2UvcG5n')); input.process(packet(id, 'DONE'));
        await command; assert.equal(requests.length, 0);
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

test('public SDK clipboard extension: intact request/staging/interactive submission respects model policy', options, async (t) => {
  for (const blocked of [false, true]) await t.test(`blockImages=${blocked}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-host-')); let h;
    try {
      h = await setup(directory, blocked);
      h.consent = false; await h.session.prompt('/tmux-image-paste'); assert.equal(reads(h.writes).length, 0);
      h.consent = true; await h.stage(); assert.equal(h.confirmations, 2);
      assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('1 PNG pending'));
      h.input.process('normal typing'); h.input.process('\x1b[200~plain text paste\x1b[201~');
      assert.ok(h.keys.join('').includes('normal typing')); assert.ok(h.keys.at(-1).includes('plain text paste'));
      const existing = { type: 'image', data: png, mimeType: 'image/png' };
      await h.session.prompt('Intentional user prompt', { source: 'interactive', images: [existing] });
      assert.equal(images(h.session.messages).length, 2);
      assert.equal(h.requests.length, 1); assert.equal(images(h.requests[0].messages).length, blocked ? 0 : 2);
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
    h = await setup(directory, true); await h.stage();
    assert.equal((await h.session.extensionRunner.emitInput('rpc input', undefined, 'rpc')).action, 'continue');
    assert.equal((await h.session.extensionRunner.emitInput('early-handled', undefined, 'interactive')).action, 'handled');
    assert.ok(h.widgetMap.has('pi-tmux-image-clipboard'), 'earlier handler keeps pending image');
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
    await h.stage(); await h.session.prompt('/tmux-image-paste clear'); assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    await h.stage(); await h.session.reload();
    assert.ok(h.unsubscribeCount > 0); assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('public SDK clipboard: fragment detection permits prefix contamination, quarantines, drains late packets without staging', options, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-fragment-')); let h;
  try {
    h = await setup(directory, true);
    const command = h.session.prompt('/tmux-image-paste'); await until(() => reads(h.writes).length === 1);
    const id = /id=([A-Za-z0-9_.+-]+);/.exec(reads(h.writes)[0])[1];
    const data = packet(id, 'DATA', png, ':mime=aW1hZ2UvcG5n'), split = data.indexOf(png) + 4;
    h.input.process(data.slice(0, split)); await delay(100); h.input.process(data.slice(split));
    await command;
    assert.ok(h.notices.some((n) => /Fragmented clipboard reply detected/.test(n.message)));
    assert.ok(h.keys.join('').includes('5522;type=read'), 'permitted prefix contamination is not erased');
    assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('UNRESOLVED'));
    await h.session.prompt('/tmux-image-paste'); assert.equal(reads(h.writes).length, 1, 'unresolved read cannot compete');
    h.input.process(packet(id, 'DONE')); assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    const keyCount = h.keys.length;
    h.input.process(packet(id, 'DATA', png, ':mime=aW1hZ2UvcG5n')); assert.equal(h.keys.length, keyCount, 'intact late issued response consumed');
    h.input.process('\x1b]'); await delay(100); h.input.process('plain text'); assert.ok(h.keys.join('').endsWith('\x1b]plain text'));
    h.input.process(packet('not-owned-1', 'DONE')); assert.ok(h.keys.at(-1).includes('not-owned-1'));
    assert.equal((await h.session.extensionRunner.emitInput('inspect draft', undefined, 'interactive')).action, 'continue');
    assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});

test('public SDK clipboard: cancellation, late denial, missing/invalid PNG and branch cleanup', options, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-errors-')); let h;
  try {
    h = await setup(directory, true);
    let count = 0;
    async function begin() {
      const done = h.session.prompt('/tmux-image-paste'); await until(() => reads(h.writes).length > count);
      count = reads(h.writes).length;
      return { done, id: /id=([A-Za-z0-9_.+-]+);/.exec(reads(h.writes).at(-1))[1] };
    }
    const first = await begin();
    await h.session.prompt('/tmux-image-paste cancel'); await first.done;
    assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('UNRESOLVED'));
    h.input.process(packet(first.id, 'DONE', 'YQ=='));
    h.input.process(packet(first.id, 'EPERM', undefined, ':mime=aW1hZ2UvcG5n'));
    assert.ok(h.widgetMap.get('pi-tmux-image-clipboard').render().join('').includes('UNRESOLVED'), 'malformed terminal packets must not clear quarantine');
    await h.session.prompt('/tmux-image-paste'); assert.equal(reads(h.writes).length, count);
    h.input.process(packet(first.id, 'EPERM')); assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    for (const kind of ['EPERM', 'missing', 'badpng', 'oversize']) {
      const request = await begin();
      if (kind === 'EPERM') h.input.process(packet(request.id, 'EPERM'));
      else {
        h.input.process(packet(request.id, 'OK'));
        if (kind !== 'missing') h.input.process(packet(request.id, 'DATA', kind === 'oversize' ? 'A'.repeat(9000) : 'YmFk', ':mime=aW1hZ2UvcG5n'));
        h.input.process(packet(request.id, 'DONE'));
      }
      await request.done; assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false, kind);
    }
    await h.stage();
    await h.session.extensionRunner.emit({ type: 'session_tree', newLeafId: null, oldLeafId: null });
    assert.equal(h.widgetMap.has('pi-tmux-image-clipboard'), false);
    assert.equal(h.requests.length, 0); assert.equal(h.session.messages.length, 0);
  } finally { await h?.cleanup(); await rm(directory, { recursive: true, force: true }); }
});
