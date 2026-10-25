# PDF viewer blank-page recovery

## Evidence and scope

The owner reported blank pages **inside the fullscreen PDF viewer**, persisting
across Escape and reopening. `/tmux-image-refresh` restored those pages, but
subsequent navigation produced blanks again. This is human-observed recovery and
recurrence on the existing Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3 setup, **not
acceptance of this repair** or proof of a specific terminal eviction bug.

**Subsequent owner check did not pass:** after being asked to reload and test the
repair, navigating through several pages and then backward reliably produced
blank pages; page 1 was never blank. The tested workflow is not human-accepted.

A follow-up worker then compared a long-running isolated Pi, started before the
repair, with a fresh process loading the same checkout and display settings.
`/reload` reset the old process's runtime/image IDs but **did not activate the
changed native behavior**: page 2/3 first visits uploaded PNGs, while page 3→2,
page 2→1 and close/reopen still emitted only placements. A fresh process emitted
the required exact cached PNG retransmission on those revisits and reopenings.
This establishes an activation failure in the installed Pi 1.0.3 reload workflow,
not proof of the owner's exact loaded module. After being asked to observe the
fresh isolated Pi and navigate the paper 1→2→3→2→1, the owner confirmed
**“pixels confirmed!”**. This records general human visual confirmation of the
activated recovery on Ghostty 1.3.1 / tmux 3.6a / Pi 1.0.3, not a separate report
for each page, close/reopen, identical-payload case or the full PDF matrix.
The installed jiti 2.6.1 async `.mjs` path uses native ESM import even with
`moduleCache: false` / `tryNative: false`. A disposable cache probe, with filesystem
cache disabled, returned old child-module code from a new jiti instance in the
same process and new code from a fresh process. No production cache-busting or
loader patch was made. Runtime recreation/new IDs alone do not verify new code.

For a non-disruptive visual check, the fresh isolated Pi used a generated six-page
PDF and a public fifteen-page paper under the owner's display settings. The
worker verified exact PNGs for the paper's 1→2→3→2→1 and close/reopen sequence;
it could not see physical pixels. No Kitty ACK observer was introduced because
activation, rather than a fresh-upload rendering failure, was the first unresolved
branch. The subsequent owner confirmation supplies the physical visual evidence;
there is no need to infer it from capture streams or introduce another transport
intervention on the strength of those streams alone.

A read-only worker exercised a fresh real fullscreen Pi in a named workmux tab,
with a generated labelled six-page PDF and a public fifteen-page paper. It tested
next/previous, jumps, rapid reversals and close/reopen. Correct page labels, exact
image IDs, scoped retirement and placement commands reached the captured stream.
Reconstructed uploaded PNGs matched independently rasterized pages byte-for-byte
and contained nonblank pixels. The worker could not inspect physical Ghostty
pixels; text placeholders and successful writes are not visual acceptance.

The former implementation retained permission to skip PNG uploads after retiring
a private placement. Revisits/reopens could therefore send only a placement for
an image silently lost by the terminal. An independent protocol-loss simulation
reproduced that stale-trust failure for viewer-only and inline-shared payloads.
Ghostty's image storage can evict unused images preferentially, but also used
images; actual eviction, configured limits or command rejection were **not
measured**. The exact terminal-side cause remains unconfirmed.

## Recovery boundary

Inside the existing **successful, guarded scoped-retirement commit**,
`src/native.mjs` deletes the retired image ID from its current-epoch upload-reuse
trust set. This applies to all private payloads, including those shared with
inline previews or identical-looking pages. Inline sharing is not a residency
acknowledgment.

This is conservative loss of reuse permission, **not pixel eviction**:

- Keep exact normalized PNGs, image IDs, all successful inline occurrence/geometry
  prototypes and the successful-write metrics inventory.
- The next actual native preparation retransmits cached exact PNG bytes through
  the existing guarded shared queue, restoring every retained inline prototype
  plus only the live private prototype. A same-ID PNG replaces terminal placements,
  so the complete restoration batch is essential even without external loss.
- Preparation, logical release, failed/denied/stale callbacks and no-op retirement
  do not apply this success-only invalidation. Failed cleanup retains its single
  obligation and blocks rebinding; retries still flush removal before deletion.
- An inline successor can perform the reupload first; a later viewer can reuse
  those fresh pixels. Never-retired inline-resident first binds also retain reuse.
- Current-lease resident pan remains zero-transport; zoom/resize continue to reuse
  its PNG. Pacing remains 150 ms idle after deferred first-own component receipt,
  with wheel expiry disabled.

No new detector, force path, acknowledgment, budget, placement slot, timer,
settings switch, source reread, session entry, attachment or model turn is added.
Later-page navigation retains its existing provider/raster behavior; this repair
adds no provider work. Page 1 remains the canonical stored preview.

