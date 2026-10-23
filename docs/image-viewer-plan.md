# Image viewer handoff — plan and implementation status

## Status, baseline and authority

**0.3.0 implementation / general owner acceptance:** final package is committed at
`210d524`; pure viewport/protocol phase is committed at
`dd13569`, shared native/presentation/metrics at `5898185`, following automated
feasibility gate `e92b1cd` and plan `d324d87`. The UI/controller is now implemented
in `src/viewer.mjs` and `extensions/index.ts`: ready-cell fullscreen clicks,
`/tmux-image-view`, newest-first same-overlay picker, one pending/latest prepare,
shared PNG reuse and scoped ephemeral retirement. Accepted defaults are 1.25×
fit-relative zoom, 25% minimum, dynamic **297×297** canvas maximum, four-cell pan,
fit/recenter each open, and resize retaining/clamping zoom factor/source center.
Minimum graphical pane is **20×7**; smaller panes retain keyboard-owned fallback.
Close revokes replay immediately, removes the owned overlay, flushes a public
removal frame outside render/focus callbacks, then retires the private prototype;
failed frame/retirement leaves one bounded obligation for guarded retry. Existing
modal/search admission refusal and close-on-public-focus-loss are implemented.
Title width reserves Fit/limit chrome and preserves PDF page identity separately.
Final production public SDK matrix **15/15**, host suite **181/181**, existing
SDK suite **12/12** and portable **150 passed / 31 optional skips** pass on the
verified source. The owner confirmed “all is working!” after being asked to reload
and try click-open/zoom/pan/reset/Esc on Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3 with
`terminal.images: auto` and `images.blockImages: true`, package 0.3.0 (`210d524`).
This records general human acceptance of the new in-pane viewer, not individual
manual matrix passes: both PDF pages, keyboard picker/regular mode, other terminals,
modal/search, bounds, reconnect, source-deletion and failure races were not separately
reported. Narrower unreported cases remain automated-only or human-pending, as
applicable; no camera inspection or latency measurement was made. See
[viewer-verification.md](viewer-verification.md) for the evidence boundary.
Known-working implementation/observed-inline rollback remains `9dc2944` / 0.2.0.


**Proceed authorization / Step 1 gate checkpoint:** the owner now authorizes
proceeding from `d324d87` / `checkpoint/image-viewer-plan`; coordinated automated
feasibility gates passed (host-enabled suite **131/131**). The accepted public
lifetime is widget-injected **`TUI.showOverlay` + owned handle**, not
`ctx.ui.custom`: refuse an existing modal/search and close on public focus loss,
marking the lease closing/aborting synchronously before deferred scoped cleanup.
Use a bounded **297x297 full-image prototype + independently addressed subset**,
not virtual source crop ignored by the supported renderer. These decisions
supersede the earlier proposed custom/crop paths below. Read
[viewer-seam.md](viewer-seam.md), [viewer-crop.md](viewer-crop.md) and
[viewer-lifetime.md](viewer-lifetime.md) before implementation. The formerly
recommended fit-relative defaults are now explicitly selected above; other new
UX scope requires owner approval. Budgeting remains disabled.

The following records the historical documentation-only checkpoint. Current
implementation and scoped general owner acceptance are summarized above; historical
statements of unimplemented controls or pending acceptance below describe that
checkpoint, not the current package.

The owner asked to **first make a checkpoint with the plan** for the agreed
viewer UX below. This is a documentation-only **local Git checkpoint**, not a
machine/EBS checkpoint, package activation or implementation. The coordinator
reviews this plan, runs `npm test` and commits the documentation; the planning
worker does not commit. The coordinator will create the local annotated tag
**`checkpoint/image-viewer-plan`** to locate this plan checkpoint. Its documentation
commit will become the new parent for future phase commits. No viewer controls
described here are installed yet.

Known-working baseline: `9dc2944`, package version **0.2.0**. Native rendering,
snapshot replay, live inline fitting, conservative capability detection and
measurement-only metrics are implemented; graphics budgeting/eviction is disabled.
Recorded baseline evidence (not rerun by this planning worker): host-enabled suite
**99/99**, offline SDK integration **12/12**, portable suite **90 passed / 9
optional host skips**. See [verification.md](verification.md) for exact scope.

