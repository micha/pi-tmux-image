# Viewer public UI seam — Pi 1.0.3 feasibility and production viewer

## 0.3.0 implementation status

`src/viewer.mjs` now implements the public policy proved below and
`extensions/tmux-image/index.ts` wires it to immutable active-branch snapshot indexing,
ready-cell-only fullscreen `MouseRegion` clicks and `/tmux-image-view`. A
newest-first keyboard picker shares the same owned overlay; one snapshot opens
automatically. No viewer history/session fields, source rereads, new attachments,
model turns or image-policy filters are introduced.

Implemented choices: 1.25× fit-relative zoom, 25% minimum, dynamic 297-canvas
maximum, four-cell pan, fit/recenter each open, preserved/clamped normalized center
and fit factor on resize, and **20×7** graphical minimum with keyboard-owned
fallback below it. Zoom/limit title width is reserved before label truncation;
long paths abbreviate to basename and PDF page identity is a separate hint.
`+` uses literal/public `parseKey` and `Shift+=` matching: Pi 1.0.3
`matchesKey('+', '+')` is false. Public-host regressions require actual prototype
growth for ASCII/Kitty/shift-equals reports, shrinkage for raw/Kitty minus, stable
source-center window origins and both foreground/colon-underline IDs through CJK
chrome and width fitting.

Native `resolvePayload`/`reserveViewerPlacement`/`prepareViewer`/`releaseViewer` /
`prepareViewerRetirement` share one private slot, PNG residency and the inline
queue. `presentation.connection`/`bind`/`commit` extend the existing public widget
seam. UI keeps one pending prepare plus one latest intent, drains canceled work
before retirement/rebind, and retries a retained obligation before new reserve.
Retirement retries capture current connection/context **after** awaiting close.
A nonempty prepared retirement forces public `tui.renderNow()` outside the host
frame/focus callback before final guarded commit; flush failure invokes the
prepared failure callback and preserves the bounded obligation. Recovery must
successfully flush before deletion too. Actual Alt/Main tests with fully cached
guards and **no caller renderNow** prove HOST-FRAME precedes scoped PRIVATE-DELETE,
including an unrelated upper dialog; throwing-frame and concurrent-refresh races
have controller regressions.

Verified prior commits: plan `d324d87`, gate `e92b1cd`, pure `dd13569`, shared
runtime `5898185`; final package 0.3.0 is committed at `210d524`.
Focused controller tests **12/12** and actual-host seam **22/22** pass. Final
production public SDK matrix **15/15**, host-enabled suite **181/181**, existing
SDK **12/12**, and portable **150 passed / 31 optional skips** pass on the exact
verified source. The owner confirmed “all is working!” after being asked to reload
and try click-open/zoom/pan/reset/Esc on Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3 with
`terminal.images: auto` and `images.blockImages: true`, package 0.3.0 (`210d524`).
This is general human acceptance of the new in-pane viewer, not a separate report
for each manual case. Both PDF pages, keyboard picker/regular mode, other terminals,
modal/search, bounds, reconnect, source-deletion and failure races were not
individually reported; narrower cases remain automated-only or human-pending.
No camera inspection or latency measurement was made. Baseline inline observations
remain distinct; see [viewer-verification.md](viewer-verification.md).

## Gate decision

**Public UI feasibility gate READY under the coordinator-authorized v1 policy:**
direct owned `TUI.showOverlay`, refuse admission while any overlay exists, and
close the viewer on public focus loss. Click, keyboard controls, lifecycle and
ordered transport have actual-host proof. This policy resolves the host's search
routing limitation without intercepting global keys or reading private state.
`ctx.ui.custom` in the earlier plan was a proposal, not an absolute API requirement.
The following records the Step 1 evidence; current production status is above.

`test/host-viewer-seam.test.mjs` runs actual exported `CustomMessageComponent`,
`TuiAltScreen`, `TuiMainScreen`, `InteractiveMode`, SDK sessions and the host's real
`ctx.ui.custom` implementation against a capture terminal. Mouse input enters the
terminal's installed input callback as SGR reports; it is **not** a direct call to
the test component's handler. The offline model-runtime boundary fails if invoked.
No settings files, active package reload, terminal graphics on the real tty,
provider calls or private imports/patches are used.

### Rejected `ctx.ui.custom` findings (resolved by the direct API below)

