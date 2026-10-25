# Viewer lifetime and shared graphics ownership — Step 1 review

## Decision and evidence boundary

Architecture review against `d324d87` (plan checkpoint), Pi **1.0.3** and the
existing native implementation. This is **not production implementation**.
The coordinator reports the authorized public UI/API lifetime policy gate passed
**17/17 actual-host tests** in `test/host-viewer-seam.test.mjs`; this worker also
inspected its admission/focus-loss proof. No settings changes, active reload, real terminal
graphics, source-image reads, model requests or new dependencies were used.
Context7 quota was already exhausted; installed primary docs/declarations/source
and the Kitty specification were used instead.

Recommended design: **one shared native payload/residency owner, one open viewer
reservation, one fixed private virtual-prototype slot**, and a public
**`TUI.showOverlay` / owned `OverlayHandle.hide`** lifetime obtained through the
existing widget-injected TUI. The coordinator/user explicitly authorized this
alternative after actual-host UI tests reproduced `ctx.ui.custom`'s wrong-stack
completion bug. This is still Pi-managed rendering/input, not a second renderer.
Inline history remains
append-only in its current successful-prototype registry. Viewer motion/open
history must not enter that registry, the inline presentation cache or the stable
allocator. No global deletion and no image-pixel deletion are needed.

The crop worker reports that Ghostty 1.3.1/current ignores virtual-placement
source `x/y/w/h`. Accordingly, the recommended candidate is a bounded whole-image
canvas (`c/r <= 297`) plus an independently addressed viewport subset. Pan changes
placeholder origins, not the prototype. Zoom/resize redefines the private
whole-image prototype at the same `(imageId, placementId)`; it does not redefine
an inline prototype. The crop worker owns verification of this protocol/target
claim. Do not advertise source-crop support or unconstrained zoom.

**UI/API gate approved for this policy:** actual-host click/drag routing,
regular/fullscreen owned lifetime, compositing/removal, close with a later host
overlay, admission refusal and immediate logical close/deferred physical cleanup
on public focus loss. See [viewer-seam.md](viewer-seam.md) and its `READY policy`
tests. Target-terminal pixel acceptance, including regular-mode terminal-owned
scrollback behavior during growth, is still not established by captured streams.
A pure bounded-state test is architecture evidence, not a substitute for the
host tests or owner-observed pixels. See [image-viewer-plan.md](image-viewer-plan.md)
and [implementation-plan.md](implementation-plan.md).

## Existing code and why it must not simply be reused for motion

- `src/native.mjs`: `normalize()` shares a promise by immutable attachment
  MIME/base64 hash; `payloadIdentity()` hashes **exact normalized PNG bytes**.
  Successful `prepare()` commits image residency and every retained
  occurrence/geometry prototype into `ownedPlacements`. Same-ID PNG transmission
  recreates **all** retained prototypes. Queue reservations are released by
  success, failure and signal abort, preserving predecessor order.
- `src/identity.mjs`: `GraphicsIdentityRegistry.resolve()` allocates both image
  and occurrence/geometry placement IDs. `StableIdAllocator` has no release API;
  every unique key stays in `#byKey`/`#used`. Calling it with viewport/generation
  variations leaks allocator state even if another cache is later pruned.
- `src/presentation.mjs`: `component()` retains every ready/error layout in
  `connection.records`, coalescing only obsolete **pending** layouts. It has no
  per-surface dispose/remove API. Viewer pan/zoom must not use this cache unchanged.
- `src/metrics.mjs`: normalized payload metadata is deduplicated; transport is
  success/current-epoch only. Placement metadata is immutable for a given pair:
  changed geometry at the same ID currently throws. There is no replacement or
  scoped-retirement event. That API must be extended explicitly, not bypassed.
- `src/capabilities.mjs` and `extensions/tmux-image/index.ts`: current public policy,
  read-only bounded tmux detection, pre/post preparation checks, synchronous
  ready-row gates and unified refresh generation must remain the common authority.
  `images.blockImages` is **not** a viewer-display gate.

Keep the existing inline identity and history-retention behavior. A viewer needs
an explicitly ephemeral surface path, not an invented durable occurrence for each
pan. Existing total inline/payload history is intentionally unbounded; this
proposal bounds **incremental viewer state**, not total terminal or session memory.

## Ownership and proposed interfaces

Names below are design interfaces, **not existing exported repository APIs**.

### Shared owner (native worker/coordinator)

1. `resolvePayload(snapshot, signal)` calls the existing immutable normalization
   cache; returns a shared normalized record/payload key/image ID. Split image-ID
   lookup from the current inline `resolve()` so opening a viewer does not allocate
   an unused inline placement. Do not duplicate PNG bytes, normalize on each key,
   reread a path, rerun Poppler or append a session entry.
