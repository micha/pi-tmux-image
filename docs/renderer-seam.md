# Renderer integration decision — Pi 1.0.3

## Decision and current scope

Use the **public widget factory → TUI terminal + repaint** seam. Install a
zero-row, namespaced widget from `session_start`, keep the injected TUI only for
that connection, and disconnect from both widget disposal and `session_shutdown`.
Do not replace Pi's footer/editor, intercept stdout, import private host modules,
or put transport prefixes into transcript rows.

`src/presentation.mjs` implements this boundary without importing Pi. The current
extension routes existing command-time Chafa uploads through its `write()` method;
commands, tools, attachments, message details, narrow-pane behavior and
`triggerTurn: false` remain unchanged. This deliverable **does not replace Chafa,
regenerate restored messages, implement automatic replay, or resize existing
image grids**. The asynchronous component interface is ready for native snapshot
encoding integration, not wired into the legacy message renderer yet.

Supported evidence is Pi's normal tmux capability selection (`images: null`), in
both regular and fullscreen TUI modes. Forced native Kitty fullscreen rendering
has an unresolved host reset boundary described below. Never change user
capabilities to hide that limitation.

## Primary API evidence

Inspected the installed Pi 1.0.3 distribution, not OMP API guesses. Paths below
are relative to the installed coding-agent package root (the `pi-monorepo`
directory in this installation):

- `docs/extensions.md`: factories must not start long-lived resources; use
  `session_start`/idempotent `session_shutdown`. Terminal-only work must guard
  `ctx.mode === "tui"`, not just `hasUI` (RPC also supports some UI).
- `docs/tui.md`: component output must fit width; invalidate affected cached
  output and call injected `tui.requestRender()` after asynchronous state changes.
- `dist/core/extensions/types.d.ts:101–104`: `ctx.ui.setWidget(key, factory)`
  receives `(tui: TUI, theme: Theme)` and returns `Component & { dispose?(): void }`.
- `node_modules/@earendil-works/pi-tui/dist/tui.d.ts:213–243`: public `TUI`
  exposes `terminal`, `requestRender(force?)`, and `renderNow(force?)`.
- `node_modules/@earendil-works/pi-tui/dist/terminal.d.ts:23–46`: public
  `Terminal.write(data: string): void`, `columns`, and `rows`.
- `dist/core/extensions/types.d.ts:1132`: message renderer receives only
  `(message, options, theme)`, not a TUI or repaint callback. Therefore an
  independent supported factory is needed to obtain the connection.
- `dist/index.d.ts:36`: `CustomMessageComponent` is publicly exported.
  `pi-tui/dist/index.d.ts` publicly exports `TuiMainScreen`, `TuiAltScreen`,
  `visibleWidth`, `sliceByColumn`, `getCellDimensions`, and the terminal types.
- `examples/extensions/custom-footer.ts`: asynchronous notifications use
  injected `tui.requestRender()`; `dispose` owns unsubscribe cleanup.
  `widget-placement.ts` and `message-renderer.ts` demonstrate the two APIs used.

Also read the complete relevant local cross-references: packages, themes,
configuration, settings, SDK, CLI, terminal setup, tmux, session format and
message types; inspected the SDK extension/runtime examples and entry renderer.
Context7 quota was already exhausted; evidence is current primary local docs,
declarations and shipped source. No upstream implementation was copied.

## Ordering and epoch contract

```
render(width) → cache miss → queue preparation → return readable fallback
                 ↓ (outside synchronous render)
prepare(width, {epoch, signal}) → normalized snapshot + pure encoded output
                 ↓
TUI.terminal.write(uploads) → publish ready rows → TUI.requestRender()
                 ↓
next frame renders only SGR + placeholder cells
```

This guarantees **host output stream order**, not an acknowledgment that the
outer terminal decoded the PNG. Complete wrapped commands must be quiet and
cursor-independent (`U=1`). `Terminal.write` returns void; the stream's own queue
preserves ordering even when writes are buffered. No upload is done inside
synchronous `render(width)` or in a component-line prefix.

Each attachment to the widget creates a fresh runtime `Symbol` epoch and abort
controller. Disconnect aborts in-flight work and clears prepared rows. Stale
completions cannot upload, publish cells, or repaint a replacement connection.
Widget disposal is epoch-specific: disposing an old widget cannot close a newer
connection. Nothing about residency is persisted in session details.

The async component itself has no local layout cache; each render checks the
connection's shared record. Thus a normal `requestRender()` is sufficient when
preparation completes. Actual Pi message invalidation rebuilds the custom
component, so jobs are keyed outside the individual component instance to avoid
repeated normalization/uploads during rebuilds. Failed preparation leaves a
readable fallback and does not retry every frame. Width misses share one pending
job per occurrence/key/width; different widths may prepare independently.

### Suggested native encoder interface

```js
presentation.component({
  key: immutableOccurrenceAndGeometryKey,
  prepare: async (width, { epoch, signal }) => ({
    uploads: wrappedPngAndVirtualPlacementCommands,
    lines: independentlyAddressedPlaceholderRows,
  }),
  fallback: (width, error) => readableWidthFittingRows,
});
```

