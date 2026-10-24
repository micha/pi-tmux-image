import { computeViewport, zoomViewport, zoomViewportAt, panViewport, resetViewport, PAN_CELLS } from './viewport.mjs';

/** The raw overlay fills the pane; only its inner image area addresses Kitty cells. */
export function viewerArea(columns, rows) {
  const area = { columns: Math.min(297, Math.max(0, columns - 4)), rows: Math.min(297, Math.max(0, rows - 6)) };
  return { area, left: Math.floor((columns - area.columns - 2) / 2), top: 2,
    usable: columns >= 20 && rows >= 7 && area.columns > 0 && area.rows > 0 };
}

/** Reserve zoom/limit chrome FIRST; preserve PDF page identity on its own row. */
export function viewerTitle(label, view, width, { truncateToWidth, visibleWidth }) {
  const page = /[—–-]\s*page\s+(\d+)\s*$/i.exec(label);
  const pageHint = page ? `page ${page[1]}` : '';
  const suffix = view ? `${Math.round(view.fitPercent)}% Fit${view.atZoomLimit ? ' (limit)' : ''}` : '';
  const room = Math.max(0, width - visibleWidth(suffix) - (suffix ? 3 : 0));
  const compact = visibleWidth(label) <= room ? label : label.split(/[\\/]/).at(-1);
  const fitted = truncateToWidth(compact, room);
  return { title: suffix ? `${fitted}${fitted ? ' — ' : ''}${suffix}` : truncateToWidth(compact, width), pageHint };
}

/** Active-branch snapshot index. Identity comes from entries/occurrences, never labels. */
export function indexSnapshots(entries, describe) {
  return entries.flatMap((entry) => {
    const snapshot = describe(entry);
    if (!snapshot) return [];
    return [Object.freeze({ ...snapshot, attachment: Object.freeze({ ...snapshot.attachment }) })];
  }).reverse();
}

/** Host-import-free controller over the existing public widget TUI connection.
 * Native owns PNGs, queue, private placement and success callbacks. There is only
 * one selected snapshot, one pending prepare and one replaceable latest intent.
 */
