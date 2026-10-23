import { execFile } from 'node:child_process';

const PANE_FORMAT = '#{pane_id}\t#{session_id}\t#{window_active}\t#{window_zoomed_flag}\t#{pane_active}\t#{window_linked}';
const CLIENT_FORMAT = '#{client_name}\t#{client_termtype}\t#{client_termname}\t#{client_control_mode}';
const MAX_OUTPUT_BYTES = 8192;

/** PATH-resolved, argument-array-only query. No graphics or settings writes. */
export function runTmuxQuery(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, shell: false, killSignal: 'SIGKILL', encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function denied(code, message, details = {}) {
  return freeze({ supported: false, code, message, ...details });
}

/** Supply pi.getSettings() from a live public extension API handler, not ctx. */
export function resolvePiDisplayPolicy(settings, env = process.env) {
  const terminal = settings?.terminal;
  const preference = terminal?.images;
  // Pi auto/unset settings leave the environment fallback active. Only concrete
  // settings override it; exactly matches installed public capability behavior.
  const environment = typeof env.PI_IMAGE_PROTOCOL === 'string' ? env.PI_IMAGE_PROTOCOL.toLowerCase() : '';
  const imagePolicy = preference === false || preference === 'kitty' || preference === 'iterm2'
    ? preference
    : environment === 'kitty' || environment === 'iterm2' ? environment
      : environment === 'none' || environment === '0' ? false : 'auto';
  return Object.freeze({ imagePolicy, showImages: terminal?.showImages ?? true });
}

/** Synchronous public-policy gate, also used before returning cached ready rows. */
export function checkDisplayPolicy({ mode, env = process.env, hostCapabilities,
  imagePolicy = 'auto', showImages = true, enabled = true, nested = false } = {}) {
  if (mode !== 'tui') return denied('non-interactive', 'Local graphics require interactive Pi inside tmux.');
  if (!env.TMUX || !/^%\d+$/.test(env.TMUX_PANE ?? '')) return denied('not-tmux', 'Local graphics require interactive Pi inside tmux with a valid TMUX/TMUX_PANE; no graphics were sent.');
  if (nested) return denied('nested-multiplexer', 'Nested tmux is unsupported by the single-layer graphics transport.');
  if (!enabled || !showImages || imagePolicy === false || imagePolicy === 'none') {
    return denied('images-disabled', 'Local images are disabled by the supplied Pi/display policy.');
  }
  if (!['auto', 'kitty', 'iterm2'].includes(imagePolicy)) return denied('invalid-policy', 'Pass the effective Pi image preference: auto, kitty, iterm2 or false.');
  if (imagePolicy === 'iterm2') return denied('incompatible-policy', 'The explicit iTerm2 image preference is incompatible with Kitty placeholders.');
  if (!hostCapabilities || ![null, 'kitty', 'iterm2'].includes(hostCapabilities.images) || typeof hostCapabilities.trueColor !== 'boolean') {
    return denied('missing-host-capabilities', 'Supply Pi public getCapabilities() output before allowing graphics.');
  }
  if (hostCapabilities.images === 'kitty' || imagePolicy === 'kitty') {
    return denied('host-native-conflict', 'Native Kitty mode may let Pi clear untracked extension uploads; this host ownership conflict is unsupported. Keep Pi image detection automatic in tmux; no setting was changed.');
  }
  if (hostCapabilities.images === 'iterm2') return denied('incompatible-policy', 'Pi currently selects iTerm2 images, not Kitty placeholders.');
  if (!hostCapabilities.trueColor) return denied('truecolor-disabled', 'Pi reports truecolor disabled; 24-bit placeholder IDs require truecolor.');
  return undefined;
}

/** Family allowlist, not a terminal negotiation. A nonempty type takes priority. */
export function identifyPlaceholderTerminal(termtype, termname) {
  const type = termtype.trim().toLowerCase().replace(/^(kitty)\(([^()]*)\)$/, '$1 $2');
  const name = termname.trim().toLowerCase();
  if (/^(?:tmux|screen)(?:$|[ -])/.test(type) || /^(?:tmux|screen)(?:$|[-.])/.test(name)) {
    return { supported: false, reason: 'nested-multiplexer' };
  }
  if (type) {
    const match = /^(ghostty|kitty)(?:\s+(\d+)\.(\d+)\.(\d+)(?:[-+][a-z0-9.-]+)?)?$/.exec(type);
    if (!match) return { supported: false, reason: 'unknown-terminal' };
    const [, family, major, minor, patch] = match;
    if (major !== undefined) {
      const version = [Number(major), Number(minor), Number(patch)];
      if (!version.every(Number.isSafeInteger)) return { supported: false, reason: 'unknown-terminal' };
      if ((family === 'kitty' && version[0] === 0 && version[1] < 28) ||
          (family === 'ghostty' && version[0] < 1)) {
        return { supported: false, reason: 'old-terminal', family, version: version.join('.') };
      }
      return { supported: true, family, source: 'client_termtype', version: version.join('.'), versionVerified: true };
    }
    return { supported: true, family, source: 'client_termtype', version: null, versionVerified: false };
  }
  const family = name === 'xterm-ghostty' ? 'ghostty' : name === 'xterm-kitty' ? 'kitty' : null;
  return family
    ? { supported: true, family, source: 'client_termname', version: null, versionVerified: false }
    : { supported: false, reason: 'unknown-terminal' };
}

function lines(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT_BYTES || /[\x00-\x08\x0b-\x1f\x7f]/.test(output)) {
    throw new Error('Invalid tmux output');
  }
  return output.replace(/\n$/, '').split('\n');
}

