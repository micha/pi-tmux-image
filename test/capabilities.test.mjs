import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDisplayPolicy, identifyPlaceholderTerminal, resolvePiDisplayPolicy, TmuxCapabilityDetector, runTmuxQuery } from '../src/capabilities.mjs';

const context = {
  mode: 'tui', env: { TMUX: '/tmp/test-tmux,123,0', TMUX_PANE: '%42' },
  hostCapabilities: { images: null, trueColor: true, hyperlinks: false },
};
function fixture(overrides = {}) {
  const state = { pane: '%42\t$7\t1\t0\t1\t0\n', passthrough: 'on\n', clients: '/dev/pts/8\tghostty 1.3.1\txterm-ghostty\t0\n', ...overrides };
  const calls = [];
  const run = async (file, args, options) => {
    calls.push({ file, args, options });
    const key = { 'display-message': 'pane', 'show-options': 'passthrough', 'list-clients': 'clients' }[args[0]];
    const value = state[key];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value();
    return { stdout: value, stderr: '' };
  };
  return { state, calls, run };
}

test('public Pi settings snapshot policy retains disabled provenance and concrete-setting precedence', () => {
  for (const [settings, env, expected] of [
    [{}, {}, { imagePolicy: 'auto', showImages: true }],
    [{ terminal: { images: false } }, { PI_IMAGE_PROTOCOL: 'kitty' }, { imagePolicy: false, showImages: true }],
    [{ terminal: { images: 'kitty' } }, { PI_IMAGE_PROTOCOL: 'none' }, { imagePolicy: 'kitty', showImages: true }],
    [{ terminal: { images: 'iterm2' } }, { PI_IMAGE_PROTOCOL: 'kitty' }, { imagePolicy: 'iterm2', showImages: true }],
    [{ terminal: { images: 'auto', showImages: false } }, { PI_IMAGE_PROTOCOL: 'KiTtY' }, { imagePolicy: 'kitty', showImages: false }],
    [{}, { PI_IMAGE_PROTOCOL: 'none' }, { imagePolicy: false, showImages: true }],
    [{}, { PI_IMAGE_PROTOCOL: '0' }, { imagePolicy: false, showImages: true }],
    [{}, { PI_IMAGE_PROTOCOL: 'invalid' }, { imagePolicy: 'auto', showImages: true }],
    [{ images: { blockImages: true } }, {}, { imagePolicy: 'auto', showImages: true }],
    [{ images: { blockImages: false } }, {}, { imagePolicy: 'auto', showImages: true }],
  ]) {
    const original = JSON.stringify({ settings, env });
    const result = resolvePiDisplayPolicy(settings, env);
    assert.deepEqual(result, expected);
    assert.ok(Object.isFrozen(result));
    assert.equal(JSON.stringify({ settings, env }), original);
  }
});

test('primary client identity precedes TERM fallback, including actual Kitty XTVersion syntax', () => {
  for (const [type, name, family] of [
    ['ghostty 1.3.1', 'xterm-ghostty', 'ghostty'],
    ['kitty(0.40.1)', 'xterm-kitty', 'kitty'],
    ['kitty 0.28.0', 'xterm-kitty', 'kitty'],
    ['', 'xterm-kitty', 'kitty'], ['', 'xterm-ghostty', 'ghostty'],
    ['Ghostty', 'xterm-256color', 'ghostty'],
  ]) {
    const result = identifyPlaceholderTerminal(type, name);
    assert.equal(result.supported, true);
    assert.equal(result.family, family);
    assert.equal(result.source, type ? 'client_termtype' : 'client_termname');
  }
  assert.equal(identifyPlaceholderTerminal('kitty(0.27.1)', 'xterm-kitty').reason, 'old-terminal');
  assert.equal(identifyPlaceholderTerminal('ghostty 0.9.0', 'xterm-ghostty').reason, 'old-terminal');
  for (const [type, name] of [['wezterm 2025', 'xterm-kitty'], ['xterm', 'xterm-ghostty'], ['', 'xterm-256color'], ['not-ghostty', ''], ['kitty 0.40.1 extra', '']]) {
    assert.equal(identifyPlaceholderTerminal(type, name).supported, false);
  }
  assert.equal(identifyPlaceholderTerminal('tmux 3.6a', 'xterm-ghostty').reason, 'nested-multiplexer');
  assert.equal(identifyPlaceholderTerminal('ghostty 1.3.1', 'screen-256color').reason, 'nested-multiplexer');
});