2. `prepareInline(...)` preserves existing occurrence/geometry identity and all
   successful history prototypes. Same PNG across different formats/occurrences
   shares the exact-byte payload ID and epoch residency.
3. `acquireViewer(sessionToken, occurrencePage)` reserves the controller **before
   any await**. Candidate modal admission also requires public `tui.hasOverlay()`
   to be false before starting and immediately before mounting after any awaits;
   an existing search/overlay dialog gets a readable "close it first" refusal,
   not hidden UI stacking. The approved v1 lifecycle below closes on public
   focus loss when a later host dialog/search takes input; actual-host tests
   establish its safety. Reserve one placement ID once from the same collision-checked
   allocator under a constant private key, e.g. `surface:viewer:slot:0`. The key
   must not contain open count, crop, pan, zoom, geometry, epoch or generation.
   The placement namespace is `(imageId, placementId)`, so the slot can be rebound
   to another payload **after** safe retirement of its prior tuple. One-open also
   covers the picker/opening/closing phases; reject/coalesce duplicate open
   requests without creating a second interaction or index copy.
4. `prepareViewer(lease, { canvas, origin, visibleGrid, cells }, context)` uses
   payload image ID and fixed private slot ID. Canonical canvas geometry/cell
   inputs form a **replacement validation key**, not an allocation key. Origin
   participates in the **rows/view key** only. It returns ordered transport,
   bounded rows and idempotent success/failure callbacks with captured
   `{sessionToken, epoch, leaseGeneration, viewGeneration}`.
5. `releaseViewer(lease, reason)` immediately excludes it from live replay,
   aborts/releases queued work and clears ready/pending rows. It separately
   schedules at most one capability-guarded scoped retirement obligation.

A lease is runtime-only, not persisted metadata. Its selected snapshot reference
is immutable; occurrence/page selects the exact branch snapshot, not a pathname
or label. New opens use a new lease generation and fit state, **the same fixed
slot ID**, and no retained prior view cache. Maintain inline and ephemeral maps
separately. A future multi-viewer feature would require a new ownership decision;
never silently grow a slot pool when the sole slot is busy.

### UI and viewport worker boundary

The UI controller owns selection, synchronous lightweight component creation,
the specific public overlay handle and an independently settled interaction promise,
one-open guard, wheel/input suppression, chrome and view intent. The math worker
returns `{canvas, origin, visibleGrid, cells}` with all
marks `0..296` and positive canvas dimensions `<=297`; the native owner owns
IDs, normalization, protocol, queue, epochs, successful prototypes and metrics.

The presentation seam needs a distinct bounded `ephemeralSurface(lease)` path:
**one ready record, one pending job, one latest desired intent, one failure
record**, not a map indexed by all motion keys. Repeated identical pan/layout
reuses rows; new motion replaces the latest desired record. Pending normalization
must not spawn a promise chain per keypress: keep one runner and overwrite latest
intent. Release the per-surface records explicitly on close/dispose; the constant
allocator slot remains reserved for the runtime. The runner responds to
signal abort, but does not relaunch another native reservation until the prior
waiter actually leaves the shared queue. Await the original preparation/settlement;
do not `Promise.race` abort and then spin up one new blocked waiter per keypress.
All retained rows are bounded by the viewport/canvas limit, including preparation
copies. An old component's `dispose` or async completion must never close or
publish into a later lease.

## Constant-space prototype and allocator policy

### Preferred single-slot path

- One slot ID reserved for this native runtime; no allocator release/reuse change
  is required. Local collision checking still shares the inline allocator;
  randomization is not global terminal namespace coordination.
- One committed live tuple `{payloadKey,imageId,placementId,canvasKey,canvas}`.
  Its inline prototype keys/IDs cannot equal the private surface key/ID.
- Pan emits a bounded subset of cells whose explicit row/column marks are
  `origin + local coordinate`. **No PNG or prototype command** when canvas/epoch
  residency is unchanged. Do not cache 10,000 pan origins.
- Zoom/resize emits `a=p,U=1` with the **same image/placement ID** and new canvas
  dimensions; replaces the ephemeral record after successful current transport.
  No inline geometry is changed or removed. All visible cells are regenerated
  from current origin and new bounded canvas before publication.
- A redefinition can change the interpretation of currently displayed viewer
  cells until Pi paints the new frame. Stream order does not promise atomic
  pixels. If that transient is unacceptable or target redefinition is unsafe,
  stop at the gate; a two-slot buffer needs a proven old-frame-removal/retirement
  boundary. Do not invent an after-paint callback or grow per-motion prototypes.
- At close, cancel publication first, complete/remove the overlay, then retire
  only its owned private tuple. Closing does not touch the inline payload ID,
  snapshot normalization or inline retained geometry.