export function createViewerController({ native, presentation, getContext, getSnapshots,
  requireCapability, readyPolicy, getCells, matchesKey, parseKey = () => undefined, truncateToWidth, visibleWidth,
  sanitizeText = String, style = (_kind, text) => text, notify = () => {} }) {
  let active;
  const unsubscribe = presentation.bind({ onDisconnect() { close('connection'); } });
  const current = (token) => active === token && !token.closing && presentation.connection?.epoch === token.epoch;
  const repaint = (token) => { if (current(token)) token.tui.requestRender(); };
  const fitText = (text, width) => truncateToWidth(String(text), Math.max(0, width));
  // '+' is a literal symbol, not a modifiers+key matcher expression in Pi 1.0.3.
  // Public parseKey also recognizes Kitty codepoint reports; Shift+= is the
  // supported report used by terminals that encode the physical shifted key.
  const key = (data, name) => name === '+'
    ? data === '+' || parseKey(data) === '+' || matchesKey(data, 'shift+=')
    : matchesKey(data, name);

  function policy(token) {
    const reason = readyPolicy(token.ctx);
    if (reason) { close('display-policy'); return false; }
    return current(token);
  }

  function viewInput(token, width = token.tui.terminal.columns) {
    const frame = viewerArea(width, token.tui.terminal.rows);
    if (!frame.usable || !token.payload) return undefined;
    return { frame, input: { image: token.payload, area: frame.area, cells: getCells(),
      zoomFactor: token.zoomFactor, center: token.center } };
  }

  function intent(token, width) {
    const geometry = viewInput(token, width);
    if (!geometry) {
      token.desiredKey = undefined; token.latest = undefined; token.ready = undefined;
      token.request?.abort(); return undefined;
    }
    const view = computeViewport(geometry.input);
    token.zoomFactor = view.zoomFactor; token.center = view.center;
    const id = JSON.stringify([view.canvas, view.window, geometry.input.cells]);
    token.desiredKey = id;
    if (token.ready?.key !== id) token.ready = undefined;
    if (token.ready || token.runningKey === id || (token.latest?.key === id && token.runner) || token.failedKey === id) return { ...geometry, view };
    token.latest = { key: id, view, cells: geometry.input.cells };
    if (token.runningKey !== id) token.request?.abort();
    if (!token.runner) {
      // Set the runner before any await; rapid input replaces latest, not promises.
      token.runner = Promise.resolve().then(() => run(token)).finally(() => {
        token.runner = undefined;
        if (current(token) && token.latest) intent(token);
      });
    }
    return { ...geometry, view };
  }

  async function run(token) {
    while (current(token) && token.latest) {
      const job = token.latest; token.latest = undefined; token.runningKey = job.key;
      const request = new AbortController(); token.request = request;
      const abort = () => request.abort(); token.controller.signal.addEventListener('abort', abort, { once: true });
      const context = { epoch: token.epoch, signal: request.signal };
      let prepared;
      try {
        await requireCapability(token.ctx, request.signal);
        prepared = await native.prepareViewer({ lease: token.lease,
          canvas: { ...job.view.canvas, cellWidthPx: job.cells.widthPx, cellHeightPx: job.cells.heightPx }, window: job.view.window }, context);
        await requireCapability(token.ctx, request.signal);
        if (!current(token) || request.signal.aborted || token.desiredKey !== job.key || !policy(token)) {
          prepared.onUploadFailed?.(new Error('Viewer preparation superseded')); continue;
        }
        if (presentation.commit(prepared, context)) {
          token.ready = { key: job.key, lines: prepared.lines.slice(), view: job.view };
          token.error = undefined; token.failedKey = undefined;
          repaint(token);
        } else {
          token.error = 'Viewer surface is no longer current'; token.failedKey = job.key; repaint(token);
        }
      } catch (error) {
        prepared?.onUploadFailed?.(error);
        if (current(token) && !request.signal.aborted && token.desiredKey === job.key) {
          token.error = sanitizeText(error.message || error); token.failedKey = job.key; repaint(token);
        }
      } finally {
        token.controller.signal.removeEventListener('abort', abort);
        token.runningKey = undefined; if (token.request === request) token.request = undefined;
      }
    }
  }

  function select(token, snapshot) {
    if (!current(token) || token.snapshot) return;
    token.snapshot = snapshot; token.picker = false;
    token.selection = (async () => {
      try {
        await requireCapability(token.ctx, token.controller.signal);
        const payload = await native.resolvePayload(snapshot.attachment, token.controller.signal);
        await requireCapability(token.ctx, token.controller.signal);
        if (!current(token) || !policy(token)) return;
        token.lease = native.reserveViewerPlacement({ payload, occurrence: snapshot.occurrence });
        token.payload = payload;
        intent(token); repaint(token);
      } catch (error) {
        if (current(token)) { token.error = sanitizeText(error.message || error); repaint(token); }
      }
    })();
    repaint(token);
  }

  // Captured mouse targets retain last-frame bounds. Cancel gestures on live
  // layout/cell/scale changes rather than interpreting motion in stale geometry.
  function mouseLayout(token, geometry) {
    return JSON.stringify([token.tui.terminal.columns, token.tui.terminal.rows,
      geometry.frame, geometry.input.cells, computeViewport(geometry.input).canvas]);
  }

  function applyState(token, state) {
    token.zoomFactor = state.zoomFactor; token.center = state.center;
    intent(token); repaint(token);
  }

  function mouse(token, event) {
    const consumed = { handled: true, render: false };
    if (!current(token) || !policy(token)) return consumed;
    const geometry = viewInput(token);
    if (token.picker || !geometry) { token.drag = undefined; token.wheel = undefined; return consumed; }
    const layout = mouseLayout(token, geometry);
    if (token.drag?.layout !== layout) token.drag = undefined;
    if (!Number.isSafeInteger(event.x) || !Number.isSafeInteger(event.y)) return consumed;
    const point = { column: event.x - geometry.frame.left - 1 + 0.5,
      row: event.y - geometry.frame.top - 1 + 0.5 };
    const inside = point.column >= 0 && point.column < geometry.frame.area.columns &&
      point.row >= 0 && point.row < geometry.frame.area.rows;
    const ready = token.ready && token.drawn?.key === token.ready.key &&
      token.desiredKey === token.ready.key && token.drawn.layout === layout;

    if (event.type === 'wheel') {
      token.drag = undefined;
      if (!ready || !inside || !Number.isFinite(event.wheelDelta) || !event.wheelDelta) return consumed;
      // Pi's delta is accelerated transcript lines, not physical wheel notches.
      // Use only its sign and one latest event per synchronous input burst; there
      // is at most one microtask and no timer or promise chain per wheel report.
      token.wheel = { direction: event.wheelDelta < 0 ? 'in' : 'out', point,
        layout, key: token.ready.key };
      if (!token.wheelQueued) {
        token.wheelQueued = true;
        queueMicrotask(() => {
          token.wheelQueued = false;
          const job = token.wheel; token.wheel = undefined;
          if (!job || !current(token) || !policy(token)) return;
          const live = viewInput(token);
          if (!live || mouseLayout(token, live) !== job.layout ||
              token.ready?.key !== job.key || token.drawn?.key !== job.key) return;
          applyState(token, zoomViewportAt(live.input, job.direction, job.point));
        });
      }
      return consumed;
    }
    if (event.type === 'press') {
      token.drag = undefined; token.wheel = undefined;
      if (event.button !== 'left' || !ready || !inside) return consumed;
      const view = token.ready.view;
      // Grab occupied image cells, not the surrounding centered blank margins.
      if (point.column < view.origin.column || point.column >= view.origin.column + view.window.columns ||
          point.row < view.origin.row || point.row >= view.origin.row + view.window.rows) return consumed;
      token.drag = { x: event.x, y: event.y, layout };
      return { ...consumed, capture: true }; // Do not refocus: public focus loss closes the viewer.
    }
    if (event.type === 'drag' || event.type === 'release') {
      const drag = token.drag;
      if (!drag) return consumed;
      // Some terminals report release with button 'none'. It still ends our grab.
      if (event.type === 'drag' && event.button !== 'left') { token.drag = undefined; return consumed; }
      const xCells = drag.x - event.x, yCells = drag.y - event.y;
      drag.x = event.x; drag.y = event.y;
      if (event.type === 'release') token.drag = undefined;
      if (xCells || yCells) applyState(token, panViewport(geometry.input, { xCells, yCells }));
    }
    return consumed; // Entire pane remains a barrier to hidden transcript input.
  }

  function input(token, data) {
    if (!current(token) || !policy(token)) return;
    token.drag = undefined; token.wheel = undefined;
    if (key(data, 'escape')) { close('escape'); return; }
    if (token.picker) {
      if (key(data, 'up') || key(data, 'k')) token.selected = Math.max(0, token.selected - 1);
      else if (key(data, 'down') || key(data, 'j')) token.selected = Math.min(token.snapshots.length - 1, token.selected + 1);
      else if (key(data, 'return')) select(token, token.snapshots[token.selected]);
      repaint(token); return;
    }
    const geometry = viewInput(token);
    if (!geometry) return;
    let state;
    if (key(data, '+')) state = zoomViewport(geometry.input, 'in');
    else if (key(data, '-')) state = zoomViewport(geometry.input, 'out');
    else if (key(data, '0')) state = resetViewport(geometry.input);
    else if (key(data, 'h')) state = panViewport(geometry.input, { xCells: -PAN_CELLS });
    else if (key(data, 'j')) state = panViewport(geometry.input, { yCells: PAN_CELLS });
    else if (key(data, 'k')) state = panViewport(geometry.input, { yCells: -PAN_CELLS });
    else if (key(data, 'l')) state = panViewport(geometry.input, { xCells: PAN_CELLS });
    if (!state) return; // Never forward unknown keys to the hidden editor.
    applyState(token, state);
  }

  function render(token, width) {
    if (!current(token) || !policy(token)) return [];
    token.drawn = undefined;
    const height = Math.max(1, token.tui.terminal.rows);
    const lines = Array.from({ length: height }, () => ' '.repeat(width));
    const put = (row, text) => { if (row >= 0 && row < height) lines[row] = fitText(text, width); };
    if (token.picker) {
      put(0, style('accent', 'Stored images — newest first'));
      const count = Math.max(0, height - 4);
      const start = Math.max(0, Math.min(token.selected - count + 1, token.snapshots.length - count));
      for (let i = 0; i < count && start + i < token.snapshots.length; i++) {
        const n = start + i;
        put(i + 1, style(n === token.selected ? 'accent' : 'text', `${n === token.selected ? '›' : ' '} ${n + 1}. ${sanitizeText(token.snapshots[n].label)}`));
      }
      const selected = sanitizeText(token.snapshots[token.selected].label);
      const page = /[—–-]\s*page\s+(\d+)\s*$/i.exec(selected);
      put(height - 2, style('muted', page ? `Selected: page ${page[1]}` : `Selected: ${selected.split(/[\\/]/).at(-1)}`));
      put(height - 1, style('muted', '↑/↓ j/k select • Enter open • Esc close'));
      return lines;
    }
    const geometry = intent(token, width);
    if (!geometry || token.drag?.layout !== mouseLayout(token, geometry)) token.drag = undefined;
    const label = sanitizeText(token.snapshot?.label || 'Stored image');
    const title = viewerTitle(label, geometry?.view, width, { truncateToWidth, visibleWidth });
    put(0, style('accent', title.title));
    // PDF page identity retains its dedicated row; keyboard hints take width
    // precedence, with mouse hints appended when that row is occupied.
    put(height - 1, style('muted', '+/- zoom • 0 fit • hjkl pan • Esc close' +
      (title.pageHint ? ' • wheel zoom/drag pan (fullscreen)' : '')));
    if (height > 2) put(1, style('muted', title.pageHint || 'Fullscreen: wheel zoom • drag pan'));
    if (!geometry) {
      put(Math.min(2, height - 1), style('muted', token.payload ? 'Pane too small' : token.error ? `Viewer: ${token.error}` : 'Preparing stored image…'));
      if (token.payload && height > 4) put(3, style('muted', 'Need 20×7; Esc close'));
      return lines;
    }
    const { frame, view } = geometry;
    const border = (text) => style('border', text);
    const prefix = ' '.repeat(frame.left);
    put(frame.top, prefix + border('┌' + '─'.repeat(frame.area.columns) + '┐'));
    for (let row = 0; row < frame.area.rows; row++) {
      const local = row - view.origin.row;
      let body = ' '.repeat(frame.area.columns);
      if (token.ready && local >= 0 && local < token.ready.lines.length) {
        const cells = token.ready.lines[local];
        body = ' '.repeat(view.origin.column) + cells + ' '.repeat(Math.max(0, frame.area.columns - view.origin.column - visibleWidth(cells)));
      } else if (row === 0 && !token.ready) {
        const text = fitText(token.error ? `Viewer: ${token.error}` : 'Preparing viewport…', frame.area.columns);
        body = text + ' '.repeat(Math.max(0, frame.area.columns - visibleWidth(text)));
      }
      put(frame.top + 1 + row, prefix + border('│') + body + border('│'));
    }
    put(frame.top + frame.area.rows + 1, prefix + border('└' + '─'.repeat(frame.area.columns) + '┘'));
    if (token.ready) token.drawn = { key: token.ready.key, layout: mouseLayout(token, geometry) };
    return lines;
  }

  async function retirePending(ctx, connection, signal = new AbortController().signal) {
    const context = { epoch: connection.epoch, signal };
    await requireCapability(ctx, signal);
    const prepared = await native.prepareViewerRetirement(context);
    try {
      // hide() only schedules a frame. Flush outside frame/focus callbacks,
      // including recovery retries, before deleting referenced private cells.
      // No-op retirement needs no frame; a failed flush releases the prepared
      // reservation but leaves the one bounded native obligation intact.
      if (prepared.uploads) connection.tui.renderNow();
      await requireCapability(ctx, signal);
      if (!presentation.commit(prepared, context)) throw new Error('Viewer retirement transport was superseded; retry after refresh');
    } catch (error) { prepared.onUploadFailed?.(error); throw error; }
  }

  function close(reason = 'close') {
    const token = active;
    if (!token) return Promise.resolve();
    if (token.closing) return token.done;
    token.closing = true; token.ready = undefined; token.latest = undefined;
    token.drag = undefined; token.wheel = undefined; token.drawn = undefined;
    token.controller.abort(); token.request?.abort();
    if (token.lease) native.releaseViewer(token.lease); // Revoke replay BEFORE deferred text removal.
    queueMicrotask(async () => {
      try {
        token.handle?.hide(); token.component?.dispose();
        await token.selection; await token.runner;
        const connection = presentation.connection;
        if (token.lease && connection?.epoch === token.epoch) await retirePending(token.ctx, connection);
      } catch (error) { notify(sanitizeText(`Viewer cleanup: ${error.message || error}`), 'warning'); }
      finally { if (active === token) active = undefined; token.settle(reason); }
    });
    return token.done;
  }

  async function open(occurrence) {
    if (active) throw new Error('An image viewer is already open or closing');
    const connection = presentation.connection, ctx = getContext();
    if (!connection || !ctx) throw new Error('Image viewer requires interactive Pi inside tmux');
    if (connection.tui.hasOverlay()) throw new Error('Close the current dialog/search before opening the image viewer');
    let settle;
    const token = { ...connection, ctx, controller: new AbortController(), closing: false,
      zoomFactor: 1, center: { x: 0.5, y: 0.5 }, selected: 0, disposed: false,
      done: new Promise((resolve) => { settle = resolve; }) };
    token.settle = settle; active = token; // Reserve BEFORE capability/normalization awaits.
    try {
      await requireCapability(ctx, token.controller.signal);
      if (!current(token)) return token.done;
      if (token.tui.hasOverlay()) throw new Error('Close the current dialog/search before opening the image viewer');
      // A denied/disconnected previous cleanup retains one obligation. Retry it
      // after old work/text are gone, before rebinding the fixed private slot.
      await retirePending(ctx, connection, token.controller.signal);
      if (!current(token)) return token.done;
      if (token.tui.hasOverlay()) throw new Error('Close the current dialog/search before opening the image viewer');
      token.snapshots = getSnapshots();
      if (!token.snapshots.length) throw new Error('No stored image snapshots on the active session branch');
      const snapshot = occurrence ? token.snapshots.find((item) => item.occurrence === occurrence) : token.snapshots.length === 1 ? token.snapshots[0] : undefined;
      if (occurrence && !snapshot) throw new Error('That image snapshot is no longer on the active session branch');
      token.picker = !snapshot;
      let focused = false, hadFocus = false;
      token.component = {
        get focused() { return focused; },
        set focused(value) { focused = value; if (value) hadFocus = true; else if (hadFocus && active === token && !token.closing) close('focus-lost'); },
        render: (width) => render(token, width), invalidate() {},
        handleInput: (data) => input(token, data),
        handleMouse: (event) => mouse(token, event),
        dispose() { if (token.disposed) return; token.disposed = true; },
      };
      token.handle = token.tui.showOverlay(token.component, { row: 0, col: 0, width: '100%', maxHeight: '100%' });
      if (snapshot) select(token, snapshot);
      return token.done;
    } catch (error) {
      if (token.closing) return token.done;
      await close('open-failed'); throw error;
    }
  }

  return { open, close, get isOpen() { return Boolean(active); },
    async retryRetirement() {
      if (active) await close('retirement-retry');
      // close() can drain across a concurrent public refresh/session transition.
      // Select the supported connection/context AFTER that wait, never retire
      // through a previously captured epoch.
      const connection = presentation.connection, ctx = getContext();
      if (connection && ctx) await retirePending(ctx, connection);
    },
    async dispose() { unsubscribe(); await close('dispose'); } };
}
