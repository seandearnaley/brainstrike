# Clear Database / Factory Reset E2E Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add E2E coverage that proves Clear Database actually empties the database — including `mastra_workflow_snapshot` — and that factory reset survives a populated database, on the paths where those assertions can actually fail.

**Architecture:** Two new spec files assert database row counts before and after driving the real Clear All Collections button (desktop via the `db:query` IPC channel, web via an extended `WebE2ETestHooks`). Two existing factory-reset specs gain a seeded-database precondition that guards the error-surfacing strictness PR #1978 introduced. Every new assertion is control-tested by deliberately breaking production code and confirming the test goes red.

**Tech Stack:** Playwright, Electron (desktop), PGlite, pnpm workspaces.

Spec: `docs/superpowers/specs/2026-07-25-clear-database-reset-e2e-design.md`

> **Post-rebase note:** PR #1986 consolidated the clear helpers named throughout this
> plan into ONE PROBING HELPER PER SIDE — `clearLazilyCreatedRelation` was renamed
> `clearOptionalRelation` (desktop, `db-ipc.ts`), and `clearWorkflowSnapshotsIfPresent`
> and `clearMigratedRelation` were both replaced by a single `clearRelationIfPresent`
> (renderer, `db-provider.tsx`). This plan's task steps, code blocks, and commit-message
> templates describe the code and the control tests as they existed when the tasks below
> were executed — including several already-landed commits that use the old names — and
> are preserved verbatim for historical accuracy. Narrative summary sentences are annotated
> inline with the current names where the distinction matters for a reader relying on this
> plan today.

## Global Constraints

- TypeScript strict. Never `any` — prefer `unknown` + narrowing. Annotate params and return types.
- **NO SILENT FALLBACKS.** Seeding is unconditional; no probe-and-adapt, no `try/catch` that lets a test proceed on a state it did not establish.
- No early `return`s used as skips. Every precondition is an assertion. (`database-persistence.test.ts` is the anti-pattern being avoided, not copied.)
- Prefer role/text/data-testid selectors over raw CSS.
- Seed row ids MUST be bare `crypto.randomUUID()` values. **Correction:** an earlier draft of
  this plan claimed production `file_records.id` and `file_chunks.id` are `uuid` under the
  drizzle runner and that a prefixed string raises `22P02`. That is false — a later drizzle
  migration in `packages/db/src/drizzle/migrations.json` runs `ALTER TABLE "file_records"
  ALTER COLUMN "id" SET DATA TYPE text` (and the same for `file_chunks.id` and
  `file_chunks.file_record_id`), matching `packages/db/src/schema/index.ts:150`
  (`id: text('id').primaryKey()`). The original claim came from reading only the first
  `CREATE TABLE` in the migrations file and never checking for later `ALTER`s. Bare
  `crypto.randomUUID()` ids are still used here — not because the column type requires it,
  but because a UUID is a valid TEXT value and keeps seeded ids collision-free.
- `mastra_workflow_snapshot` columns: `workflow_name TEXT`, `run_id TEXT`, `"resourceId" TEXT`, `snapshot JSONB NOT NULL`, `"createdAt" TIMESTAMPTZ NOT NULL`, `"updatedAt" TIMESTAMPTZ NOT NULL`. No defaults — supply `NOW()` for both timestamps. Quote the camelCase identifiers.
- `db:query` permits `CREATE TABLE IF NOT EXISTS` but rejects `DROP`/`TRUNCATE`/`ALTER…DROP` (`DESTRUCTIVE_SCHEMA_SQL_PATTERN`, `apps/desktop/src/ipc-domains/db-ipc.ts:105`). It is single-statement.
- Run Playwright non-interactively. Never `--headed`, never `--ui`, never `--debug`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Control-Test Requirement

Every task that adds an assertion includes a **control step**: revert the relevant #1978 fix in a scratch edit, run the new test, confirm it FAILS with the expected message, then restore the file with `git checkout --`. This is the RED half of the cycle. A regression test that has never been observed failing is not evidence it guards anything — recorded as a standing lesson from the Series C build-mechanics work.

