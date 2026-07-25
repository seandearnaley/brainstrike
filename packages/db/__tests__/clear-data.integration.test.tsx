// @vitest-environment jsdom
/**
 * DbProvider clear + factory reset against a REAL PGlite (BST-558).
 *
 * `clear-data.test.tsx` and `factory-reset.test.tsx` stub `tx.query` with
 * `vi.fn()`. That models "which SQL was issued" but CANNOT model Postgres
 * transaction semantics: in real Postgres (and PGlite is real Postgres) a
 * statement error puts the enclosing transaction into the ABORTED state, and
 * every later command fails with `25P02 current transaction is aborted,
 * commands ignored until end of transaction block` until ROLLBACK. There are no
 * savepoints in this repo, so catching the original error does not undo that.
 *
 * `mastra_workflow_snapshot` is created LAZILY by
 * `PgliteWorkflowsStore.initialize()` and by NO migration, so "relation absent"
 * is the NORMAL state for a database whose owner never opened the assistant.
 * The fully migrated test snapshot therefore reproduces production exactly: it
 * has every other relation and not that one.
 *
 * Both reset paths named by the FACTORY RESET CONTRACT are covered here — the
 * direct-PGlite clear (`clearViaPGlite`) and the factory-reset purge
 * (`purgeTablesTx`, previously with no regression lock at all).
 */
import type { PGlite } from '@electric-sql/pglite';
import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DbProvider,
  useClearAllData,
  useFactoryReset,
  useFileRecordRepository,
} from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';
import { createMigratedTestDb } from './helpers/migrated-test-db';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

/**
 * The provider closes the database at the end of a factory reset. The test
 * still needs to READ the post-reset rows, so `close` is neutralised through a
 * Proxy — `Reflect.get(target, prop, target)` keeps every other member bound to
 * the real instance, so PGlite's private fields keep working.
 */
function withNoopClose(db: PGlite): PGlite {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'close') {
        return async () => {
          // Intentionally left open; afterEach closes the real instance.
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as PGlite;
}

const SENTINEL_INSERTS = [
  // Cleared BEFORE mastra_workflow_snapshot in both paths.
  `INSERT INTO prompt_items (id, kind, title, content)
     VALUES ('sentinel-prompt', 'prompt', 'sentinel', 'sentinel')`,
  // Cleared AFTER it (clearThreadSearchIndexIfPresent) — the first statement
  // that would observe an aborted transaction.
  `INSERT INTO brainstrike_diagnostic_events
     (id, occurred_at, severity, source, message, fingerprint, session_id, app_version, platform)
     VALUES ('sentinel-diag', NOW(), 'warn', 'test', 'sentinel', 'fp', 'sess', '0.0.0', 'test')`,
];

describe('DbProvider clear/reset (real PGlite transaction semantics)', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    for (const sql of SENTINEL_INSERTS) {
      await db.exec(sql);
    }
    const handle = withNoopClose(db);
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(handle);
    // The snapshot is already migrated; re-running the chain here would only
    // add cost, and this test is about the clear path, not the runner.
    vi.spyOn(migrations, 'migrate').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  async function countRows(table: string): Promise<number> {
    const result = await db.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM ${table}`
    );
    return Number(result.rows[0]?.count ?? -1);
  }

  async function assertSentinelsCleared(): Promise<void> {
    expect(await countRows('prompt_items')).toBe(0);
    expect(await countRows('brainstrike_diagnostic_events')).toBe(0);
  }

  it('commits the direct clear when mastra_workflow_snapshot was never created', async () => {
    const { result } = renderHook(
      () => ({ clearData: useClearAllData(), repo: useFileRecordRepository() }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.repo).not.toBeNull();
      expect(result.current.clearData).not.toBeNull();
    });

    await expect(result.current.clearData?.()).resolves.toBeDefined();
    await assertSentinelsCleared();
  });

  it('commits the factory-reset purge when mastra_workflow_snapshot was never created', async () => {
    const { result } = renderHook(
      () => ({ factoryReset: useFactoryReset(), repo: useFileRecordRepository() }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.repo).not.toBeNull();
      expect(result.current.factoryReset).not.toBeNull();
    });

    await act(async () => {
      await result.current.factoryReset?.();
    });
    await assertSentinelsCleared();
  });

  it('clears the workflow snapshot rows when the relation does exist', async () => {
    await db.exec('CREATE TABLE mastra_workflow_snapshot (run_id text primary key)');
    await db.exec("INSERT INTO mastra_workflow_snapshot (run_id) VALUES ('suspended-run')");

    const { result } = renderHook(
      () => ({ clearData: useClearAllData(), repo: useFileRecordRepository() }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.repo).not.toBeNull();
      expect(result.current.clearData).not.toBeNull();
    });

    await expect(result.current.clearData?.()).resolves.toBeDefined();
    expect(await countRows('mastra_workflow_snapshot')).toBe(0);
    await assertSentinelsCleared();
  });
});
