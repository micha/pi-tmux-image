import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import test from 'node:test';
import { createClipboardReader, strictBase64 } from '../src/clipboard-protocol.mjs';
import { validateClipboardPng } from '../src/clipboard-png.mjs';
import { probeClipboardTopology } from '../src/clipboard-capabilities.mjs';
import { registerClipboardPaste } from '../src/clipboard.mjs';

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data = Buffer.alloc(0)) {
  const size = Buffer.alloc(4), checksum = Buffer.alloc(4), name = Buffer.from(type);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
function png({ interlace = 0, filter = 0, color = 6, depth = 8, raw = Buffer.from([filter, 255, 0, 0, 255]), extra = [] } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = depth; header[9] = color; header[12] = interlace;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND')]);
}
const PNG = png();
const packet = (id, status, payload, extra = '') => `\x1b]5522;type=read:status=${status}:id=${id}${extra}${payload === undefined ? '' : `;${payload}`}\x1b\\`;
const idOf = (request) => /id=([A-Za-z0-9_.+-]+);/.exec(request)[1];
function reader(options = {}) {
  let timer;
  const warnings = [];
  const instance = createClipboardReader({ prefix: 'runtime', setTimer: (fn) => { timer = fn; return 1; }, clearTimer() {}, onWarning: (message) => warnings.push(message), ...options });
  return { instance, warnings, timeout: () => timer() };
}
function success(input, id, bytes = PNG) {
  input(packet(id, 'OK'));
  for (let offset = 0; offset < bytes.length; offset += 17) input(packet(id, 'DATA', bytes.subarray(offset, offset + 17).toString('base64'), ':mime=aW1hZ2UvcG5n'));
  input(packet(id, 'DONE'));
}

test('clipboard strict base64 and PNG validate bounded still image data', () => {
  assert.deepEqual(strictBase64('YQ=='), Buffer.from('a'));
  for (const text of ['YQ', 'YQ=\n', 'YR==', 'YQ===', 'YQ== ']) assert.throws(() => strictBase64(text));
  assert.deepEqual(validateClipboardPng(PNG), { width: 1, height: 1 });
  const palette = chunk('PLTE', Buffer.from([0,0,0,255,255,255]));
  for (const filter of [0,1,2,3,4]) assert.deepEqual(validateClipboardPng(png({ color: 3, raw: Buffer.from([filter,1]), extra: [palette] })), { width: 1, height: 1 });
  assert.deepEqual(validateClipboardPng(png({ color: 3, depth: 1, raw: Buffer.from([0,128]), extra: [palette] })), { width: 1, height: 1 });
  assert.throws(() => validateClipboardPng(png({ color: 3, raw: Buffer.from([0,2]), extra: [palette] })));
  for (const bytes of [Buffer.from('not png'), PNG.subarray(0, -1), Buffer.concat([PNG, Buffer.from('x')]),
    png({ interlace: 1 }), png({ filter: 5 }), png({ raw: Buffer.alloc(6) }), png({ extra: [chunk('acTL', Buffer.alloc(8))] })]) {
    assert.throws(() => validateClipboardPng(bytes));
  }
  const corrupt = Buffer.from(PNG); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => validateClipboardPng(corrupt));
  assert.throws(() => validateClipboardPng(PNG, { maxBytes: 1 }));
  assert.throws(() => validateClipboardPng(PNG, { maxPixels: 0 }));
  assert.throws(() => validateClipboardPng(PNG, { maxDecodedBytes: 1 }));
});

test('clipboard owns only exact actually issued IDs, consumes intact replies and stages after DONE', async () => {
  const { instance: r } = reader();
  assert.equal(r.state.issued, 0);
  assert.equal(r.input('ordinary text'), undefined);
  const { request, done } = r.begin(), id = idOf(request);
  assert.match(request, /^\x1bPtmux;\x1b\x1b\]5522;/);
  for (const unowned of ['runtime-0', 'runtime-01', 'runtime-2', 'runtime-1-other', 'else-1']) assert.equal(r.input(packet(unowned, 'DONE')), undefined);
  assert.throws(() => r.begin(), /unresolved/);
  success((data) => assert.deepEqual(r.input(data), { consume: true }), id);
  const result = await done;
  assert.equal(result.ok, true); assert.equal(result.image.data, PNG.toString('base64'));
  assert.equal(r.state.waiting, false);
  assert.deepEqual(r.input(packet(id, 'DATA', 'late', ':mime=aW1hZ2UvcG5n')), { consume: true });
  r.dispose();
});

