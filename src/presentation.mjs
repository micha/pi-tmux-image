/**
 * Supported Pi UI seam. Encoding/normalization belongs to the caller; this module
 * only orders prepared transport bytes before exposing their placeholder rows.
 * No host imports, stdout interception, persisted residency, or terminal probing.
 */
export function createPresentation() {
  let connection;

  function disconnect(expected = connection) {
    if (!expected || connection !== expected) return;
    connection = undefined;
    expected.controller.abort();
    for (const sizes of expected.records.values()) {
      for (const record of sizes.values()) record.controller.abort();
    }
    expected.records.clear();
  }

  function connect(tui, owner = {}) {
    disconnect();
    const next = {
      tui,
      owner,
      epoch: Symbol("pi-tmux-image connection"),
      controller: new AbortController(),
      records: new Map(),
    };
    connection = next;
    return () => { if (connection?.owner === owner) disconnect(); };
  }

  return {
    /** Called from session_start, never from the extension factory. */
    attach(ctx, insideTmux) {
      if (ctx.mode !== "tui" || !insideTmux) return false;
      ctx.ui.setWidget("pi-tmux-image-transport", (tui) => {
        const dispose = connect(tui);
        return { render: () => [], invalidate() {}, dispose };
      });
      return true;
    },
    disconnect,
    /** Explicit reconnect recovery: same widget owner, fresh residency epoch. */
    refresh() {
      if (!connection) throw new Error("pi-tmux-image terminal transport is not connected");
      const { tui, owner } = connection;
      connect(tui, owner);
      tui.requestRender();
    },
    get epoch() { return connection?.epoch; },
    get dimensions() {
      return connection ? { columns: connection.tui.terminal.columns, rows: connection.tui.terminal.rows } : undefined;
    },
    /** Existing command-time uploads use the same public terminal transport. */
    write(uploads) {
      if (!connection) throw new Error("pi-tmux-image terminal transport is not connected");
      connection.tui.terminal.write(uploads);
    },
    /**
     * Native renderer interface. key identifies an immutable occurrence;
     * layout(width) optionally captures { key, ...geometryInputs } synchronously.
     * prepare(width, { epoch, signal }, capturedLayout) returns { uploads, lines,
     * onUploaded?, onUploadFailed? }. Geometry-only work reuses caller PNG caches.
     * fallback(width, error?) fits width. Pending superseded layouts are aborted;
     * ready geometry versions remain reusable for retained grids/resize reversal.
     *
     * Components have no local render cache, so requestRender is sufficient;
     * host invalidate/rebuild can create another component with the same key.
     */
    component({ key, layout, prepare, fallback }) {
      return {
        render(width) {
          const active = connection;
          if (!active) return fallback(width);
          const captured = layout ? layout(width) : { key: width };
          let sizes = active.records.get(key);
          if (!sizes) active.records.set(key, sizes = new Map());
          // Coalesce resize drags. Never upload obsolete pending geometry or
          // publish stale cells into the current layout. Ready versions survive.
          for (const [sizeKey, pending] of sizes) {
            if (sizeKey !== captured.key && !pending.lines && !pending.error) {
              pending.controller.abort();
              sizes.delete(sizeKey);
            }
          }
          let record = sizes.get(captured.key);
          if (!record) {
            const controller = new AbortController();
            record = { lines: undefined, error: undefined, controller };
            sizes.set(captured.key, record);
            // Even synchronous preparation runs outside the synchronous host frame.
            let prepared;
            Promise.resolve().then(() => {
              controller.signal.throwIfAborted();
              return prepare(width, { epoch: active.epoch, signal: controller.signal }, captured);
            }).then((result) => {
              prepared = result;
              if (connection !== active || controller.signal.aborted || sizes.get(captured.key) !== record) {
                prepared.onUploadFailed?.(new Error("Image connection replaced before upload"));
                return;
              }
              if (!Array.isArray(prepared.lines) || !prepared.lines.every((line) => typeof line === "string") ||
                  typeof prepared.uploads !== "string") {
                throw new Error("Invalid prepared image presentation");
              }
              // write() queues all bytes in the host's stream before ready rows can
              // enter a later frame. This is stream order, not a terminal ACK.
              if (prepared.uploads) active.tui.terminal.write(prepared.uploads);
              prepared.onUploaded?.();
              record.lines = prepared.lines.slice();
              active.tui.requestRender();
            }).catch((error) => {
              prepared?.onUploadFailed?.(error);
              if (connection !== active || controller.signal.aborted || sizes.get(captured.key) !== record) return;
              record.error = error;
              active.tui.requestRender();
            });
          }
          return record.lines ? record.lines.slice() : fallback(width, record.error);
        },
        invalidate() {},
      };
    },
  };
}