Never commit the broken production file. Every control step ends with `git checkout -- <file>` and a `git status --short` that shows the file clean.

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/desktop/e2e/utils/reset-seed-helpers.ts` (create) | Shared desktop seed/count helpers over `db:query`. One responsibility: establish and read the three-table probe state. |
| `apps/desktop/e2e/clear-database-rows.desktop.test.ts` (create) | Desktop Clear Database row-count spec. |
| `apps/desktop/e2e/factory-reset.desktop.test.ts` (modify) | Add seeded-database precondition to the confirm-path test. |
| `apps/web/src/web-e2e-test-hooks.tsx` (modify) | Add `seedResetProbeRows` / `readResetRowCounts` to the webdriver-gated hook surface. **Only production file touched.** |
| `apps/web/e2e/clear-database-rows.test.ts` (create) | Web Clear Database row-count spec. |
| `apps/web/e2e/factory-reset-recovery.test.ts` (modify) | Add seeded-database precondition to the confirm-path test. |
| `apps/web/package.json` (modify) | New `test:e2e:lane:clear-database`; chain it and the orphaned `destructive-reset` into `full-regression`. |

Desktop needs no lane change: `test:e2e:lane:full-regression` is `--project=regression --grep-invert="@desktop-embedding-"`, which already picks up any new regression-project spec.

---

### Task 1: Desktop seed/count helpers

**Files:**
- Create: `apps/desktop/e2e/utils/reset-seed-helpers.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ResetProbeCounts = { fileRecords: number; fileChunks: number; workflowSnapshots: number }`
  - `seedResetProbeRows(page: Page): Promise<void>`
  - `readResetProbeCounts(page: Page): Promise<ResetProbeCounts>`

Both are used by Tasks 2 and 4.

- [ ] **Step 1: Write the helper module**

Create `apps/desktop/e2e/utils/reset-seed-helpers.ts`:

```ts
import type { Page } from '@playwright/test';

/**
 * Row counts for the three relations a Clear Database / factory reset must empty.
 *
 * `workflowSnapshots` is the BST-558 invariant: `mastra_workflow_snapshot` is
 * created lazily by `PgliteWorkflowsStore.initialize()` and by NO migration, so
 * these helpers create it explicitly rather than assuming the assistant has run.
 */
export type ResetProbeCounts = {
  readonly fileChunks: number;
  readonly fileRecords: number;
  readonly workflowSnapshots: number;
};

type QueryResult = { rows?: ReadonlyArray<Record<string, unknown>> };

type DbQueryBridge = {
  readonly db?: {
    readonly query?: (sql: string, params?: readonly unknown[]) => Promise<QueryResult>;
  };
};

function readBridge(): NonNullable<NonNullable<DbQueryBridge['db']>['query']> {
  const api = (window as Window & { electronAPI?: DbQueryBridge }).electronAPI;
  const query = api?.db?.query;
  if (typeof query !== 'function') {
    throw new Error('Electron db.query bridge is not available');
  }
  return query;
}

/**
 * Establishes the probe state unconditionally: one `file_records` row, one
 * `file_chunks` child, and one `mastra_workflow_snapshot` row behind an
 * idempotent CREATE.
 *
 * Ids are bare UUIDs because production `file_records.id` / `file_chunks.id` are
 * `uuid` columns under the drizzle runner; a prefixed string raises 22P02.
 *
 * Deliberately NOT probe-and-adapt: a seed that silently accepts either schema
 * state cannot report which branch the test exercised.
 */
export async function seedResetProbeRows(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (window as Window & { electronAPI?: unknown }).electronAPI;
    const query = (
      api as { db?: { query?: (sql: string, params?: readonly unknown[]) => Promise<unknown> } }
    )?.db?.query;
    if (typeof query !== 'function') {
      throw new Error('Electron db.query bridge is not available');
    }

    const fileRecordId = crypto.randomUUID();
    const chunkId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    await query('INSERT INTO file_records (id, name, path, size) VALUES ($1, $2, $3, $4)', [
      fileRecordId,
      'reset-probe.txt',
      `reset-probe://${fileRecordId}`,
      42,
    ]);
    await query(
      'INSERT INTO file_chunks (id, file_record_id, chunk_index, content) VALUES ($1, $2, 0, $3)',
      [chunkId, fileRecordId, 'reset probe chunk']
    );

    // `db:query` permits CREATE TABLE (only DROP/TRUNCATE/ALTER..DROP are
    // rejected) and is single-statement, so the indexes from
    // MASTRA_WORKFLOW_SCHEMA_SQL are intentionally omitted — this test only
    // needs the relation to exist and hold a row.
    await query(
      `CREATE TABLE IF NOT EXISTS mastra_workflow_snapshot (
         workflow_name TEXT NOT NULL,
         run_id TEXT NOT NULL,
         "resourceId" TEXT,
         snapshot JSONB NOT NULL,
         "createdAt" TIMESTAMPTZ NOT NULL,
         "updatedAt" TIMESTAMPTZ NOT NULL,
         PRIMARY KEY (workflow_name, run_id)
       )`
    );
    await query(
      `INSERT INTO mastra_workflow_snapshot
         (workflow_name, run_id, "resourceId", snapshot, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())`,
      ['reset-probe-workflow', runId, 'reset-probe-resource', '{"status":"suspended"}']
    );
  });
}