test('clipboard errors/missing PNG and malformed/oversized data do not import', async () => {
  for (const kind of ['EPERM', 'ENOSYS', 'EBUSY', 'missing', 'encoding', 'mime', 'oversize', 'order', 'packet', 'metadata', 'packets', 'badpng']) {
    const { instance: r } = reader({ maxBytes: kind === 'oversize' ? 4 : 1024, maxPackets: kind === 'packets' ? 1 : 100 });
    const { request, done } = r.begin(), id = idOf(request);
    if (['EPERM','ENOSYS','EBUSY'].includes(kind)) r.input(packet(id, kind));
    else if (kind === 'order') { r.input(packet(id, 'DATA', 'YQ==', ':mime=aW1hZ2UvcG5n')); r.input(packet(id, 'DONE')); }
    else {
      r.input(packet(id, 'OK'));
      if (kind === 'packet') r.input(packet(id, 'DATA', 'A'.repeat(9000), ':mime=aW1hZ2UvcG5n'));
      else if (kind === 'metadata') r.input(packet(id, 'DATA', 'YQ==', ':invalid=%'));
      else if (kind !== 'missing') r.input(packet(id, 'DATA', kind === 'encoding' ? 'YR==' : (kind === 'badpng' ? Buffer.from('bad') : PNG).toString('base64'), `:mime=${kind === 'mime' ? 'dGV4dC9wbGFpbg==' : 'aW1hZ2UvcG5n'}`));
      r.input(packet(id, 'DONE'));
    }
    assert.equal((await done).ok, false, kind);
    assert.equal(r.state.waiting, false, kind);
    r.dispose();
  }
});

test('clipboard timeout/cancel quarantine read until terminal end; late data never stages', async () => {
  for (const reason of ['timeout', 'cancel']) {
    const h = reader(), r = h.instance;
    const { request, done } = r.begin(), id = idOf(request);
    if (reason === 'timeout') h.timeout(); else r.cancel();
    assert.equal((await done).unresolved, true);
    assert.equal(r.state.unresolved, true);
    assert.throws(() => r.begin(), /unresolved/);
    success((data) => r.input(data), id);
    assert.equal(r.state.waiting, false);
    const next = r.begin(); assert.equal(idOf(next.request), 'runtime-2');
    r.dispose(); assert.equal((await next.done).ok, false);
    assert.equal(r.input(packet(id, 'DONE')), undefined);
  }
});

test('clipboard fragment observer never holds Alt+] or printable keys; rejects recognized owned recovery', async () => {
  const h = reader(), r = h.instance, { request, done } = r.begin(), id = idOf(request);
  const data = packet(id, 'DATA', PNG.toString('base64'), ':mime=aW1hZ2UvcG5n');
  assert.equal(r.input('\x1b]'), undefined);
  for (const key of data.slice(2, -2)) assert.equal(r.input(key), undefined);
  assert.equal((await done).ok, false);
  assert.equal(h.warnings.length, 1); assert.match(h.warnings[0], /Inspect/);
  assert.deepEqual(r.input('\x1b\\'), { consume: true });
  for (const value of ['\x1b]', 'plain text', '\x1b[200~literal protocol text\x1b[201~', '\x1b[A']) assert.equal(r.input(value), undefined);
  r.input(packet(id, 'DONE')); assert.equal(r.state.waiting, false);
  r.dispose();
});

test('clipboard fragment observation is bounded, expires, ignores unissued IDs and recognizes fragmented DONE', async () => {
  let now = 0;
  const h = reader({ now: () => now }), r = h.instance, { request, done } = r.begin(), id = idOf(request);
  r.input('\x1b]'); for (const key of '5522;type=read:status=OK:id=runtime-2:') r.input(key);
  assert.equal(h.warnings.length, 0);
  r.input('\x1b]'); now = 1001; r.input('5'); assert.equal(h.warnings.length, 0);
  r.input('\x1b]'); for (let i = 0; i < 10000; i++) r.input('x');
  r.cancel(); await done;
  r.input('\x1b]'); for (const key of packet(id, 'DONE').slice(2, -2)) r.input(key);
  r.input('\x1b\\'); assert.equal(r.state.waiting, false);
  r.dispose();
});

