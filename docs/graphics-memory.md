# Graphics memory measurements (no eviction)

## Status and policy

`src/metrics.mjs` provides measurement-only accounting, now integrated into
`createNativeRenderer()`'s successful transport commit in `src/native.mjs`.
`native.stats(presentationEpoch)` exposes a local aggregate snapshot, and
`/tmux-image-stats` provides the extension's diagnostic command. Coordinator/seam
verification reports SDK 12/12 passing, including exact captured wire counters and
no terminal/provider/session side effects. The metrics module
has no terminal write or runtime non-built-in dependency and retains metadata,
not PNG/base64 payloads.

**Eviction and budgeting are disabled.** No automatic image deletion, placement
deletion, fallback substitution or history truncation is implemented. Preserve the
existing long-history policy until actual usage demonstrates a need and the owner
approves the historical-image trade-off. Metrics are not a global graphics-memory
limit and must not be presented as one.

## API

```js
import { GraphicsMetrics } from "../src/metrics.mjs";

const metrics = new GraphicsMetrics({ runtimeId: "optional diagnostic label" });
metrics.beginEpoch(presentationEpoch);
metrics.recordNormalization({
  payloadKey, pngBytes: normalized.outputBytes,
  width: normalized.width, height: normalized.height,
});
// Only following a successful write/native onUploaded commit:
metrics.recordTransport({
  epoch: presentationEpoch,
  image: { imageId, payloadKey, pngBytes: normalized.outputBytes,
    width: normalized.width, height: normalized.height },
  placements: [
    { placementId, placementKey, occurrenceKey, geometryKey, uploaded: true },
    // More restored/new geometry prototypes may be in the same write.
  ],
  imageUploaded,
  wireBytes, uploadChunks, placementCommands,
});
const measurements = metrics.snapshot();
```

One instance belongs to one **native renderer runtime**. The default runtime ID is
a random UUID for diagnostics, not a session path or a persistent image identity.
The `epoch` getter gives the active token. `beginEpoch(token)` uses the
presentation connection's epoch token; repeated calls with the same token are
idempotent. A new token clears tracked images, placements and epoch transfer
counters. It retains normalization inventory and runtime transfer totals, matching
native runtime snapshot caching across connection changes. A new class instance
starts every inventory/counter empty.

`recordNormalization(metadata)` counts each normalized payload once. Repeating it
with identical metadata is free. It can happen before/independently of upload;
normalization can be successfully cached even if a subsequent write fails.
`recordTransport(event)` also registers that image's normalization metadata, so a
caller which did not separately inventory normalization still accounts for every
successfully uploaded payload.

`recordTransport` is **success-only**, never preparation-only. A stale epoch
returns `false` with no changes; a current valid event returns `true`. Invalid
metadata/counts throw atomically. Nonzero 24-bit IDs, positive safe-integer image
sizes, safe RGBA estimates and nonnegative safe-integer counters are required.
Upload flags must agree with command counts and wire-byte presence. Reusing an
image/placement requires that it already be tracked in this epoch. An existing
payload/ID/placement cannot silently change metadata. These checks are programmer
contract checks, not pixel validation or terminal queries.

`recordTransport` describes **one successful write**, with one image and a batch
of placement entries. Each `placements` entry has identity metadata and a boolean
`uploaded` indicating whether its command was included. `wireBytes` and
`uploadChunks` describe the whole write **once**, not once per placement.
`placementCommands` must equal the number of `uploaded: true` entries. Duplicate
`(imageId, placementId)` entries are rejected. Singular
`placement` + `placementUploaded` is retained as a compatibility shorthand; mixing
it with `placements` is rejected. An empty batch supports image-only transmissions.

