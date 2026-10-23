# Pure Kitty protocol helpers (Phase 1)

These helpers are deliberately independent of Pi, Chafa, conversion, terminal
writes and lifecycle integration. They do not activate a renderer or establish
terminal support. Integration must upload before exposing placeholder rows and
must preserve the project's model-image policy. No Kitty or OMP implementation
code has been incorporated; this is a small implementation of the public wire
protocol. This document is implementation/reference material, not an installation
manual.

## Primary references and verification

Consulted the current public specification on 2026-10-23:

- [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/),
  especially [remote client/chunking](https://sw.kovidgoyal.net/kitty/graphics-protocol/#remote-client)
  and [Unicode placeholders](https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders).
- [Kitty's ordered row/column protocol constants](https://github.com/kovidgoyal/kitty/blob/07c8731470f4f7d461b5418c355b17a6d6edd9d3/gen/rowcolumn-diacritics.txt)
  (Kitty master resolved to this revision during verification).
- [tmux manual](https://github.com/tmux/tmux/blob/master/tmux.1),
  `allow-passthrough`, and [tmux parser](https://github.com/tmux/tmux/blob/master/input.c),
  `input_state_dcs_escape_table` and `input_dcs_dispatch`: a DCS beginning
  `tmux;` passes its decoded contents through; ESC ESC becomes a literal ESC,
  whereas ESC backslash terminates the outer DCS. No tmux source was copied.
- [Unicode 6.0.0 UnicodeData.txt](https://www.unicode.org/Public/6.0.0/ucd/UnicodeData.txt)
  and [Unicode copyright and permission notice](https://www.unicode.org/license.txt).

The base64 payload limit is **4096 characters per Kitty command**, not 4096 raw
PNG bytes. Nonfinal chunks are multiples of four. Only the first transmission
command has image metadata; continuations contain only `m` and optional `q`.
Every command uses `q=2` (silence successes and errors), and every complete APC is
wrapped separately for **one** tmux layer. Nested multiplexers require another
transport strategy; these helpers do not detect or configure passthrough.

The default base64 chunk size is 2048, leaving generous framing headroom. Callers
may choose another multiple of four from 4 through 4096. This is a protocol
bound, not a claim that every historical tmux version supports the chosen frame
size. The tested encoder does not contact a physical terminal.

## Interfaces

### `src/kitty.mjs`

- `encodePngUpload(png, imageId, { chunkSize?, maxBytes? }?) -> string[]`:
  consumes `Buffer`/`Uint8Array` with its actual byte offset/length; returns ordered
  complete tmux-wrapped `a=t,f=100,t=d` commands. Last chunk has `m=0`. Default
  input bound is 64 MiB. Checks the PNG signature and nonempty data **only**, not
  PNG structure, dimensions, CRCs or decode safety. Pixel normalization and
  decoded-pixel resource limits belong to the caller. No compression/file medium.
- `encodeVirtualPlacement({ imageId, placementId, columns, rows }) -> string`:
  complete wrapped `a=p,U=1` prototype, quiet and explicitly identified. No
  ordinary positioned placement, cursor movement or combined transmit/display.
- `encodePlaceholderRows({ imageId, placementId, columns, rows }) -> string[]`:
  one string per row, **without** newline separators. SGR reset at both row
  boundaries; truecolor foreground encodes image ID and colon-form SGR 58
  underline color encodes placement ID. No underline text attribute is enabled.
  Background defaults after reset; transparent pixels therefore use the default
  terminal background. Do not restyle these rows or include them in model text.
- `encodePlaceholderCell(row, column) -> string`: U+10EEEE followed by explicit
  row, column and zero high-image-byte marks. The third mark deliberately
  prevents high-byte inheritance from unrelated adjacent placeholder cells,
  although IDs here are only 24 bits. Row/column encoding never relies on a left
  neighbor; colors are scoped at row level, as required by Pi's layout contract.
- `wrapTmux(sequence) -> string`, `validateId(id, name?)`,
  `validateGrid({ columns, rows })`; exported protocol constants and frozen
  `DIACRITICS`.

Both ID types are restricted to **1..0xffffff**; larger values fail rather than
truncate. Placement IDs are mandatory, avoiding ambiguous prototype selection.
The full specification table has **297** marks, so each dimension can be
1..297 and each zero-based coordinate can be 0..296. Application layout should
usually enforce a much smaller grid. The protocol's 32-bit-ID mode is not
implemented. Only SGR escapes and placeholder cells occur in returned grid rows;
all APC/DCS escapes stay in separate upload/placement strings.

### `src/identity.mjs`

- `payloadIdentity(png)`: SHA-256 of exact normalized PNG snapshot bytes, not a
  file path or a mutable source file. Does not convert or verify PNG structure.
- `geometryIdentity({ columns, rows, cellWidthPx?, cellHeightPx? })`: a canonical
  protocol-versioned geometry key. Missing pixel dimensions are represented by
  null; supply them when relevant. This helper currently supports whole-image
  virtual rectangles, not cropping/fit-policy alternatives.
- `placementIdentity(payloadKey, occurrenceKey, geometry)`: unambiguous structured
  key. Occurrence must be a durable caller-assigned string, e.g. message ID and
  PDF page index, not a label/path that accidentally aliases another occurrence.
- `StableIdAllocator({ random?, maxAttempts? }?)`: `allocate(key)` chooses a
  cryptographically randomized nonzero 24-bit candidate by default, checks
  collisions against all IDs allocated by this instance, and reuses a key's ID.
  Random candidate injection supports tests. Retries are bounded (128 default);
  exhaustion fails rather than looping. Invalid injected candidates fail. IDs
  are not released/reused: old scrollback may still refer to them.
- `GraphicsIdentityRegistry(options?)`: `resolve({ png, occurrenceKey, geometry })`
  returns frozen `{ payloadKey, placementKey, imageId, placementId }`. Identical
  payloads share an image ID, including across occurrences. Distinct occurrences
  and geometries have distinct placement IDs, preserving old prototypes on
  resize. Changed payloads receive distinct image and placement IDs. Image and
  placement allocation share one locally checked allocator.
- `ResidencyCache`: runtime-only `epoch` token, `beginEpoch()`, `hasImage(id)`,
  `markImage(id, epoch)`, `hasPlacement(imageId, placementId)`, and
  `markPlacement(imageId, placementId, epoch)`. Marks return false for stale
  epochs; placement marks also require a resident image. Mark **only after**
  successful transport; never mark just because encoding completed. Start a new
  epoch for connection resets and reject late async completions from the old
  epoch. A new cache instance starts empty with a distinct token.

Allocators/registries/cache are runtime objects, not session data. Repeated
layout in one registry is stable; a fresh process can assign new randomized IDs
while rebuilding from persisted attachment snapshots. No claim of global
collision freedom: the terminal namespace is shared with other applications
and independent registry instances. SHA-256 is a content identity, not a global
terminal-ID allocator. The cache is tracking only, with no automatic upload,
repaint, eviction, deletion or reconnect detection. Resource deletion/budgeting
is deliberately not implemented here; virtual prototypes require the deletion
semantics specified in Kitty's Unicode-placeholder section, not an indiscriminate
screen-placement delete.

## Diacritic data provenance and scoped notice

`src/kitty-diacritics.mjs` contains **protocol mapping constants only**. They were
independently extracted from Unicode 6.0.0 `UnicodeData.txt` using the filtering
rule documented by Kitty, then checked for exact ordered equality against the
pinned public mapping above. Select records containing `;Mn;230;NSM;;`, in source
order, excluding codepoints:

```
0300 0301 0302 0303 0304 0306 0307 0308 0309 030A 030B 030C
030F 0311 0313 0314 0342 0653 0654
```

This yields all 297 codepoints, including supplementary-plane marks. No Unicode
character names, implementation logic, Kitty GPL implementation or OMP MIT
implementation was copied. The pinned mapping file's SHA-256 is
`a80368b3272c41d8b50f3f640cf4305b6423e5a1aae6b72a405129bc29425f2c`.
SHA-256 of the resulting comma-separated decimal codepoints is
`18f1acc3adb9de8f88c66131efa8384d1a4f574ff4c7ac6f6c6335342afd5cc4`,
asserted by the test. This provenance makes the mapping reproducible without
incorporating upstream implementation code.

The following Unicode notice is retained for the Unicode-derived data in
`src/kitty-diacritics.mjs` and its associated data documentation. **It does not
choose or change a license for this project or its independently written
implementation.** The same full notice is retained inline in the table module,
so the current package's inclusion of `src` preserves it even when this document
is not shipped. Retain the inline notice when distributing the table.

> UNICODE LICENSE V3
>
> COPYRIGHT AND PERMISSION NOTICE
>
> Copyright © 1991-2026 Unicode, Inc.
>
> NOTICE TO USER: Carefully read the following legal agreement. BY
> DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
> SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
> TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
> DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.
>
> Permission is hereby granted, free of charge, to any person obtaining a
> copy of data files and any associated documentation (the "Data Files") or
> software and any associated documentation (the "Software") to deal in the
> Data Files or Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, and/or sell
> copies of the Data Files or Software, and to permit persons to whom the
> Data Files or Software are furnished to do so, provided that either (a)
> this copyright and permission notice appear with all copies of the Data
> Files or Software, or (b) this copyright and permission notice appear in
> associated Documentation.
>
> THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
> KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
> MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
> THIRD PARTY RIGHTS.
>
> IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
> BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
> OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
> WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
> ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
> FILES OR SOFTWARE.
>
> Except as contained in this notice, the name of a copyright holder shall
> not be used in advertising or otherwise to promote the sale, use or other
> dealings in these Data Files or Software without prior written
> authorization of the copyright holder.

## Automated checks and remaining boundaries

`test/kitty.test.mjs` reconstructs uploads across base64 chunk and padding
boundaries, checks exact ESC escaping/APC/DCS framing, continuation-only fields,
quiet replies, PNG-view offsets and input limits. It checks the entire diacritic
order by digest, independently decodes each cell's coordinates/high byte and
known foreground/underline colors, verifies row resets and bounds, and runs
helpers in a subprocess to assert zero stdout/stderr effects.

`test/identity.test.mjs` forces allocation collisions and bounded exhaustion,
checks stable rendering, shared-payload/distinct-occurrence semantics,
payload/geometry/cell-size changes, structured-key ambiguity, local randomized
allocation bounds and stale-epoch upload completion rejection.

These are encoder/state tests, **not** visual or host-integration proof. PNG
conversion, Pi width/clipping behavior, actual upload ordering, replay, resize,
terminal capability/passthrough detection, physical-terminal compatibility and
budgeting remain separate coordinator work. No image/model requests, package
activation, OS changes, settings edits or terminal graphics writes were used to
verify these helpers.