`prepare` owns snapshot selection, supported PNG conversion, aspect fitting,
stable image/placement IDs and residency reuse. Keep the standard image content
canonical, not source paths or copied base64 in rendering details. Key placement
geometry/cell dimensions separately from payload identity. The seam caches by
caller key and width only: height/cell-size changes need caller key invalidation
or an extended geometry-key API during integration. This is not a complete
height-responsive layout or memory-budget policy. Cache ownership lasts for the
connection; no terminal resources are globally deleted during extension cleanup.

## Lifecycle investigation

`dist/core/extensions/types.d.ts:552–559,615–621` declares:

| Operation | Old runtime event | Fresh runtime event |
|---|---|---|
| Initial startup | — | `session_start`, reason `startup` |
| `/reload` | `session_shutdown`, reason `reload` | `session_start`, reason `reload` |
| New session | `session_shutdown`, reason `new` | `session_start`, reason `new` |
| Resume/switch | `session_shutdown`, reason `resume` | `session_start`, reason `resume` |
| Fork | `session_shutdown`, reason `fork` | `session_start`, reason `fork` |
| Orderly quit | `session_shutdown`, reason `quit` | — |

Actual SDK runtime tests verified startup/reload/new/resume/quit, not merely the
declarations. Reload source (`dist/core/agent-session.js:2899–2931`) awaits old
shutdown, invalidates the runner, reloads resources, rebuilds runtime, and emits
fresh start. Runtime replacement (`dist/core/agent-session-runtime.js`) similarly
tears down and rebinds the replacement. Widget cleanup in interactive mode
(`dist/modes/interactive/interactive-mode.js:1848–1908`) calls component disposal
when removing/replacing widgets and resetting extension UI.

There is **no public extension resize event**. `Terminal.start`'s resize callback
calls `requestRender()` (`pi-tui/dist/tui.js:563`), and components observe their
new available width. Do not install a second terminal input/resize owner.
`getCellDimensions()` is a public geometry source for later integration. Session
tree navigation has its own `session_tree` event; it is not a new connection epoch.

There is no public terminal-reconnect/graphics-reset notification. Abrupt process
kill cannot run cleanup. Explicit recovery may be needed after a reconnect;
automatic universal terminal reset detection is not claimed.

## Rejected prefix technique and forced-native limitation

**Wrapped APC/DCS prefixes are not safe component text in this host.** Actual
public utility tests show one SGR-styled placeholder cell has width 1, but a tmux
DCS-wrapped upload followed by that cell has a greater measured width;
`sliceByColumn(..., 0, 1)` cuts into the DCS and loses the cell. Shipped
`terminal-image.js:141–148` recognizes *any* nested `ESC_G` as an image line,
while ordinary width/slicing utilities do not understand the complete outer
DCS/escaped ESC framing. That changes resets, overlay and image-processing paths.
Keep wrapped commands exclusively in the terminal transport.

**Fullscreen forced-native Kitty is not safely supported by out-of-band residency.**
`pi-tui/dist/tui-alt-screen.js:1486–1489` can emit `deleteAllKittyImages()` on a full
redraw when the host's own uploaded-image set is empty. A height-only resize can
therefore emit a global deletion before already-cached extension cells, with no
extension upload or reset callback. A focused actual-host test reproduces the
unsafe stream. Native tmux forwarding of those unwrapped host deletes depends on
the terminal path; this test proves host output, not outer-terminal pixel loss.

Mixed native images can also introduce global placement deletion. Merely checking
`fullRedraws` after rendering is too late; replaying every frame is not an
acceptable workaround. The extension must diagnose unsupported forced-native
combinations during native integration, without mutating capabilities. General
support needs an upstream public graphics ownership/reset hook (or host deletion
scoped to owned IDs), ideally with uploads coordinated before the placeholder
frame. This is not a blocker for the tested normal tmux `images: null` seam.

## Verification and limits of evidence

Portable tests: `npm test` includes pure presentation lifecycle/ordering tests.
Actual-host tests are optional so no physical Pi packages become dependencies:

```sh
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/coding-agent/package npm test
```

`test/host-seam.test.mjs` imports only public package entry points. It runs actual
`CustomMessageComponent` and both host renderers against a capture terminal,
checks asynchronous repaint, upload-before-cells, preserved ID colors/combining
marks, cache reuse on host rebuild, width resize, unchanged snapshot/message
counts, unsafe wrapped text, and the forced-native reset boundary. Its SDK test
loads the actual extension in isolated directories, exercises lifecycle changes
and a non-TUI command guard without calling a model. Separate checks confirm
print/JSON/RPC/outside-tmux attach no transport. All temporary SDK files are
removed.

An isolated `PI_CODING_AGENT_DIR` installation (`pi install .`, `pi list`, offline
`pi --help`) also passed. No active package was activated/reloaded, no user or
tmux settings were changed, and no model requests were made.

These are automated host stream/component tests, **not human-observed pixels**.
New text, scroll up/down, pane position, window switching, zoom/unzoom, resize,
image/PDF visual correctness, and native snapshot replay still need coordinated
interactive verification when native encoding is integrated.