The owner observed PNG/two-page PDF appearance, continued conversation, transcript
scrolling, tmux zoom/unzoom, window switching, explicit refresh and reload recovery
on **Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3**. These are owner observations, not an
agent/camera inspection and not evidence for the new overlay. Narrower resize,
pane-position, partial-edge, reconnect/resume and other-terminal corners remain
pending. Preserve the owner-approved `terminal.images: auto` and
`images.blockImages: true`; this plan authorizes no configuration changes.

Read `AGENTS.md`, [implementation-plan.md](implementation-plan.md), and this plan
before viewer work. The earlier plan remains authoritative for existing native
contracts; this document adds a separate viewer phase, not budgeting approval.

## Agreed UX

- A **Pi-managed overlay inside the current pane**, not another tmux popup,
  process, window or external viewer. The owner may tmux-zoom the pane normally.
- Clicking an image or a specific displayed PDF page should open **that snapshot**
  initially fitted to the overlay's usable image area, subject to the public mouse
  feasibility gate below. Do not advertise working click support before testing.
- `+` / `-`: zoom in/out while keeping the viewed center stable (clamp at bounds).
  `0`: fit and recenter. `h` / `j` / `k` / `l`: pan left/down/up/right.
  `Escape`: close, returning to the unchanged transcript image size and scroll
  position. Overlay controls must not reach the editor or trigger host actions.
- Show sanitized image label / PDF page, zoom indication and a concise controls
  hint. Chrome is styled separately; never recolor placeholder ID cells.
- Every new open starts fit/recentered with **ephemeral viewport state**. Remembered
  zoom/pan across opens is not requested.
- Provide a keyboard-only open/picker path to existing image/page snapshots.
  `/tmux-image-view` is a **proposed, tentative command name**, not an installed
  command or a new source-path display operation. Regular mode uses this fallback.
- With the overlay closed, preserve drag transcript selection and wheel transcript
  scrolling. A click target must not swallow selection drags or unrelated links.
  While open, wheel/input must not mutate the hidden transcript or editor;
  ignoring wheel versus using it for viewport panning remains undecided UI policy.

Zoom enlarges existing pixels; it cannot recover missing detail. PDF snapshots
remain the first two Poppler-rendered pages at a **1200-pixel longest side**. No
source re-rasterization, new PDF pagination or higher-resolution attachment work.

**Selected v1 defaults:** 1.25× zoom step, 25% fit-relative minimum, dynamic
297×297 full-canvas maximum, four-cell pan, graphical pane minimum 20×7,
100% = initial fit, newest-first picker, resize preserving fit-relative factor
and normalized source center subject to clamping. No aliases or remembered state.
A new host modal/search closes rather than suspends the viewer. Refresh/reload,
widget disposal and session/branch changes close it; later reopen starts fit.
Further UX changes need explicit review rather than silently expanding scope.

## Invariants and proposed architecture

Canonical standard Pi attachment snapshots stay immutable. Opening, input,
repainting and closing the viewer must do **no source reads, duplicate attachments,
new session messages/entries, model turns/requests, context filters or settings
writes**. Existing command/tool ordering and `triggerTurn: false` remain unchanged;
that flag is not permission to send messages for viewer interaction. Never gate
local viewing on `images.blockImages`; Pi alone owns model-image policy, and
blocking does not prevent session storage.

Use public Pi APIs and the existing interactive/current capability gates. Reject
non-TUI, outside-tmux and unsupported/disabled paths before graphics work. Guard
initial open, each preparation, ready rows, resize and refresh, including releasing
reservations after failed post-preparation checks. Sync ready-row policy stays
subprocess-free. Refresh invalidates detector decisions, failed presentation and
residency together. Do not force native capability, set `WEZTERM_PANE`, import
private host modules, patch stdout, own a second input/renderer loop, or modify
Pi/tmux/terminal configuration.

Proposed split (names are not mandatory):

1. A session-local snapshot/page index and viewer controller own open/close and
   selection. Index existing active-branch messages by stable occurrence/page,
   not label/path; do not duplicate snapshot bytes into persisted metadata.
2. Pure viewport math converts fit/zoom/center/pan plus live usable dimensions and
   public cell pixels into bounded crop/placement/placeholder geometry.
