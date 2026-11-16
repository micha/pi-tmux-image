import { runTmuxQuery } from './capabilities.mjs';

const PANE = '#{pane_id}\t#{session_id}\t#{window_active}\t#{pane_active}\t#{window_linked}\t#{pane_in_mode}\t#{pane_dead}';
const CLIENT = '#{client_name}\t#{client_termtype}\t#{client_termname}\t#{client_control_mode}\t#{client_flags}';
const unavailable = () => new Error('Clipboard import requires one focused Ghostty >=1.4 client and an active pane in one tmux layer; no setting was changed.');

/** Clipboard-specific evidence, never graphics policy or a clipboard read. No cache. */
export async function probeClipboardTopology({ mode, env = process.env, signal } = {}, { run = runTmuxQuery, timeoutMs = 300 } = {}) {
  if (mode !== 'tui' || !env.TMUX || !/^%\d+$/.test(env.TMUX_PANE || '')) throw unavailable();
  signal?.throwIfAborted();
  async function query(args) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timer;
    try {
      const result = await Promise.race([
        run('tmux', args, { timeout: timeoutMs, maxBuffer: 4096, signal: controller.signal,
          env: { ...process.env, TMUX: env.TMUX } }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, timeoutMs); }),
      ]);
      signal?.throwIfAborted();
      const output = result.stdout;
      if (typeof output !== 'string' || Buffer.byteLength(output) > 4096 || /[\x00-\x08\x0b-\x1f\x7f]/.test(output)) throw unavailable();
      return output.replace(/\n$/, '');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  try {
    const pane = env.TMUX_PANE;
    const fields = (await query(['display-message', '-p', '-t', pane, PANE])).split('\t');
    if (fields.length !== 7 || fields[0] !== pane || !/^\$\d+$/.test(fields[1]) ||
        fields.slice(2).join('') !== '11000') throw unavailable();
    const passthrough = await query(['show-options', '-A', '-p', '-v', '-t', pane, 'allow-passthrough']);
    if (!['on', 'all'].includes(passthrough)) throw unavailable();
    const clients = (await query(['list-clients', '-t', fields[1], '-F', CLIENT])).split('\n');
    if (clients.length !== 1) throw unavailable();
    const client = clients[0].split('\t');
    if (client.length !== 5 || !client[0] || client[3] !== '0') throw unavailable();
    const flags = client[4].split(',');
    if (!flags.includes('attached') || !flags.includes('focused') ||
        flags.some((flag) => ['control-mode', 'read-only', 'suspended'].includes(flag))) throw unavailable();
    // Actual client's numeric XTVersion evidence, not TERM_PROGRAM in the pane.
    // Name-only and old identities cannot establish implemented OSC 5522 support.
    const version = /^ghostty\s+(\d+)\.(\d+)\.(\d+)(?:[-+][a-z0-9.-]+)?$/i.exec(client[1]);
    if (!version || !version.slice(1).map(Number).every(Number.isSafeInteger) ||
        Number(version[1]) < 1 || (Number(version[1]) === 1 && Number(version[2]) < 4) ||
        /^(tmux|screen)(?:$|[-.])/i.test(client[2])) throw unavailable();
    return Object.freeze({ fingerprint: JSON.stringify([env.TMUX, pane, fields[1], client[0], client[1]]),
      version: version.slice(1).join('.') });
  } catch { throw unavailable(); }
}
