# Scheduled live-query handles and the Vitest 5 clock-less lane — evidence

Supports `docs/agents/database.md` § "QUERY TELEMETRY BOUNDARY".

Why `createScheduledLiveQueryHandle` offers no retry, what the PGlite 0.5.5 `unsubscribe` fix did and did not change, and how the clock-less package-import regression is run. Read before adding retry/reactivation semantics to a scheduled handle or reworking that regression.

The record below is the original contract text, extracted unchanged.

The upstream fact that justifies "no retry" is narrower than it once read here,
and it did NOT change in the 0.5.5 bump (BST-1283): PGlite's `unsubscribe`
detaches the callback and latches `dead = true` SYNCHRONOUSLY, before it awaits
the teardown transaction. So a rejected teardown still leaves the listener
detached and the raw handle permanently dead — upstream itself offers no retry,
and the wrapper's own `active = false`-before-await mirrors that exactly. What
0.5.5 DID change is the multi-listener case only: `unsubscribe(cb)` previously
ran `callbacks.filter((callback) => callback !== callback)`, a shadowed
parameter that made the predicate always false and so emptied the whole
collection, terminalizing the handle for every listener. 0.5.5 fixes the shadow
(`(cb) => cb !== callback`), so a handle with other listeners now stays live.
Nothing in this repo subscribes twice to one handle, so that fix is inert here.

Vitest 5 migration (BST-1689): the clock-less package import regression runs
in an isolated Node/tsx process using the shared workspace source aliases.
The resolver converts absolute source paths to file URLs for Windows ESM, and
child assertion errors inherit stderr so import failures remain diagnosable.
Removing `performance` from a Vitest worker breaks the runner's own clock and
cannot test package initialization reliably. The child must import the public
DB source entry without a clock, then fail explicitly when telemetry is used.
DB browser-storage tests stub and restore `navigator` with Vitest's global
helpers; hook cleanup uses `vi.doUnmock`, since hoisted `vi.unmock` is module-only.
Root source aliases are shared by inline projects through Vitest 5 inheritance;
keep the snapshot `globalSetup` on the unit project only.
