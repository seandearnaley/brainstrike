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

## Coverage guard (BST-1085, 2026-09-26)

The original missing runtime wrappers were present on main. Review exposed
unmeasured count reads in both clearAll implementations; these now use the
file-tree wrapper without counting the subsequent deletion as a read. `database-telemetry-seams-contract.test.mjs` parses the
TypeScript AST and classifies every declared and public file-record method.
It requires Base and Drizzle reads (including managed-cache reads), token-cache
lookups/aggregate/folder preload reads, the single embedding queue poller, scheduled live-query creation/refresh, and Electron start/refresh
to execute inside the matching measured callback. Live subscription/update
counters are pinned at their owning functions. Existing scheduler and live-query
behavioral suites remain the lifecycle semantics proof. Negative controls reject
missing, mislabeled, pre-wrapper and eagerly evaluated reads, comment-only
instrumentation, deferred nested callbacks, and removed operations. An awaited
scheduler.run callback is the sole allowed nested callback boundary. Public
properties/accessors also require classification. Write methods are inspected:
Drizzle selects require measurement; Base queries skip only simple SQL beginning
with INSERT/UPDATE/DELETE (literal or a single local declaration). That syntax
check does not analyze subqueries, aliases, or arbitrary dynamic SQL. New query
shapes require extending this guard or a focused behavioral test. This guards the named feature seams;
it is not a whole-program SQL or data-flow analyser.