/** Reads the three probe counts. Throws if the bridge or a relation is missing. */
export async function readResetProbeCounts(page: Page): Promise<ResetProbeCounts> {
  return await page.evaluate(async () => {
    const api = (window as Window & { electronAPI?: unknown }).electronAPI;
    const query = (
      api as {
        db?: {
          query?: (
            sql: string
          ) => Promise<{ rows?: ReadonlyArray<Record<string, unknown>> }>;
        };
      }
    )?.db?.query;
    if (typeof query !== 'function') {
      throw new Error('Electron db.query bridge is not available');
    }

    const countOf = async (table: string): Promise<number> => {
      const result = await query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      const value = result?.rows?.[0]?.count;
      if (typeof value !== 'number') {
        throw new Error(`Count for ${table} was not a number: ${JSON.stringify(value)}`);
      }
      return value;
    };

    return {
      fileChunks: await countOf('file_chunks'),
      fileRecords: await countOf('file_records'),
      workflowSnapshots: await countOf('mastra_workflow_snapshot'),
    };
  });
}
```

**Correction:** the code block above (`apps/desktop/e2e/utils/reset-seed-helpers.ts`) is
preserved verbatim as historical record of what was actually committed, including its
`Ids are bare UUIDs because production file_records.id / file_chunks.id are uuid columns
under the drizzle runner; a prefixed string raises 22P02` comment. That rationale is false
— see the Global Constraints correction above. `file_records.id` and `file_chunks.id` are
TEXT columns (`packages/db/src/schema/index.ts:150`); bare `crypto.randomUUID()` ids are
used because a UUID is a valid TEXT value and keeps seeded ids collision-free, not because
the column type requires it.

Note: `readBridge` above is declared for the Node-side type shape only and is not
referenced inside `page.evaluate` (evaluate bodies are serialized and cannot close
over module scope). If lint flags it as unused, delete `readBridge` and
`DbQueryBridge` — they are documentation, not behavior.

- [ ] **Step 2: Type-check the new file**

Run: `pnpm --filter @brainstrike/desktop exec tsc --noEmit -p tsconfig.e2e.json`
Expected: PASS, no errors mentioning `reset-seed-helpers.ts`.

- [ ] **Step 3: Lint**

Run: `pnpm dlx ultracite check apps/desktop/e2e/utils/reset-seed-helpers.ts`
Expected: PASS. If it reports unused `readBridge`/`DbQueryBridge`, delete both and re-run.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/utils/reset-seed-helpers.ts
git commit -m "test(desktop): add reset probe seed/count helpers

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Desktop Clear Database row-count spec

**Files:**
- Create: `apps/desktop/e2e/clear-database-rows.desktop.test.ts`
- Reference (do not modify): `apps/desktop/src/ipc-domains/db-ipc.ts:806`

**Interfaces:**
- Consumes: `seedResetProbeRows`, `readResetProbeCounts`, `ResetProbeCounts` from Task 1.
- Produces: nothing consumed by later tasks.

This is the spec that covers the exact PR #1978 bug site: `db:clearAll` →
`clearLazilyCreatedRelation(tx, MASTRA_WORKFLOW_TABLE)` (renamed `clearOptionalRelation`
by PR #1986; same call site, same `MASTRA_WORKFLOW_TABLE` argument).

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/e2e/clear-database-rows.desktop.test.ts`:

