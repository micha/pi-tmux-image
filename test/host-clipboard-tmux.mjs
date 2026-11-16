// Synthetic end-to-end regression through a real PRIVATE tmux inbound parser.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile), repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.PI_TEST_HOST_ROOT;
let tools = true;
try { await run('python3', ['--version']); await run('tmux', ['-V']); } catch { tools = false; }
for (const format of ['csi-u', 'xterm']) for (const fragmented of [false, true]) {
  test(`private tmux + actual ProcessTerminal/TUI/SDK: ${format}, ${fragmented ? 'fragmented' : 'coalesced'} reply`, {
    skip: (!root || !tools) && 'requires PI_TEST_HOST_ROOT, Python 3 and tmux', timeout: 40000,
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-clipboard-real-tmux-'));
    try {
      await mkdir(join(directory, 'package')); await mkdir(join(directory, 'workspace')); await mkdir(join(directory, 'bin')); await mkdir(join(directory, 'agent'));
      await writeFile(join(directory, 'agent/keybindings.json'), JSON.stringify({ 'app.clipboard.pasteImage': [] }));
      for (const name of ['src', 'extensions', 'package.json']) await cp(join(repo, name), join(directory, 'package', name), { recursive: true });
      // Only capability evidence is stubbed. Transport uses absolute real tmux,
      // its PTYs, real inbound key reencoding and public ProcessTerminal.start.
      await writeFile(join(directory, 'bin/tmux'), `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==='display-message') process.stdout.write(process.env.TMUX_PANE+'\\t$2\\t1\\t1\\t0\\t0\\t0\\n');
else if(a[0]==='show-options') process.stdout.write('all\\n');
else if(a[0]==='list-clients') process.stdout.write('/dev/fake\\tghostty 1.4.0\\txterm-ghostty\\t0\\tattached,focused,UTF-8\\n');
else process.exitCode=1;
`, { mode: 0o700 });
      const { stdout } = await run('python3', [join(repo, 'test/clipboard-tmux-driver.py'), directory, root,
        join(repo, 'test/clipboard-tmux-worker.mjs'), process.execPath, format, fragmented ? 'yes' : 'no'],
      { timeout: 35000, maxBuffer: 64 * 1024 });
      const result = JSON.parse(stdout);
      assert.equal(result.ok, true); assert.equal(result.modifyOtherKeys, true);
      assert.equal(result.encodedMarkersObserved, true); assert.equal(result.pendingImage, true);
      assert.equal(result.draftUnchanged, true); assert.equal(result.editorReceivedProtocolOrModalTyping, false); assert.equal(result.outsideInputPreserved, true);
      assert.equal(result.shortcutActivated, true); assert.equal(result.submissions, 0);
      assert.equal(result.automaticTurns, 0); assert.equal(result.realClipboardRead, false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