test('clipboard late issued IDs cannot disturb a newer read and fresh runtimes do not own old IDs', async () => {
  const { instance: r } = reader(); const first = r.begin();
  r.input(packet(idOf(first.request), 'EPERM')); await first.done;
  const second = r.begin(), id = idOf(second.request);
  r.input(packet('runtime-1', 'DATA', 'A'.repeat(9000), ':mime=aW1hZ2UvcG5n'));
  assert.equal(r.state.unresolved, false);
  success((data) => r.input(data), id); assert.equal((await second.done).ok, true);
  const fresh = reader({ prefix: 'replacement' }).instance;
  assert.equal(fresh.input(packet(id, 'DONE')), undefined);
  r.dispose(); fresh.dispose();
});

test('clipboard malformed DONE/error packets cannot release quarantine, including fragmented/discard paths', async () => {
  for (const cancelled of [false, true]) for (const fragmented of [false, true]) {
    for (const status of ['DONE', 'EPERM', 'ENOSYS', 'EBUSY']) for (const malformed of ['payload', 'mime', 'extra']) {
      const { instance: r } = reader(); const { request, done } = r.begin(), id = idOf(request);
      if (cancelled) { r.cancel(); await done; }
      const data = packet(id, status, malformed === 'payload' ? 'YQ==' : undefined,
        malformed === 'mime' ? ':mime=aW1hZ2UvcG5n' : malformed === 'extra' ? ':extra=value' : '');
      if (fragmented) {
        r.input('\x1b]'); for (const key of data.slice(2, -2)) r.input(key); r.input('\x1b\\');
      } else assert.deepEqual(r.input(data), { consume: true });
      assert.equal((await done).ok, false);
      assert.equal(r.state.unresolved, true, `${status}/${malformed}/${fragmented}/${cancelled}`);
      assert.throws(() => r.begin(), /unresolved/);
      r.input(packet(id, 'EPERM')); assert.equal(r.state.waiting, false); r.dispose();
    }
  }
});

test('clipboard packet/header/chunk limits reject without retaining partial images', async () => {
  for (const input of [
    (id) => packet(id, 'DATA', Buffer.alloc(4097).toString('base64'), ':mime=aW1hZ2UvcG5n'),
    (id) => packet(id, 'DATA', 'YQ==', `:mime=aW1hZ2UvcG5n:extra=${'a'.repeat(600)}`),
  ]) {
    const { instance: r } = reader(); const { request, done } = r.begin(), id = idOf(request);
    r.input(packet(id, 'OK')); assert.deepEqual(r.input(input(id)), { consume: true });
    assert.equal((await done).ok, false); assert.equal(r.state.unresolved, true);
    r.input(packet(id, 'DONE')); assert.equal(r.state.waiting, false); r.dispose();
  }
});

const env = { TMUX: 'private,1,0', TMUX_PANE: '%7' };
function topology(overrides = {}) {
  const output = ['%7\t$2\t1\t1\t0\t0\t0\n', 'on\n', '/dev/fake\tghostty 1.4.0\txterm-ghostty\t0\tattached,focused,UTF-8\n'];
  Object.assign(output, overrides);
  const calls = [];
  return { calls, run: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: output[calls.length - 1] }; } };
}
test('clipboard topology is independent of graphics policy, verifies active pane, focused client and implemented Ghostty', async () => {
  const h = topology();
  const result = await probeClipboardTopology({ mode: 'tui', env, hostCapabilities: { trueColor: false }, showImages: false }, h);
  assert.equal(result.version, '1.4.0'); assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0].file, 'tmux'); assert.equal(h.calls[0].options.env.TMUX, env.TMUX);
  for (const [index, value] of [[0,'%7\t$2\t0\t1\t0\t0\t0'],[0,'%7\t$2\t1\t0\t0\t0\t0'],[0,'%7\t$2\t1\t1\t1\t0\t0'],[0,'%7\t$2\t1\t1\t0\t1\t0'],[1,'off'],
    [2,'/dev/fake\tghostty 1.3.0\txterm-ghostty\t0\tattached,focused'],[2,'/dev/fake\tghostty\txterm-ghostty\t0\tattached,focused'],[2,'/dev/fake\tghostty 1.4.0\ttmux-256color\t0\tattached,focused'],
    [2,'/dev/fake\tghostty 1.4.0\txterm-ghostty\t1\tattached,focused'],[2,'/dev/fake\tghostty 1.4.0\txterm-ghostty\t0\tattached'],[2,'a\na'],[2,'\x1bmalformed']]) {
    await assert.rejects(probeClipboardTopology({ mode: 'tui', env }, topology({ [index]: value })), /requires one focused/);
  }
  const none = topology(); await assert.rejects(probeClipboardTopology({ mode: 'rpc', env }, none)); assert.equal(none.calls.length, 0);
});