```ts
import { expect, test } from './fixtures/electron-fixture';
import { readResetProbeCounts, seedResetProbeRows } from './utils/reset-seed-helpers';
import { showDatabaseDemoPanel, waitForDatabaseReady } from './utils/layout-helpers';

/**
 * Guards PR #1978: a swallowed 42P01 inside `db.transaction(...)` left the
 * transaction aborted, the next statement raised 25P02, and the whole clear
 * rolled back behind a misleading message — while the unit tests stayed green
 * because they mock `tx.query` with `vi.fn()`.
 *
 * Asserts ROW COUNTS, never the success toast: the defect class is a FALSE
 * SUCCESS, so asserting the toast would reproduce the original blind spot.
 */
test.describe('Clear Database clears rows (desktop) @destructive @desktop-db-storage', () => {
  test.describe.configure({ mode: 'serial' });

  test('clears file records, chunks, and workflow snapshots', async ({ window }) => {
    const readyPage = await waitForDatabaseReady(window);
    const panelPage = await showDatabaseDemoPanel(readyPage);

    await seedResetProbeRows(panelPage);

    const before = await readResetProbeCounts(panelPage);
    expect(before.fileRecords).toBeGreaterThan(0);
    expect(before.fileChunks).toBeGreaterThan(0);
    expect(before.workflowSnapshots).toBeGreaterThan(0);

    // Expand Import Settings > Danger Zone, where Clear All Collections lives.
    // The settings content renders in a portal, so the button is queried from
    // the page root rather than from the panel scope.
    const panelScope = panelPage.locator('[data-testid="database-demo-panel"]');
    const clearButton = panelPage.getByRole('button', { name: 'Clear All Collections' });
    if (!(await clearButton.isVisible({ timeout: 500 }).catch(() => false))) {
      await panelScope
        .getByRole('button', { name: /import settings|settings/i })
        .first()
        .click();
    }
    await expect(clearButton).toBeVisible({ timeout: 10_000 });
    await expect(clearButton).toBeEnabled({ timeout: 10_000 });
    await clearButton.click();

    const confirmDialog = panelPage.getByRole('dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    await confirmDialog.getByRole('button', { name: /clear/i }).first().click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 15_000 });

    await expect
      .poll(() => readResetProbeCounts(panelPage), {
        message: 'expected Clear Database to empty every probed relation',
        timeout: 20_000,
      })
      .toEqual({ fileChunks: 0, fileRecords: 0, workflowSnapshots: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it PASSES against fixed code**

Run:
```bash
pnpm --filter @brainstrike/desktop exec playwright test e2e/clear-database-rows.desktop.test.ts --project=regression --workers=1 --retries=0
```
Expected: PASS. (The production fix already landed in #1978; this run only proves the harness works. Step 3 is the real check.)

If it fails on the seed, check the error message for the actual cause — `file_records.id`
and `file_chunks.id` are TEXT columns, not `uuid`, so a non-UUID id string does not raise
`22P02` here. (An earlier draft of this plan claimed otherwise; see the Global Constraints
correction above.)

- [ ] **Step 3: CONTROL — prove the test can fail**

(superseded by #1986: `clearLazilyCreatedRelation` was renamed `clearOptionalRelation`
after this control step was executed against the pre-rebase code below; the function name
in this step is preserved as historical record of what was actually run.)

Edit `apps/desktop/src/ipc-domains/db-ipc.ts`. Find `clearLazilyCreatedRelation` (~:333) and replace its `to_regclass` probe body with the pre-#1978 delete-and-catch form:

```ts
async function clearLazilyCreatedRelation(
  tx: { query: (sql: string) => Promise<unknown> },
  tableName: typeof MASTRA_WORKFLOW_TABLE
): Promise<void> {
  // CONTROL ONLY — DO NOT COMMIT
  try {
    await tx.query(`DELETE FROM ${tableName}`);
  } catch {
    // swallow, as the pre-#1978 code did
  }
}
```

Edit `apps/desktop/src/ipc-domains/db-ipc.ts`. In `clearLazilyCreatedRelation` (~:333),
change the probed name to a stale one, reproducing the permanent-silent-skip failure
the FACTORY RESET CONTRACT warns about (`to_regclass` on a stale name returns NULL
forever — no error, no warn, only a `logger.debug`):

```ts
  // CONTROL ONLY — DO NOT COMMIT
  const probe = (await tx.query(
    `SELECT to_regclass('${tableName}_STALE') IS NOT NULL AS present`
  )) as { rows?: Array<{ present?: boolean }> } | undefined;
```

Do NOT edit `reset-seed-helpers.ts` and do NOT delete the Playwright profile — the
seed must stay exactly as committed in Task 1, or the control proves nothing about
the committed test.

Run:
```bash
pnpm --filter @brainstrike/desktop exec playwright test e2e/clear-database-rows.desktop.test.ts --project=regression --workers=1 --retries=0
```
Expected: FAIL — `workflowSnapshots` stays at 1 and the `.poll` times out with
`expected Clear Database to empty every probed relation`.

Record the observed failure message in the report file.

- [ ] **Step 4: Restore production code and the seed**

```bash
git checkout -- apps/desktop/src/ipc-domains/db-ipc.ts apps/desktop/e2e/utils/reset-seed-helpers.ts
git status --short
```
Expected: neither file listed as modified.

- [ ] **Step 5: Re-run to confirm GREEN**

Run:
```bash
pnpm --filter @brainstrike/desktop exec playwright test e2e/clear-database-rows.desktop.test.ts --project=regression --workers=1 --retries=0
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/e2e/clear-database-rows.desktop.test.ts
git commit -m "test(desktop): assert Clear Database empties rows incl. workflow snapshots

Covers the db:clearAll path fixed in #1978. Asserts row counts rather than
the success toast, because the defect class is a false success.

Control-tested: reverting clearLazilyCreatedRelation to delete-and-catch
against a profile without mastra_workflow_snapshot turns this red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Web test-hook surface

**Files:**
- Modify: `apps/web/src/web-e2e-test-hooks.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces, on `WebE2ETestHooks`:
  - `readonly seedResetProbeRows: () => Promise<void>`
  - `readonly readResetRowCounts: () => Promise<WebE2EResetRowCounts>`
  - `export type WebE2EResetRowCounts = { readonly fileChunks: number; readonly fileRecords: number; readonly workflowSnapshots: number }`

Task 4 consumes both. This is the only production file the plan touches.

- [ ] **Step 1: Add the exported result type**

In `apps/web/src/web-e2e-test-hooks.tsx`, after the `WebE2EEmbeddingQualification` interface (~:52), add:

```ts
export interface WebE2EResetRowCounts {
  readonly fileChunks: number;
  readonly fileRecords: number;
  readonly workflowSnapshots: number;
}