Repeating a successful image upload increments transfer counters but not resident
image counts. **Kitty retransmission of the same image ID deletes all its previous
placements**, even if the PNG payload is unchanged. Accounting therefore removes
all tracked placements for that ID and registers only uploaded batch entries after
a retransmission. The native renderer must supply all retained geometry prototypes
it restored in that write, not just the current occurrence. A reused
`uploaded: false` placement cannot survive an image retransmission and is rejected.
Failed/stale batches change nothing; with no terminal ACK, partial failed writes
can still have unknown effects outside this accounting. This follows the
[Kitty graphics protocol's placement/retransmission note](https://sw.kovidgoyal.net/kitty/graphics-protocol/#displaying-images)
(primary specification checked during batch API review).

Multiple terminal image IDs for one payload increment per-ID encoded/RGBA totals
while retaining one unique-payload total. Multiple occurrences share image pixels
but add placements. Placement-only batches preserve already tracked prototypes.
New geometry versions add placements while leaving upload chunks at zero when
pixels remain resident.

## Snapshot fields and units

- `scope`: runtime ID, ordinal epoch number, `terminalAcknowledged: false`,
  `residency: "locally-tracked-successful-writes"`, `evictionEnabled: false`.
- `normalization.payloads`: number of runtime registered normalized payload keys.
- `normalization.pngBytes`: sum of their **binary encoded PNG** sizes, not source
  bytes, base64 string size or wrapped terminal output. This inventory is based on
  integration metadata, not a heap profiler or proof every payload is still cached.
- `normalization.estimatedRgbaBytes`: `width * height * 4` once per normalized
  payload. This is a hypothetical decoded-RGBA estimate, not measured Node memory.
- `resident.imageIds`, `resident.payloads`: locally known current-epoch IDs and
  unique PNG payload keys. Different source formats which normalize to identical
  PNG bytes should use the same normalized payload identity.
- `resident.pngBytes`, `resident.estimatedRgbaBytes`: sums **per image ID**, exposing
  duplicate copies if one payload was allocated multiple terminal IDs.
- `resident.uniquePayloadPngBytes`, `resident.uniquePayloadEstimatedRgbaBytes`:
  corresponding deduplicated sums once per resident payload key.
- `placements.occurrences`: unique durable logical occurrence keys with a locally
  tracked placement in this epoch.
- `placements.geometryVersions`: number of locally tracked `(imageId,
  placementId)` virtual placements. These are occurrence-specific geometry versions,
  not just a count of distinct column/row dimensions; two occurrences with the same
  geometry still have two placements.
- `transfer`: current-epoch successful `wireBytes`, PNG `uploadChunks`,
  `placementCommands`, and `successfulCommits`.
- `runtimeTransfer`: the same cumulative totals across every epoch of this instance.

Wire bytes include base64, Kitty controls and tmux framing for all included upload
and virtual-placement commands. They exclude placeholder transcript cells, labels,
other Pi output, capability queries and unknown terminal replies. `uploadChunks`
counts individually wrapped PNG transmission commands; placements are separate.
`placementCommands` may be **greater than one** when geometry prototypes are
restored following image retransmission. If a preparation contains no commands, an optional
zero-byte commit changes only `successfulCommits`, not bytes/chunks/residency.
Snapshots return copied aggregate objects; callers cannot mutate stored counters.

## Native lifecycle integration (reviewed)

`createNativeRenderer()` now owns one metrics instance, inventories each successful
normalization by exact PNG payload identity, and captures one transport event with
the complete emitted placement batch. Its functional image/prototype residency is
committed **before** guarded accounting. The presentation layer performs the public
terminal write before invoking `onUploaded`, then exposes cells/requestRender.

Implemented and reviewed hooks:

1. One `GraphicsMetrics` is created alongside one native renderer instance, not
   globally or in persisted message details.
2. On connection-token change, `beginEpoch(epoch)` runs during preparation and also
   when a diagnostic requests `native.stats(presentationEpoch)`. This clears only
   current accounting trust; it preserves normalization/runtime totals. Calling
   `native.stats()` without an epoch leaves the current accounting epoch unchanged.
3. Successful normalized PNGs are registered once per snapshot-cache entry using
   `payloadIdentity(image.pngBytes)`, not a source path or occurrence. The metrics
   registry deduplicates distinct snapshots with byte-identical normalized payloads.
4. Preparation captures image/placement IDs and keys, occurrence/geometry keys,
   dimensions, PNG bytes, exact `Buffer.byteLength(uploads)`, the actual PNG command
   array length and all emitted prototype commands. Restored/new prototype entries
   each use `uploaded: true`; no unwritten/reused entry is included. This prevents a
   hardcoded single-placement subtraction or inflated chunk count on replay.
5. Native `finish(true)` first commits functional image/prototype residency. If the
   captured `wireBytes > 0`, it then calls `recordTransport` once for the complete
   batch. Zero-byte reuse skips the accounting hook altogether, so integrated
   `successfulCommits` counts actual nonempty successful writes, not repaints.
   The native finish guard makes repeated `onUploaded()` calls idempotent.
6. Failed writes, cancellation and replaced native epochs never account a transport
   or mark its prototypes successful. Successful normalization inventory may still
   be retained. A stale callback without an AbortSignal is also rejected by the
   native `current === state` test, independently of signal cancellation.
7. Every optional accounting operation is guarded by native `account()`. Exceptions
   increment diagnostic errors and capture a sanitized `lastError`, without throwing
   into presentation or stranding the serialized upload queue. Normalization,
   successful functional residency and ready cells remain intact. Snapshot failure
   returns a minimal scope and `accounting.unavailable: true`; snapshot success still
   reports `accounting.errors`/`lastError`, so incomplete accounting is not concealed.

The measurement worker reviewed but did not edit native/extension files. Tests use
simulated successful writes or thrown writes, not real terminal graphics. Native
regressions include a throwing accounting hook with the actual presentation seam:
placeholder cells still become ready, the payload is not retransmitted, later
occurrences proceed, and accounting errors are reported. An additional metrics-
owned integration regression captures restored multi-prototype events and checks
single wire totals, no-byte skips, current epoch and genuinely stale un-aborted
callbacks.

## What the measurements cannot know

A successful host write establishes stream ordering, **not a terminal ACK**. Quiet
Kitty replies may be disabled; the terminal can ignore a command. A throwing stream
write may have partially written bytes; excluded attempted bytes cannot be inferred
from success-only accounting. Renderer repaint/reset or external image deletion can
invalidate residency without an observation hook.

A fresh runtime cannot discover pixels retained from earlier runtimes, other
sessions, another Pi process or other applications. Similarly, `beginEpoch()`
clears trust/accounting, **not terminal memory**. Counts returning to zero after a
reset are not evidence that memory was freed. Replayed images under new IDs may
coexist with older untracked pixels. Do not sum runtime snapshots as a global
terminal bound or claim automatic fresh-runtime accounting covers retained pixels.

`width * height * 4` omits terminal textures, alignment, compression, decoder
scratch, multiple CPU/GPU copies, retained source data, placement overhead, host
base64/session data, native normalization cache and this metadata registry itself.
Some terminals deduplicate or allocate differently. These are useful estimates
for choosing experiments, not measured resident-set/GPU bytes.

The metadata registry grows with retained normalized payloads and placements.
There is no metadata pruning, owned-delete hook or graphics eviction in this
phase. Adding one requires coherent shared-payload/placement ownership and
careful historical scrollback semantics, not merely decrementing a counter.

## Sample and stress evidence

Real primary Google fixture bytes normalized with installed public Pi 1.0.3
`convertToPng`, then encoded with the pure Kitty encoder. **Transport commits were
simulated; no terminal graphics were emitted.** Default 2048-character chunks,
fixed 60x24 geometry and deterministic small IDs:

| Fixture | PNG dimensions | PNG bytes | Estimated RGBA bytes | Wrapped wire bytes incl. placement | PNG chunks |
|---|---:|---:|---:|---:|---:|
| `gallery/1.jpg` | 550x368 | 435,617 | 809,600 | 587,703 | 284 |
| `gallery/1.webp` | 550x368 | 367,906 | 809,600 | 496,367 | 240 |
| `animated/1.webp` still | 300x225 | 47,830 | 270,000 | 64,607 | 32 |
| Total | 3 unique payloads | 851,353 | 1,889,200 | 1,148,677 | 556 |

Source base: `https://www.gstatic.com/webp/`. Numeric wire byte totals vary slightly
with ID digit lengths and protocol options. PNG bytes are distinct for this JPEG
and WebP pair; source-image similarity is not byte identity. This small sample
establishes measurement sanity, **not a demonstrated need for eviction**.

Deterministic tests simulate:

- 10,000 occurrences sharing one payload: one resident ID/100 PNG bytes, two PNG
  chunks total, 10,000 placements, 600,180 simulated successful wire bytes.
- 1,000 unique payloads: retain all 1,000 IDs, 100,000 PNG bytes and 800,000 estimated
  RGBA bytes with no silent eviction. Simulated transfer: 240,000 bytes/2,000 chunks.

These tests intentionally use known synthetic metadata. They measure accounting
behavior and history retention, not actual terminal allocation or rendering speed.

```sh
node --test test/metrics.test.mjs
npm test
```

Tests cover deduplication, separate occurrences/geometry, multiple IDs per payload,
epoch/runtime resets, stale completion, failed writes and retry, copied snapshots,
invalid/conflicting records, safe-integer bounds and stress. Batch tests cover
multi-prototype epoch replay, same-ID placement invalidation, partial restoration,
placement-only additions, zero-byte batch reuse, failed/stale/duplicate batches,
count validation and one-time aggregate transfer accounting. No new dependency,
provider request, OS/configuration change or renderer implementation copying is
required. Human terminal memory/scrollback experiments remain separate work.
