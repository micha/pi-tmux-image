// Diagnostic regression evidence, not clipboard feature acceptance. Uses only
// the host's public package exports and synthetic input, never a real terminal.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = process.env.PI_TEST_TUI_ROOT;
const host = root ? await import(pathToFileURL(join(root, 'dist/index.js')).href) : undefined;
const version = root ? JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version : undefined;
const options = { skip: !root && 'set PI_TEST_TUI_ROOT to installed pi-tui package root' };
const packet = '\x1b]5522;type=read:status=DATA:id=owned-1:mime=aW1hZ2UvcG5n;c3ludGhldGlj\x1b\\';

function harness() {
  const input = new host.StdinBuffer();
  const events = [], keys = [], pastes = [];
  let onInput;
  const terminal = {
    columns: 80, rows: 24, kittyProtocolActive: false,
    start(callback) { onInput = callback; }, stop() {}, write() {},
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    async drainInput() {},
  };
  const tui = new host.TuiMainScreen(terminal);
  const component = { render() { return []; }, invalidate() {}, handleInput(data) { keys.push(data); } };
  tui.addChild(component);
  tui.setFocus(component);
  tui.addInputListener((data) => { events.push(data); });
  input.on('data', (data) => onInput(data));
  input.on('paste', (data) => { pastes.push(data); onInput(`\x1b[200~${data}\x1b[201~`); });
  tui.start();
  return { input, events, keys, pastes, dispose() { input.destroy(); tui.stop(); } };
}

test('public host: complete synthetic OSC 5522 reaches input listener as one packet', options, () => {
  const h = harness();
  try {
    h.input.process(packet);
    assert.deepEqual(h.events, [packet]);
  } finally { h.dispose(); }
});

test('public host: delayed OSC 5522 fragment becomes Alt+] and printable payload keys', options, async (t) => {
  t.diagnostic(`pi-tui ${version}; default StdinBuffer timing; synthetic data only`);
  const h = harness();
  try {
    const split = packet.indexOf('c3ludG') + 4;
    h.input.process(packet.slice(0, split));
    assert.deepEqual(h.events, []);
    // Default sequence timeout is 50 ms. Simulates network fragmentation, not
    // a clipboard permission delay (which is before packets are sent).
    await delay(100);
    assert.equal(h.events[0], '\x1b]');
    assert.equal(h.events.slice(1).join(''), packet.slice(2, split));
    assert.ok(h.events.includes('c'), 'synthetic base64 prefix has reached the listener as a key');
    assert.ok(h.keys.includes('c'), 'the focused component receives the printable fragment');
    h.input.process(packet.slice(split));
    assert.equal(h.events.join(''), packet);
    assert.ok(h.events.length > 20, 'packet was not preserved as a control string');
  } finally { h.dispose(); }
});

test('public host: ordinary Alt+] uses the same ambiguous first listener event', options, async () => {
  const h = harness();
  try {
    h.input.process('\x1b]');
    await delay(100);
    assert.deepEqual(h.events, ['\x1b]']);
    h.input.process('plain text');
    assert.equal(h.keys.join(''), '\x1b]plain text');
  } finally { h.dispose(); }
});

test('public host: normal text and bracketed paste remain ordinary input', options, () => {
  const h = harness();
  try {
    h.input.process('plain text');
    assert.equal(h.keys.join(''), 'plain text');
    h.input.process('\x1b[200~literal 5522 text\x1b[201~');
    assert.deepEqual(h.pastes, ['literal 5522 text']);
    assert.equal(h.keys.at(-1), '\x1b[200~literal 5522 text\x1b[201~');
  } finally { h.dispose(); }
});