interface CountRow {
  readonly count: number | string;
}
```

- [ ] **Step 2: Extend the hook interface**

In the `WebE2ETestHooks` interface (~:54-63), add two members, keeping the existing
alphabetical ordering of properties:

```ts
  readonly readResetRowCounts: () => Promise<WebE2EResetRowCounts>;
  readonly seedResetProbeRows: () => Promise<void>;
```

- [ ] **Step 3: Implement both members**

Inside the `hooks` object literal (~:89), add — again alphabetically, so
`readResetRowCounts` sits after `qualifyLocalEmbedding` and `seedResetProbeRows`
after `readModelEnabled`:

```ts
      readResetRowCounts: async (): Promise<WebE2EResetRowCounts> => {
        const countOf = async (table: string): Promise<number> => {
          const result = await db.query<CountRow>(`SELECT COUNT(*)::int AS count FROM ${table}`);
          const value = result.rows[0]?.count;
          const parsed = typeof value === 'number' ? value : Number(value);
          if (!Number.isFinite(parsed)) {
            throw new Error(`Count for ${table} was not numeric: ${String(value)}`);
          }
          return parsed;
        };

        return {
          fileChunks: await countOf('file_chunks'),
          fileRecords: await countOf('file_records'),
          workflowSnapshots: await countOf('mastra_workflow_snapshot'),
        };
      },
```

and

```ts
      seedResetProbeRows: async (): Promise<void> => {
        if (typeof db.transaction !== 'function') {
          throw new Error('Web E2E database handle does not expose transactions');
        }
        const fileRecordId = crypto.randomUUID();
        const chunkId = crypto.randomUUID();
        const runId = crypto.randomUUID();

        // `mastra_workflow_snapshot` is created lazily by
        // `PgliteWorkflowsStore.initialize()` and by NO migration, so on a fresh
        // web profile it is absent. Create it explicitly rather than assuming
        // the assistant has run — a probe-and-skip seed could not report which
        // branch the test exercised.
        await db.exec(`
          CREATE TABLE IF NOT EXISTS mastra_workflow_snapshot (
            workflow_name TEXT NOT NULL,
            run_id TEXT NOT NULL,
            "resourceId" TEXT,
            snapshot JSONB NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (workflow_name, run_id)
          );
        `);

        await db.transaction(async (tx) => {
          await tx.query(
            'INSERT INTO file_records (id, name, path, size) VALUES ($1, $2, $3, $4)',
            [fileRecordId, 'reset-probe.txt', `reset-probe://${fileRecordId}`, 42]
          );
          await tx.query(
            'INSERT INTO file_chunks (id, file_record_id, chunk_index, content) VALUES ($1, $2, 0, $3)',
            [chunkId, fileRecordId, 'reset probe chunk']
          );
          await tx.query(
            `INSERT INTO mastra_workflow_snapshot
               (workflow_name, run_id, "resourceId", snapshot, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())`,
            ['reset-probe-workflow', runId, 'reset-probe-resource', '{"status":"suspended"}']
          );
        });
      },
```

If `db.exec` is not on the handle type, use `db.query` for the `CREATE TABLE` and
drop the trailing semicolon — `query` is single-statement.

- [ ] **Step 4: Type-check**

Run: `pnpm --filter @brainstrike/web run type-check`
Expected: PASS.

- [ ] **Step 5: Lint**

Run: `pnpm dlx ultracite check apps/web/src/web-e2e-test-hooks.tsx`
Expected: PASS. Biome requires alphabetically sorted object properties — fix ordering if flagged.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/web-e2e-test-hooks.tsx
git commit -m "test(web): expose reset probe seed/count on the E2E test hooks

Web E2E has no SQL seam; the webdriver-gated WebE2ETestHooks is the only
handle on the live PGlite instance.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Web Clear Database spec and lane wiring

**Files:**
- Create: `apps/web/e2e/clear-database-rows.test.ts`
- Modify: `apps/web/package.json` (scripts)

**Interfaces:**
- Consumes: `seedResetProbeRows`, `readResetRowCounts` from Task 3.
- Produces: nothing consumed by later tasks.

Covers `clearViaPGlite` → `clearWorkflowSnapshotsIfPresent` (now `clearRelationIfPresent`),
a distinct implementation from desktop's `clearLazilyCreatedRelation` (now
`clearOptionalRelation`) and the only one the web build runs.

- [ ] **Step 1: Write the spec**

Create `apps/web/e2e/clear-database-rows.test.ts`:

```ts
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import { waitForAppLoad } from './utils/layout-helpers';

