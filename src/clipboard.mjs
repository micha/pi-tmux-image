import { createClipboardReader } from './clipboard-protocol.mjs';
import { probeClipboardTopology } from './clipboard-capabilities.mjs';

const KEY = 'pi-tmux-image-clipboard';
const CONSENT = 'Experimental: stay in this focused tmux pane, terminal client and Pi session/process until the read completes, including Ghostty permission prompts. Do not disconnect. Timeout/cancel does NOT cancel the terminal prompt or guarantee no late reply. Fragmented replies may put protocol text in your draft before detection; inspect it manually. No draft is erased and nothing is auto-submitted. Submitted images are stored in the session even when model images are blocked. Continue?';

/** Public extension API only. Separate from image rendering, PDF and viewer pacing. */
export function registerClipboardPaste(pi, { presentation, env = process.env,
  probe = probeClipboardTopology, createReader = createClipboardReader } = {}) {
  let runtime;
  function update(current) {
    if (runtime !== current || current.closed) return;
    const state = current.reader.state;
    const status = state.waiting ? state.unresolved
      ? 'Clipboard: terminal read UNRESOLVED — stay in this pane; resolve its permission prompt.'
      : 'Clipboard: reading PNG — stay in this pane (including permission prompts).'
      : current.pending ? 'Clipboard: 1 PNG pending for next interactive prompt; /tmux-image-paste clear removes it.' : undefined;
    // UI feedback failure must not turn an owned reply into editor input.
    try { current.context.ui.setWidget(KEY, status ? [status] : undefined); } catch {}
  }
  function close() {
    const current = runtime;
    if (!current) return;
    current.closed = true;
    current.attempt?.abort();
    current.reader.dispose();
    current.unsubscribe?.();
    current.pending = undefined;
    try { current.context.ui.setWidget(KEY, undefined); } catch {}
    runtime = undefined;
  }
  pi.on('session_start', (_event, ctx) => {
    close();
    if (ctx.mode !== 'tui' || typeof ctx.ui.onTerminalInput !== 'function' || !env.TMUX || !/^%\d+$/.test(env.TMUX_PANE || '')) return;
    const current = { context: ctx, closed: false, consent: false, busy: false, pending: undefined, attempt: undefined };
    runtime = current;
    current.reader = createReader({ onChange: () => update(current), onWarning: (message) => {
      if (runtime === current && !current.closed) {
        try { current.context.ui.notify(message, 'warning'); } catch {}
      }
    } });
    current.unsubscribe = ctx.ui.onTerminalInput((data) => current.reader.input(data));
  });
  pi.on('session_shutdown', close);
  pi.on('session_tree', () => {
    if (!runtime) return;
    runtime.attempt?.abort(); runtime.reader.cancel(); runtime.pending = undefined; update(runtime);
  });
  presentation.bind({ onDisconnect() { runtime?.attempt?.abort(); runtime?.reader.cancel(); } });
  pi.on('input', (event) => {
    const current = runtime;
    if (!current || current.closed || event.source !== 'interactive' || !current.pending) return;
    // Consume AT HANDOFF, not at persistence/turn ACK. A later transformer may
    // handle the prompt or replace images. Never retry into another user prompt.
    const image = current.pending;
    current.pending = undefined;
    update(current);
    return { action: 'transform', text: event.text, images: [...(event.images || []), image] };
  });
  pi.registerCommand('tmux-image-paste', {
    description: 'Experimental focused-pane clipboard PNG import; clear removes pending image; cancel stops import locally',
    handler: async (args, ctx) => {
      const current = runtime;
      if (!current || current.closed || ctx.mode !== 'tui') {
        ctx.ui.notify('Clipboard import requires interactive Pi with public terminal-input support inside tmux.', 'error'); return;
      }
      const action = args.trim();
      if (action === 'clear') { current.pending = undefined; update(current); ctx.ui.notify('Pending clipboard image removed.', 'info'); return; }
      if (action === 'cancel') {
        current.attempt?.abort(); current.reader.cancel();
        ctx.ui.notify('Stopped locally only. Any terminal permission prompt/read may still be pending; stay in this pane until resolved.', 'warning'); return;
      }
      if (action) { ctx.ui.notify('Usage: /tmux-image-paste [clear|cancel]', 'warning'); return; }
      if (current.busy || current.reader.state.waiting || current.pending) {
        ctx.ui.notify('Clipboard import is busy/unresolved, or a PNG is pending. Resolve the terminal prompt; submit or clear a pending image before another read.', 'warning'); return;
      }
      const attempt = new AbortController();
      current.attempt = attempt; current.busy = true;
      const live = () => runtime === current && !current.closed && !attempt.signal.aborted;
      try {
        if (!current.consent) {
          const agreed = await ctx.ui.confirm('Experimental focused-pane image paste', CONSENT, { signal: attempt.signal });
          if (!live() || !agreed) return;
          current.consent = true;
        }
        if (!presentation.connection || presentation.connection.tui.hasOverlay()) throw new Error('Close other overlays before importing a clipboard image.');
        const before = await probe({ mode: ctx.mode, env, signal: attempt.signal });
        if (!live()) return;
        const connection = presentation.connection;
        if (!connection || connection.tui.hasOverlay()) throw new Error('Clipboard terminal transport is unavailable.');
        const request = current.reader.begin();
        // The write is void and may partially fail: keep unresolved ownership.
        try { presentation.write(request.request); }
        catch { current.reader.cancel(); }
        const result = await request.done;
        if (!live()) return;
        if (!result.ok) { ctx.ui.notify(result.message, 'warning'); return; }
        const after = await probe({ mode: ctx.mode, env, signal: attempt.signal });
        if (!live()) return;
        if (before.fingerprint !== after.fingerprint || presentation.connection?.epoch !== connection.epoch) {
          throw new Error('Clipboard terminal context changed; image discarded. Focus checks cannot prevent tmux reply misrouting.');
        }
        current.pending = result.image;
        update(current);
        ctx.ui.notify('PNG staged for your next interactive prompt; clear with /tmux-image-paste clear. It is consumed when handed to the input pipeline, not on a storage acknowledgement; later input extensions may discard it.', 'info');
      } catch {
        if (live()) ctx.ui.notify('Clipboard import failed its focused Ghostty >=1.4/tmux or transport checks. No image staged; no setting changed.', 'error');
      } finally {
        if (runtime === current && current.attempt === attempt) { current.attempt = undefined; current.busy = false; update(current); }
      }
    },
  });
}
