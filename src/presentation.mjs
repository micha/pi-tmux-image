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
    expected.records.clear();
  }

  function connect(tui) {
    disconnect();
    const next = {
      tui,
      epoch: Symbol("pi-tmux-image connection"),
      controller: new AbortController(),
      records: new Map(),
    };
    connection = next;
    return () => disconnect(next);
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
     * Future native renderer interface. key identifies an immutable occurrence;
     * prepare(width, { epoch, signal }) returns { uploads, lines }. Callers cache
     * normalized PNGs/IDs separately and include geometry/cell-size in key when
     * width alone does not identify layout. fallback(width, error?) fits width.
     *
     * Components have no local render cache, so requestRender is sufficient;
     * host invalidate/rebuild can create another component with the same key.
     */
    component({ key, prepare, fallback }) {
      return {
        render(width) {
          const active = connection;
          if (!active) return fallback(width);
          let sizes = active.records.get(key);
          if (!sizes) active.records.set(key, sizes = new Map());
          let record = sizes.get(width);
          if (!record) {
            record = { lines: undefined, error: undefined };
            sizes.set(width, record);
            // Even synchronous preparation runs outside the synchronous host frame.
            let prepared;
            Promise.resolve().then(() => {
              active.controller.signal.throwIfAborted();
              return prepare(width, { epoch: active.epoch, signal: active.controller.signal });
            }).then((result) => {
              prepared = result;
              if (connection !== active) {
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
              if (connection !== active) return;
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