type ResetRowCounts = {
  readonly fileChunks: number;
  readonly fileRecords: number;
  readonly workflowSnapshots: number;
};

async function seedProbeRows(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E test hooks are not installed');
    }
    await hooks.seedResetProbeRows();
  });
}

async function readProbeCounts(page: Page): Promise<ResetRowCounts> {
  return await page.evaluate(async () => {
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E test hooks are not installed');
    }
    return await hooks.readResetRowCounts();
  });
}

/**
 * Asserts ROW COUNTS, never the success toast: the defect class PR #1978 fixed
 * is a FALSE SUCCESS, so a toast assertion would reproduce the blind spot.
 */
test.describe('Clear Database clears rows (web) @destructive @web-clear-database', () => {
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
    await waitForAppLoad(page);
  });

  test('clears file records, chunks, and workflow snapshots', async ({ page }) => {
    const home = new HomePage(page);
    await home.goto();
    await waitForAppLoad(page);

    await seedProbeRows(page);

    const before = await readProbeCounts(page);
    expect(before.fileRecords).toBeGreaterThan(0);
    expect(before.fileChunks).toBeGreaterThan(0);
    expect(before.workflowSnapshots).toBeGreaterThan(0);

    const clearButton = page.getByRole('button', { name: 'Clear All Collections' });
    if (!(await clearButton.isVisible({ timeout: 500 }).catch(() => false))) {
      await page
        .getByRole('button', { name: /import settings|settings/i })
        .first()
        .click();
    }
    await expect(clearButton).toBeVisible({ timeout: 10_000 });
    await expect(clearButton).toBeEnabled({ timeout: 10_000 });
    await clearButton.click();

    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    await confirmDialog.getByRole('button', { name: /clear/i }).first().click();
    await expect(confirmDialog).not.toBeVisible({ timeout: 15_000 });

    await expect
      .poll(() => readProbeCounts(page), {
        message: 'expected Clear Database to empty every probed relation',
        timeout: 20_000,
      })
      .toEqual({ fileChunks: 0, fileRecords: 0, workflowSnapshots: 0 });
  });
});
```

If the Database panel is not open by default in the web shell, navigate to it via
`HomePage` before querying the button — mirror whatever
`apps/web/e2e/database-import-backfill.test.ts` does to reach that panel, and add
the navigation as an assertion, not a conditional.

- [ ] **Step 2: Add the lane script and wire it into full-regression**

In `apps/web/package.json` scripts, add:

```json
"test:e2e:lane:clear-database": "unset NO_COLOR; pnpm exec playwright test e2e/clear-database-rows.test.ts --project=functional --workers=1 --retries=0 --max-failures=1 --global-timeout=600000 --grep \"@web-clear-database\"",
```

Then extend `test:e2e:lane:full-regression` by appending two lanes to its `&&`
chain — the new one, and `destructive-reset`, which is currently orphaned
(`full-regression` excludes `@destructive` from its broad pass and never chains it
back, so `factory-reset-recovery.test.ts` runs nowhere in CI):

```
... && pnpm run test:e2e:lane:collection-browser-state && pnpm run test:e2e:lane:destructive-reset && pnpm run test:e2e:lane:clear-database
```

- [ ] **Step 3: Verify the lane selects exactly the new test**

Run:
```bash
pnpm --filter @brainstrike/web exec playwright test e2e/clear-database-rows.test.ts --project=functional --grep "@web-clear-database" --list
```
Expected: exactly one test listed. Zero listed means the tag is wrong — fix before proceeding, since a lane that selects nothing exits 0 and reads as green.

- [ ] **Step 4: Run the spec**

Run: `pnpm --filter @brainstrike/web run test:e2e:lane:clear-database`
Expected: PASS.

- [ ] **Step 5: CONTROL — prove the test can fail**

(superseded by #1986: `clearWorkflowSnapshotsIfPresent` and `clearMigratedRelation` were
both replaced by a single `clearRelationIfPresent` after this control step was executed
against the pre-rebase code below; the function name in this step is preserved as
historical record of what was actually run.)

Edit `packages/db/src/db-provider.tsx`. In `clearWorkflowSnapshotsIfPresent` (~:216),
change the table constant to a stale name to simulate the permanent-silent-skip
failure the contract warns about:

```ts
  const table = 'mastra_workflow_snapshot_STALE';
