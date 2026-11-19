import { createClipboardReader } from './clipboard-protocol.mjs';
import { probeClipboardTopology } from './clipboard-capabilities.mjs';
import { openClipboardModal } from './clipboard-modal.mjs';
import { CLIPBOARD_SHORTCUT_FILE, DEFAULT_PASTE_SHORTCUT, PASTE_SHORTCUT_CHOICES, readPasteShortcut, savePasteShortcut } from './clipboard-shortcut.mjs';

const KEY = 'pi-tmux-image-clipboard';
const MAX_PENDING_IMAGES = 4, MAX_PENDING_MIB = 16;
const MAX_PENDING_BYTES = MAX_PENDING_MIB * 1024 * 1024;
const pngCount = (count) => `${count} PNG${count === 1 ? '' : 's'}`;
// The reader returns canonical padded base64; count PNG bytes without decoding again.
const pngBytes = (image) => Buffer.byteLength(image.data, 'base64');
const pendingBytes = (images) => images.reduce((total, image) => total + pngBytes(image), 0);

/** Public extension API only. Separate from image rendering, PDF and viewer pacing. */
export function registerClipboardPaste(pi, { presentation, env = process.env, parseKey, matchesKey, truncateToWidth,
  shortcutFile, hasActiveDialog = () => false, probe = probeClipboardTopology, createReader = createClipboardReader } = {}) {
  // Read the preference at factory time. No registration-time tmux probe and
  // no shortcut outside inherited pane context, preserving native dispatch.
  const inPane = () => Boolean(env.TMUX && /^%\d+$/.test(env.TMUX_PANE || ''));
  let shortcut, invalidShortcut = false;
  if (inPane()) {
    try { shortcut = shortcutFile ? readPasteShortcut(shortcutFile).paste : DEFAULT_PASTE_SHORTCUT; }
    catch { invalidShortcut = true; }
  }
  let runtime, configuring;
  let tuiSession = false;
  function notify(current, message, level = 'warning') {
    if (runtime === current && !current.closed) {
      try { current.context.ui.notify(message, level); } catch {}
    }
  }
  function update(current) {
    if (runtime !== current || current.closed) return;
    current.modal?.update();
    const state = current.reader.state;
    const status = state.waiting ? state.unresolved
      ? 'Clipboard: read UNRESOLVED — check terminal permission; stay in this pane.'
      : 'Clipboard: reading PNG — do not type or leave this pane.'
      : current.pending.length ? `Clipboard: ${pngCount(current.pending.length)} pending — /tmux-image paste clear` : undefined;
    try { current.context.ui.setWidget(KEY, status ? [status] : undefined); } catch {}
  }
  function focusLost(current) {
    current.reader.cancel();
    if (!current.focusWarning) {
      current.focusWarning = true;
      notify(current, 'Clipboard dialog lost TUI input focus. Import stopped but the terminal read may remain pending; the dialog was not dismissed. Another UI may receive replies. Resolve the terminal prompt; no focus was changed.');
    }
  }
  function close() {
    tuiSession = false;
    configuring?.abort();
    configuring = undefined;
    const current = runtime;
    if (!current) return;
    if (current.reader.state.waiting) notify(current, 'Pi is leaving a runtime with an unresolved terminal clipboard read. This does not cancel Ghostty permission; late replies cannot be protected in another runtime/process.');
    current.closed = true;
    current.attempt?.abort(); current.reader.dispose(); current.modal?.dispose();
    current.unsubscribe?.(); current.pending = [];
    try { current.context.ui.setWidget(KEY, undefined); } catch {}
    runtime = undefined;
  }
  pi.on('session_start', (_event, ctx) => {
    close();
    tuiSession = ctx.mode === 'tui';
    if (tuiSession && invalidShortcut) notifyShortcutFile(ctx);
    if (!tuiSession || typeof ctx.ui.onTerminalInput !== 'function' || !inPane()) return;
    const current = { context: ctx, closed: false, busy: false, pending: [], attempt: undefined, modal: undefined, removalFailed: false, focusWarning: false };
    runtime = current;
    current.reader = createReader({ parseKey, onChange: () => update(current), onWarning: (message) => notify(current, message) });
    current.unsubscribe = ctx.ui.onTerminalInput((data) => {
      // The visible focused overlay owns input through its public component.
      // Elsewhere only the bounded non-holding late-response observer runs.
      if (current.modal?.focused()) return;
      if (current.modal && current.reader.state.waiting) focusLost(current);
      return current.reader.input(data);
    });
  });
  pi.on('session_shutdown', close);
  pi.on('agent_start', () => { configuring?.abort(); });
  pi.on('session_tree', () => {
    configuring?.abort();
    if (!runtime) return;
    runtime.attempt?.abort(); runtime.reader.cancel(); runtime.pending = []; update(runtime);
  });
  presentation.bind({ onDisconnect() {
    if (!runtime) return;
    runtime.attempt?.abort(); runtime.reader.cancel();
    if (runtime.reader.state.waiting) notify(runtime, 'Clipboard transport disconnected; import stopped, but any visible dialog keeps draining while its TUI is alive. Terminal permission was not cancelled.');
  } });
  pi.on('input', (event) => {
    const current = runtime;
    if (!current || current.closed || event.source !== 'interactive' || !current.pending.length) return;
    // Consume AT HANDOFF, not at persistence/turn ACK. Later handlers may discard.
    const images = current.pending; current.pending = []; update(current);
    return { action: 'transform', text: event.text, images: [...(event.images || []), ...images] };
  });
  function notifyShortcutFile(ctx) {
    ctx.ui.notify(`Could not read ${CLIPBOARD_SHORTCUT_FILE}. Repair or remove it, then run /reload. /tmux-image paste still works.`, 'warning');
  }
  function checkConfigure(ctx) {
    if (!tuiSession || ctx.mode !== 'tui' || !ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages()) {
      throw new Error('Configure the paste shortcut from an idle interactive Pi session.');
    }
    if (runtime?.busy || runtime?.modal || runtime?.reader.state.waiting || hasActiveDialog() || presentation.connection?.tui.hasOverlay()) {
      throw new Error('Finish any clipboard read and close the current dialog/viewer before configuring the paste shortcut.');
    }
  }
  const clipboard = {
    actions: ['clear', 'cancel'],
    async configure(ctx) {
      if (configuring) throw new Error('The paste shortcut picker is already open.');
      checkConfigure(ctx);
      let saved;
      try { saved = readPasteShortcut(shortcutFile); }
      catch { notifyShortcutFile(ctx); return; }
      const controller = new AbortController();
      configuring = controller;
      try {
        const current = saved.paste;
        const keys = [current, ...PASTE_SHORTCUT_CHOICES.filter((key) => key !== current)];
        const marker = saved.raw === null ? ' (default)' : ' (saved)';
        const options = keys.map((key) => (key === 'off' ? 'Off' : key) + (key === current ? marker : ''));
        const choice = await ctx.ui.select('Clipboard paste shortcut', options, { signal: controller.signal });
        if (controller.signal.aborted || choice === undefined) return;
        checkConfigure(ctx);
        const key = keys[options.indexOf(choice)];
        if (!key) throw new Error('Unknown paste shortcut selection.');
        if (key === current) return;
        savePasteShortcut(shortcutFile, saved.raw, key);
        ctx.ui.notify('Paste shortcut saved. Run /reload to apply it.' +
          (runtime?.pending.length ? ' Submit or clear staged PNGs first.' : ''), 'info');
      } finally { if (configuring === controller) configuring = undefined; }
    },
    async paste(ctx, args = '') {
      const current = runtime;
      if (!current || current.closed || ctx.mode !== 'tui') {
        ctx.ui.notify('Clipboard import requires interactive Pi with public terminal-input support inside tmux.', 'error'); return;
      }
      const action = args.trim();
      if (action === 'clear') { current.pending = []; update(current); notify(current, 'Pending clipboard PNGs cleared.', 'info'); return; }
      if (action === 'cancel') {
        current.attempt?.abort(); current.reader.cancel();
        notify(current, 'Stopped importing locally only; the dialog keeps draining. Resolve any terminal permission prompt. Leaving the dialog explicitly can expose late replies.'); return;
      }
      if (action) { notify(current, `Usage: /tmux-image paste [${clipboard.actions.join('|')}]`); return; }
      if (configuring) { notify(current, 'Close the paste shortcut picker before pasting.'); return; }
      if (current.busy || current.reader.state.waiting || current.modal) {
        notify(current, 'Clipboard import is still running or unresolved. Resolve any terminal permission prompt before pasting again.'); return;
      }
      if (current.pending.length >= MAX_PENDING_IMAGES || pendingBytes(current.pending) >= MAX_PENDING_BYTES) {
        notify(current, `Clipboard queue is full (${MAX_PENDING_IMAGES} PNGs or ${MAX_PENDING_MIB} MiB total). Submit your prompt or use /tmux-image paste clear.`); return;
      }
      const attempt = new AbortController(); current.attempt = attempt; current.busy = true;
      const live = () => runtime === current && !current.closed && !attempt.signal.aborted;
      try {
        if (typeof parseKey !== 'function' || typeof matchesKey !== 'function' || typeof truncateToWidth !== 'function') throw new Error();
        if (!presentation.connection || presentation.connection.tui.hasOverlay()) throw new Error();
        const before = await probe({ mode: ctx.mode, env, signal: attempt.signal });
        if (!live()) return;
        const connection = presentation.connection;
        if (!connection || connection.tui.hasOverlay()) throw new Error();
        current.removalFailed = false; current.focusWarning = false;
        let modal;
        modal = openClipboardModal({ tui: connection.tui, parseKey, matchesKey, truncateToWidth, reader: current.reader,
          cancelPreparation: () => attempt.abort(), isCurrent: () => runtime === current && !current.closed && current.modal === modal,
          onFocusLost: () => focusLost(current),
          onClosed: (rendered, removed) => {
            if (removed && current.modal === modal) current.modal = undefined;
            if (!rendered) current.removalFailed = true; // Sticky for this import, even after cleanup retry.
          },
          onLeave: () => { update(current); notify(current, 'Clipboard dialog left explicitly. The terminal read remains unresolved; late replies may contaminate your draft. New reads remain blocked until a clean owned completion.'); },
        });
        current.modal = modal;
        if (!modal.ready || !live() || !modal.focused()) {
          modal.close();
          if (live()) throw new Error('Clipboard dialog was not visibly ready.');
          return;
        }
        // Install and render the owned input component BEFORE beginning/writing.
        modal.markEmitted();
        const request = current.reader.begin();
        try { presentation.write(request.request); } catch { current.reader.cancel(); }
        const result = await request.done;
        if (!live()) return;
        if (!result.ok) { notify(current, result.message); return; }
        const after = await probe({ mode: ctx.mode, env, signal: attempt.signal });
        if (!live()) return;
        if (before.fingerprint !== after.fingerprint || presentation.connection?.epoch !== connection.epoch || current.removalFailed || current.modal) throw new Error();
        // Enforce the aggregate cap against what's still staged, after a clean
        // read. An image that doesn't fit never changes the queue or quarantine.
        if (pendingBytes(current.pending) + pngBytes(result.image) > MAX_PENDING_BYTES) {
          notify(current, `This PNG would exceed the ${MAX_PENDING_MIB} MiB pending limit. Paste a smaller PNG, submit your prompt, or use /tmux-image paste clear.`); return;
        }
        current.pending.push(result.image); update(current);
        const label = current.pending.length === 1 ? 'PNG' : pngCount(current.pending.length);
        notify(current, `${label} ready for your next prompt.`, 'info');
      } catch {
        if (current.modal && !current.modal.emitted) current.modal.close();
        if (live()) notify(current, 'Clipboard import failed its focused Ghostty >=1.4/tmux, dialog or transport checks. No image staged; no setting changed.', 'error');
      } finally {
        if (runtime === current && current.attempt === attempt) { current.attempt = undefined; current.busy = false; update(current); }
      }
    },
  };
  if (shortcut && shortcut !== 'off') pi.registerShortcut(shortcut, {
    description: 'Paste a clipboard PNG',
    handler: (ctx) => clipboard.paste(ctx),
  });
  return clipboard;
}
