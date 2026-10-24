import { createViewerPacer, isWheelExpired } from './viewer-pacing.mjs';
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
 * one selected snapshot, one admitted immutable sample and one canonical target.
 */
export function createViewerController({ native, presentation, getContext, getSnapshots,
  requireCapability, readyPolicy, getCells, matchesKey, parseKey = () => undefined, truncateToWidth, visibleWidth,
  sanitizeText = String, style = (_kind, text) => text, notify = () => {}, pacing = {},
  openDocument, pageAttachment, releaseDocument }) {
  // Owner-reviewed candidate; receipt is local component production, not an ACK.
  const timing = { now: () => performance.now(), schedule: (callback, delay) => setTimeout(callback, delay),
    cancelScheduled: clearTimeout, defer: queueMicrotask, idleMs: 150, wheelExpiryMs: null, ...pacing };
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
    const cells = getCells();
    return { frame, input: { image: token.payload, area: frame.area,
      cells: { widthPx: cells.widthPx, heightPx: cells.heightPx },
      zoomFactor: token.zoomFactor, center: token.center } };
  }

  function baseLayout(token, geometry) {
    return JSON.stringify([token.tui.terminal.columns, token.tui.terminal.rows,
      geometry.frame, geometry.input.cells]);
  }

  const pageExact = (token, record) => record?.pageGeneration === token.pageGeneration &&
    record.pageKey === token.pageKey && record.lease === token.lease;
  const pageIdentity = (token, page) => JSON.stringify([token.snapshot.occurrence,
    token.snapshot.document.sha256, page, token.snapshot.document.render]);

  function residentReady(token, geometry) {
    return pageExact(token, token.ready) && token.ready?.base === baseLayout(token, geometry) && token.ready.isResident?.() === true;
  }

  const chrome = (view) => JSON.stringify([view.zoomFactor, view.atZoomLimit]);

  // Description never publishes, allocates rows, aborts or schedules work.
  function describeDesired(token, width) {
    const geometry = viewInput(token, width);
    if (!geometry) return undefined;
    const view = computeViewport(geometry.input), base = baseLayout(token, geometry);
    return { ...geometry, view, base, key: JSON.stringify([base, view.canvas, view.window]),
      generation: token.generation };
  }

  function dropUntrusted(token, geometry) {
    if (token.ready && (!geometry || !residentReady(token, geometry))) {
      token.ready = undefined; token.drawn = undefined; token.drag = undefined; token.wheel = undefined;
      return true;
    }
    return false;
  }

  function observeLayout(token, width) {
    const geometry = viewInput(token, width);
    const base = geometry ? baseLayout(token, geometry) : JSON.stringify([
      token.tui.terminal.columns, token.tui.terminal.rows, width, getCells(), 'unusable']);
    if (token.layoutBase !== base) {
      token.layoutBase = base; token.generation++;
      token.pacer?.cancel(); token.pacer = undefined;
      token.request?.abort(); token.ready = undefined; token.drawn = undefined;
      token.drag = undefined; token.wheel = undefined;
      token.failedKey = undefined;
      if (token.payload) token.error = undefined;
      wake(token);
    }
    if (dropUntrusted(token, geometry)) {
      // Lost proof can remove the only frame capable of supplying an own receipt.
      // Revoke that scheduling generation, retain canonical state, and recover
      // only after any real native predecessor drains (never receipt polling).
      token.generation++; token.pacer?.cancel(); token.pacer = undefined;
      token.request?.abort(); wake(token);
    }
    return geometry;
  }

  function mappingAgrees(token, desired) {
    return desired && token.ready?.key === desired.key && token.ready.base === desired.base &&
      token.drawn?.key === desired.key && token.drawn.base === desired.base &&
      pageExact(token, token.drawn) && token.drawn.generation === token.generation && residentReady(token, desired);
  }

  function dirty(token, desired = describeDesired(token)) {
    return desired && token.failedKey !== desired.key &&
      (!token.ready || token.ready.key !== desired.key || chrome(token.ready.view) !== chrome(desired.view));
  }

  function wake(token) {
    if (!current(token)) return;
    if (token.snapshot?.document && !token.payload) { wakePage(token); return; }
    if (!token.payload || token.runner || token.pageRunner) return;
    const desired = describeDesired(token);
    if (!desired || token.failedKey === desired.key) return;
    if (!token.pacer) {
      const generation = token.generation;
      const pacer = createViewerPacer({ ...timing,
        onEligible(ticket) {
          if (!current(token) || token.pacer !== pacer || generation !== token.generation) return;
          admitSample(token, pacer, ticket);
        },
        onError(error) { if (current(token)) fail(token, desired.key, error); },
      });
      token.pacer = pacer;
    }
    if (dirty(token, desired) || token.wheel) token.pacer.request();
  }

  function publish(token, sample, prepared, live) {
    token.ready = { ticket: sample.ticket, key: sample.key, base: sample.base,
      generation: sample.generation, pageGeneration: sample.pageGeneration, pageKey: sample.pageKey,
      lease: sample.lease, page: sample.page, lines: prepared.lines, view: live.view,
      isResident: prepared.isResident };
    if (token.snapshot?.document) token.shownPage = sample.page;
    token.error = undefined; token.failedKey = undefined;
    sample.pacer.published(sample.ticket);
    if (token.wheel || dirty(token)) sample.pacer.request();
    // Bytes have committed. A repaint exception cannot release that receipt obligation.
    try { repaint(token); } catch (error) { notify(sanitizeText(`Viewer repaint: ${error.message || error}`), 'warning'); }
  }

  function fail(token, key, error) {
    token.pacer?.cancel(); token.pacer = undefined;
    token.ready = undefined; token.drawn = undefined; token.drag = undefined; token.wheel = undefined;
    token.error = sanitizeText(error.message || error); token.failedKey = key;
    repaint(token);
  }

  function finalView(token, sample, signal) {
    if (!current(token) || signal.aborted || !policy(token)) return undefined;
    observeLayout(token);
    const live = describeDesired(token);
    return pageExact(token, sample) && token.pacer === sample.pacer && sample.generation === token.generation &&
      live?.base === sample.base && live.key === sample.key ? live : undefined;
  }

  function admitSample(token, pacer, ticket) {
    if (!policy(token)) return;
    observeLayout(token);
    if (token.pacer !== pacer) return;
    let desired = describeDesired(token);
    if (!desired || token.failedKey === desired.key) { pacer.blocked(ticket); return; }
    // Resize clamps are canonical, not reconstructed from displayed cell centers.
    token.zoomFactor = desired.view.zoomFactor; token.center = desired.view.center;
    if (token.wheel && mappingAgrees(token, desired)) {
      const wheel = token.wheel; token.wheel = undefined;
      if (wheel.generation === token.generation && wheel.base === desired.base &&
          !isWheelExpired(wheel.receivedAt, timing.now(), timing.wheelExpiryMs)) {
        const state = zoomViewportAt(desired.input, wheel.direction, wheel.point);
        token.zoomFactor = state.zoomFactor; token.center = state.center;
        desired = describeDesired(token);
      }
    }
    if (!dirty(token, desired)) { pacer.blocked(ticket); return; }
    const sample = Object.freeze({ ticket, pacer, key: desired.key, base: desired.base,
      generation: token.generation, pageGeneration: token.pageGeneration, pageKey: token.pageKey,
      lease: token.lease, page: token.boundPage, view: desired.view, cells: Object.freeze({ ...desired.input.cells }) });
    const context = { epoch: token.epoch, signal: token.controller.signal };
    // Same geometry with new nominal metadata needs truthful chrome, not encoding.
    if (token.ready?.key === sample.key) {
      const live = finalView(token, sample, context.signal);
      if (live) publish(token, sample, token.ready, live);
      else pacer.settled(ticket, { retry: true });
      return;
    }
    try {
      if (token.ready && native.reuseViewer) {
        const reused = native.reuseViewer({ lease: token.lease,
          canvas: { ...sample.view.canvas, cellWidthPx: sample.cells.widthPx, cellHeightPx: sample.cells.heightPx },
          window: sample.view.window }, context);
        if (reused) {
          const live = finalView(token, sample, context.signal);
          if (!live) {
            reused.onUploadFailed?.(new Error('Viewer preparation superseded'));
            dropUntrusted(token, viewInput(token)); pacer.settled(ticket, { retry: true }); return;
          }
          if (!presentation.commit(reused, context)) throw new Error('Viewer surface is no longer current');
          publish(token, sample, reused, live); return;
        }
      }
    } catch (error) { fail(token, sample.key, error); return; }
    // One admitted immutable sample. Raw input cannot spawn a successor promise.
    token.runner = Promise.resolve().then(() => runSample(token, sample)).finally(() => {
      token.runner = undefined;
      if (current(token)) wake(token);
    });
  }

  async function runSample(token, sample) {
    const request = new AbortController(); token.request = request;
    const abort = () => request.abort(); token.controller.signal.addEventListener('abort', abort, { once: true });
    const context = { epoch: token.epoch, signal: request.signal };
    let prepared, published = false, rejected = false;
    try {
      if (!current(token) || !pageExact(token, sample) || token.pacer !== sample.pacer || sample.generation !== token.generation) return;
      await requireCapability(token.ctx, request.signal);
      if (!current(token) || !pageExact(token, sample) || request.signal.aborted) return;
      prepared = await native.prepareViewer({ lease: sample.lease,
        canvas: { ...sample.view.canvas, cellWidthPx: sample.cells.widthPx, cellHeightPx: sample.cells.heightPx },
        window: sample.view.window }, context);
      await requireCapability(token.ctx, request.signal);
      const live = finalView(token, sample, request.signal);
      if (!live) {
        rejected = true; prepared.onUploadFailed?.(new Error('Viewer preparation superseded'));
        dropUntrusted(token, viewInput(token)); repaint(token);
      } else if (presentation.commit(prepared, context)) {
        published = true; publish(token, sample, prepared, live);
      } else {
        rejected = true; // presentation already releases rejected reservations.
        fail(token, sample.key, new Error('Viewer surface is no longer current'));
      }
    } catch (error) {
      if (!published && !rejected) prepared?.onUploadFailed?.(error);
      dropUntrusted(token, viewInput(token));
      if (current(token) && pageExact(token, sample) && !request.signal.aborted && token.pacer === sample.pacer) {
        const live = describeDesired(token);
        if (live?.key === sample.key) fail(token, sample.key, error);
        else repaint(token); // benign supersession: latest final target stays dirty.
      }
    } finally {
      token.controller.signal.removeEventListener('abort', abort);
      if (token.request === request) token.request = undefined;
      if (current(token) && token.pacer === sample.pacer && !published) {
        sample.pacer.settled(sample.ticket, { retry: Boolean(dirty(token) || token.wheel) });
      }
    }
  }

  // Page lifecycle is serialized independently of paced viewport sampling. Raw
  // page keys only replace the scalar target and abort the one actual operation.
  function requestPage(token, target) {
    const page = Math.max(1, Math.min(token.snapshot.document.pageCount, target));
    if (token.documentHandle?.available === false && page !== 1) {
      token.pageError = sanitizeText(token.documentHandle.unavailableReason || 'Original PDF not retained; browsing unavailable');
      repaint(token); return;
    }
    if (page === token.requestedPage && ((!token.pageError && !token.error) ||
        token.ready?.page === page && pageExact(token, token.ready))) {
      token.pageError = undefined; repaint(token); return;
    }
    token.requestedPage = page; token.pageGeneration++;
    token.pageKey = pageIdentity(token, page);
    token.pageController?.abort(); token.request?.abort();
    token.pacer?.cancel(); token.pacer = undefined;
    token.ready = token.drawn = token.drag = token.wheel = undefined;
    token.shownPage = token.boundPage = undefined;
    token.error = token.pageError = token.failedKey = undefined;
    token.zoomFactor = 1; token.center = { x: 0.5, y: 0.5 };
    if (token.lease) {
      native.releaseViewer(token.lease); token.retireRequired = true; token.lease = undefined;
    }
    token.payload = undefined;
    wakePage(token); repaint(token);
  }

  function wakePage(token) {
    if (!current(token) || !token.documentHandle || token.pageRunner || token.payload || token.pageError) return;
    // No rasterization/normalization/reservation in the text-only fallback.
    if (!viewerArea(token.tui.terminal.columns, token.tui.terminal.rows).usable) return;
    const runner = Promise.resolve().then(async () => {
      // Drain the old native runner before touching its scoped cleanup tuple.
      await token.runner;
      if (!current(token)) return;
      const controller = new AbortController(); token.pageController = controller;
      const abort = () => controller.abort();
      token.controller.signal.addEventListener('abort', abort, { once: true });
      const generation = token.pageGeneration, pageKey = token.pageKey, page = token.requestedPage;
      const exact = () => current(token) && !controller.signal.aborted &&
        token.pageGeneration === generation && token.pageKey === pageKey;
      try {
        if (token.retireRequired) {
          await retirePending(token.ctx, { tui: token.tui, epoch: token.epoch }, controller.signal);
          token.retireRequired = false;
        }
        if (!exact() || !viewerArea(token.tui.terminal.columns, token.tui.terminal.rows).usable) return;
        await requireCapability(token.ctx, controller.signal);
        if (!exact()) return;
        const attachment = await pageAttachment(token.documentHandle, page, { signal: controller.signal });
        if (!exact()) return;
        const payload = await native.resolvePayload(attachment, controller.signal);
        await requireCapability(token.ctx, controller.signal);
        if (!exact() || !policy(token) || !viewerArea(token.tui.terminal.columns, token.tui.terminal.rows).usable) return;
        const lease = native.reserveViewerPlacement({ payload, occurrence: pageKey });
        token.lease = lease; token.payload = payload; token.boundPage = page;
        token.zoomFactor = 1; token.center = { x: 0.5, y: 0.5 };
        observeLayout(token); repaint(token);
      } catch (error) {
        if (exact()) {
          token.pageError = token.error = sanitizeText(error.message || error); repaint(token);
        }
      } finally {
        token.controller.signal.removeEventListener('abort', abort);
        if (token.pageController === controller) token.pageController = undefined;
      }
    }).finally(() => {
      if (token.pageRunner !== runner) return;
      token.pageRunner = undefined;
      if (current(token)) wake(token);
    });
    token.pageRunner = runner;
  }

  function select(token, snapshot) {
    if (!current(token) || token.snapshot) return;
    token.snapshot = snapshot; token.picker = false;
    token.pageKey = snapshot.occurrence;
    if (snapshot.document) {
      token.requestedPage = 1;
      token.pageKey = pageIdentity(token, 1);
      token.selection = (async () => {
        let handle;
        try {
          await requireCapability(token.ctx, token.controller.signal);
          if (!openDocument || !pageAttachment || !releaseDocument) throw new Error('PDF browsing is unavailable');
          handle = await openDocument(snapshot, { signal: token.controller.signal });
          if (!current(token)) { await releaseDocument(handle); return; }
          token.documentHandle = handle;
          if (handle.available === false && token.requestedPage !== 1) {
            // Input can arrive before the cheap open resolves. An unavailable
            // original must still install the canonical page-one snapshot.
            token.requestedPage = 1; token.pageGeneration++;
            token.pageKey = pageIdentity(token, 1);
          }
          wakePage(token);
        } catch (error) {
          if (current(token)) { token.pageError = token.error = sanitizeText(error.message || error); repaint(token); }
        }
      })();
      repaint(token); return;
    }
    token.selection = (async () => {
      try {
        await requireCapability(token.ctx, token.controller.signal);
        const payload = await native.resolvePayload(snapshot.attachment, token.controller.signal);
        await requireCapability(token.ctx, token.controller.signal);
        if (!current(token) || !policy(token)) return;
        token.lease = native.reserveViewerPlacement({ payload, occurrence: snapshot.occurrence });
        token.payload = payload;
        observeLayout(token); wake(token); repaint(token);
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
    // Every delta is reduced/clamped, but presentation work is opportunity-bound.
    wake(token);
  }

  function mouse(token, event) {
    const consumed = { handled: true, render: false };
    if (!current(token) || !policy(token)) return consumed;
    observeLayout(token);
    const geometry = describeDesired(token);
    if (token.picker || token.jump || (token.snapshot?.document && !token.ready) || !geometry) { token.drag = undefined; token.wheel = undefined; return consumed; }
    const layout = mouseLayout(token, geometry);
    if (token.drag?.layout !== layout) token.drag = undefined;
    if (!Number.isSafeInteger(event.x) || !Number.isSafeInteger(event.y)) return consumed;
    const point = { column: event.x - geometry.frame.left - 1 + 0.5,
      row: event.y - geometry.frame.top - 1 + 0.5 };
    const inside = point.column >= 0 && point.column < geometry.frame.area.columns &&
      point.row >= 0 && point.row < geometry.frame.area.rows;
    const ready = token.ready && residentReady(token, geometry) &&
      token.drawn?.base === baseLayout(token, geometry);
    const rendered = ready && token.drawn.key === token.ready.key;

    if (event.type === 'wheel') {
      token.drag = undefined;
      if (!ready || !inside || !Number.isFinite(event.wheelDelta) || !event.wheelDelta) return consumed;
      // Pi's delta is accelerated transcript lines, not physical wheel notches.
      // Retain one latest sign/position through preparation, not a report queue.
      token.wheel = { direction: event.wheelDelta < 0 ? 'in' : 'out', point,
        base: baseLayout(token, geometry), generation: token.generation, receivedAt: timing.now() };
      wake(token);
      return consumed;
    }
    if (event.type === 'press') {
      token.drag = undefined; token.wheel = undefined;
      if (event.button !== 'left' || !rendered || !mappingAgrees(token, geometry) || !inside) {
        wake(token); return consumed;
      }
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
      else if (event.type === 'release') wake(token);
    }
    return consumed; // Entire pane remains a barrier to hidden transcript input.
  }

  function input(token, data) {
    if (!current(token) || !policy(token)) return;
    token.drag = undefined; token.wheel = undefined;
    if (token.jump) {
      if (key(data, 'escape')) { token.jump = undefined; repaint(token); return; }
      if (key(data, 'return')) {
        const page = Number(token.jump.text);
        if (!Number.isSafeInteger(page) || page < 1 || page > token.snapshot.document.pageCount) {
          token.jump.error = `Enter 1–${token.snapshot.document.pageCount}`;
        } else { token.jump = undefined; requestPage(token, page); }
      } else if (key(data, 'backspace')) { token.jump.text = token.jump.text.slice(0, -1); token.jump.error = undefined; }
      else {
        const digit = /^[0-9]$/.test(data) ? data : parseKey(data);
        if (typeof digit === 'string' && /^[0-9]$/.test(digit) &&
            token.jump.text.length < String(token.snapshot.document.pageCount).length) {
          token.jump.text += digit; token.jump.error = undefined;
        }
      }
      repaint(token); return;
    }
    if (key(data, 'escape')) { close('escape'); return; }
    if (token.picker) {
      if (key(data, 'up') || key(data, 'k')) token.selected = Math.max(0, token.selected - 1);
      else if (key(data, 'down') || key(data, 'j')) token.selected = Math.min(token.snapshots.length - 1, token.selected + 1);
      else if (key(data, 'return')) select(token, token.snapshots[token.selected]);
      repaint(token); return;
    }
    if (token.snapshot?.document) {
      if (key(data, 'g')) { token.jump = { text: '' }; repaint(token); return; }
      if (key(data, 'n') || key(data, 'pageDown')) { requestPage(token, token.requestedPage + 1); return; }
      if (key(data, 'p') || key(data, 'pageUp')) { requestPage(token, token.requestedPage - 1); return; }
      if (!token.ready) return;
    }
    observeLayout(token);
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
    const putCells = (row, text) => { if (row >= 0 && row < height) lines[row] = text; };
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
    observeLayout(token, width);
    const geometry = describeDesired(token, width);
    if (!geometry || token.drag?.layout !== mouseLayout(token, geometry)) token.drag = undefined;
    const label = sanitizeText(token.snapshot?.label || 'Stored image');
    const title = viewerTitle(label, token.ready?.view || geometry?.view, width, { truncateToWidth, visibleWidth });
    put(0, style('accent', title.title));
    // PDF page identity retains its dedicated row; keyboard hints take width
    // precedence, with mouse hints appended when that row is occupied.
    put(height - 1, style('muted', '+/- zoom • 0 fit • hjkl pan • Esc close' +
      (title.pageHint ? ' • wheel zoom/drag pan (fullscreen)' : '')));
    if (height > 2) put(1, style('muted', title.pageHint || 'Fullscreen: wheel zoom • drag pan'));
    if (token.snapshot?.document) {
      const count = token.snapshot.document.pageCount;
      const status = token.ready ? `Page ${token.ready.page} of ${count}` :
        `${token.pageError || token.error ? 'Error loading' : 'Loading'} page ${token.requestedPage} of ${count}`;
      put(1, style('muted', status));
      put(height - 1, style('muted', 'n/p PgDn/PgUp • g jump • +/- zoom • 0 fit • hjkl • Esc close'));
      if (token.documentHandle?.available === false) put(height - 2, style('muted',
        sanitizeText(token.documentHandle.unavailableReason || 'Original PDF not retained; browsing unavailable')));
      if (token.jump) put(height - 2, style('accent', `Page: ${token.jump.text}▏${token.jump.error ? ` — ${token.jump.error}` : ' • Enter go • Esc cancel'}`));
    }
    if (!geometry) {
      put(Math.min(2, height - 1), style('muted', token.payload ? 'Pane too small' : token.error ? `Viewer: ${token.error}` :
        token.snapshot?.document && !viewerArea(width, height).usable ? 'Pane too small; page loading deferred' : 'Preparing stored image…'));
      if (token.payload && height > 4) put(3, style('muted', 'Need 20×7; Esc close'));
      return lines;
    }
    const { frame } = geometry;
    const view = token.ready?.view || geometry.view;
    if (token.ready && dirty(token, geometry) && !token.jump) put(height - 2, style('muted', 'Updating viewport…'));
    const border = (text) => style('border', text);
    const prefix = ' '.repeat(frame.left);
    putCells(frame.top, prefix + border('┌' + '─'.repeat(frame.area.columns) + '┐'));
    for (let row = 0; row < frame.area.rows; row++) {
      const local = row - view.origin.row;
      let body = ' '.repeat(frame.area.columns);
      if (token.ready && local >= 0 && local < token.ready.lines.length) {
        const cells = token.ready.lines[local];
        // Encoder guarantees one column per addressed cell. These rows already
        // fit by construction: avoid rescanning/truncating Unicode ID cells.
        body = ' '.repeat(view.origin.column) + cells + ' '.repeat(Math.max(0, frame.area.columns - view.origin.column - view.window.columns));
      } else if (row === 0 && !token.ready) {
        const text = fitText(token.error ? `Viewer: ${token.error}` : 'Preparing viewport…', frame.area.columns);
        body = text + ' '.repeat(Math.max(0, frame.area.columns - visibleWidth(text)));
      }
      putCells(frame.top + 1 + row, prefix + border('│') + body + border('│'));
    }
    putCells(frame.top + frame.area.rows + 1, prefix + border('└' + '─'.repeat(frame.area.columns) + '┘'));
    if (token.ready) {
      token.drawn = { key: token.ready.key, base: token.ready.base, generation: token.generation,
        pageGeneration: token.ready.pageGeneration, pageKey: token.ready.pageKey, lease: token.ready.lease };
      token.pacer?.rendered(token.ready.ticket);
      // A receipt can unblock a waiting mapping, never consume its wheel inline.
      if (token.wheel) token.pacer?.request();
    }
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
    token.closing = true; token.ready = undefined; token.pageGeneration++;
    token.pageController?.abort(); token.jump = undefined;
    token.pacer?.cancel(); token.pacer = undefined;
    token.drag = undefined; token.wheel = undefined; token.drawn = undefined;
    token.controller.abort(); token.request?.abort();
    if (token.lease) native.releaseViewer(token.lease); // Revoke replay BEFORE deferred text removal.
    queueMicrotask(async () => {
      try {
        token.handle?.hide(); token.component?.dispose();
        await token.selection; await token.pageRunner; await token.runner;
        const connection = presentation.connection;
        if ((token.lease || token.retireRequired) && connection?.epoch === token.epoch) await retirePending(token.ctx, connection);
      } catch (error) { notify(sanitizeText(`Viewer cleanup: ${error.message || error}`), 'warning'); }
      finally {
        try { if (token.documentHandle) await releaseDocument(token.documentHandle); }
        catch (error) { notify(sanitizeText(`Viewer document cleanup: ${error.message || error}`), 'warning'); }
        if (active === token) active = undefined; token.settle(reason);
      }
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
      zoomFactor: 1, center: { x: 0.5, y: 0.5 }, generation: 0, pageGeneration: 0, selected: 0, disposed: false,
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
        dispose() {
          if (token.disposed) return;
          token.disposed = true;
          if (current(token)) close('component-dispose');
        },
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
