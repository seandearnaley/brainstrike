# A WebAssembly trap must fail closed, not spin — evidence

Supports `docs/agents/database.md` § "A WebAssembly trap poisons the PGlite instance — it never spins (BST-1221)".

Why PGlite 0.5.8 is patched at all, the trace that identified the spin, what the patch deliberately does not do, and the conditions under which it is dropped. Read before touching the patch, its guard, or any close path that could trap.

## The defect

`patches/@electric-sql__pglite@0.5.8.patch` changes one thing in PGlite 0.5.8's
synchronous protocol loop (`execProtocolRawSync`, in both `dist/index.js` and
`dist/index.cjs`). Stock 0.5.8 catches any throw from `_PostgresMainLoopOnce()`
and, when `_pgl_setPGliteExitStatus(-2)` is not the longjmp sentinel, simply
loops again without advancing its read offset.

A genuine WebAssembly trap therefore spins the caller forever at 100% CPU with
its event loop blocked, so no timer, timeout or reporter can act. Observed
deterministically as `RuntimeError: function signature mismatch` in `$palloc`
when native stream cleanup overlapped database close (`Unit (rest)`, run
34653237231). Upstream tracks the loop defect as
[electric-sql/pglite#1058](https://github.com/electric-sql/pglite/issues/1058);
our evidence is on that thread. The close race that reached the trap is
[electric-sql/pglite#1084](https://github.com/electric-sql/pglite/issues/1084),
recorded in `database/pglite-close-drain.md`.

## What the patched loop does

On a non-longjmp trap it:

- throws a `PGliteFatalTrapError` from the call that trapped — the message names
  the exit status, `cause` is the original trap;
- marks the instance poisoned, so every later protocol call rejects with a
  `PGliteFatalTrapError` whose `cause` is that fatal, because memory a trap has
  corrupted must not run more SQL;
- lets `close()` release the WebAssembly instance and then rethrows the fatal, so
  a trapped instance can never end a test or a session cleanly.

After a fatal trap the loop does not call the WASM ready/flush finalizers, which
could trap again and replace the original failure. Startup packets are rejected
on a poisoned instance too; only Terminate remains available for teardown.
Ordinary PostgreSQL errors still take the unchanged longjmp path and leave the
instance usable.

## Why the guard checks the patch first

`packages/db/__tests__/pglite-fatal-trap-fail-closed.integration.test.ts` pins
all three behaviours with a simulated trap and a healthy control. Before it
simulates the trap it proves the patched loop is the one it is about to call —
the method source carries the `PGliteFatalTrapError` branch. If the patch were
missing or stopped applying, the test fails immediately with a named error
instead of driving the stock loop, which would spin the worker until the CI job
is killed.

## Scope and removal

This is deliberately not a retry, a fallback or a timeout: the failure stays a
failure, named and immediate. The patch is not to be widened beyond the loop.
When a PGlite release terminates the loop itself, drop the patch and rewrite the
guard's precondition against the upstream fix rather than keeping the
precondition as written.