- At subsequent open on a different payload, finish prior scoped retirement
  **before** binding this slot to the new image ID. Opens on the same tuple may
  overwrite it only after reference/cell lifetime is proven safe.

### Retirement and denied/failing cleanup

Kitty specifies replacement for an identical `(image id, placement id)`. Virtual
prototypes are affected only by `d=i/I/r/R/n/N`, not screen-coordinate or `d=a`
deletions. Candidate retirement is **lowercase** scoped ID deletion:

```text
ESC_Ga=d,d=i,i=<owned-image-id>,p=<private-placement-id>,q=2 ESC\\
```

Wrap the complete command in the existing single-layer tmux transport. Ownership
must prove **no inline consumer references this private prototype and no other
active viewer/queued publisher can still reference it**. Do not confuse that with
no inline consumer of the *image pixels*: inline references to the shared PNG are
allowed, and their distinct prototypes must survive. Never use uppercase deletion,
a pixel-delete, an unscoped image-ID delete or a global delete for this viewer.
This phase does not implement payload eviction, even for a viewer-only payload.

A denied capability/throwing retirement cannot justify sending graphics anyway or
forgetting the old tuple. Keep at most **one fixed pending-retirement tuple** (a
bounded tombstone), mark terminal effect untrusted on failure, and block rebinding
to a different payload until an allowed retirement succeeds. No unbounded retry
log, tombstone list or new IDs. Capability loss may close the visible UI immediately;
cleanup/reopen can retry through the ordinary guarded path or explicit refresh.
Epoch reset must not discard an unresolved old-tuple obligation: reset clears
trust, not terminal resources. Runtime shutdown drops runtime metadata only;
prior-runtime terminal resources can remain and are explicitly outside the bound.

**Important gate:** if regular-mode overlay cells can escape into immutable
terminal scrollback during background streaming/resize, fixed-slot redefinition
or deletion may change/orphan that scrollback. Retaining all historical viewer
prototypes is not an acceptable fallback. Actual-host capture tests establish
repaint/removal through the public raw path; owner-observed terminal checks must
still establish regular-mode streaming/scrollback appearance. If that fails,
report the scoped boundary rather than retaining unbounded viewer history.

## Shared retransmission, serialization and cancellation

Use the **same transport serialization authority** for inline, ephemeral
replacement and retirement. Do not construct a second owner that independently
assumes the shared PNG is resident. Keep inline successful history prototypes
across epoch changes, and at write time compute replay as:

```text
all retained successful inline prototypes for image
+ current live committed private viewer prototype for image
+ current validated candidate prototype (deduplicate by image/placement pair)
```

With one private slot, the current desired candidate replaces, rather than adds a
second version of, that pair. **Closed/retired viewer prototypes never replay.**
Same-ID PNG retransmission deletes all placements even when bytes are identical;
a batch must restore all inline prototypes, not merely those currently visible.
An inline-triggered retransmission also restores the live viewer; a
viewer-triggered first upload/epoch replay restores inline history. A delayed
prepared replay must validate/rebuild its ephemeral portion if the live lease
closed or changed before write, or abort/reprepare the batch. Inline restoration
must not accidentally revive a closed viewer from an earlier captured batch.

Ordering for every nonempty candidate or retirement:

1. Validate current session/lease and public policy; async bounded capability
   probe (including fresh visibility on `allow-passthrough=on`).
2. Normalize if necessary, coalesce latest intent and acquire native transport
   reservation. An abortable waiter must release without overtaking its
   predecessor. Do not leave a shared-payload successor waiting for a dead viewer.
3. Prepare with the shared epoch and current prototype set; validate capability
   **again after preparation**, releasing the reservation on rejection.
4. Immediately before synchronous public `Terminal.write`, validate epoch,
   session/lease/view tokens and ready policy. No await between that validation,
   write and functional success commit. A stale job writes **zero bytes**.
5. Successful write commits functional residency/replacement/retirement first;
   diagnostic accounting is guarded afterward. Only then publish current cells
   and `tui.requestRender()`. Failures release reservations, publish no candidate
   cells and record no successful wire totals.

Abort on superseded motion, Escape/cancel, component disposal, refresh,
`session_shutdown` and session replacement. Do not tie viewer lifetime to the
active agent operation's `ctx.signal`: opening during a stream must not disappear
merely because that turn ends/aborts. Its own session/lease signal is authoritative.
Shared immutable normalization does not inherit one consumer's abort, but its
stale result may not upload or request render. A completion already written must
not be forgotten merely because a later callback is stale; use the synchronous
write/commit critical section above and reconcile unknown partial failures without
counting them as successful transport.

## Pi 1.0.3 public lifecycle and blockers

Paths are relative to installed `pi-monorepo`; these source inspections explain
host behavior, not permission to import private modules.