3. A fresh public `TUI.showOverlay` component, obtained from the existing widget
   TUI connection, owns each interaction, chrome and viewport. Admit only without
   another modal/search. Public `Focusable.focused` loss synchronously cancels the
   lease; deferred **owned raw handle** hide/dispose/settle preserves new host UI.
   Do not use `ctx.ui.custom` completion or hide a custom-owned handle.
4. A shared native payload/residency owner reuses exact normalized PNG identity and
   image IDs across inline and overlay consumers. Overlay placements have a
   **separate private ephemeral surface identity**; they must not alias or redefine
   committed transcript occurrence/geometry prototypes. Uploads/placement writes
   precede publishing cells through the proven transport ordering seam.

Do not fork a second image-ID/upload registry that independently assumes shared
residency. Crop, surface, cell dimensions and viewport changes must participate in
appropriate identity/cache validation. Shared PNG retransmission deletes all
placements: restore every retained inline prototype **and only currently live
owned overlay prototypes**, before exposing their cells.

Current `src/native.mjs` keeps every successfully committed inline geometry in
`ownedPlacements`; that protects scrollback. Blindly storing every pan/zoom there
would create unbounded viewer history and replay work. Design a bounded ephemeral
viewport/prototype/cache owner, ideally reusing a private prototype where safe.
Bound allocator/identity retention too, not merely the visible component cache.
Do not change existing inline retention. Retire only proven-owned, unreferenced
overlay prototypes using verified protocol semantics; never globally delete
resources or delete shared pixels needed by inline/other live consumers. If safe
retirement/redefinition cannot be established, stop and report the boundary rather
than shipping unbounded state or hiding orphaned cells. Global budgeting remains
disabled and requires separate owner approval.

Metrics must distinguish payloads from inline/overlay surfaces without
double-counting shared PNG/RGBA estimates. Count complete wrapped wire totals,
PNG chunks, placement/replacement/retirement writes only after successful
current-epoch transport, not preparation, failure, stale work or zero-byte reuse.
Retired ephemeral prototypes must not remain reported as live. Epoch reset clears
local trust, not terminal resources; accounting errors stay explicit and cannot
break functional residency, rows or queue release. These remain local estimates,
not terminal ACKs, global/GPU memory bounds or eviction enforcement.

## Step 1 — feasibility design and actual-host gate (before implementation)

Inspect installed **Pi 1.0.3 public declarations/docs/examples** and the current
public Kitty specification. Produce a brief design decision with exact exported
interfaces, protocol semantics, blockers and focused **actual-host** tests using
public package entry points and a capture terminal/offline SDK, no real provider.
Pure/mock component tests alone do not pass this gate.

Required investigations and tests:

- **Click routing:** can a public custom message component receive normalized
  fullscreen mouse events and resolve the right occurrence/PDF page after
  transcript scroll, clipping, padding and renderer rebuild? Establish supported
  hit regions and click-vs-drag arbitration. Leave unhandled primary drags to
  selection, unhandled wheel to transcript scrolling and OSC 8 precedence intact.
  How does a renderer without `ctx` safely ask a current controller to open?
- **Overlay lifecycle:** verify public `ctx.ui.custom` focus, completion/disposal,
  close restoring editor/transcript state, resize and small-pane clipping in both
  fullscreen and regular modes. Opening via a slash command may itself affect
  scrolling: test preservation from invocation, not just overlay dismissal. Do
  not invent private scroll-offset access if native overlay behavior is insufficient.
- **Text/graphics pipeline:** pass independent row/column marks and foreground /
  underline IDs through actual width fitting, overlay borders, offsets, partial
  top/left/right/bottom clipping and compositing. Confirm upload-before-cells and
  no host global-delete/reset interference under supported automatic capabilities.
- **Zoom/pan protocol:** decide between validated Kitty source cropping on a
  virtual prototype and a validated viewport subset of independently addressed
  placeholder cells. Test source/display aspect semantics and target-terminal
  behavior; virtual placement crop support must not be inferred from ordinary
  positioned placements. No ordinary cursor-positioned graphics workaround.
  Keep dimensions within 297 and zero-based marks within **0..296**; a huge
  zoomed virtual canvas cannot be encoded by arbitrarily large diacritic indices.
