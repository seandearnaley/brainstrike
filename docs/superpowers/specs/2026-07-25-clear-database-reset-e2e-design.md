# Clear Database / Factory Reset E2E Coverage — Design

Date: 2026-07-25
Status: approved, pending implementation plan
Related: PR #1978 (BST-558 follow-up), `docs/agents/platform-contracts.md` (FACTORY RESET CONTRACT)

> **Post-rebase note:** PR #1986 consolidated the clear helpers named throughout this
> document into ONE PROBING HELPER PER SIDE — `clearLazilyCreatedRelation` was renamed
> `clearOptionalRelation` (desktop, `db-ipc.ts`), and `clearWorkflowSnapshotsIfPresent`
> and `clearMigratedRelation` were both replaced by a single `clearRelationIfPresent`
> (renderer, `db-provider.tsx`). References to the old names below describe the code as
> it existed when this spec was written and are preserved for historical accuracy
> rather than silently renamed; the current names are noted inline where it matters.

## Problem

PR #1978 fixed two defects in the database clear/reset paths:

1. **Clear Database failed outright.** A swallowed `42P01` inside `db.transaction(...)`
   left the transaction aborted, so the next statement raised `25P02` and the whole
   clear rolled back behind a misleading "current transaction is aborted" message.
2. **`purgeTablesTx` could report a SUCCESSFUL factory reset having cleared nothing.**
   Its tail swallowed every error, and `COMMIT` on an aborted transaction degrades to
   `ROLLBACK` without raising.

Both passed every CI check, because the unit tests mock `tx.query` with `vi.fn()` and a
mock has no Postgres transaction semantics. Both are now covered by real-PGlite
integration tests at the handler layer. Nothing drives the UI path.

## Verified premises

The brief that prompted this work carried four claims that do not survive a read of the
code. They are recorded here because two of them change the deliverable.

### 1. Existing E2E coverage is thin, not absent

`grep -rEil 'clear.?database|clearAll|factory.?reset|purgeTables' apps/*/e2e` returns
matches:

- `apps/desktop/e2e/factory-reset.desktop.test.ts` — asserts browser storage, filesystem
  sentinels, token preferences. No database rows.
- `apps/web/e2e/factory-reset-recovery.test.ts` — asserts localStorage token preferences.
  No database rows.
- `apps/desktop/e2e/database-persistence.test.ts:591` — drives the real Clear All
  Collections button and asserts `tbody tr` count is 0, but is built out of early returns
  (`if (!dataCreated) return`, `if (recordCountBefore === 0) return`) so it silently
  no-ops instead of failing.

**Accurate gap:** no E2E asserts database row counts across a clear, and nothing anywhere
touches `mastra_workflow_snapshot`.

### 2. `purgeTablesTx` is the WEB factory-reset path only

`FactoryResetPanel` (`packages/preferences/src/settings/system/factory-reset-panel.tsx`)
prefers `getDesktopResetBridge()` — `window.electronAPI.db.resetLocal` — and only falls
back to `useFactoryReset()` when that bridge is absent. `factoryReset` in
`packages/db/src/db-provider.tsx:1103` makes the same choice internally, trying
`tryElectronHardReset()` before `resetPGliteState()` (which runs `purgeTablesTx`).

On desktop the bridge exists: `apps/desktop/src/preload.ts:583` exposes `db:resetLocal`,
whose handler is `createDesktopFactoryResetHandler` (`apps/desktop/src/main.ts:1028`,
`desktop-reset-platform.ts:69`) → `resetDesktopApplicationData`
(`apps/desktop/src/desktop-factory-reset.ts:146`), which wipes the database and userData
rather than deleting rows.

The two bugs #1978 fixed therefore live on different platforms:

| | Desktop | Web |
| --- | --- | --- |
| **Clear Database** | `db:clearAll` → `clearLazilyCreatedRelation` (superseded by #1986: renamed `clearOptionalRelation`) — **the 42P01/25P02 bug** | `clearViaPGlite` → `clearWorkflowSnapshotsIfPresent` (superseded by #1986: renamed `clearRelationIfPresent`) |
| **Factory Reset** | `db:resetLocal` → database + userData wipe | `purgeTablesTx` → **the false-success bug** |

`purgeTablesTx` never executes on desktop.

### 3. Post-reset row counts are unfalsifiable on BOTH platforms

Both factory-reset paths destroy the database container immediately after purging:

- Desktop: `resetDesktopApplicationData` wipes the database and userData.
- Web: `wasmLoader.deleteIndexedDB(resolvedPath)` at `db-provider.tsx:985`.

A row count taken after either reset reads zero **whether or not the purge did anything**.
Writing that assertion produces a test that passes for the wrong reason and cannot fail
for the reason we care about — the same class of blind spot as asserting the success
toast. The `purgeTablesTx` false-success is genuinely only observable inside the
transaction, which is where `packages/db/__tests__/clear-data.integration.test.tsx`
already observes it.

### 4. `mastra_workflow_snapshot` is not created by `MASTRA_MEMORY_SCHEMA_SQL`

`MASTRA_MEMORY_SCHEMA_SQL` (`packages/assistant-contract/src/mastra-memory-schema.ts:32`)
ends after `mastra_observational_memory`. The snapshot table comes from a separate export,
`MASTRA_WORKFLOW_SCHEMA_SQL` (line 113), exec'd from exactly one place:
`PgliteWorkflowsStore.initialize()` (`packages/agent/src/pglite-mastra-memory/workflows-store.ts:282`),
reached eagerly by `createPgliteMastraMemory` (`memory-factory.ts:137`).

"Relation absent" is therefore reachable on **both** platforms, gated on whether the Mastra
memory factory has run — not on desktop-vs-web. A manual CDP session finding the table
present means memory had already initialized, not that a migration creates it.

`DESTRUCTIVE_SCHEMA_SQL_PATTERN` (`apps/desktop/src/ipc-domains/db-ipc.ts:105`) matches only
`DROP`/`TRUNCATE`/`ALTER…DROP`, so `CREATE TABLE IF NOT EXISTS` **is** permitted through
`db:query`. A test can deterministically establish the present-relation state. It cannot
establish the absent state (no `DROP`), which keeps that case with the integration tests.

## Design

### Component 1 — Desktop clear-database row counts

New file `apps/desktop/e2e/clear-database-rows.desktop.test.ts`.

Seed through `db:query` (already used freely across the desktop suite for INSERT/DELETE):

- one `file_records` row,
- one `file_chunks` child,
- an idempotent `CREATE TABLE IF NOT EXISTS mastra_workflow_snapshot (…)` followed by one
  snapshot row.

Assert all three counts are non-zero, drive the real **Clear All Collections** button
through the Database panel's Import Settings, then re-count and assert `0/0/0`.

Seeding is unconditional rather than probe-and-adapt: a test that silently accepts either
schema state cannot report which branch it exercised, and the project rule is no silent
fallbacks. No toast assertion. No early returns — every precondition that
`database-persistence.test.ts` currently `return`s on becomes an assertion.

Tag `@desktop-db-storage`. `test:e2e:lane:db-storage` (`apps/desktop/package.json`) passes
an explicit file-argument list (`database-persistence.test.ts`) and merely narrows it with
`--grep`; the tag alone does not add a spec to the lane. The new file must also be added to
that lane's file-argument list, matching how the other desktop lanes compose.

### Component 2 — Web clear-database row counts

Web E2E has no SQL seam. The only DB access is `apps/web/src/web-e2e-test-hooks.tsx`, a
`navigator.webdriver`-gated component holding the live PGlite handle.

Extend `WebE2ETestHooks` with two members following the existing shape:

- `seedResetProbeRows(): Promise<void>`
- `readResetRowCounts(): Promise<{ fileRecords: number; fileChunks: number; workflowSnapshots: number }>`

New file `apps/web/e2e/clear-database-rows.test.ts` drives the same Clear All Collections
button. This covers `clearViaPGlite` → `clearWorkflowSnapshotsIfPresent` (now
`clearRelationIfPresent`), a distinct implementation from desktop's
`clearLazilyCreatedRelation` (now `clearOptionalRelation`) and the only one the web build
ever runs.

New tag plus a lane script mirroring `test:e2e:lane:destructive-reset` in
`apps/web/package.json`.

This is the only production-code change in the work.

### Component 3 — Factory reset strictness guard, both platforms

Extend the confirm-path test in each existing factory-reset spec rather than adding files.

Seed the same three-table set *before* resetting, then assert the reset **completes** and
the app reboots clean. This guards the strictness #1978 introduced, since hardened by #1986
into a probe-before-delete design: `clearMigratedRelation` (now `clearRelationIfPresent`)
no longer catches-and-rethrows at all — it probes each relation with `to_regclass` first
and leaves the DELETE unwrapped, so a genuine failure surfaces directly — and
`purgeAndCloseDirectDb` still rethrows on purge failure, so a genuinely populated database
can newly turn a working reset into a hard failure.

An in-test comment records why post-reset row counts are deliberately omitted (see verified
premise 3), so the omission is not later "fixed" into an unfalsifiable assertion.

### Component 4 — Lane placement

All regression, no merge-gate smoke.

Both `Web E2E` and `Desktop E2E` are required checks in `.github/workflows/test.yml`
(:549 and :637) running `test:e2e:lane:smoke`. The desktop smoke lane is an explicit
seven-file list under `--max-failures=1` and a 300s total budget. A destructive test that
clears the database and restarts the app does not belong in that budget.

## Out of scope

- **Absent-relation end-to-end.** No renderer seam can drop the table (`db:query` blocks
  `DROP`). Stays with `clear-data.integration.test.tsx`.
- **`docs/agents/platform-contracts.md:120-128`.** At the time this spec was written, the
  doc's claim that "both production sites and every test import the constant" was stale:
  `db-provider.tsx:166-212` then deliberately used a local literal instead of importing
  `MASTRA_WORKFLOW_TABLE`, pinned by
  `scripts/__tests__/mastra-workflow-table-literal-contract.test.mjs`, because importing the
  contract there reordered bundle chunk init and killed the renderer. **Resolved upstream by
  PR #1988**, which introduced a lazy in-function read of `MASTRA_WORKFLOW_TABLE` instead of a
  module-scope import — `db-provider.tsx` and `db-ipc.ts` now both import the constant,
  matching the doc's description, and `scripts/verify-mastra-schema-init-order.mjs` enforces
  the lazy-read constraint repo-wide. No longer a live follow-up.

## Open decision

The seed set in Component 1 is a trade-off to be made during implementation. Three tables
is the minimum that discriminates. A wider set (`job_queue`, `roots`,
`brainstrike_diagnostic_events`) catches more regressions but couples the test to the clear
list, so it fails on every deliberate change to that list.

## Testing

The tests are the deliverable. Verification is the full gate — clean build, lint, type
check, and unit tests green in the same run — plus the two regression lanes these specs
join, run locally before the PR opens.