| Public boundary | Exact evidence / use |
|---|---|
| Temporary UI (recommended alternative) | Public `TUI.showOverlay(component, options?: OverlayOptions): OverlayHandle` from the existing widget factory. Raw owned `handle.hide()` removes **its specific entry**; controller, not host `custom`, owns disposal and interaction settlement. No private access, extra renderer or replaced editor. |
| Custom UI (rejected path) | `dist/core/extensions/types.d.ts:121–130`: `ctx.ui.custom<T>((tui, theme, keybindings, done) => Component & {dispose?()} or Promise<...>, {overlay:true, overlayOptions?, onHandle?}) -> Promise<T>`. Completion wrongly pops the top entry when another overlay is above it. **Never call its handle.hide() as a workaround**; use a raw public overlay instead. |
| Layout/input | Public `Component.render(width)`, `invalidate()`, `handleInput?`, `handleMouse?`; `TUI.terminal.columns/rows`, `TUI.requestRender()`, public `getCellDimensions()`. No extension resize event; inspect live dimensions each render. |
| Overlay handle | Public `OverlayHandle.hide/focus/unfocus/setHidden/isFocused/getBounds`. `hide` is valid for the **raw showOverlay** ownership path only. Do not release focus/hide on narrow panes: render a compact fallback that retains Escape. |
| Session lifetime | Public `session_shutdown` reasons `quit/reload/new/resume/fork`, followed by fresh `session_start` where applicable. No event named `session_switch`; actual switching is shutdown/resume-start. `session_tree` changes branch without a new connection epoch; close/reindex if selected occurrence leaves branch. |
| Input hook | Public `TUI.addInputListener(listener): () => void`, `removeInputListener(listener)` or `ctx.ui.onTerminalInput(handler): () => void`; listeners may `{consume:true}` for input they receive. A lease-scoped optional hook owns controls **only when its own handle.isFocused()**; upper dialogs are unaffected. It cannot suppress already-consumed host search/mouse events. The approved focus-loss policy handles that lifetime instead of claiming listener precedence. |
| Editor | `getEditorText/setEditorText` expose text, **not cursor/selection/undo state**. Leave editor/component unchanged rather than copying/restoring text. Overlay branch does not reset editor in host `showExtensionCustom`. |
| Scroll | Injected `TUI` has no transcript scroll snapshot API. Public `TuiAltScreen` separately exposes `viewportTop`, `isFollowingOutput`, `scrollBy`, top/bottom; no exact semantic anchor restore API or regular terminal-scrollback control. Prefer native overlay preservation; don't claim frozen scroll during new output/reflow. |

Recommended open: validate a plain immutable selection with a current session
token and live widget-injected TUI; reserve the one-open guard; create a
**synchronous lightweight component**; call public `tui.showOverlay(component,
{nonCapturing:false, ...responsiveSizes})` and store the returned owned handle;
start async preparation afterward. Never block a stream event handler waiting
for the interaction to finish. No `ctx.ui.custom` factory/mount promise is involved.
`AgentSession.prompt()` handles extension slash commands
before normal/model input even during streaming (`dist/core/agent-session.js:
1478–1496,1600–1623`). No `waitForIdle()` is necessary. Slash invocation itself
adds command editor history/clears input in streaming/compaction paths
(`interactive-mode.js:2688–2708`); UI worker must test preservation **from
invocation**, not just from completion. A click route uses the current controller,
not a stale captured renderer context.

### Public raw-overlay close contract

`TUI.showOverlay` owns compositing/focus and returns a handle; unlike `custom`, it
does **not** dispose the component or settle an interaction promise. The viewer
controller therefore owns both. One idempotent `close(lease, reason)` must:

1. Mark the lease closing/non-live and invalidate its generation before anything
   that can request render. Abort preparation and stop future row publication;
   remove it from replay while leaving inline history intact.
2. Call that lease's **owned raw `handle.hide()`** exactly once (no
   `tui.hideOverlay()`, no custom-UI handle). Source `tui.js:382–396` finds/removes
   its entry, retargets other overlays' `preFocus`, and changes focus only if the
   removed component currently owns it. Closing a lower viewer must leave an
   unrelated upper overlay mounted/focused; closing the upper later must not
   restore focus to the disposed viewer. This behavior requires actual-host tests.
3. Explicitly dispose the component; abort/clear its bounded surface records and
   unsubscribe any viewer input hooks. Guards must make unexpected dispose/metric
   errors unable to strand cleanup. Dispose does not recursively close a later
   lease or remove another overlay.
4. Settle the controller's own interaction promise once, clear strong references
   to handle/component/TUI/selection, and release the one-open reservation only
   after logical teardown; keep the fixed retirement obligation separately.
   Pending queued transport may still drain, but a new lease cannot share its
   obsolete publisher or start another reservation before that drain completes.