```

Run: `pnpm --filter @brainstrike/web run test:e2e:lane:clear-database`
Expected: FAIL — `workflowSnapshots` stays at 1, and the `.poll` reports
`expected Clear Database to empty every probed relation`.

- [ ] **Step 6: Restore**

```bash
git checkout -- packages/db/src/db-provider.tsx
git status --short
```
Expected: `db-provider.tsx` not listed.

- [ ] **Step 7: Re-run to confirm GREEN, then commit**

```bash
pnpm --filter @brainstrike/web run test:e2e:lane:clear-database
git add apps/web/e2e/clear-database-rows.test.ts apps/web/package.json
git commit -m "test(web): assert Clear Database empties rows; wire destructive lanes into CI

full-regression excluded @destructive from its broad pass and never chained
the destructive lane back, so factory-reset-recovery.test.ts ran nowhere in
CI. Chain it alongside the new clear-database lane.

Control-tested: a stale table name in clearWorkflowSnapshotsIfPresent turns
this red.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Factory-reset strictness guard (desktop)

**Files:**
- Modify: `apps/desktop/e2e/factory-reset.desktop.test.ts`

**Interfaces:**
- Consumes: `seedResetProbeRows` from Task 1.
- Produces: nothing.

Guards the strictness #1978 introduced, since hardened by #1986 into a
probe-before-delete design: `clearMigratedRelation` (now `clearRelationIfPresent`) no
longer catches-and-rethrows at all — it probes each relation with `to_regclass` first
and leaves the DELETE unwrapped — so a populated database that trips a genuine failure
can newly turn a working reset into a hard failure.

- [ ] **Step 1: Import the seed helper**

Add to the imports at the top of `apps/desktop/e2e/factory-reset.desktop.test.ts`:

```ts
import { seedResetProbeRows } from './utils/reset-seed-helpers';
```

- [ ] **Step 2: Seed before the reset**

In the `confirm path clears persisted state and reloads cleanly` test, immediately
after the existing `await seedBrowserPersistentState(window);` line (~:204), add:

```ts
    // Populate the database before resetting. PR #1978 made previously-swallowed
    // purge errors visible, so a realistically-populated database is the case
    // that can newly turn a working reset into a hard failure.
    //
    // Post-reset ROW COUNTS are deliberately NOT asserted here: desktop factory
    // reset routes through db:resetLocal -> resetDesktopApplicationData, which
    // wipes the database and userData wholesale. A count taken afterwards reads
    // zero whether or not the purge did anything, so the assertion could not
    // fail for the reason it appears to guard. That case is covered at the
    // handler layer by
    // apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts.
    await seedResetProbeRows(window);
```

- [ ] **Step 3: Run the ipc-reset lane**

Run: `pnpm --filter @brainstrike/desktop run test:e2e:lane:ipc-reset`
Expected: PASS, both factory-reset tests included.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/e2e/factory-reset.desktop.test.ts
git commit -m "test(desktop): seed the database before factory reset

Guards the error-surfacing strictness #1978 introduced. Records why post-reset
row counts are deliberately omitted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Factory-reset strictness guard (web)

**Files:**
- Modify: `apps/web/e2e/factory-reset-recovery.test.ts`

**Interfaces:**
- Consumes: `seedResetProbeRows` hook member from Task 3.
- Produces: nothing.

On web, factory reset is the `purgeTablesTx` path — the one that could report success
having cleared nothing. `purgeAndCloseDirectDb` rethrows on purge failure, so a
populated database that trips a genuine error now aborts the reset visibly.

- [ ] **Step 1: Add a seed helper local to the spec**

After the `TOKEN_PREFERENCES_STORAGE_KEY` constant (~:8), add:

```ts
async function seedProbeRows(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const hooks = window.__brainstrikeWebE2ETestHooks__;
    if (!hooks) {
      throw new Error('Web E2E test hooks are not installed');
    }
    await hooks.seedResetProbeRows();
  });
}
```

- [ ] **Step 2: Seed before the reset**

In the `confirm path clears persisted state and reloads cleanly` test, immediately
before `await settings.openCategory(/Factory Reset/i, 'factory-reset');` (~:80), add:

(superseded by #1986: the committed comment was later corrected — see
`apps/web/e2e/factory-reset-recovery.test.ts:90-99` — because `clearMigratedRelation`
was replaced by `clearRelationIfPresent`, which probes with `to_regclass` before
deleting and never wraps the DELETE in a try/catch, rather than catching-and-rethrowing.
The block below is preserved as originally written for historical accuracy.)

```ts
    // Populate the database before resetting. This is the purgeTablesTx path —
    // the one that could report a SUCCESSFUL reset having cleared nothing.
    //
    // Post-reset ROW COUNTS are deliberately NOT asserted: resetPGliteState
    // deletes the whole IndexedDB database after purging (db-provider.tsx:985),
    // so a count afterwards reads zero regardless of what the purge did. The
    // false-success case is only observable INSIDE the transaction, which is
    // where packages/db/__tests__/clear-data.integration.test.tsx observes it.
    // What this seed does guard: that a realistically-populated database still
    // completes a reset, now that clearMigratedRelation rethrows.
    await seedProbeRows(page);
```