test('PATH queries target the actual pane/session and resolve inherited on/all values', async () => {
  for (const passthrough of ['on', 'all']) {
    const f = fixture({ passthrough: `${passthrough}\n` });
    const detector = new TmuxCapabilityDetector({ run: f.run });
    const result = await detector.probe(context);
    assert.equal(result.supported, true);
    assert.equal(result.passthrough, passthrough);
    assert.equal(result.pane, '%42');
    assert.equal(result.session, '$7');
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.terminal) && Object.isFrozen(result.warnings));
    assert.equal(result.requiresVisiblePane, passthrough === 'on');
    assert.deepEqual(f.calls[1].args, ['show-options', '-A', '-p', '-v', '-t', '%42', 'allow-passthrough']);
    assert.deepEqual(f.calls[2].args.slice(0, 4), ['list-clients', '-t', '$7', '-F']);
    assert.deepEqual(f.calls[0].args.slice(0, 4), ['display-message', '-p', '-t', '%42']);
    assert.ok(f.calls.every((call) => call.file === 'tmux' && call.options.timeout === 300 && call.options.maxBuffer === 8192 && call.options.signal instanceof AbortSignal));
    assert.ok(f.calls.every((call) => call.options.env.TMUX === context.env.TMUX && !call.options.shell));
    assert.ok(f.calls.every((call) => !['set-option', 'set', 'send-keys'].includes(call.args[0])));
  }
});

test('passthrough off, unknown, absent old option, hidden pane and zoom hiding fail closed', async () => {
  for (const [overrides, code] of [
    [{ passthrough: 'off\n' }, 'passthrough-disabled'],
    [{ passthrough: '\n' }, 'unknown-passthrough'],
    [{ passthrough: 'unexpected\n' }, 'unknown-passthrough'],
    [{ passthrough: new Error('unknown option') }, 'query-failed'],
    [{ pane: '%42\t$7\t0\t0\t1\t0\n' }, 'pane-not-visible'],
    [{ pane: '%42\t$7\t1\t1\t0\t0\n' }, 'pane-not-visible'],
  ]) {
    const f = fixture(overrides);
    const result = await new TmuxCapabilityDetector({ run: f.run }).probe(context);
    assert.equal(result.code, code);
    assert.equal(result.supported, false);
    assert.ok(f.calls.length <= 2);
  }
  const f = fixture({ pane: '%42\t$7\t0\t1\t0\t0\n', passthrough: 'all\n' });
  assert.equal((await new TmuxCapabilityDetector({ run: f.run }).probe(context)).supported, true);
});

test('unknown/old/nested clients, no client, multi-client, control mode and linked sessions fail closed', async () => {
  for (const [overrides, code] of [
    [{ clients: '/dev/pts/1\twezterm\txterm-kitty\t0\n' }, 'unknown-terminal'],
    [{ clients: '/dev/pts/1\tkitty(0.27.0)\txterm-kitty\t0\n' }, 'old-terminal'],
    [{ clients: '/dev/pts/1\ttmux 3.6a\ttmux-256color\t0\n' }, 'nested-multiplexer'],
    [{ clients: '' }, 'no-client'],
    [{ clients: '/dev/pts/1\tghostty\txterm-ghostty\t0\n/dev/pts/2\tkitty\txterm-kitty\t0\n' }, 'multiple-clients'],
    [{ clients: 'control\tghostty\txterm-ghostty\t1\n' }, 'control-client'],
    [{ pane: '%42\t$7\t1\t0\t1\t1\n' }, 'linked-window'],
  ]) {
    const f = fixture(overrides);
    const result = await new TmuxCapabilityDetector({ run: f.run }).probe(context);
    assert.equal(result.code, code);
    assert.equal(result.supported, false);
  }
});