5. Attempt capability-guarded private-prototype retirement after overlay removal;
   failure leaves the one bounded obligation, not a dangling visible component.

Invoke the same close on Escape, explicit refresh, `session_shutdown` and owning
widget disposal/replacement. Widget cleanup must close the raw overlay while it
still has its captured TUI/handle, **then** disconnect transport; an obsolete
widget's disposal cannot close a new connection/lease. Raw overlay state must not
survive reload/session replacement merely because it was absent from host custom
UI tracking. Host may also remove overlays during UI reset; owned `hide()` must
be safe when its entry is already absent, while controller dispose/settlement
still runs. Normal native focus restoration avoids writing editor text or losing
cursor/selection/undo state. Do not directly reset focus to the editor: that would
steal focus from an unrelated upper overlay.

### Host hazards and their approved policy boundary

1. `interactive-mode.js:2309–2375` implements `custom`'s `done()` with **stack-pop
   `this.ui.hideOverlay()`**, not removal of the overlay's captured handle. UI
   worker actual-host tests reproduced removal of an unrelated upper overlay.
   The authorized raw `showOverlay`/owned `hide` path avoids this completion bug;
   upstream repair is not prerequisite **if** raw lifecycle tests pass.
2. An async `custom` factory's early completion skips disposal of its later
   returned component. The raw synchronous-component path avoids this factory
   leak/microtask mounting window; async preparation is owned by the lease instead.
3. `resetExtensionUI()` (`interactive-mode.js:1893–1905`) calls `hideOverlay()`
   and clears widgets/input listeners but does not call arbitrary raw component
   `dispose()`. Explicit `session_shutdown`/widget cleanup remains necessary.
   Check actual shutdown/reset ordering and overlapping overlays; the extension
   must not issue a stack-pop itself or rely on UI reset to release the lease.
4. Fullscreen `tui-alt-screen.js:470–546` processes mouse and the transcript-search
   key **before** deferring ordinary keys to focused overlays. A wheel over an
   exposed background component can dispatch to that component before focus
   deferral; mouse outside bounds can reach selection/scrollbar/link handlers.
   A viewer-local `handleMouse` alone cannot guarantee hidden-background isolation.
   A fullscreen search key can stack another overlay despite the viewer's focus.
   UI worker must verify narrow public input gating or identify a blocker.
   A public `addInputListener`/`onTerminalInput` subscription is a supported scoped
   lifecycle hook, not a second raw input loop. Gate it with **this lease's own
   `handle.isFocused()`**, not merely any overlay being present; return unhandled
   when an upper dialog owns focus and unsubscribe on close. However, the
   fullscreen constructor installs `handleViewportInput` first
   (`tui-alt-screen.js:105`) and `TuiBase` iterates an insertion-ordered listener
   Set (`tui.js:685–696`). Both public subscription paths append. Source evidence
   therefore predicts a later viewer hook cannot consume a search/mouse event
   already handled by the host. Actual-host tests reported by the coordinator
   confirm ordinary keyboard/Escape and wheel isolation, but hidden **existing
   search navigation mouse controls** bypass an unguarded viewer. The approved
   admission/focus-loss policy below avoids that invalid lifetime without changing
   host routing. Do not remove unknown host listeners or patch their
   order. Keys that do reach the focused component are never forwarded.
5. Regular mode leaves mouse/scrollback to the terminal. Ignoring incoming wheel
   bytes cannot suppress terminal-owned wheel scrolling if the terminal emits no
   bytes. Do not enable mouse modes/change settings to conceal this. Distinguish
   preserving editor input from a guarantee to freeze terminal scrollback.

### Gate-approved v1 modal admission and close-on-focus-loss policy

The coordinator selected this v1 lifecycle and reports **17/17 actual-host UI
tests passed**. Lifecycle was previously undecided. Main click/open, `+/-`, `0`,
`hjkl` and Escape remain unchanged. This is an approved feasibility reference,
**not implemented production controls**.

Instead of querying private search state or closing someone else's UI, open only
when public **`tui.hasOverlay() === false`**. Apply the same guard to click and
command/picker entry, reserve before awaits, and recheck before mount: if another
search/dialog appeared during capability/normalization work, release the viewer
reservation without graphics and ask the user to close the existing overlay first.
The guard detects visible overlays, not every editor-area built-in selector; do
not pretend it is a general private dialog-state API.