test('clipboard topology bounds hung queries, malformed output and missing tmux', async () => {
  for (const run of [() => new Promise(() => {}), async () => { throw new Error('secret stderr'); }, async () => ({ stdout: 'x'.repeat(5000) })]) {
    await assert.rejects(probeClipboardTopology({ mode: 'tui', env }, { run, timeoutMs: 2 }), (error) => !error.message.includes('secret'));
  }
});

function extensionHarness({ consent = true, mode = 'tui', probe = async () => ({ fingerprint: 'same' }) } = {}) {
  const handlers = new Map(), commands = new Map(), notices = [], writes = [], widgets = new Map();
  let input, confirms = 0, unsubscribe = 0;
  const pi = { on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); }, registerCommand(name, command) { commands.set(name, command); } };
  const ctx = { mode, ui: { confirm: async () => { confirms++; return consent; }, notify: (...args) => notices.push(args), setWidget: (key, lines) => widgets.set(key, lines), onTerminalInput: (listener) => { input = listener; return () => { unsubscribe++; }; } } };
  const presentation = { connection: { epoch: 1, tui: { hasOverlay: () => false } }, write: (data) => writes.push(data), bind() {} };
  registerClipboardPaste(pi, { presentation, env, probe });
  const emit = async (name, event = {}) => { let result; for (const handler of handlers.get(name) || []) result = await handler(event, ctx); return result; };
  return { ctx, emit, notices, writes, widgets, input: (data) => input?.(data), command: (args = '') => commands.get('tmux-image-paste').handler(args, ctx), get confirms() { return confirms; }, get unsubscribe() { return unsubscribe; } };
}
async function stage(h) {
  const command = h.command();
  for (let i = 0; i < 10 && !h.writes.length; i++) await Promise.resolve();
  assert.equal(h.writes.length, 1);
  success(h.input, idOf(h.writes[0])); await command;
}

test('clipboard extension only reads after consent, visibly stages, preserves attachments and consumes at interactive handoff', async () => {
  const h = extensionHarness(); await h.emit('session_start'); assert.equal(h.writes.length, 0);
  await stage(h); assert.equal(h.confirms, 1);
  assert.ok([...h.widgets.values()].flat().some((text) => text?.includes('1 PNG pending')));
  const existing = { type: 'image', mimeType: 'image/png', data: 'existing' };
  for (const source of ['rpc','extension']) assert.equal(await h.emit('input', { source, text: 'untouched', images: [existing] }), undefined);
  const result = await h.emit('input', { source: 'interactive', text: 'my prompt', images: [existing] });
  assert.equal(result.text, 'my prompt'); assert.equal(result.images[0], existing); assert.equal(result.images[1].data, PNG.toString('base64'));
  assert.equal(await h.emit('input', { source: 'interactive', text: 'next' }), undefined);
  assert.equal(JSON.stringify(h.notices).includes(PNG.toString('base64')), false);
  await h.emit('session_shutdown'); assert.equal(h.unsubscribe, 1);
});

test('clipboard extension clear, lifecycle, denied consent and non-TUI do not submit or emit', async () => {
  const no = extensionHarness({ consent: false }); await no.emit('session_start'); await no.command(); assert.equal(no.writes.length, 0); await no.emit('session_shutdown');
  const rpc = extensionHarness({ mode: 'rpc' }); await rpc.emit('session_start'); await rpc.command(); assert.equal(rpc.writes.length, 0);
  for (const clear of ['clear', 'session_tree', 'session_shutdown']) {
    const h = extensionHarness(); await h.emit('session_start'); await stage(h);
    if (clear === 'clear') await h.command('clear'); else await h.emit(clear);
    assert.equal(await h.emit('input', { source: 'interactive', text: 'unchanged' }), undefined);
    await h.emit('session_shutdown');
  }
});