1. **Completion removes the last-created overlay, not the completing overlay.**
   `InteractiveMode.showExtensionCustom` calls `this.ui.hideOverlay()` in `done`.
   `TuiBase.hideOverlay()` pops the overlay stack. Actual-host reproduction opens
   LOWER and UPPER through `ctx.ui.custom`, then completes LOWER: LOWER is disposed
   but remains mounted, UPPER disappears without disposal or promise completion.
   Completing UPPER subsequently removes LOWER. `handle.focus()` changes visual
   order/focus, not stack insertion order; it is not a fix.
   - A one-open reservation prevents this extension opening two viewers, but
     cannot prevent other extensions/host custom overlays above it.
   - `OverlayHandle.isFocused()`/`getBounds()` do not disclose stack ownership.
     Deferring close until focused is not proof that stack-pop targets the viewer.
   - Do **not** call `handle.hide()` for a `ctx.ui.custom` overlay: forbidden by the
     documented contract and the agreed plan, and `done` would still pop another
     overlay afterward.
   - **Resolution:** use sanctioned public `TUI.showOverlay` and its own
     handle (below), not a `ctx.ui.custom` handle. An upstream custom-completion
     fix would be useful but is no longer required for our direct controller.
2. **Early completion of an async factory skips disposal of its later result.**
   Actual-host test completes while factory promise is pending, then resolves a
   disposable component: it never mounts and `dispose()` is never called.
   A lightweight synchronous factory, a reservation before all awaits, and
   controller-owned idempotent cancellation/disposal can avoid this for our code.
   Do not await pixel preparation inside the factory; display a preparing state.
   Even synchronous factories mount in a promise continuation: guard completion
   before `onHandle`, and do not rely solely on Pi to clean up an unmounted result.

A concurrent **built-in `ctx.ui.select`** is a different case: it occupies the
editor area rather than a second overlay. Tests in both modes show programmatic
viewer completion from `session_shutdown` disposes the viewer once and removes
its overlay; the dialog is independently canceled through its public abort
signal. That success does not fix the rejected stacked-custom-overlay API.

### Sanctioned direct overlay: actual-host ownership proof

`TUI.showOverlay(component, options): OverlayHandle` is public and uses the same
Pi renderer, pane, layout, focus and input loop. Its **own** `handle.hide()` removes
that exact entry and retargets other overlay pre-focus references. The documented
prohibition on hiding a `ctx.ui.custom` handle does not apply here. The controller
must own its waiter/disposal/cancellation; `showOverlay` does not call `dispose`
or settle a promise.

Both-mode actual InteractiveMode tests open a raw lower viewer and unrelated
upper `ctx.ui.custom` overlay, close the raw lower viewer programmatically, and
prove upper bounds/focus/promise remain active. Escape closes the upper normally;
editor focus and draft are restored (including retargeting the removed lower
pre-focus). Fullscreen transcript position is unchanged. Additional tests cover
full-pane mouse ownership, 40x16→12x6→40x16 resize, upload-before-raw-cells,
refresh-like idempotent cancellation, repaint removing raw placeholder cells,
actual zero-row widget removal triggering controller close, and `session_shutdown`
closing/disposing/settling once before host reset. Regular capture output repaints
underlying content without re-emitting closed cells. This is not pixel retirement:
the protocol/lifetime owner separately handles ephemeral terminal prototypes.

Suggested close sequence: reserve one open before awaits; mount a lightweight
synchronous raw component; on close invalidate/abort its surface work, unsubscribe
only owned listeners, hide the **owned raw** handle, dispose idempotently, settle
owned waiter, release reservation. Widget disposal/shutdown and explicit refresh
must converge on this path. No async custom-factory completion race exists.

### Host search boundary and rejected trapping assumption

Fullscreen host dispatch runs search mouse handling **before** overlay dispatch.
The test opens public fullscreen search, enters `TRANSCRIPT`, records its rendered
navigation coordinates, then places a focused full-pane raw viewer above it.
All `+/-/0/hjkl`, Escape and wheel controls first pass unchanged-scroll/editor
assertions with that lower search still active; Escape removes only the viewer.
After reopening the viewer, clicking the now-hidden search ↑ control changes
`viewportTop` beneath it. The viewer receives release only; its consuming mouse
root never receives press.

`TUI.addInputListener` and `ctx.ui.onTerminalInput` append listeners after the
fullscreen constructor's existing viewport listener. The test installs both,
scoped to `ownedHandle.isFocused()`: neither sees those consumed mouse presses,
releases, nor the global fullscreen search shortcut. Printable `+` does reach the
later TUI listener; without a filter, viewer `h`/Escape work normally. There is no
public listener-priority argument, normalized pre-dispatch interceptor, search
state accessor or scoped search-close method. No private listener removal/reorder,
synthetic terminal input, monkeypatch or second input loop is acceptable.