If a later host dialog/search takes focus, **close the viewer**, do not suspend it
behind hidden host UI. The component implements the public `Focusable.focused`
property with a setter: a true-to-false transition while live marks the lease
closing, invalidates publication/replay and aborts pending surface work
**synchronously**. Then schedule one idempotent owned-handle hide/dispose/settle
continuation **after the host focus transition**, avoiding reentrant stack/focus
mutation from inside `setFocus`. Use a single scheduled flag, not one closure per
focus event. Cleanup-triggered focus loss and a stale lease setter do nothing.
The microtask uses the captured lease's raw handle/TUI; it cannot close a new lease.
The one-open guard remains reserved until that logical teardown settles, and
native reservation drain/retirement rules still apply.

The actual configured CtrlShiftF may be reserved/consumed by the host before any
later listener. It need not be trapped: if it opens search, public focus loss
closes the viewer and exposes search normally, instead of permitting interaction
with a hidden background or retaining a suspended viewer. An unrelated later
built-in/non-search upper dialog likewise remains mounted/focused; owned hide
retargets its restoration away from the disposed viewer. Scoped optional input
hooks return unhandled once the viewer's handle is not focused.

Actual-host proof in `test/host-viewer-seam.test.mjs` establishes:

- `READY policy: admission plus public focused setter closes before user
  search/batched input`: refusal of existing search, real configured CtrlShiftF
  positive control, synchronous closing/abort, no closing-viewer frame publication,
  deferred owned removal/dispose/settle, search remains visible/focused, batched
  search input and navigation do not reach the closed viewer, editor draft and
  restoration survive, and messages/entries/model requests remain unchanged.
- Both `READY policy: ... upper dialog focus/preFocus and close races remain
  owned` tests cover regular/fullscreen upper dialog creation, immediate abort,
  repeat close plus refresh/shutdown races, exactly-once viewer disposal,
  upper handle focus/bounds/promise intact, and eventual editor restoration.

No private search getter, listener-array inspection/reordering, production fake
keys or host patch is required. `BLOCKER` tests remain regression evidence for
**unguarded** lifetimes, not failures of this approved policy. If production
integration deviates or finds unreliable public notification/unsafe cleanup,
stop and report the boundary instead of silently weakening isolation. This
worker inspected the ready-policy tests but did not rerun the 17/17 host suite;
that result is coordinator/UI-worker evidence. Further production tests still
must connect immediate abort to the actual native reservation/transport owner.

## Recommended defaults for coordinator/UI agreement (not owner requirements)

- Every open: fit/recenter. `0`: recompute fit/recenter; no remembered view.
- `+/-`: **1.25x** steps, stable source center then edge clamp. Use natural-pixel
  percentage `100 * displayPixelScale` (100% = one source pixel per display pixel),
  show a separate `fit` indication. Canvas cell rounding gives slightly different
  X/Y ratios; math worker must define/report the authoritative scale, not infer
  natural percentage from a cropped width. If that cannot be represented honestly,
  label the multiplier `x fit` instead and get coordinator agreement.
- Minimum zoom: current fit. Maximum: largest positive step satisfying whole
  canvas `columns/rows <=297` and all marks `<=296`, not an arbitrary huge zoom
  limit. Expose reaching this cap; the fallback trades unlimited crop zoom for
  bounded protocol addressability. A resize may lower the valid maximum.
- Pan: **five display cells** per key, converted to source-space center delta at
  current scale, then clamp; no pan beyond edge and no blank leaks. This is a
  simple recommendation, not settled UX.
- Resize: preserve natural scale/center where possible, clamp scale to updated
  fit/addressability range and center to valid bounds. If in fit mode, remain fit.
  Coalesce width/height/cell changes. A pane too small for positive image area
  shows compact text/close hint with focus retained and no image preparation.
- While open: wheel **ignored**, unrelated controls never forwarded to editor;
  Escape always completes. Do not swallow wheel/selection while closed. The host
  caveats above must be resolved before promising this in both modes.
- Refresh: recommend **close/dispose**, matching the coordinator's simplest
  supported lifecycle policy; reload/new/resume/fork/session replacement also close.
  Cancel lease, close its raw owned handle and settle its own
  promise, invalidate detector + presentation failures/records + shared residency
  in one generation, repaint
  inline from stored snapshots. Later open fits. Plain `/tmux-image-refresh` and
  `/reload` cannot be typed into a focused viewer and extension shortcuts are
  installed on the editor, not automatically global (`interactive-mode.js:
  1749–1760`). Reachable ordinary path is **Escape, then slash command**; that is
  not a test of refresh *while open*. Offline SDK invocation of the registered
  refresh command and `session.reload()` can exercise while-open races without
  input forwarding/model work. A dedicated viewer refresh key would be a new UI
  scope choice; do not silently introduce it. Reload/new/resume/fork/quit cancel
  via the public shutdown event even when initiated externally.

## Measurement changes required for ephemeral surfaces

