# Vitest event-loop watchdog — evidence

Supports `docs/agents/ci-quality.md` § "A worker with a blocked event loop is
killed and named" (BST-1221). Read this before changing the watchdog, its
position in `setupFiles`, the stall budget, or the lane list, and when a lane
dies with a watchdog stderr line. The contract holds the rules; this file is
the record of why.

`LostTestFileReporter` below needs the worker to DIE. The PGlite wedge does
the opposite: PGlite 0.5.8's synchronous protocol loop retries
`_PostgresMainLoopOnce` forever after a WASM trap (`function signature
mismatch` in `$palloc`), so the worker spins at 100% CPU with its event loop
blocked. (The trap that reached that loop was the BST-1320 close race — a
Mastra statement floating into `close()` — not a Node or V8 defect; see
`docs/agents/assistant-persistence.md`. The watchdog stays because any blocked
loop, whatever reaches it, must fail by name.) `testTimeout` is a timer in
that loop and never fires, the worker never reports, turbo prints nothing,
and the job is cancelled at its 30-minute limit
with no verdict (`Unit (rest)`, run 34653237231, PR #3141).

Every lane that hosts real PGlite (`agent`, `app-shell`, `assistant-data`,
`assistant-service`, `db`, `db-explorer` unit and integration, `desktop`,
`embeddings`, `file-import`) lists
`@brainstrike/test-utils/vitest.event-loop-watchdog.setup` FIRST in
`setupFiles` (`packages/test-utils/vitest-event-loop-watchdog.mjs`). First,
because its heartbeat interval is captured at module evaluation and must be a
real timer, ahead of any setup that could install fake timers. It runs a
`worker_threads` watchdog with its own event loop; the main thread heartbeats
every second, `beforeEach` labels the running test, and after
`BRAINSTRIKE_VITEST_EVENT_LOOP_STALL_MS` (default 60 s — at or above every
lane's `testTimeout`; `db-explorer` integration ties at 60 s, which is
harmless because a slow-but-async test keeps heartbeating and only a genuinely
blocked loop can reach the stall) of silence the watchdog writes one stderr
line naming the test and SIGKILLs the worker. The lane list is enforced:
`scripts/verify-event-loop-watchdog.mjs` (paired test in `scripts/__tests__`,
run by `pnpm test:scripts` in the Static job) loads all 16 listed configs,
including the actual `test:integration` configs independently of their base,
and requires the setup to be the FIRST effective `setupFiles` entry (or the
sole string value). Override/reordering fixtures prove that the guard rejects an
integration config that removes the inherited watchdog. A config declaring
projects requires an explicit project in the lane contract; top-level setup
cannot stand in for the setup that its project files run. Load failures are reported by
config path alongside every other failing lane. A new
PGlite-hosting lane is added to that list, and a second-position or missing
entry fails Static rather than silently reintroducing the hang.

Outcome by pool: in a `forks` lane (`agent`, `db`, `embeddings`, `db-explorer`
integration) the child worker dies, the vitest process survives, and the
lost-file reporter fails the run naming the file. In a `threads` lane
(`assistant-data`, `app-shell`, `file-import`, `db-explorer` unit) the vitest
worker is a thread of the vitest process, so SIGKILL takes the whole run and
the stderr line is the only attribution. Both replace a silent 30-minute hang
with a named failure in about a minute. This is not a retry, timeout increase
or suppression: the wedge still fails the lane.

Debugging: the watchdog does not start when the process was launched with
`--inspect*` (execArgv or `NODE_OPTIONS`) and says so once on stderr, so
`vitest --inspect-brk` keeps working on these lanes.

Paired tests: `packages/test-utils/__tests__/vitest-event-loop-watchdog.test.ts`
(blocked loop killed and labelled; responsive worker exits on its own; inspector
opt-out — `inspector.url()` first, then the `--inspect`/`--inspect-brk` flags;
impossible heartbeat budget and non-integer budgets refused, under a debugger
too) and its vitest fixture runs: two healthy files under isolated forks and
under a REUSED worker (`isolate: false`, the registry-reuse path) with no
spurious kill, and a named kill of a blocking file under both `forks` and
`threads`. Proof against the real wedge is on BST-1221.