### Authorized v1 resolution: admission plus close-on-focus-loss

The coordinator authorized this v1 lifecycle default (the earlier plan left that
policy undecided), and **actual-host tests now prove it**:

1. Refuse open if public `tui.hasOverlay()` is true; ask the user to close the
   current dialog/search first. The test refuses real existing search without
   mounting a viewer or altering the screen/scroll, then allows open after Escape.
2. Mount the lightweight raw component with a public `Focusable.focused` accessor.
   On true→false, synchronously mark its lease closing, invalidate publication and
   abort work. No ready rows may publish once closing. Schedule **one** owned hide,
   dispose and waiter settlement after the host focus transition (microtask),
   guarding recursive focus loss and repeated explicit closes. Retain the one-open
   reservation until teardown completes.
3. Let new host search/dialog input proceed. Ctrl+Shift+F is **not trapped**: the
   host creates search and transfers focus; that public focus transfer closes the
   viewer, exposing search. Reopen starts fresh after the host dialog is closed.

Positive-control testing uses the identical recognized Ctrl+Shift+F report in the
same fixture with and without a viewer. With the guarded viewer, its closing
callback observes original editor draft and fullscreen `viewportTop` unchanged,
and its abort signal is already set before subsequent reports in the same batch.
Search query reports are then allowed because the viewer is logically closed.
Deferred scoped removal preserves the visible/focused search, no stale viewer
frame appears, and later search navigation cannot reach a live viewer or its mouse
handler. Search Escape restores editor focus through correctly retargeted
pre-focus, not the disposed viewer.

Both-mode tests open an unrelated upper `ctx.ui.custom` dialog: focus loss marks
the viewer closing before `onHandle`; batched input reaches the upper dialog;
owned deferred removal leaves that dialog focused/mounted and does not settle or
dispose it. Its Escape restores the draft editor. Real built-in `ctx.ui.select`
likewise takes focus, cancels the viewer, retains selection input, and restores
editor focus afterward. Escape-first versus focus-loss, repeated shutdown/refresh
close calls, and an upper overlay mounted before cleanup all dispose only the
owned viewer once. Ordinary `+/-/0/hjkl`, wheel/click and repeated renders do not
spuriously cancel the focused viewer or change hidden editor/scroll.

This is explicitly **new-modal-closes-viewer**, not suspension, trapping all global
keys or remaining open underneath search. Do not blindly call `handle.focus()` /
`tui.setFocus(component)` again on an already focused lease: host `setFocus`
assigns false then true, so a redundant refocus can look like loss. Focus acquisition
is owned by mounting; never install a second loop or reorder private listeners.
Upstream modal pre-routing/occlusion-aware search would improve Pi generally but
is no longer required for this authorized v1 policy. The tests retaining the
unsafe no-policy cases are regression evidence, not recommended code.


## Exact supported interfaces

Installed package public entry points and declarations (relative to the installed
coding-agent root):

- `dist/index.d.ts`: exports `CustomMessageComponent`, `InteractiveMode`,
  `createAgentSessionRuntime`, `createAgentSessionServices`,
  `createAgentSessionFromServices`, `SessionManager`, `SettingsManager`.
  `InteractiveModeOptions.terminal?: Terminal` is the capture seam; `init()`,
  `getUserInput()`, `stop()` are public.
- `dist/core/extensions/types.d.ts`: `MessageRenderer<T>` receives
  `(message, { expanded, outputPad }, theme) => Component | undefined`; no `ctx`.
  `ctx.ui.setWidget(key, (tui, theme) => Component & { dispose?() })` supplies
  the public TUI transport. `session_start` supplies current `ExtensionContext`;
  `session_shutdown` is the idempotent teardown boundary.
- `ExtensionUIContext.custom<T>(factory, options): Promise<T>`:
  `factory(tui, theme, keybindings, done)` returns a component or its promise.
  Options: `overlay`, `overlayOptions` and `onHandle(handle)`. Complete with
  `done(result)`. Components may have `dispose()`.
- `@earendil-works/pi-tui` public entry point exports `MouseRegion`, `Box`,
  `Container`, `ScrollView`, `TuiAltScreen`, `TuiMainScreen`, `matchesKey`,
  `getCellDimensions`, `visibleWidth`, `sliceByColumn`, `compositeTuiLine`,
  `TuiMouseEvent`, `TuiMouseEventResult`, `OverlayOptions`, `OverlayHandle`.
  Its internal dispatch helpers are **not** public entry-point exports and are
  unnecessary; do not import them directly.