Keep one `GraphicsMetrics` instance and exact-PNG normalization inventory.
Incremental viewer motion must not duplicate payload/RGBA estimates. Add explicit
surface metadata (`inline` versus private `viewer`) and **replacement**/**retirement**
operations to the current immutable-placement accounting contract.

- Replacement at the same pair updates geometry/version in place after a
  successful current-epoch write; no growth per zoom. Inline metadata remains
  immutable. Retired viewer slots disappear from live placement/occurrence totals.
- Pan, unchanged reopen and reused rows: **zero transport**, no successful-write
  event. Reopen may still need a prototype command if it was retired; that is
  placement-only, not PNG upload.
- Every successful nonempty write records wrapped `Buffer.byteLength` once, actual
  PNG chunk count and actual prototype command count. Distinguish replacement
  commands and scoped retirement commands/counters; do not count deletion as PNG
  or a create/replay. A successful retirement can remove already-untrusted local
  metadata while still counting its real wire bytes in the current epoch.
- Same-ID retransmission resets placements for that image and registers the full
  restored inline + **only live** viewer batch. Replays are placement commands,
  not user zoom replacements. Epoch reset clears current trust/epoch transfer;
  runtime scalar totals and normalized inventory survive. No per-motion event log.
- No accounting on preparation, stale/failed/partial writes or zero-byte reuse.
  Commit functional owner state first, catch metric errors, release queue in all
  cases, report incomplete accounting explicitly. A diagnostic failure must never
  break display/close/residency or hold the one-open guard.

Numbers remain local successful-write estimates, **not terminal ACKs, known freed
GPU bytes, a global bound, budgets or eviction**. External/prior-runtime resources,
terminal copies, decoder/cache and placement overhead are unobservable.

## Focused acceptance additions

The independent `test/viewer-lifetime-feasibility.test.mjs` models one-slot ownership
and demonstrates 10,000 motion/reopen requests do not grow viewer keys, retained
prototypes or cache state; pan has no transport; only live overlay restores with
all inline history; denied cleanup blocks unsafe cross-payload rebinding. It does
not call production APIs, encode real frames or establish host/terminal semantics.

Production acceptance, if later authorized, must test actual shared owner/seam:

1. Identical PNG inline/viewer shares one normalization/resident image ID; distinct
   inline and private placement IDs. 10,000 pans/zooms/opens add constant viewer
   allocator/cache/metrics state with unchanged inline history.
2. Epoch retransmission restores every retained inline prototype plus exactly one
   live private tuple, never a closed or superseded view. Pan only changes cells.
3. Cancel while queued, normalized, post-preparation-probing and ready-before-write;
   reopen/refresh/session replacement cannot publish stale rows, resurrect old
   private tuples, leak reservations or block unrelated inline successors.
4. Scoped lowercase retirement/redefinition in the protocol simulator **and
   target terminal**, with inline pixels/prototypes intact. Failed/denied cleanup
   stays bounded; no graphic writes on denial and no unsafe new-payload rebind.
5. Actual-host lifecycle/input tests in both modes, during simulated background
   streaming, small-pane resize, wheel inside/outside bounds, search/other dialog
   overlap, raw owned-handle close/disposal/settlement, refresh/reload while open
   and editor
   text/cursor/selection preservation. Assertions must include invocation scroll
   effects and overlay cells not escaping to retained history.
6. Exact captured stream bytes and surface counters for create/replace/replay/
   retire; errors/stale/no-byte reuse excluded; throwing metrics leave display
   functional. Standard snapshot/session/model counts unchanged; zero source/PDF
   work and no provider requests.

Run portable/host-enabled suites and offline SDK integration under repository
contracts. UI/crop actual-host reports and owner-observed pixel checks are separate
coordinator evidence; this architecture report alone does not authorize shipping.

## Production shared-surface implementation (runtime phase)

After the pure helper commit `dd13569`, the authorized runtime phase implements
the following APIs in `src/native.mjs` / `src/presentation.mjs`. UI integration is
owned separately; this section does not claim shipped controls or pixel acceptance.

```js
const payload = await native.resolvePayload(attachment, signal);
const lease = native.reserveViewerPlacement({ payload, occurrence });
const context = { epoch: presentation.epoch, signal };
const prepared = await native.prepareViewer({ lease, canvas, window }, context);
// Caller performs capability checks before preparation and again after it.
if (presentation.commit(prepared, context)) publishCurrentRows(prepared.lines);

native.releaseViewer(lease); // immediate closing/focus-loss replay revocation
// AFTER owned raw overlay hide/dispose has removed cells, with fresh pre/post gates:
const retirement = await native.prepareViewerRetirement(context);
presentation.commit(retirement, context);
```

`canvas` has whole-prototype `{columns,rows,cellWidthPx?,cellHeightPx?}`;
`window` has bounded `{columns,rows,columnOffset,rowOffset}` from `computeViewport`.
The separate `encodeViewportRows` helper validates canvas intersection and explicit
marks; inline `encodePlaceholderRows` is unchanged. Retirement uses
`encodeOwnedVirtualRetirement` with lowercase ID+placement scoping only.

`resolvePayload` shares immutable normalization and the inline registry's
image-only lookup. `reserveViewerPlacement` accepts only records returned by that
renderer, reserves the one fixed private allocator key, and rejects a live lease,
undrained viewer reservation or unresolved retirement. `prepareViewer` rejects
concurrent viewer preparations: UI owns one runner/latest intent. Abort does not
relaunch a native reservation until the predecessor chain drains; closing an
uncommitted queued lease cannot evade that bound by reopening repeatedly.

Every prepared result includes `isCurrent`, `onUploaded`, `onUploadFailed`,
`uploads`, `lines` and exact transport metrics. Success/failure callbacks are
idempotent. Repeated stale callbacks cannot clear a new lease/work slot. Inline
PNG replay captures only a live committed private prototype; release before write
invalidates that result, and presentation retries from current ownership without
caching failed/stale rows. Inline history retains all committed geometries.

Retirement failure leaves one obligation across epoch resets. The UI must retry
it through fresh pre/post capability checks **before** safe payload rebinding.
Successful retirement now conservatively ends PNG upload-reuse trust for the
retired image ID, including inline-shared payloads. Cached PNGs, identities and
all retained inline prototypes remain; the next actual preparation restores the
complete inline batch and only the live private prototype after retransmission.
Earlier placement-only reopen recommendations in this historical review are
superseded by this recovery boundary, not by pixel eviction or new slots.
Same-lease pan/zoom reuse is unchanged. See [PDF blank-page recovery](pdf-blank-recovery.md).
`stats().viewer` reports lease/prototype/work/retirement flags, constant-slot
allocation totals and one sanitized retirement failure. A successful deletion
when the current epoch has no resident image metadata records only delete wire;
it does not invent image residency or normalization. No-op retirement still
validates its requested epoch/signal and records no transport. This is no ACK or
proof of GPU resources freed.

`presentation.bind({onConnect,onDisconnect})` and `presentation.connection` expose
only the existing public widget-injected `{tui,epoch}`. Disconnect observers run
before record abort/transport detach; UI closes its owned raw overlay there.
Binding errors are counted by `bindingErrors` but cannot stop other cleanup or
strand transport. `presentation.commit(prepared,{epoch,signal})` guards current
connection/epoch/signal/native validity, then writes and calls success synchronously
without an await; it publishes no rows or repaint itself. Stale results return
false and release their reservation; thrown writes release and rethrow.

Metrics retain compatible inline totals, add `surfaces` and
`surfaceTransfer`/`runtimeSurfaceTransfer` replacement/retirement counters, and
explicitly distinguish a released (non-live) private prototype from one whose
scoped deletion has committed. Functional ownership commits before guarded
accounting. See [graphics-memory.md](graphics-memory.md).

Runtime automated coverage adds real native 10,000 motion and 10,000 alternating
payload open/retire cycles, constant allocator/prototype counts, shared PNG reuse,
complete inline+live-viewer replay, release during prepared inline replay,
queued close/drain, stale repeated callbacks, failed/denied/partial retirement
across epochs and retry without invented residency. These are actual repository
runtime tests and captured/protocol-semantic streams, not observed pixels.

## Primary references inspected

- Installed complete `docs/extensions.md`, `docs/tui.md`, `docs/sdk.md`,
  `docs/keybindings.md`, `docs/themes.md`; shipped `overlay-qa-tests.ts` and
  `message-renderer.ts`; public `dist/core/extensions/types.d.ts`, pi-tui
  `dist/tui.d.ts` and `dist/tui-alt-screen.d.ts` relevant declarations.
- Host source paths/line ranges identified above, plus pi-tui `tui.js:365–570,
  680–757`, `tui-alt-screen.js:694–824`. Read-only source inspection; no private
  imports or patches.
- [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/),
  sections Displaying images, Unicode placeholders, Deleting images. Existing
  primary specification capture `/tmp/pi-image-viewer-kitty-spec.txt`:
  same-pair replacement/retransmission at 2298–2312; virtual deletion distinction
  2545–2582; scoped lowercase ID deletion 2687–2788 and example 2820–2841.
  These protocol rules do not by themselves prove Ghostty pixels.
- Repository `src/native.mjs`, `presentation.mjs`, `identity.mjs`, `metrics.mjs`,
  `capabilities.mjs`, `extensions/tmux-image/index.ts` and
  [renderer-seam.md](renderer-seam.md), [kitty-protocol.md](kitty-protocol.md),
  [graphics-memory.md](graphics-memory.md).
