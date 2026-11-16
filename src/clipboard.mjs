import { createClipboardReader } from './clipboard-protocol.mjs';
import { probeClipboardTopology } from './clipboard-capabilities.mjs';
import { openClipboardModal } from './clipboard-modal.mjs';

const KEY = 'pi-tmux-image-clipboard';
const CONSENT = 'Experimental: a visible Reading clipboard—do not type dialog will capture input instead of your draft. Stay in this focused tmux pane, client and Pi session/process, including Ghostty permission prompts; do not disconnect. Ctrl+C cancels import but keeps the dialog draining. Timeout/cancel does NOT cancel the terminal permission prompt/read. Ctrl+Q twice explicitly leaves anyway; late replies may then contaminate your draft and new reads remain blocked. Nothing is auto-submitted or erased. Submitted images are stored even when model images are blocked. Continue?';

/** Public extension API only. Separate from image rendering, PDF and viewer pacing. */
export function registerClipboardPaste(pi, { presentation, env = process.env, parseKey, matchesKey, truncateToWidth,
  probe = probeClipboardTopology, createReader = createClipboardReader } = {}) {
  // Factory-time opt-in: flags are not resolved yet and late registration would
  // miss host shortcut discovery. Never register a disabled/default shortcut.
  const shortcutValue = env.PI_TMUX_IMAGE_PASTE_SHORTCUT;
  const shortcut = ['ctrl+v', 'ctrl+shift+v', 'ctrl+alt+v'].includes(shortcutValue) ? shortcutValue : undefined;
  const invalidShortcut = Boolean(shortcutValue) && !shortcut;
  let runtime;
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
      ? 'Clipboard: terminal read UNRESOLVED — resolve its permission prompt; do not retry or leave this pane.'
      : 'Clipboard: reading PNG in input-owning dialog — do not type or leave this pane.'
      : current.pending ? 'Clipboard: 1 PNG pending for next interactive prompt; /tmux-image-paste clear removes it.' : undefined;
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
    const current = runtime;
    if (!current) return;
    if (current.reader.state.waiting) notify(current, 'Pi is leaving a runtime with an unresolved terminal clipboard read. This does not cancel Ghostty permission; late replies cannot be protected in another runtime/process.');
    current.closed = true;
    current.attempt?.abort(); current.reader.dispose(); current.modal?.dispose();
    current.unsubscribe?.(); current.pending = undefined;
    try { current.context.ui.setWidget(KEY, undefined); } catch {}
    runtime = undefined;
  }
  pi.on('session_start', (_event, ctx) => {
    close();
    if (ctx.mode !== 'tui' || typeof ctx.ui.onTerminalInput !== 'function' || !env.TMUX || !/^%\d+$/.test(env.TMUX_PANE || '')) return;
    const current = { context: ctx, closed: false, consent: false, busy: false, pending: undefined, attempt: undefined, modal: undefined, removalFailed: false, focusWarning: false };
    runtime = current;
    current.reader = createReader({ parseKey, onChange: () => update(current), onWarning: (message) => notify(current, message) });
    current.unsubscribe = ctx.ui.onTerminalInput((data) => {
      // The visible focused overlay owns input through its public component.
      // Elsewhere only the bounded non-holding late-response observer runs.
      if (current.modal?.focused()) return;
      if (current.modal && current.reader.state.waiting) focusLost(current);
      return current.reader.input(data);
    });
    if (invalidShortcut) notify(current, 'Invalid PI_TMUX_IMAGE_PASTE_SHORTCUT; use ctrl+v, ctrl+shift+v or ctrl+alt+v. No shortcut registered; /tmux-image-paste remains available.');
    else if (shortcut) notify(current, `Clipboard shortcut ${shortcut} requested. If Pi accepts it, it intentionally replaces that key's native action; Cmd+V is unchanged. Check /hotkeys and host conflict warnings if it does not activate; reserved keys are not overridden.`, 'info');
  });
  pi.on('session_shutdown', close);
  pi.on('session_tree', () => {
    if (!runtime) return;
    runtime.attempt?.abort(); runtime.reader.cancel(); runtime.pending = undefined; update(runtime);
  });
  presentation.bind({ onDisconnect() {
    if (!runtime) return;
    runtime.attempt?.abort(); runtime.reader.cancel();
    if (runtime.reader.state.waiting) notify(runtime, 'Clipboard transport disconnected; import stopped, but any visible dialog keeps draining while its TUI is alive. Terminal permission was not cancelled.');
  } });
  pi.on('input', (event) => {
    const current = runtime;
    if (!current || current.closed || event.source !== 'interactive' || !current.pending) return;
    // Consume AT HANDOFF, not at persistence/turn ACK. Later handlers may discard.
    const image = current.pending; current.pending = undefined; update(current);
    return { action: 'transform', text: event.text, images: [...(event.images || []), image] };
  });
  const command = {
    description: 'Experimental focused-pane PNG paste dialog; clear removes pending image; cancel keeps draining',
    handler: async (args, ctx) => {
      const current = runtime;
      if (!current || current.closed || ctx.mode !== 'tui') {
        ctx.ui.notify('Clipboard import requires interactive Pi with public terminal-input support inside tmux.', 'error'); return;
      }
      const action = args.trim();
      if (action === 'clear') { current.pending = undefined; update(current); notify(current, 'Pending clipboard image removed.', 'info'); return; }
      if (action === 'cancel') {
        current.attempt?.abort(); current.reader.cancel();
        notify(current, 'Stopped importing locally only; the dialog keeps draining. Resolve any terminal permission prompt. Leaving the dialog explicitly can expose late replies.'); return;
      }
      if (action) { notify(current, 'Usage: /tmux-image-paste [clear|cancel]'); return; }
      if (current.busy || current.reader.state.waiting || current.pending || current.modal) {
        notify(current, 'Clipboard import is busy/unresolved, or a PNG is pending. Resolve the terminal prompt; submit or clear a pending image before another read.'); return;
      }
      const attempt = new AbortController(); current.attempt = attempt; current.busy = true;
      const live = () => runtime === current && !current.closed && !attempt.signal.aborted;
      try {
        if (!current.consent) {
          const agreed = await ctx.ui.confirm('Experimental focused-pane paste dialog', CONSENT, { signal: attempt.signal });
          if (!live() || !agreed) return;
          current.consent = true;
        }
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
        current.pending = result.image; update(current);
        notify(current, 'PNG staged for your next interactive prompt; clear with /tmux-image-paste clear. Consumed at input handoff, not a storage acknowledgement; later extensions may discard it.', 'info');
      } catch {
        if (current.modal && !current.modal.emitted) current.modal.close();
        if (live()) notify(current, 'Clipboard import failed its focused Ghostty >=1.4/tmux, dialog or transport checks. No image staged; no setting changed.', 'error');
      } finally {
        if (runtime === current && current.attempt === attempt) { current.attempt = undefined; current.busy = false; update(current); }
      }
    },
  };
  pi.registerCommand('tmux-image-paste', command);
  if (shortcut) pi.registerShortcut(shortcut, {
    description: 'Open the clipboard PNG paste dialog (intentional opted key replacement)',
    handler: (ctx) => command.handler('', ctx),
  });
}