/** Runtime-only detector; does not read files, mutate Pi capabilities or configure tmux. */
export class TmuxCapabilityDetector {
  #run;
  #now;
  #timeout;
  #successTtl;
  #failureTtl;
  #maxEntries;
  #generation = 0;
  #cache = new Map();
  #pending = new Map();
  #active = 0;

  constructor({ run = runTmuxQuery, now = Date.now, timeoutMs = 300,
    successTtlMs = 5000, failureTtlMs = 250, maxEntries = 32 } = {}) {
    if (typeof run !== 'function' || typeof now !== 'function') throw new TypeError('run and now must be functions');
    for (const [name, value] of Object.entries({ timeoutMs, successTtlMs, failureTtlMs, maxEntries })) {
      if (!Number.isSafeInteger(value) || value < (name.endsWith('TtlMs') ? 0 : 1)) throw new RangeError(`${name} is out of range`);
    }
    this.#run = run;
    this.#now = now;
    this.#timeout = timeoutMs;
    this.#successTtl = successTtlMs;
    this.#failureTtl = failureTtlMs;
    this.#maxEntries = maxEntries;
  }

  /** Reconnect/config change: discard cache and reject outstanding stale successes. */
  invalidate() {
    this.#generation++;
    this.#cache.clear();
    this.#pending.clear();
  }