- **Ownership:** prove shared payload upload reuse, distinct surface placement
  IDs, bounded ephemeral state and safe owned-prototype retirement/redefinition,
  including replacement retransmission while both surfaces are live.

**Current code is not crop-ready:** `encodeVirtualPlacement` accepts only image /
placement IDs and columns/rows, with no `x/y/w/h`; `geometryIdentity` and the native
geometry cache also lack crop/surface fields. `encodePlaceholderRows` starts at
row/column zero. Do not assume these work unchanged for pan/crop.

If required public click, focus, clipping, scroll restoration or safe transport
APIs are unavailable, document the precise blocker and ask the owner about an
upstream API or scoped alternative. Keyboard-only delivery where click is blocked
needs an explicit scope decision; do not pretend it fulfills the complete UX.
No monkey patch or forced-capability escape hatch.

### Evidence to start from, not proof of the viewer

Installed Pi 1.0.3 `docs/tui.md` and `docs/extensions.md` document temporary custom
overlays, completion-owned disposal, focus handles, invalidate/requestRender,
fullscreen normalized mouse routing, unhandled wheel/selection behavior and
regular-mode terminal-owned mouse/scrollback. Read their relevant cross-references
and shipped `examples/extensions/overlay-qa-tests.ts` and `message-renderer.ts`;
verify exact public exported types before choosing signatures. A documented
`MouseRegion` does not establish that our message renderer's event path works.
[renderer-seam.md](renderer-seam.md) records existing public transport evidence and
the forced-native reset blocker, not viewer feasibility.

Primary Kitty reference inspected for this plan:
[graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/), sections
“Controlling displayed image layout”, “Unicode placeholders” and “Deleting images”.
It describes pixel-source `x/y/w/h`, display `c/r`, same image/placement-ID replacement,
replacement-upload deletion of all placements, and underline-color placement IDs.
Virtual prototypes are distinct from placeholder-derived real images; only the
listed ID/number/range deletion modes affect virtual prototypes, with placement
ID scoping available for ID deletion. Lowercase deletion need not free pixels;
uppercase can free data when no references remain. This motivates a scoped
ownership design, **not** a claim that crop/redefinition/retirement works visually
on Ghostty. Recheck specification and target behavior in Step 1. See also
[kitty-protocol.md](kitty-protocol.md) and [graphics-memory.md](graphics-memory.md).
Context7 quota was recorded exhausted before this task; use current primary
installed docs/spec evidence rather than spending more quota or guessing APIs.

## Phased implementation after the gate

1. **Pure protocol and viewport math:** bounded crop/offset encoding and identity
   design, fit/center zoom/pan/reset/aspect/rounding tests, cell-pixel changes,
   source intersections, invalid inputs, extreme zoom and mapping limits. No
   terminal effects. Record proposed limits/steps separately from agreed UX.
2. **Keyboard overlay + keyboard open/picker:** immutable snapshot selection,
   initial fit on every open, controls/chrome, close restoration, shared PNG reuse,
   isolated public custom UI loading. No new model-callable source tool needed.
3. **Click integration:** only supported fullscreen public event paths; exact page
   hit testing through scroll/clip/padding/rebuild, selection-drag and wheel
   noninterference. Keep regular-mode keyboard fallback explicit.
4. **Lifecycle, metrics, docs and acceptance:** coalesce width/height/cell changes,
   cancel stale work on close/reopen/session replacement; cover refresh/reload
   while open, shared prototype restoration, bounded ephemeral cleanup and
   coherent success-only surface accounting. Update README with implemented
   controls/limitations only after validation, and record evidence in verification.

Proposed lifecycle policy for review: preserve bounded center/zoom through ordinary
resize with updated fit scale; refresh keeps the current interaction only if public
lifetime/transport permits; reload/session switch cancels and disposes it, and a
later reopen starts fit. These are design recommendations, not settled preferences.
Define how refresh/reload are exercised while focus owns input before promising
behavior; do not assume slash commands can be typed through the overlay.

## Required verification and manual acceptance

Automated additions must establish:

- Pan bounds, stable center zoom, reset, portrait/landscape/aspect rounding,
  cell queries/changes, crop limits and 297 mapping bounds.
- No redundant resident PNG uploads on opens/zoom/pan/resize; correct retransmit
  restoration of retained inline and live overlay prototypes after epoch reset.
- No dual-surface alias, obsolete async cells, orphan after close/refresh/reload,
  leaked controls, restyled ID colors or unbounded pan/open cache growth.
- Capability denial/non-TUI produces zero graphics; ready-row disablement and
  reservations/queue cleanup remain safe. Refresh rechecks previously denied paths.
- Unchanged message/entry/attachment counts and exact snapshot content, zero source
  reads or PDF subprocesses, zero new model work on open/input/close. Exercise
  Pi's actual blocked/unblocked model pipeline offline; no extension filter/gate.
- Focus/completion/disposal, actual-host hit/selection/wheel/clip and geometry
  behavior in both modes, not just source-text assertions or protocol simulation.

Run portable `npm test`, the complete host-enabled suite and offline SDK integration
using the existing `AGENTS.md` host variables/contracts; report revision, totals
and skips separately. Verify `pi install .` and command/resource loading with a
temporary `PI_CODING_AGENT_DIR`, no provider requests, no physical host dependencies
installed into this repository and no automatic active-package replacement.

Owner/manual matrix on the supported setup (detailed cases remain **unreported**;
general owner acceptance above does not mark each row passed):

| Case | Acceptance |
|---|---|
| PNG and each of two PDF pages | Click where supported and keyboard picker select the exact snapshot/page; every open fits and shows correct label/zoom/hints. |
| Zoom/pan/reset | `+/-` preserve center until bound clamp; `h/j/k/l` reach edges without distortion/blank leaks; `0` fits/recenters. PDF detail is limited to stored raster. |
| Escape and reopen | Close restores original inline size and transcript scroll position; controls did not edit/submit; next open resets fit. |
| Closed overlay | Drag selection across image/text and wheel scrolling work as before; links/unrelated clicks are not intercepted. Test regular-mode keyboard fallback. |
| Borders and clipping | Narrow/wide/short panes, pane positions, top/left/right/bottom edges, width/height drag and cell-size change preserve crop, IDs, aspect and readable chrome. |
| tmux operations | Zoom/unzoom pane and switch windows while viewer is open, then close/revisit inline history; no placement alias or missing pixels. |
| Refresh/reload while open | Exercise the documented reachable lifecycle path plus pending-write/close races; bounded recovery or deliberate disposal per recorded policy, retained inline PNG/PDF history intact, reopened viewer fits. |

Record automated streams/components separately from owner-observed pixels. Request
manual checks only after coordinated isolated validation; do not claim general
reconnect or other-terminal support from this matrix.

## Non-goals, delivery, rollback and next-session coordination

No separate popup/process, copy-image/context-menu/clipboard enhancement, PDF
pagination/page-count change, source re-rasterization, permanent transcript
resizing, remembered viewport preference, model-image policy change, native Pi
`read` customization, budgeting/eviction or universal reconnect detection.

Keep **`9dc2944` / 0.2.0** as the known-working implementation rollback reference;
the documentation checkpoint becomes the new implementation parent. Commit verified
phases locally, no push/remote creation, license choice, OS installation or user /
system / tmux configuration edits. Revert viewer phase commits to recover baseline
behavior while retaining this plan. Coordinate package replacement and reload with
the owner, never load overlapping spike/package commands together. Rollback cannot
promise reclamation of prior-runtime terminal allocations; retain existing
no-global-delete safety and explicit refresh limitations.

For the next session, the coordinator uses worker agents through **workmux**, in
named stable tabs in the **current workspace**. This checkpoint's context names
are workspace **`pi-extension-spikes`** and coordinator tab
**`pi-image-coordinator`**, not globally required names for future sessions.
Requested worker Pi model: **`us.openai.gpt-6.1-sol`**,
thinking **medium**. Assign disjoint ownership, review reports, run verification,
then make local phase commits. Say **thank you** when a worker is safe to close.
This planning task spawns no workers; its owned docs freeze after the report at
`/tmp/pi-image-viewer-plan-report.md` until coordinator review/thank-you.
