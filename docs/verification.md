# Verification

## Portable suite

```sh
npm test
```

The default suite needs Node, not a physical installation of Pi. Optional tests
in `*.test.mjs` skip when their host is unavailable. Protocol, identity,
normalization, subprocess, cleanup and presentation tests do not send images to
a model or draw on the invoking terminal.

## Actual-host offline integration

Use an installed Pi package compatible with the tested **1.0.3** API:

```sh
PI_TEST_HOST_ROOT=/absolute/path/to/pi-coding-agent-package \
  node --test test/host-integration.mjs
```

`PI_TEST_HOST_ROOT` denotes the directory containing Pi's `package.json`, not its
CLI executable. Without that variable the harness tries normal resolution of
`@earendil-works/pi-coding-agent`; if neither is available it skips explicitly.
The harness is intentionally not a prerequisite of the portable `npm test`.
There are no machine-specific store paths in the harness.

The harness:

- Generates a valid PNG and two-page PDF in a disposable workspace. Real Poppler
  must be on PATH for the PDF case; converters are not stubbed.
- Runs the selected host's real `pi install <checkout>` with a temporary
  `PI_CODING_AGENT_DIR`, a temporary HOME, offline mode and telemetry disabled.
  It passes an environment allowlist rather than inherited provider secrets.
  Local installation does not copy or install dependencies into the checkout.
- Discovers the installed package with public `DefaultResourceLoader` and loads
  the actual extension through Pi's extension module mapping. Both slash-command
  names, both tool names, required `path` arguments and sequential declarations
  are checked.
- Supplies a disposable PATH-resolved `tmux` capability-query fixture and query
  log for a recognized single-client Ghostty path with passthrough enabled. The
  fixture also models passthrough off, an unknown client and a killed/timeout
  query. It never queries/configures the active server. This tests capability
  plumbing, not real terminal identity or passthrough; converters remain real.
- Uses public `createAgentSession`, an in-memory `SessionManager`, isolated
  settings, and an offline mock of the public `modelRuntime` boundary. The mock
  returns one assistant response calling both viewers and one final response.
  There is no provider client, credential store or network request.
- Captures requests **after the SDK's actual conversion and blockImages filter**.
  It additionally checks the session agent's public `convertToLlm` function.
  Calling the standalone exported `convertToLlm` would not prove SDK blocking.
- Checks both `images.blockImages` states: three standard attachments remain in
  session context in either case; blocked requests have zero image blocks and
  the host's disabled-image notice; unblocked requests have the same three
  eligible image snapshots. Blocking is not a session-storage policy.
- Exercises real tool execution with both sibling calls in one assistant
  response. The first execution ends before the second starts; both tool results
  precede viewer messages; exactly two assistant responses/model requests and
  only the original user turn are present. This checks `triggerTurn: false`
  behavior rather than inspecting source strings.
- Invokes the loaded message renderer, captures terminal transport in memory,
  and confirms local placeholder output with blocking both on and off. Rendering
  leaves the stored conversation unchanged. No placeholders or terminal upload
  text enter captured model messages. Repeated frames, invalidation and rebuilt
  renderer components do not retransmit pixels.
- Deletes original image/PDF sources, calls public `session.reload()`, and
  renders the same three attachment snapshots with the recreated extension.
  PDF page scratch files are already gone. A new runtime uploads again, all
  three images recover, stored session JSON remains exactly unchanged, the model
  policy still applies, and no new request is made. Future schemas/missing
  snapshots yield readable no-placeholder fallback. Injected ESC/APC/newline/C1
  controls in copied labels are neutralized without mutating stored content.
- Checks live component width, height-only terminal changes and public host
  `setCellDimensions()` changes. Captured placement commands show aspect-fitted
  geometry, stable payload IDs and new placement IDs; geometry-only changes
  send no PNG uploads, and reversing a resize reuses cached geometry.
- Injects a terminal write failure: no placeholder cells become visible. Invokes
  the actual `/tmux-image-refresh` through `session.prompt()` and confirms a
  requested repaint, new-residency upload and recovery of the existing component
  without adding messages or starting model work.