- `TuiMouseEvent`: local zero-based `x/y`, absolute `screenX/screenY`, component
  `width/height`, type (`press/release/move/drag/click/wheel`), button, modifiers,
  optional `wheelDelta/clickCount`. Result fields: `handled`, `capture`, `focus`,
  `render`. Capture/focus imply handled. Preserve unhandled events by returning
  `undefined`, not an unconditional handled result.
- `OverlayOptions`: percentage/absolute width and maxHeight, minimum width,
  anchor, row/col, offsets, margins, visibility predicate, nonCapturing.
  `OverlayHandle`: `getBounds()` returns last rendered terminal-relative
  `{row,col,width,height}`; `isFocused`, `focus`, `unfocus`, `setHidden` exist.
  Bounds are absent before the first frame, after removal, or while invisible.
- Public `TUI.terminal.write(string): void`, `terminal.columns/rows`,
  `showOverlay(component, options): OverlayHandle`,
  `addInputListener(listener): () => void`, `tui.requestRender()`, component
  `invalidate()` supply overlay ownership, optional later filtering and repaint.
  `TUI` has no transcript scroll-offset accessor; the exported concrete
  `TuiAltScreen.viewportTop/getScreenLines()` are test diagnostics, not an excuse
  to reach into InteractiveMode's private transcript `ScrollView`.

Sources inspected: complete installed `docs/extensions.md`, `docs/tui.md`;
related SDK, themes, configuration, settings, packages, keybindings, terminal
setup, tmux, message types and session format; shipped `overlay-qa-tests.ts`,
`message-renderer.ts`, widget/footer/modal-editor/Q&A examples, DOOM overlay entry
and SDK runtime example; public declarations and shipped implementation of the
custom-message wrapper, custom UI completion, mouse routing and overlay layout.
Context7 was already quota-exhausted; evidence is the installed primary host.

## Mouse routing and controller handoff

`CustomMessageComponent` extends `Container`, adds a one-row leading spacer and
mounts the renderer-returned component directly. It does not impose the default
message box on a custom renderer. `outputPad` is a rendering preference, not an
automatic coordinate offset: the extension's own `Box`/layout must apply it.
Containers and fullscreen layout dispatch propagate transformed mouse coordinates
through the actual scroll/clipping/padding chain.

Actual-host assertions establish:

- A page partly clipped at the transcript top receives screen y=0 but local y=1;
  nested horizontal padding maps screen x=2 to image-local x=0. Padding is not a
  page hit. After rebuilding the custom message and scrolling to page two, clicks
  resolve page two's stable occurrence, not page one's stale component.
- Handle **only primary `click`**, not `press`, `drag`, `release` or wheel. On an
  unhandled press the host starts selection; a release at the unchanged cell
  produces the normalized click. A moved drag selects/copies transcript text and
  does not open the viewer. Unhandled wheel scrolls the containing `ScrollView`.
- An OSC 8 link under that same region opens through the host `openUrl` path and
  does not invoke the enclosing click action. Handling press would bypass this
  arbitration and break both selection and link precedence.
