# Phase 3: lifecycle in desktop main — evidence

Supports `docs/agents/effect-boundary.md` § "Shared helpers" (the
`runShutdownSequence` rule) and `docs/agents/platform-contracts.md` § "Graceful
shutdown ownership". Ticket: BST-1819 (parent BST-1811). Measured against
`effect@4.0.0-rc.117` on 2026-09-24.

## The plan this phase replaced, and why

The rollout plan's Phase 3 said: turn the chunking, embedding and LLM host
managers into scoped Layers, build desktop main's runtime from one Layer, and
express `runGracefulShutdown` and the factory-reset runtime list as Scope
finalizers. Mapping `main.ts` showed three mismatches.

1. **Shutdown order is a dependency order across all of main, not acquisition
   order.** A Scope releases in reverse acquisition order. The managers are
   constructed at module scope as chunking, parser, embedding, llm, so a Scope
   would release llm first. Shutdown instead runs `renderers`,
   `assistant-server`, `mcp-runtime`, `chunking-host`, `parser-host`,
   `embedding-host`, `llm-host`, `git-inventory`, `forge`, `database`,
   `error-log-sink`, and records `McpShutdownOrderingError` when MCP closes
   before the assistant server drained. Getting that order out of Layer
   dependencies means rebuilding the whole composition root (about 2,400 lines
   of module-scope and `whenReady` wiring) as a Layer graph, not just wrapping
   the hosts.
2. **Factory reset is not a scope closing.** It stops eleven runtimes in
   parallel with `Promise.allSettled`, names every failure in one
   `AggregateError`, and the hosts restart lazily in the new profile. A Scope
   finalizer is final teardown; a restartable stop is a different operation.
3. **The orchestration had no behavioural test.** `runGracefulShutdown` lived
   in `main.ts` (Electron side effects at import) and was pinned only by tests
   that search `main.ts` for literal strings (`ndjson-backstop.md` recorded the
   missing seam as a known gap).

The owner chose the narrowed scope below on 2026-09-24.

## What changed

- **`runShutdownSequence` (effect-kit).** `Effect.forEach` over the steps, each
  step an `Effect.tryPromise` wrapped in `Effect.exit`, so a failure becomes a
  recorded outcome and the next step still runs. The whole run sits under
  `Effect.timeoutOrElse`.
  - rc.117's `timeoutOrElse` is `raceFirst(self, sleep)` followed by `orElse`,
    so the running step is interrupted (its `AbortSignal` aborts) before
    `orElse` calls `onDeadline`. `shutdown-sequence.test.ts` pins this by
    reading the step's signal from inside `onDeadline`.
  - `Effect.exit` does not capture interruption, so an interrupted step is
    never reported as settled; `onDeadline` receives it with its elapsed time.
  - The deadline timer is cleared when the steps finish in time (the test
    counts Node `Timeout` resources, as `timeout.test.ts` does).
- **`main/desktop-graceful-shutdown.ts` (desktop).** Owns
  `DESKTOP_SHUTDOWN_STEP_ORDER`, the shutdown latch and backfill retirement,
  the MCP ordering check, the failure warn (logged inside the `error-log-sink`
  step, before its close, as before), the completion log, re-entrancy and the
  forced-exit log. `main.ts` supplies a `planRun()` that builds one run's step
  bodies, so each run still captures `stopAssistantServer` when it starts.
  `desktop-graceful-shutdown.test.ts` is the first behavioural test of this
  orchestration.
- **Five IPC disposers joined the stack.** `workspace-open-ready`, `secrets`,
  `provider-auth`, `agent` and `runtime` returned an unregister function that
  `main.ts` discarded. `ipc-disposer-ledger.test.ts` parses `main.ts` and
  fails on any `register*IpcHandlers(...)` call that is not the second
  argument of `ipcDisposers.add`. Against the pre-change `main.ts` it reported
  exactly those five calls.
  Each of the five is `() => registry.unregisterAll()`, handler removal only,
  so running them at `will-quit`, after the database closed, touches no DB,
  secrets store or engine.
- **A backstop keeps the exit bounded if the orchestration itself fails.**
  Review of the first push (#3305) found that the step deadline lives inside
  `runShutdownSequence`, so a throw from `retireBackgroundAdmission`,
  `planRun` or a hook left no deadline at all, and `handleShutdownSignal`
  could hang on a rejected run. The old `scheduleForcedProcessExit` timer was
  armed before any of that. `run()` now arms an unref'd backstop first, at
  the deadline plus `DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS` (250 ms), so the step
  deadline still fires first on a stuck step and names it. The backstop is
  cleared when the run finishes or the step deadline has fired. `run()` never
  rejects: an orchestration failure is logged, and callers go on to quit.
  Disabling the backstop fails both orchestration-failure tests. Only the
  first run arms it, so a signal arriving after a finished run cannot leave a
  stray timer. A throwing logger can neither cancel the forced exit nor make
  `run()` reject (second review of #3305).
- **The error-log sink closes even if the failure warn throws.** The warn runs
  inside the `error-log-sink` step, so the close sits in a `finally`.

## Behaviour differences, deliberately small

- The deadline starts when the sequence starts, not when the trigger handler
  armed its timer. Both happened in the same tick; the handlers no longer arm a
  separate timer (the module's backstop took that job), and `will-quit` no
  longer clears one.
- At the deadline the running step's signal aborts and later steps are not
  started. Before, they kept running until `process.exit(1)`, which was called
  in the same callback, so production behaviour is unchanged apart from the
  signal. No owner reads the signal yet.
- While steps run, the step deadline is a referenced timer (Effect's `sleep`),
  not an `unref`'d one. Electron main keeps its event loop alive during
  shutdown anyway, the timer is cleared as soon as the steps settle, and the
  backstop is unref'd.
- `mcp-runtime` calls `cleanupMcpRuntimeForShutdown()` through a wrapper: the
  cleanup's optional first parameter is the runtime, so passing it the step
  signal would have been a bug.

## Not moved, with reasons

- **Factory reset** keeps its parallel `stop()` list (reason 2 above).
- **Hosts as Layers, and main as one Layer.** Needs a composition-root design
  first: which services become Layer-built, how module-scope IPC registration
  reaches them, and how reset re-creates a profile scope. Record that decision
  before any code.