- Resumes a separate public SDK session containing an unversioned legacy custom
  message created with `SessionManager.appendCustomMessageEntry()`. Its old Chafa
  rows are ignored; its standard stored attachment supplies native pixels after
  source removal. Rebuilding uses stable runtime occurrence identity, does not
  retransmit, and does not rewrite persisted details. Both model policies remain
  effective and no provider request is made by resume/rendering.
- Checks print, JSON, RPC and TUI-outside-tmux rejection through public extension
  bindings: both tools fail, no attachment messages are appended, no terminal
  widget is installed and no graphics bytes are emitted. A separate forced-host
  Kitty case rejects both viewers without uploads or attachments; that case can
  install a zero-row transport owner but must never write to it.
- Checks disabled local display, concrete setting/environment precedence,
  forced host Kitty and false truecolor gates with zero probes or graphics.
  Missing source paths prove both image and PDF tools reject before reading or
  rasterizing. Unsupported passthrough/client/timeout cases also fail before
  source reads, without attachment messages or graphics.
- Replays stored snapshots while passthrough is off or a query times out, with
  blocking both on and off. Denied replay emits no graphics. After correcting
  the fixture, `/tmux-image-refresh` makes fresh readonly probes and recovers
  the same component without changing stored messages or starting model work.
  A changed public `showImages` policy immediately hides already-ready cells;
  re-enabling unchanged cells does not repeat uploads.
- Disposes sessions/widgets and removes every generated fixture and isolated
  configuration in `finally` cleanup. It does not alter the active user's Pi
  settings, installed package, tmux options or terminal.

Important host detail: resource loading reloads settings from storage. Test-only
`applyOverrides` must run **after** `loader.reload()` so that an apparent blocked
case does not accidentally run with the default unblocked setting.

### Renderer seam and format parity

To run the optional actual-host cases alongside the portable suite:

```sh
HOST=/absolute/path/to/pi-coding-agent-package
PI_TEST_HOST_ROOT="$HOST" \
  PI_IMAGE_HOST_MODULE="file://$HOST/dist/index.js" npm test
```

The seam tests use `PI_TEST_HOST_ROOT`; actual converter tests currently use
`PI_IMAGE_HOST_MODULE`, a file URL of the package's public root entry. Set both
for the complete host-enabled suite. Setting only the first skips converter
parity tests rather than proving them.

See [renderer-seam.md](renderer-seam.md) for upload-before-placeholder ordering,
repaint/rebuild/resize experiments and the forced-native Kitty deletion blocker.
Normal tmux host image capability `null` is supported; forcing Pi's native Kitty
protocol is not proof of extension compatibility. Tests that demonstrate the
host's global deletion behavior are regression evidence of a limitation, not
proof that replay after that reset works.

See [pixel-normalization.md](pixel-normalization.md) and
[kitty-protocol.md](kitty-protocol.md) for converter/encoding contracts and their
focused tests.

## Observations and remaining manual verification

Automated observation on Pi 1.0.3: the offline integration harness passed twelve
checks (parent integration plus eleven subtests) against native Phases 1–3,
including isolated installation/discovery, both blocking states, source-free
reload/replay, live width/height/cell sizing, failed-write refresh recovery,
legacy-session resume, unchanged-frame upload reuse, all non-TUI/outside-tmux
rejection cases, public local policy precedence, unsupported path/timeouts,
forced-native/truecolor guards and denied-to-supported refresh recovery. These
results describe the reviewed working tree, not a pinned release; rerun after
each integration phase and record the revision under test. They are not human
visual verification. The latest fully host-enabled suite also passed **88/88**,
with zero skips; without both host variables that is not the same coverage.

A captured public UI transport does not emulate Ghostty's image decoding or tmux
passthrough. Before declaring a phase complete, independently observe actual
image and two-page PDF display in a real tmux pane: position, more text below,
scrolling in both directions, and window switching. For replay/resize claims add
shrink/expand, height-only resize, zoom/unzoom, reload, resume after source removal,
and the documented reconnect/refresh path. Record which checks were automated
versus human-observed; do not infer these outcomes from a green offline harness.
