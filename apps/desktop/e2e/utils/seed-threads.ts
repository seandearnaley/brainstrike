/** Current desktop conversations are created through the public host protocol.
 * Retired PGlite rows are seeded only by explicit exclusion tests. */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { withAppHost } from './agent-host-log';

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
export async function seedRetiredThreadRows(
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

/** Seed current conversations through the same owner that lists and opens them. */
export async function seedHostThreads(
  userDataDir: string,
  specs: readonly SeedThreadSpec[]
): Promise<readonly string[]> {
  return await withAppHost(userDataDir, async (host) => {
    const ids: string[] = [];
    for (const spec of specs) {
      const { threadId } = await host.request('thread/start', { commandId: randomUUID() });
      await host.request('thread/update', { commandId: randomUUID(), threadId, title: spec.title });
      if (spec.folder) {
        await host.request('thread/workspace/binding/update', {
          commandId: randomUUID(),
          patch: {
            operatingRootDisplayName: spec.folder.displayName,
            operatingRootId: spec.folder.id,
            ...(spec.folder.path ? { operatingRootPath: spec.folder.path } : {}),
          },
          threadId,
        });
      }
      ids.push(threadId);
    }
    return ids;
  });
}