- [ ] **Step 3: Run the destructive-reset lane**

Run: `pnpm --filter @brainstrike/web run test:e2e:lane:destructive-reset`
Expected: PASS, both tests included.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/factory-reset-recovery.test.ts
git commit -m "test(web): seed the database before factory reset

Exercises purgeTablesTx against a populated database. Records why post-reset
row counts are deliberately omitted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Full gate and PR

**Files:** none modified.

- [ ] **Step 1: Confirm no production file is accidentally modified**

Run: `git diff origin/main --stat`
Expected: exactly seven paths — the two new desktop files, the two new/modified web
e2e specs, `apps/web/src/web-e2e-test-hooks.tsx`, `apps/web/package.json`,
`apps/desktop/e2e/factory-reset.desktop.test.ts`, plus the spec and plan docs.
`db-ipc.ts` and `db-provider.tsx` MUST NOT appear — if either does, a control edit
was never reverted.

- [ ] **Step 2: Full gate in one run**

Run: `pnpm build && pnpm lint && pnpm type-check && pnpm test`
Expected: all green in the same run.

If `type-check` reports `TS2306 … is not a module` in an untouched consumer
(usually utils → app-shell), that is the known cold-parallel turbo flake. Confirm
the diff does not touch it and a direct `tsc --noEmit` passes, then re-run.

- [ ] **Step 3: Run every affected E2E lane**

```bash
pnpm --filter @brainstrike/desktop exec playwright test e2e/clear-database-rows.desktop.test.ts --project=regression --workers=1 --retries=0
pnpm --filter @brainstrike/desktop run test:e2e:lane:ipc-reset
pnpm --filter @brainstrike/web run test:e2e:lane:clear-database
pnpm --filter @brainstrike/web run test:e2e:lane:destructive-reset
```
Expected: all PASS.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin test/clear-reset-row-count-e2e
```

PR body must state: the four corrected premises from the spec; that post-reset row
counts are deliberately omitted and why; that `full-regression` was silently
skipping `factory-reset-recovery.test.ts`; and the two follow-ups below.

- [ ] **Step 5: File the follow-ups**

Do not fix these in-band. Record them in the PR description:

1. `docs/agents/platform-contracts.md:120-128` claims both production sites import
   `MASTRA_WORKFLOW_TABLE`. At the time this plan was written, `db-provider.tsx:166-212`
   deliberately used a local literal pinned by
   `scripts/__tests__/mastra-workflow-table-literal-contract.test.mjs`, because importing
   the contract there reordered bundle chunk init. The rule held; the doc's description of
   its enforcement was stale. **Resolved upstream by PR #1988**, which added a lazy
   in-function read of `MASTRA_WORKFLOW_TABLE` (not a module-scope import) — both
   `db-provider.tsx` and `db-ipc.ts` now import the constant, matching the doc, enforced by
   `scripts/verify-mastra-schema-init-order.mjs`. No longer a live follow-up.
2. **Raised and disproved — not a follow-up.** An earlier draft of this plan claimed
   `apps/web/src/web-e2e-test-hooks.tsx`'s `qualifyDatabaseExtensions` (ids shaped
   `csp-file-${crypto.randomUUID()}`) had a latent `22P02` bug because
   `file_records.id` is a `uuid` column under the drizzle runner. That premise is false —
   `file_records.id` is TEXT (see the Global Constraints correction above) — and a prefixed
   string is a perfectly valid TEXT value, so there is no bug here. Recorded rather than
   silently dropped, per this branch's value being its record of corrected premises.

---

## Self-Review

**Spec coverage.** Component 1 → Tasks 1–2. Component 2 → Tasks 3–4. Component 3 →
Tasks 5–6. Component 4 → Task 4 Step 2 (web) and the File Structure note (desktop
needs no change). The spec's "Open decision" on seed breadth is resolved as the
three-table minimum, applied consistently in Tasks 1 and 3.

**Placeholder scan.** No TBD/TODO. Every code step carries complete code. Two steps
carry conditional guidance (Task 1 Step 3 on unused types, Task 4 Step 1 on panel
navigation) — both name the exact decision and its trigger rather than deferring it.

**Type consistency.** Desktop helpers return `ResetProbeCounts`; web hooks return
`WebE2EResetRowCounts`. Both have identical fields (`fileChunks`, `fileRecords`,
`workflowSnapshots`) and both are compared against
`{ fileChunks: 0, fileRecords: 0, workflowSnapshots: 0 }`. Desktop exports
`seedResetProbeRows`/`readResetProbeCounts`; the web hook members are
`seedResetProbeRows`/`readResetRowCounts` — the read names deliberately differ
because they are different surfaces, and each task references only its own.