- Regular mode does not dispatch normalized message mouse events. Its open path
  must be keyboard-only; the test exercises Enter → `getUserInput()` → public
  `session.prompt(command)` (the normal interactive loop's public operations).

Suggested future interface (not implemented):

```text
renderer(message) -> MouseRegion(image component, event =>
  primary click in image cells ? controller.requestOpen(occurrence, page) : undefined)

session_start(ctx) -> controller.bind(current ctx, session/connection generation)
session_shutdown  -> controller.cancel(generation), unbind, release own work
```

The closure passes only stable occurrence/page identity, never a captured source
path or old `ctx`. The live controller re-resolves an immutable snapshot from the
active branch, validates generation/mode/capability, reserves one interaction
**before awaits**, then opens asynchronously outside render. No `sendMessage`,
`appendEntry`, model prompt, new attachment, source read or settings write is
needed. The actual InteractiveMode test opens from this renderer-to-current-ctx
closure and confirms editor draft/fullscreen scroll remain unchanged on close.

## Overlay geometry, focus and scroll

Both actual interactive modes grant the custom component keyboard focus; `+/-/0`,
`hjkl`, PageUp and Escape do not edit the hidden draft. Escape completion restores
editor focus, calls disposal once, and a subsequent typed character edits the
original draft. Repeated completion is harmless. Percentage dimensions/margins
recompute under resize; tests shrink 40x16 to 12x6 and restore it, checking bounds
remain inside margins. Fullscreen viewport position survives the round trip.

The fullscreen command test starts away from the transcript end, submits the slash
command through the actual editor/Enter input callback, and calls public
`getUserInput()`/`session.prompt()` as the main loop does. It verifies scroll
position from **invocation**, not merely dismissal. The command itself does not
append conversation messages or start a model request. Typing a command consumes
that editor command text; it is not an alternate way to preserve a pre-existing
unsubmitted draft. Click opening preserves a draft.

Regular mode owns **native terminal scrollback**, for which Pi exposes no scroll
position query/restore API. Automated evidence establishes unchanged transcript
component content, editor focus/draft and ordered output, not the external
terminal's scrolled-back viewport. That needs owner-observed terminal acceptance;
no private scroll-offset workaround is justified. The overlay lives within the
current pane/window terminal dimensions, not a separate tmux popup.

Important implementation boundaries:

- A small centered overlay is not a pointer-modal barrier. Fullscreen routes
  pointer events outside its rectangle to underlying components. Use a full-pane
  overlay root (100% width, full terminal-row render height, row/col zero) that
  consumes mouse events, with an inner bounded viewer/chrome. The earlier full-pane
  test blocks underlying page clicks and wheel scroll in ordinary mouse dispatch.
  Hidden fullscreen search is an exception proved above;
  the full-pane root alone is not a universal modal barrier. Wheel policy
  inside can be ignore or pan later; hidden transcript mutation must remain gated.
- Do not use responsive `visible`/`setHidden(true)` for small-pane handling: an
  invisible capturing overlay loses focus, so Escape may reach the editor. Keep
  a visible keyboard-owned small-pane fallback until owner decides minimums.
- In Pi 1.0.3 the `custom` options callback is evaluated when showing the overlay,
  not each frame. Percentage `OverlayOptions` themselves are re-resolved by TUI.
  Prefer stable full-pane options plus per-render public terminal dimensions;
  derive inner usable cells after subtracting explicit border/padding/chrome.
- `getBounds()` is last-frame diagnostic state, not reliable current layout before
  render/preparation. There is no public extension resize event: observe supplied
  render width, public terminal height and `getCellDimensions()` each frame,
  coalesce/cancel async work and request render after preparation.
- Border/background styles belong to chrome only. Do not theme-wrap placeholder
  strings or mix terminal upload bytes into component rows.

## Graphics/text ordering and addressed viewport evidence

Both-mode actual InteractiveMode tests upload through the supplied
`tui.terminal.write(wire)`, then mark rows ready and request render. The captured
wire precedes the first placeholder character. Actual overlay borders, column
position, width fitting, ANSI slicing and maxHeight clipping retain independently
addressed **nonzero-origin** cells from a 12x8 prototype: visible subset starts at
row 2/column 3, with foreground image ID `0x123456` and underline placement ID
`0xabcdef`. Bottom maxHeight clipping does not rewrite row marks; left/right
width slicing does not lose the surviving independent column marks. No host global
Kitty deletion is emitted under normal automatic tmux-style capabilities
(`images: null`). Forced-native Kitty remains denied by the existing package gate.

This is **captured stream/component evidence, not outer-terminal pixels or Kitty
ACKs**, and not a claim that `U=1` source-crop x/y/w/h works on Ghostty. Use the crop
worker's independent addressed-cell viewport decision and bounded 0..296 marks;
see [viewer-crop.md](viewer-crop.md). Host overlay layout clamps coordinates into
its terminal area rather than exposing negative-position top/left crop options;
the component owns its subset/intersection. Existing inline host tests additionally
cover normal slicing and scroll clipping. Target-terminal border/edge/resize
visual acceptance is still pending.

## Verification

```sh
npm test
PI_OFFLINE=1 PI_TEST_HOST_ROOT=/path/to/installed/pi-monorepo \
  node --test test/host-viewer-seam.test.mjs
```

Final automated checkpoint: focused actual-host viewer seam **17/17**, consolidated
host-enabled suite **131/131**, portable suite **105 passed / 26 optional host
skips**. `git diff --check` passed. The optional host tests skip cleanly without
`PI_TEST_HOST_ROOT`. They use isolated
in-memory settings and temporary SDK directories, removed afterward. Ordinary
lifecycle assertions compare exact SDK messages/entries before/after interaction
and forbid model calls. Passing tests named **BLOCKER** deliberately reproduce the
unsafe installed-host behavior; they do not endorse it.

Scope deliberately excludes protocol cropping/retirement feasibility (other
workers), production controls, live package installation/reload and manual pixel
checks. Public UI feasibility is ready under the authorized admission/focus policy;
production integration and general owner acceptance are now above. The final SDK
report and scoped owner acceptance remain separate from this historical gate;
unreported manual cases are not inferred from either.