test('non-TUI/no-tmux/nested and Pi policy gates never invoke a subprocess', async () => {
  const detector = new TmuxCapabilityDetector({ run: () => assert.fail('subprocess must not run') });
  for (const [override, code] of [
    [{ mode: 'print' }, 'non-interactive'], [{ mode: 'json' }, 'non-interactive'], [{ mode: 'rpc' }, 'non-interactive'],
    [{ env: {} }, 'not-tmux'], [{ env: { TMUX: 'x', TMUX_PANE: '42;evil' } }, 'not-tmux'],
    [{ nested: true }, 'nested-multiplexer'], [{ enabled: false }, 'images-disabled'],
    [{ showImages: false }, 'images-disabled'], [{ imagePolicy: false }, 'images-disabled'],
    [{ imagePolicy: 'none' }, 'images-disabled'], [{ imagePolicy: 'iterm2' }, 'incompatible-policy'],
    [{ imagePolicy: 'force' }, 'invalid-policy'], [{ hostCapabilities: undefined }, 'missing-host-capabilities'],
    [{ hostCapabilities: { images: null, trueColor: false } }, 'truecolor-disabled'],
    [{ hostCapabilities: { images: 'iterm2', trueColor: true } }, 'incompatible-policy'],
    [{ hostCapabilities: { images: 'kitty', trueColor: true } }, 'host-native-conflict'],
    [{ imagePolicy: 'kitty' }, 'host-native-conflict'],
    // Disabling wins over a native conflict; forcing never bypasses another gate.
    [{ showImages: false, imagePolicy: 'kitty' }, 'images-disabled'],
  ]) {
    const input = { ...context, ...override };
    assert.equal(checkDisplayPolicy(input).code, code);
    assert.equal((await detector.probe(input)).code, code);
  }
  assert.equal(checkDisplayPolicy(context), undefined);
});

test('transport visibility check resamples cached on without invalidating or querying during ready rendering', async () => {
  const f = fixture();
  const detector = new TmuxCapabilityDetector({ run: f.run });
  assert.equal((await detector.probe(context)).supported, true);
  f.state.pane = '%42\t$7\t0\t0\t1\t0\n';
  assert.equal((await detector.probe(context)).supported, true, 'ordinary classification cache retains its TTL');
  assert.equal(f.calls.length, 3);
  assert.equal((await detector.probe(context, { checkVisibility: true })).code, 'pane-not-visible');
  assert.equal(f.calls.length, 5, 'transport check refreshes pane/effective option, then rejects before client query');
  detector.invalidate();
  f.state.passthrough = 'all\n';
  assert.equal((await detector.probe(context, { checkVisibility: true })).supported, true);
  const count = f.calls.length;
  await detector.probe(context, { checkVisibility: true });
  assert.equal(f.calls.length, count, 'all path does not have the on visibility constraint');
});

test('host/environment hints do not override actual client or passthrough evidence', async () => {
  const f = fixture({ clients: '/dev/pts/1\t\txterm-256color\t0\n' });
  const detector = new TmuxCapabilityDetector({ run: f.run });
  const result = await detector.probe({ ...context, env: { ...context.env, TERM: 'xterm-kitty', TERM_PROGRAM: 'ghostty', KITTY_WINDOW_ID: '1', PI_IMAGE_PROTOCOL: 'kitty' } });
  assert.equal(result.code, 'unknown-terminal');
  f.state.clients = '/dev/pts/1\t\txterm-kitty\t0\n';
  const fallback = await detector.probe(context, { refresh: true });
  assert.equal(fallback.supported, true);
  assert.equal(fallback.terminal.versionVerified, false);
  assert.equal(fallback.warnings.length, 1);
});

test('successful results cache, expire, explicitly refresh, and invalidate on reconnect', async () => {
  let now = 0;
  const f = fixture();
  const detector = new TmuxCapabilityDetector({ run: f.run, now: () => now, successTtlMs: 100 });
  const first = await detector.probe(context);
  assert.equal(await detector.probe(context), first);
  assert.equal((await detector.probe({ ...context, imagePolicy: false })).code, 'images-disabled');
  assert.equal((await detector.probe({ ...context, hostCapabilities: { images: 'kitty', trueColor: true } })).code, 'host-native-conflict');
  assert.equal(f.calls.length, 3);
  f.state.clients = '/dev/pts/1\tkitty(0.40.1)\txterm-kitty\t0\n';
  now = 99;
  assert.equal((await detector.probe(context)).terminal.family, 'ghostty');
  now = 100;
  assert.equal((await detector.probe(context)).terminal.family, 'kitty');
  assert.equal(f.calls.length, 6);
  f.state.passthrough = 'off\n';
  assert.equal((await detector.probe(context, { refresh: true })).code, 'passthrough-disabled');
  detector.invalidate();
  f.state.passthrough = 'all\n';
  assert.equal((await detector.probe(context)).supported, true);
  assert.equal((await detector.probe({ ...context, env: { ...context.env, TMUX: '/other-server,1,0' } })).supported, true);
  assert.equal(f.calls.at(-1).options.env.TMUX, '/other-server,1,0');
});

