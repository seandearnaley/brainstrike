# Persistent command sessions — evidence

Supports `docs/agents/assistant-runtime.md` § "Renderer stream-insulation boundary".
Read before changing `command-session-manager.ts`, its retention/cursor model, paging ceilings, reaping, or the two session tools.

The record below is the contract text as it stood before the
2026-09-21 distillation (original lines 2157-2228), extracted verbatim.

Persistent command sessions (desktop application layer):
`apps/desktop/src/assistant-server/command-session-manager.ts` is the
desktop-main source of truth for commands that must outlive one tool call (for
example a dev server). It deliberately does NOT replace `executeCommand`, which
remains the bounded, wait-for-exit path for normal tests/builds.

- A session belongs to one DB-backed workspace `rootId`; all list/get/read/
  write/stop/remove operations require that same root. A cross-root lookup is
  indistinguishable from an unknown id.
- `start()` resolves and realpaths the requested cwd inside that root, then
  returns immediately after a real `node-pty` spawn. Unsupported roots,
  escaping/nonexistent cwd, startup failure, exited writes, and invalid cursors
  surface typed errors; there is no cwd or cursor fallback.
- Combined PTY output is memory-only and capped at 2 Mi UTF-16 code units.
  Retention uses head-evicted, fixed-size adaptive blocks: Latin-1 terminal
  output stays one byte per code unit, and a block upgrades to UTF-16LE only
  when wider code units enter it. Tiny PTY events are copied into bounded
  blocks instead of retained as individual references, appends never rebuild
  the full retained buffer after it reaches the cap, and reads decode only the
  requested retained suffix. Oversized events copy their retained suffix so a
  V8 sliced string cannot pin the discarded parent.
  Reads use absolute cursors; `-1` attaches at the live tail without replay.
  The manager applies the requested UTF-16 page limit while decoding retained
  blocks, before joining the page, and backs the page cursor off a high
  surrogate rather than splitting a pair. An evicted cursor returns the
  retained page with explicit `hasMore`,
  `truncatedBeforeCursor` + `bufferStartCursor`; a cursor beyond the produced
  output throws. This mirrors OpenCode's bounded absolute-cursor replay shape
  and prevents duplicate polling output.
- Model-facing inventory and reads are producer-paged below a 5,500 UTF-8 byte
  result ceiling, which is deliberately below the durable artifact-settlement
  threshold. List continuation uses `offset`/`nextOffset`; read continuation
  advances `nextCursor` only through the emitted UTF-16 code units and exposes
  `availableEndCursor` plus `remainingUtf16CodeUnits`. A page never splits a
  surrogate pair. This source-owned paging is load-bearing for bounded live
  delivery. The canonical session-tool ids are additionally registered as
  non-durable outputs, so artifact settlement skips them even when a lifecycle
  hook wraps a result: command-session output must never be copied into the
  seven-day tool-output artifact store.
- Running/exited state is typed. The newest 25 exited sessions per root remain
  readable; older exited sessions are evicted. Command text, cwd, environment,
  and raw output are never logged or persisted.
- Tree reaping walks descendants before killing the PTY leader, then applies a
  POSIX process-group backstop and waits for the PTY exit event. Reaping is
  idempotent across abort/stop/remove/dispose races; operations on an already
  exited session surface typed state. Bulk disposal settles every PTY and logs
  any missing exit acknowledgement so one stuck process cannot skip the rest of
  graceful shutdown. Root disconnect reaps by the durable DB id returned from
  the path-keyed disconnect update (never the possibly divergent adapter id);
  factory reset and graceful shutdown dispose all sessions.
- Hosted desktop models receive two deferred operations through the ordinary
  native registry: read-risk `inspectCommandSessions` (list/read) and
  execute-risk `manageCommandSession` (start/write/stop/remove). The latter is
  omitted in plan mode and follows the normal ask/deny discovery and approval
  gates. Both tools own a target-aware transcript transform: start command/cwd,
  write data, streamed input deltas, session cwd, PTY output, and guarded error
  messages/reasons are replaced by allowlisted metadata before PGlite
  persistence, while the live display and current model step retain the bounded
  domain result. The built-in local provider omits both because it lacks
  deferred tool discovery. Web never constructs the desktop registry, and its
  explicit native tool-id partition omits both from settings, request
  allowlists, and the model tool menu, so it exposes no stub or fallback. Do not
  widen `executeCommand` in place. The command-session inventory UI is a separate
  follow-up slice.

Proofs: `command-session-manager.test.ts` (scoping, cursors/gaps, retention,
stdin, typed failures, startup-abort/dispose races, stuck-PTY settlement) and
`command-session-manager.integration.test.ts` (real PTY HTTP server survival,
natural non-zero exit, and leader/descendant reaping), plus the command-session
cases in `assistant-tools-read.integration.test.ts` (transcript redaction, UTF-8
result ceilings, manager/tool continuation composition, and surrogate-safe
paging).