  async probe(input = {}, { refresh = false, checkVisibility = false } = {}) {
    if (refresh) this.invalidate();
    // These gates perform NO subprocess work, including on cache hits.
    const rejected = checkDisplayPolicy(input);
    if (rejected) return rejected;
    const { env = process.env } = input;
    const pane = env.TMUX_PANE;
    const key = JSON.stringify([env.TMUX, pane]);
    const cached = this.#cache.get(key);
    // `on` can stop forwarding as soon as visibility changes. Transport callers
    // resample that path without invalidating other simultaneous inspections.
    if (cached && this.#now() < cached.expires && !(checkVisibility && cached.result.requiresVisiblePane)) return cached.result;
    if (this.#pending.has(key)) return this.#pending.get(key);
    if (this.#active >= this.#maxEntries) return denied('probe-busy', 'Too many capability queries are in flight; retry later.');
    const generation = this.#generation;
    this.#active++;
    const promise = this.#inspect(pane, env.TMUX).then((result) => {
      if (generation !== this.#generation) return denied('invalidated', 'Capability query was invalidated; re-evaluate before uploading.');
      this.#cache.delete(key);
      this.#cache.set(key, { result, expires: this.#now() + (result.supported ? this.#successTtl : this.#failureTtl) });
      while (this.#cache.size > this.#maxEntries) this.#cache.delete(this.#cache.keys().next().value);
      return result;
    }).finally(() => {
      this.#active--;
      if (this.#pending.get(key) === promise) this.#pending.delete(key);
    });
    this.#pending.set(key, promise);
    return promise;
  }

  async #query(args, tmux) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        this.#run('tmux', args, { timeout: this.#timeout, maxBuffer: MAX_OUTPUT_BYTES,
          signal: controller.signal, env: { ...process.env, TMUX: tmux } }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            const error = new Error('Tmux query timed out'); error.code = 'ETIMEDOUT'; reject(error);
          }, this.#timeout);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async #inspect(pane, tmux) {
    try {
      const paneOutput = await this.#query(['display-message', '-p', '-t', pane, PANE_FORMAT], tmux);
      const paneLines = lines(paneOutput.stdout);
      if (paneLines.length !== 1) throw new Error('Invalid pane output');
      const fields = paneLines[0].split('\t');
      const [actualPane, session, activeWindow, zoomed, activePane, linked] = fields;
      if (fields.length !== 6 || actualPane !== pane || !/^\$\d+$/.test(session) ||
          ![activeWindow, zoomed, activePane, linked].every((value) => value === '0' || value === '1')) {
        throw new Error('Invalid pane metadata');
      }
      if (linked === '1') return denied('linked-window', 'A window linked to multiple sessions is outside this detector’s single-session client scope.');
      const optionOutput = await this.#query(['show-options', '-A', '-p', '-v', '-t', pane, 'allow-passthrough'], tmux);
      const optionLines = lines(optionOutput.stdout);
      if (optionLines.length !== 1 || !['on', 'all', 'off'].includes(optionLines[0])) {
        return denied('unknown-passthrough', 'Cannot establish effective allow-passthrough; an absent/unknown option is not permission.');
      }
      const passthrough = optionLines[0];
      if (passthrough === 'off') return denied('passthrough-disabled', 'Effective allow-passthrough is off. Configure it yourself if graphics are desired; no configuration was changed.', { pane, passthrough });
      if (passthrough === 'on' && (activeWindow !== '1' || (zoomed === '1' && activePane !== '1'))) {
        return denied('pane-not-visible', 'allow-passthrough=on forwards only visible panes. Re-evaluate when this pane is visible, or deliberately configure all yourself.', { pane, passthrough });
      }
      const clientsOutput = await this.#query(['list-clients', '-t', session, '-F', CLIENT_FORMAT], tmux);
      const clientLines = lines(clientsOutput.stdout);
      if (clientLines.length === 1 && clientLines[0] === '') return denied('no-client', 'No client is attached to this pane’s session.');
      if (clientLines.length !== 1) return denied('multiple-clients', 'Multiple attached clients are unsupported: one selected client cannot establish graphics support for the entire path.');
      const clientFields = clientLines[0].split('\t');
      const [name, termtype, termname, control] = clientFields;
      if (clientFields.length !== 4 || !name || !['0', '1'].includes(control)) throw new Error('Invalid client metadata');
      if (control === '1') return denied('control-client', 'A tmux control-mode client does not establish a terminal graphics path.');
      const terminal = identifyPlaceholderTerminal(termtype, termname);
      if (!terminal.supported) return denied(terminal.reason, terminal.reason === 'nested-multiplexer'
        ? 'The tmux client is another multiplexer; a single wrapper cannot establish nested passthrough.'
        : 'The attached client is not a recognized current Ghostty/Kitty Unicode-placeholder terminal.', { pane, passthrough, terminal });
      return freeze({ supported: true, code: 'supported', message: 'Recognized single-layer tmux Unicode-placeholder path.',
        pane, session, passthrough, terminal,
        warnings: terminal.versionVerified ? [] : ['Terminal name has no version: assumes current Ghostty (>=1.0) or Kitty (>=0.28); this is identification, not feature negotiation.'],
        requiresVisiblePane: passthrough === 'on' });
    } catch (error) {
      const code = error.code === 'ENOENT' ? 'tmux-missing'
        : error.code === 'ETIMEDOUT' || error.name === 'AbortError' || error.killed ? 'query-timeout' : 'query-failed';
      return denied(code, code === 'tmux-missing' ? 'tmux was not found on PATH.'
        : code === 'query-timeout' ? 'A bounded tmux capability query timed out; re-evaluate before uploading.'
        : 'A tmux capability query failed or returned malformed output; no graphics are authorized.');
    }
  }
}