`/tmux-image-stats` retains successful-write PNG/RGBA inventory estimates after
retirement, rather than claiming memory was freed. Those estimates are distinct
from permission to omit a future PNG upload. Successful retransmission increases
wire/chunk/restoration counters once, without duplicating image inventory. See
[graphics memory](graphics-memory.md) and [native ownership](viewer-lifetime.md).

## Limits and trade-off

Revisits/reopens now cost additional PNG transfer, including ordinary images and
inline-shared pages that crossed private retirement. There is no pixel atomicity,
latency/FPS or universal recovery guarantee. The outgoing retirement boundary
cannot repair an unrelated incoming image that has never crossed that boundary,
loss during a still-live lease, or a terminal rejecting a fresh upload. Existing
explicit refresh remains the recovery path for other unobservable losses/resets.

No graphics-memory bound, freed-GPU-byte claim, application eviction or terminal
configuration change follows from this repair. It does not retroactively identify
all stale IDs in a pre-fix runtime. Active package activation remains an
owner-coordinated step. For updates to an already-loaded version on the tested
Pi 1.0.3, restart the Pi process and resume the session; `/reload` can retain
transitive native ESM code. No module-cache patch, query-string workaround or
configuration change is introduced here. First installation can still use
`/reload` when those modules have never been loaded.

The follow-up reproduction used only isolated in-memory sessions and public
write logging: one fresh process and one existing-process `/reload`, with the
same generated/public PDFs and no model requests. No owner's process was restarted.
Its before/after wire distinguishes newly uploaded pages from reused targets;
physical pixels remain unavailable.

## Verification

Automated candidate gates on Pi 1.0.3 / Node 24.21.0 passed:

| Gate | Passed | Skipped | Failed/cancelled | Duration |
| --- | ---: | ---: | ---: | ---: |
| Portable `npm test` | 252 | 34 optional host | 0/0 | 1.569 s |
| Host-enabled `npm test` | 299 | 0 | 0/0 | 10.206 s |
| Focused native/PDF controller, host-enabled | 61 | 0 | 0/0 | 1.161 s |
| Standalone SDK, including isolated install/loading | 12 | 0 | 0/0 | 12.158 s |
| Standalone viewer + public TUI pacing | 23 | 0 | 0/0 | 133.204 s |
| Standalone PDF, complete corrected rerun | 15 | 0 | 0/0 | 29.877 s |

Durations are test-runner elapsed times, not interactive latency measurements.
Seven new targeted recovery regressions failed against the old native source in
a disposable copy and passed with the candidate. Coverage includes independent
quiet terminal loss, exact cached PNG bytes, shared history and identical payloads,
repeated navigation/close/reopen, inline-first queue successors, failed/stale/no-op
retirement and guarded accounting. Production host assertions inspect the exact
transition's retransmission/restored prototypes, not only earlier upload presence.
They preserve exact entries/model conversion and current-page zero-raster behavior.

Two intermediate failing runs are not acceptance: the first coordinator
host-enabled run had 295 passed / 2 failed from superseded placement-only reopen
expectations; the first PDF run had 10 passed / 5 failed (four matrix leaves plus
parent) from a new oracle demanding reupload of an unrelated incoming page whose
trust could already have been renewed by resize-triggered inline work. The latter
was corrected by deliberately closing canonical page 1 before checking its reopen,
retaining all inline geometry versions. Final complete reruns passed without
weakening same-lease reuse or full prototype restoration.

Reviewed production change is confined to `src/native.mjs`; candidate SHA-256:
`f62b67780e58c970815cdc5eb2f1c0efa6edd56c25e4e39158405d1cc48482e1`.
The original [0.5.0 PDF acceptance record](pdf-document-viewer.md) and its source
hashes remain historical baseline evidence, not verification of this native change.
No active owner reload or physical-terminal pixel acceptance follows from these
capture/simulation/install gates.

Independent final review passed with no blockers: 176/176 focused tests,
299/299 host-enabled tests and 15/15 standalone PDF tests, plus an independent
old-code negative control failing all seven recovery regressions. An optional
review suggestion was then applied to the public seam oracle: require an actual
delete index and the exact single retired tuple before the reupload, rather than
allowing an absent delete's `-1` index to satisfy an ordering comparison. Final
coordinator reruns after that assertion hardening passed portable 252/286
(34 optional-host skips, 3.565 s) and host-enabled 299/299 (11.841 s), with zero
failures/cancellations. Production native bytes were unchanged throughout.

The earlier reload/test workflow failed; the subsequent fresh-process visual
check received general owner confirmation as recorded above. Remaining narrower
checks include identical-payload transitions, close/reopen, regular-mode behavior,
retention lifecycle and inline history/ordinary image gestures across the wider
matrix. Distinguish any future blank despite a fresh PNG batch from a reused-target
failure. No passing simulator/capture test substitutes for human pixel evidence,
and no latency/FPS or exact Ghostty-loss mechanism was established.
