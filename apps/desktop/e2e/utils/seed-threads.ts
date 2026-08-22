/**
 * Seed `mastra_threads` rows through the renderer's `electronAPI.db` bridge.
 *
 * WHY A DB SEED AND NOT THE PRODUCT PATH: a thread's folder binding
 * (`metadata.operatingRootId`) is written at its FIRST REQUEST, not at
 * creation — see `docs/agents/assistant-persistence.md` § THREAD GROUPS. So
 * the only product gesture that mints a BOUND thread is "New thread here" on a
 * folder header, and that header only exists once a bound thread already
 * groups the folder into a section. A pure product-path e2e would have to run
 * a real model turn to break that circle. Seeding the rows the first request
 * would have written keeps the whole panel under test (load → group → render)
 * while the turn itself stays out of scope.
 *
 * The bridge is the SAME database the renderer's assistant memory and the
 * `roots` table live in (the pattern `assistant-mock.ts` and
 * `assistant-approval-reload-linearity.desktop.test.ts` already rely on), so a
 * seeded `operatingRootId` resolves against a real reconciled root row.
 */
import type { Page } from '@playwright/test';

/** The panel's single memory resource — `WORKSPACE_MEMORY_RESOURCE_ID`. */
const WORKSPACE_MEMORY_RESOURCE_ID = 'brainstrike:workspace';

interface BridgeQueryResult {
  readonly rows?: readonly Record<string, unknown>[];
}

/**
 * A reconciled workspace root, read from the DB rather than assumed. The
 * durable `roots.id` is NOT the adapter root id a test seeds into main's
 * `rootsList` — W1 proved those two id spaces can diverge — and the panel
 * groups by the DURABLE one.
 */
export interface WorkspaceRootRow {
  readonly displayName: string;
  readonly id: string;
  readonly path: string | null;
}

/** One thread to seed. `folder: null` seeds an UNBOUND thread ("No folder"). */
export interface SeedThreadSpec {
  readonly folder: WorkspaceRootRow | null;
  readonly title: string;
}

/** Every reconciled root row, in id order. */
export async function readWorkspaceRootRows(page: Page): Promise<readonly WorkspaceRootRow[]> {
  return await page.evaluate(async () => {
    const api = (window as Window & { electronAPI?: unknown }).electronAPI;
    const query = (
      api as {
        db?: {
          query?: (sql: string, params?: readonly unknown[]) => Promise<BridgeQueryResult>;
        };
      }
    )?.db?.query;
    if (typeof query !== 'function') {
      throw new Error('Electron db.query bridge is not available');
    }
    const result = await query(
      'SELECT id, display_name AS "displayName", path FROM roots ORDER BY id ASC'
    );
    return (result.rows ?? []).map((row) => ({
      displayName: String(row['displayName']),
      id: String(row['id']),
      path: row['path'] === null || row['path'] === undefined ? null : String(row['path']),
    }));
  });
}

/**
 * Wait for renderer reconciliation to land THE one root row and return it.
 *
 * Exactly-one on purpose: every caller seeds ONE root into a fresh per-test
 * `userDataDir`, so a second row means a fixture leaked and every folder
 * assertion after it would be describing someone else's workspace. Reading the
 * row (rather than reusing the adapter root id seeded into main's `rootsList`)
 * is mandatory — the panel groups by the DURABLE `roots.id`, and W1 proved the
 * two id spaces can diverge.
 */
export async function waitForSingleWorkspaceRootRow(
  page: Page,
  timeoutMs = 30_000
): Promise<WorkspaceRootRow> {
  const deadline = Date.now() + timeoutMs;
  let lastSeen: readonly WorkspaceRootRow[] = [];
  for (;;) {
    lastSeen = await readWorkspaceRootRows(page);
    const [root] = lastSeen;
    if (lastSeen.length === 1 && root) {
      return root;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Expected exactly one reconciled workspace root within ${timeoutMs}ms, found ${lastSeen.length}: ${JSON.stringify(lastSeen)}`
      );
    }
    await page.waitForTimeout(250);
  }
}

/**
 * Wait until the Mastra memory schema exists.
 *
 * `to_regclass` ONLY — a bare `SELECT ... FROM mastra_threads` against a
 * missing relation raises 42P01, which aborts the surrounding transaction, so
 * "just try the insert and retry" is not a probe. The table is created by the
 * renderer's assistant memory initialization, which a caller triggers by
 * mounting the panel; this turns "has that happened yet" into a fact rather
 * than a sleep.
 */
export async function waitForMastraMemorySchema(page: Page, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const present = await page.evaluate(async () => {
      const api = (window as Window & { electronAPI?: unknown }).electronAPI;
      const query = (
        api as {
          db?: {
            query?: (sql: string, params?: readonly unknown[]) => Promise<BridgeQueryResult>;
          };
        }
      )?.db?.query;
      if (typeof query !== 'function') {
        throw new Error('Electron db.query bridge is not available');
      }
      const result = await query(`SELECT to_regclass('mastra_threads') AS relation`);
      const relation = (result.rows ?? [])[0]?.['relation'];
      return relation !== null && relation !== undefined;
    });
    if (present) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`mastra_threads did not exist within ${timeoutMs}ms`);
    }
    await page.waitForTimeout(250);
  }
}

/**
 * Insert one `mastra_threads` row per spec and return their ids in SPEC ORDER,
 * which is oldest first: the stamps start at `now - specs.length` seconds and
 * step forward one second per row, so `ids[0]` carries the EARLIEST
 * `createdAt`. The one-second spacing is what makes a recency sort
 * deterministic rather than tie-broken by id.
 *
 * Only the columns the memory schema requires are written — the same tuple
 * `seedCompactionSummaryThread` uses — so this helper cannot drift from the
 * shape Mastra actually persists.
 */
export async function seedThreadRows(
  page: Page,
  specs: readonly SeedThreadSpec[]
): Promise<readonly string[]> {
  return await page.evaluate(
    async ({
      resourceId,
      specs: threadSpecs,
    }: {
      readonly resourceId: string;
      readonly specs: readonly SeedThreadSpec[];
    }) => {
      const api = (window as Window & { electronAPI?: unknown }).electronAPI;
      const query = (
        api as {
          db?: {
            query?: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
          };
        }
      )?.db?.query;
      if (typeof query !== 'function') {
        throw new Error('Electron db.query bridge is not available');
      }
      const base = Date.now() - threadSpecs.length * 1000;
      const ids: string[] = [];
      for (const [index, spec] of threadSpecs.entries()) {
        const id = crypto.randomUUID();
        const stampedAt = new Date(base + index * 1000).toISOString();
        // The whole binding or none of it: `operatingRootPath` is omitted when
        // the root has none, exactly as `handleCreateThreadInFolder` does.
        const metadata = spec.folder
          ? {
              operatingRootDisplayName: spec.folder.displayName,
              operatingRootId: spec.folder.id,
              ...(spec.folder.path ? { operatingRootPath: spec.folder.path } : {}),
            }
          : {};
        await query(
          `INSERT INTO mastra_threads
             (id, "resourceId", title, metadata, "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4::jsonb, $5, $5)`,
          [id, resourceId, spec.title, JSON.stringify(metadata), stampedAt]
        );
        ids.push(id);
      }
      return ids;
    },
    { resourceId: WORKSPACE_MEMORY_RESOURCE_ID, specs }
  );
}
