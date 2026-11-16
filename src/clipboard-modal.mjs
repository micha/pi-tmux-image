const OSC = '\x1b]5522;', ST = '\x1b\\';

/** Deliberate modal input only. Never use this assembler as an editor listener. */
export function createClipboardAssembler({ parseKey, packet, malformed, maxPacket = 8192 }) {
  let frame = '', escape = false;
  function begin() {
    if (frame) malformed(frame);
    frame = '\x1b]'; escape = false;
  }
  function end() {
    if (frame) packet(frame + ST);
    frame = ''; escape = false;
  }
  function char(value) {
    if (escape) {
      escape = false;
      if (value === ']') { begin(); return; }
      if (value === '\\') { end(); return; }
      if (frame) { malformed(frame); frame = ''; }
    }
    if (value === '\x1b') { escape = true; return; }
    if (value === '\x9d') { begin(); return; }
    if (value === '\x9c' || value === '\x07') { end(); return; }
    if (!frame) return; // Visible dialog owns non-response typing; no draft replay.
    if (!/^[\x20-\x7e]$/.test(value)) { malformed(frame); frame = ''; return; }
    frame += value;
    if (frame.length > maxPacket || (frame.length <= OSC.length && !OSC.startsWith(frame))) {
      malformed(frame); frame = '';
    }
  }
  return {
    input(data) {
      const key = parseKey(data);
      if (key === 'alt+]') { begin(); return; }
      if (key === 'alt+\\') { end(); return; }
      // Real StdinBuffer emits intact raw control strings or single keys. The
      // character path also handles coalesced strings and split raw ESC/ST.
      for (const value of data) char(value);
    },
    reset() { frame = ''; escape = false; },
  };
}

/** Own only our public overlay handle. No editor replacement or terminal modes. */
export function openClipboardModal({ tui, parseKey, matchesKey, truncateToWidth, reader,
  cancelPreparation, onLeave, onClosed, onFocusLost, isCurrent }) {
  let handle, closed = false, exitArmed = false, emitted = false, draining = false;
  let removalFailed = false, hasFocus = false, closing = false, ready = true, cleanupOnly = false;
  const assembler = createClipboardAssembler({ parseKey,
    packet: (data) => reader.input(data), malformed: (data) => reader.rejectFrame(data) });
  function render(width) {
    const state = reader.state;
    return [
      removalFailed ? 'Clipboard dialog cleanup failed — Ctrl+Q retries owned removal.' : state.unresolved ? 'Clipboard read unresolved — waiting/draining. Do not type.' : 'Reading clipboard — do not type.',
      'Stay in this tmux pane, terminal client and Pi runtime.',
      'Ghostty permission may still be pending; resolve it in the terminal.',
      'Ctrl+C: cancel image import, KEEP this dialog draining.',
      'Timeout/cancel does NOT cancel the terminal permission prompt/read.',
      exitArmed ? 'WARNING: leaving can put late clipboard text in your draft.' : 'Ctrl+Q: show explicit leave-anyway warning. Escape does not leave.',
      exitArmed ? 'Press Ctrl+Q AGAIN to leave anyway; new reads remain blocked.' : 'The dialog closes after a clean owned terminal completion.',
    ].map((line) => truncateToWidth(line, width));
  }
  function close() {
    if (closed) return !removalFailed;
    if (closing) return false;
    closing = true; assembler.reset();
    try { handle.hide(); }
    catch {
      // A throwing hide may leave a focused overlay mounted. Keep its handle,
      // live controls and caller ownership so explicit removal can be retried.
      removalFailed = true; closing = false;
      onClosed(false, false);
      try { tui.requestRender(); } catch {}
      return false;
    }
    closed = true; // Only successful owned hide revokes the component controls.
    try { tui.renderNow(); removalFailed = false; }
    catch { removalFailed = true; }
    closing = false;
    onClosed(!removalFailed, true);
    return !removalFailed;
  }
  function focused() { return !closed && handle && !handle.isHidden() && handle.isFocused(); }
  function input(data) {
    if (closed) return;
    if (cleanupOnly) {
      if (matchesKey(data, 'ctrl+q') || matchesKey(data, 'ctrl+c')) close();
      return; // No stale runtime may parse/import or replay input.
    }
    if (!isCurrent()) return;
    if (!focused()) { onFocusLost(); return; }
    if (matchesKey(data, 'ctrl+c')) {
      exitArmed = false;
      if (emitted) reader.cancel(); else { cancelPreparation(); close(); }
      tui.requestRender(); return;
    }
    if (matchesKey(data, 'ctrl+q')) {
      if (!emitted || !reader.state.waiting) { cancelPreparation(); close(); return; }
      if (exitArmed) { if (close()) onLeave(); return; }
      reader.cancel(); exitArmed = true; tui.requestRender(); return;
    }
    assembler.input(data);
  }
  const component = { render, invalidate() {}, handleInput: input,
    get focused() { return hasFocus; },
    set focused(value) {
      const lost = hasFocus && !value;
      hasFocus = value;
      // Revoke import synchronously without hiding/reclaiming during host focus
      // transitions. The visible drain obligation survives a covering dialog.
      if (lost && emitted && !closed && !closing && isCurrent()) onFocusLost();
    },
  };
  handle = tui.showOverlay(component, { anchor: 'center', width: '90%', maxHeight: 10 });
  try { tui.renderNow(); } catch { ready = false; }
  // Return ownership even after failed initial rendering. The caller can retain
  // a usable cleanup handle if hide also fails; no request may use ready=false.
  return {
    input, close, focused,
    dispose() { cleanupOnly = true; assembler.reset(); return close(); },
    get ready() { return ready; },
    get emitted() { return emitted; },
    markEmitted() { emitted = true; },
    update() {
      if (closed) return;
      const state = reader.state;
      if (state.unresolved && !draining) { assembler.reset(); draining = true; }
      if (emitted && !state.waiting) close();
      else tui.requestRender();
    },
  };
}