test('transient failures have shorter TTL and cannot poison successful future queries', async () => {
  let now = 0;
  const f = fixture({ passthrough: new Error('temporary failure') });
  const detector = new TmuxCapabilityDetector({ run: f.run, now: () => now, failureTtlMs: 10, successTtlMs: 100 });
  assert.equal((await detector.probe(context)).code, 'query-failed');
  f.state.passthrough = 'all\n';
  now = 9;
  assert.equal((await detector.probe(context)).code, 'query-failed');
  assert.equal(f.calls.length, 2);
  now = 10;
  assert.equal((await detector.probe(context)).supported, true);
  assert.equal(f.calls.length, 5);
});

test('malformed, mismatched, overflow and terminal-control output never authorizes graphics', async () => {
  for (const overrides of [
    { pane: '%99\t$7\t1\t0\t1\t0\n' },
    { pane: '%42\t$7\t1\t0\t1\t0\nextra\n' },
    { pane: '%42\t$7\t1\t0\t1\tunknown\n' },
    { clients: 'x\tghostty\txterm-ghostty\t0\x1b[31m\n' },
    { clients: 'x'.repeat(8193) }, { clients: 'malformed\n' },
    { passthrough: 'on\noff\n' },
  ]) {
    const f = fixture(overrides);
    const result = await new TmuxCapabilityDetector({ run: f.run }).probe(context);
    assert.equal(result.supported, false);
    assert.ok(['query-failed', 'unknown-passthrough'].includes(result.code));
    assert.ok(!result.message.includes('\x1b'));
  }
});

test('timeout aborts query, missing executable is explained, and cache never hangs', async () => {
  let aborted = false;
  const detector = new TmuxCapabilityDetector({ timeoutMs: 10, run: (_file, _args, { signal }) => {
    signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } });
  assert.equal((await detector.probe(context)).code, 'query-timeout');
  assert.equal(aborted, true);
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const f = fixture({ pane: missing });
  assert.equal((await new TmuxCapabilityDetector({ run: f.run }).probe(context)).code, 'tmux-missing');
});

test('same-key parallel probes deduplicate; invalidation rejects late successes', async () => {
  let finish;
  const f = fixture({ pane: () => new Promise((resolve) => { finish = resolve; }) });
  const detector = new TmuxCapabilityDetector({ run: f.run });
  const first = detector.probe(context);
  const second = detector.probe(context);
  assert.equal(f.calls.length, 1);
  detector.invalidate();
  finish({ stdout: '%42\t$7\t1\t0\t1\t0\n', stderr: '' });
  assert.equal((await first).code, 'invalidated');
  assert.equal((await second).code, 'invalidated');
  f.state.pane = '%42\t$7\t1\t0\t1\t0\n';
  assert.equal((await detector.probe(context)).supported, true);
});

test('cache and outstanding probes are bounded, including across invalidation', async () => {
  const f = fixture();
  const detector = new TmuxCapabilityDetector({ run: f.run, now: () => 0, maxEntries: 1 });
  await detector.probe(context);
  await detector.probe({ ...context, env: { ...context.env, TMUX: 'other' } });
  const calls = f.calls.length;
  await detector.probe(context);
  assert.equal(f.calls.length, calls + 3); // first cache entry evicted
  const blocked = new TmuxCapabilityDetector({ maxEntries: 1, timeoutMs: 10, run: () => new Promise(() => {}) });
  const pending = blocked.probe(context);
  blocked.invalidate();
  assert.equal((await blocked.probe(context)).code, 'probe-busy');
  assert.equal((await pending).code, 'invalidated');
  for (const options of [{ timeoutMs: 0 }, { maxEntries: 0 }, { failureTtlMs: -1 }, { run: 1 }]) {
    assert.throws(() => new TmuxCapabilityDetector(options));
  }
});

test('real execFile boundary uses timeout/maxBuffer without terminal or shell effects', async () => {
  const result = await runTmuxQuery(process.execPath, ['-e', 'process.stdout.write("on\\n")'], { timeout: 500, maxBuffer: 8192 });
  assert.equal(result.stdout, 'on\n');
  assert.equal(result.stderr, '');
  await assert.rejects(runTmuxQuery(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeout: 10, maxBuffer: 8192 }));
  await assert.rejects(runTmuxQuery(process.execPath, ['-e', 'process.stdout.write("x".repeat(9000))'], { timeout: 500, maxBuffer: 8192 }));
});
