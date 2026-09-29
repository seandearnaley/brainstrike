# Probe, never delete-and-catch — evidence

Supports `docs/agents/platform-contracts.md` § "FACTORY RESET CONTRACT".
Read before adding a clear helper, tolerating a missing relation, or catching inside a purge transaction. The contract holds the rules; this file is the record behind them.

Everything below is extracted verbatim from the contract as it stood before
distillation (2026-09-21). Corrections verified against the code today are
marked inline as **CORRECTION (2026-09-21)**; nothing else is rewritten.

---
**A relation that can legitimately be ABSENT must be PROBED, not
deleted-and-caught.** Each table-enumerating path runs its whole body inside ONE
transaction, and PGlite is real Postgres: a statement error puts the transaction
into the ABORTED state, after which every command fails with `25P02 current
transaction is aborted, commands ignored until end of transaction block` until
ROLLBACK. Catching the original `42P01` does NOT undo that, and there are no
savepoints anywhere in this repo — so a tolerated missing-relation error rolls
the ENTIRE reset back and the user's Clear Database silently does nothing. Use
`SELECT to_regclass('<table>') IS NOT NULL AS present`, which returns NULL
instead of raising, and skip the `DELETE` when absent (BST-558 review).

There is now exactly ONE clear helper per side and both probe: desktop
`clearOptionalRelation` (`apps/desktop/src/ipc-domains/db-ipc.ts`) and renderer
`clearRelationIfPresent` (`packages/db/src/pglite-direct-transport.ts`, used by
BOTH the transport's `clearAllData` — the old `clearViaPGlite` — and
`purgeTablesTx`). Every call site is therefore safe by
construction rather than by the coincidence that its table happens to be created
by an already-run numbered migration. Do not reintroduce a delete-and-tolerate
variant alongside them.

A probed relation's `DELETE` is deliberately NOT wrapped in a catch: nothing in
this repo ever DROPs these relations, so the probe/delete race is unreachable,
and a tolerated `42P01` there could not recover anyway — it would leave the
transaction aborted and resurface as a misleading `25P02`.

Probing trades one hazard for another, and the TYPE SYSTEM is what closes the
new one. With delete-and-catch a misspelled table raises a loud `42P01`; with
`to_regclass` it returns NULL, indistinguishable from absence, so it becomes a
PERMANENT SILENT SKIP with every test still green. Both helpers therefore take a
closed literal union (`OptionalRelationTable` / `ClearableRelation`), never a
`string` parameter. Keep it that way.

**No catch anywhere in a purge tolerates a missing relation — the probe does.**
A bare `catch (err) { logger.warn(...) }` could never be a tolerance inside a
transaction: the first genuine error aborts it, every later statement fails
`25P02`, each of THOSE is swallowed too, the purge returns normally, and `COMMIT`
on an aborted transaction degrades to `ROLLBACK` WITHOUT raising — factory reset
reports SUCCESS having cleared nothing. This was measured, not reasoned: against
real PGlite, an FK violation on `job_queue` with the old bare-catch tail made
`useFactoryReset()` resolve while every table still held its rows, and an FK
violation on `roots` in `clearViaPGlite` produced three consecutive
"(table may not exist)" warnings before surfacing as a misleading `25P02`.

Narrowing such a catch was only ever a half-measure — it makes the first real
failure visible as itself, but still cannot let the clear CONTINUE past an
absent relation, because the tolerated `42P01` has already aborted the
transaction. Probing is the only form that actually tolerates absence, so the
narrowed-catch helpers (`clearMigratedRelation`, `isMissingNamedRelationError`,
`isMissingOptionalRelationError`, and the per-table `*IfPresent` variants) are
GONE, collapsed into the two probe helpers above. Do not reintroduce a
message-parsing matcher: asking the catalog is both simpler and correct.

Historical debt now CLOSED (BST-558 follow-up), recorded so it is not
re-litigated: the ~14 desktop `clearOptionalRelation` call sites and the
selection-snapshot block in `db-ipc.ts` both delete-and-tolerated. On the desktop
side the defect was latent rather than live — every one of those tables is
created by a numbered migration that has already run by the time a clear starts —
but it was a loaded gun, and the selection-snapshot block additionally only
*logged* non-missing-relation errors without rethrowing. Both are converted.

Add tests when changing reset behavior — and note that a mocked `tx.query`
CANNOT reproduce aborted-transaction semantics. Reset changes that depend on
them need a real-PGlite `*.integration.test.*`
(`packages/db/__tests__/clear-data.integration.test.tsx`,
`apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts`).
