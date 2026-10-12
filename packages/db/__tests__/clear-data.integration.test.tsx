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
 * Mastra's memory, vector, and workflow tables are created LAZILY and by NO
 * migration, so "relation absent" is the NORMAL state for a database whose
 * owner never opened the assistant. The fully migrated test snapshot therefore
 * reproduces production exactly: it has every migrated Brainstrike relation
 * and none of the lazy Mastra relations.
 *
 * Both reset paths named by the FACTORY RESET CONTRACT are covered here — the
 * direct-PGlite clear (`clearViaPGlite`) and the factory-reset purge
 * (`purgeTablesTx`, previously with no regression lock at all).
 */
import { MASTRA_WORKFLOW_TABLE } from '@brainstrike/assistant-contract/mastra-memory-schema';
import type { PGlite } from '@electric-sql/pglite';
import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbProvider } from '../src/db-provider';
import * as migrations from '../src/migrations/bootstrap';
import { useClearAllData, useFactoryReset, useFileRecordRepository } from '../src/use-db';
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
  `INSERT INTO brainstrike_assistant_thread_groups
     (id, resource_id, name, rank)
     VALUES ('sentinel-group', 'sentinel-resource', 'sentinel', 'a')`,
  `INSERT INTO brainstrike_assistant_thread_placements
     (thread_id, resource_id, group_id, rank)
     VALUES ('sentinel-thread', 'sentinel-resource', 'sentinel-group', 'a')`,
  // Cleared AFTER it (clearThreadSearchIndexIfPresent) — the first statement
  // that would observe an aborted transaction.
  `INSERT INTO brainstrike_diagnostic_events
     (id, occurred_at, severity, source, message, fingerprint, session_id, app_version, platform)
     VALUES ('sentinel-diag', NOW(), 'warn', 'test', 'sentinel', 'fp', 'sess', '0.0.0', 'test')`,
  `INSERT INTO brainstrike_assistant_run_errors
     (run_id, thread_id, resource_id, code, occurred_at)
     VALUES ('sentinel-run', 'sentinel-thread', 'sentinel-resource', 'provider_error', NOW())`,
  // BST-992: the four FK-less stores desktop `db:clearAll` cleared but both
  // web paths silently missed — none may survive a web clear or factory reset.
  `INSERT INTO brainstrike_assistant_run_usage
     (id, thread_id, run_id, resource_id, model, provider)
     VALUES ('sentinel-usage', 'sentinel-thread', 'sentinel-run', 'sentinel-resource', 'm', 'p')`,
  `INSERT INTO brainstrike_mcp_task_authorities
     (authority_epoch, server_id, resource, principal_id, runtime_id, connection_generation,
      created_at, updated_at)
     VALUES ('0199a77b-f000-7000-8000-000000000001', 'sentinel-server',
      'https://example.com/mcp', 'sentinel-principal', 'sentinel-runtime', 1, NOW(), NOW())`,
  `INSERT INTO brainstrike_mcp_tasks
     (authority_epoch, server_id, resource, principal_id, task_id, status, history,
      created_at, updated_at)
     VALUES ('0199a77b-f000-7000-8000-000000000001', 'sentinel-server',
      'https://example.com/mcp', 'sentinel-principal', 'sentinel-task', 'working',
      jsonb_build_array(jsonb_build_object('at', NOW(), 'status', 'working')), NOW(), NOW())`,
  `INSERT INTO brainstrike_assistant_message_parents
     (message_id, thread_id, resource_id)
     VALUES ('sentinel-message', 'sentinel-thread', 'sentinel-resource')`,
  // BST-1115: soft-rewind tombstones hide messages the clear just destroyed.
  `INSERT INTO brainstrike_assistant_message_tombstones
     (message_id, thread_id, rewind_id)
     VALUES ('sentinel-message', 'sentinel-thread', 'sentinel-rewind')`,
  // BST-1164: shadow-git snapshot ledger rows map threads the clear just
  // destroyed onto shadow commits.
  `INSERT INTO brainstrike_workspace_snapshots
     (id, thread_id, root_id, root_path, commit_oid, kind)
     VALUES ('sentinel-snapshot', 'sentinel-thread', 'sentinel-root', '/sentinel',
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0', 'turn-start')`,
  // BST-1190: durable counts/sizes-only tool-call telemetry.
  `INSERT INTO brainstrike_tool_call_telemetry
     (id, thread_id, run_id, tool_id, model_facing_chars)
     VALUES ('sentinel-tool-telemetry', 'sentinel-thread', 'sentinel-run',
      'brainstrike.grepSearch', 42)`,
  // BST-1205: durable estimator/provider prompt-token calibration evidence.
  `INSERT INTO brainstrike_token_estimate_calibration
     (id, thread_id, run_id, model, provider, estimated_prompt_tokens,
      final_step_prompt_tokens)
     VALUES ('sentinel-calibration', 'sentinel-thread', 'sentinel-run',
      'model', 'provider', 42, 50)`,
  // BST-992 convergence: factory-reset-only sentinel (representative of the
  // six seed-free caches) — wiped by the purge, kept by Clear Database.
  `INSERT INTO job_queue_metrics (queue, succeeded_total)
     VALUES ('sentinel-queue', 7)`,
];

/**
 * Test-owned literals are intentionally independent of the production schema
 * constants. If a reset call site omits or misspells a table, importing the same
 * constant there and here would let production and test drift together.
 */
const TEST_MASTRA_RESET_TABLES = [
  'mastra_messages',
  'mastra_observational_memory',
  'mastra_threads',
  'mastra_resources',
  'mastra_vectors',
] as const;

/**
 * Migration 117 (BST-1651) moved Mastra's four MEMORY relations into the
 * chain, so a migrated database already has them; only `mastra_vectors` is
 * still created lazily, by Mastra's vector store.
 */
const TEST_MASTRA_MIGRATED_TABLES = [
  'mastra_messages',
  'mastra_observational_memory',
  'mastra_threads',
  'mastra_resources',
] as const;

const TEST_MASTRA_LAZY_TABLES = ['mastra_vectors'] as const;

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
    expect(await countRows('brainstrike_assistant_thread_placements')).toBe(0);
    expect(await countRows('brainstrike_assistant_thread_groups')).toBe(0);
    expect(await countRows('brainstrike_assistant_run_errors')).toBe(0);
    expect(await countRows('brainstrike_diagnostic_events')).toBe(0);
    expect(await countRows('brainstrike_assistant_run_usage')).toBe(0);
    expect(await countRows('brainstrike_mcp_tasks')).toBe(0);
    expect(await countRows('brainstrike_mcp_task_authorities')).toBe(0);
    expect(await countRows('brainstrike_assistant_message_parents')).toBe(0);
    expect(await countRows('brainstrike_assistant_message_tombstones')).toBe(0);
    expect(await countRows('brainstrike_tool_call_telemetry')).toBe(0);
    expect(await countRows('brainstrike_token_estimate_calibration')).toBe(0);
    expect(await countRows('brainstrike_workspace_snapshots')).toBe(0);
  }

  async function assertMastraRelationPresence(): Promise<void> {
    for (const table of TEST_MASTRA_MIGRATED_TABLES) {
      const result = await db.query<{ present: boolean }>(
        `SELECT to_regclass('${table}') IS NOT NULL AS present`
      );
      expect(result.rows[0]?.present, `${table} is migration-backed`).toBe(true);
    }
    for (const table of TEST_MASTRA_LAZY_TABLES) {
      const result = await db.query<{ present: boolean }>(
        `SELECT to_regclass('${table}') IS NOT NULL AS present`
      );
      expect(result.rows[0]?.present, `${table} is lazily created`).toBe(false);
    }
  }

  async function seedMastraResetTables(): Promise<void> {
    // The four memory relations are migration-backed now (117), so this seeds
    // ROWS into their real shapes rather than inventing one-column stand-ins.
    await db.exec(`
      INSERT INTO mastra_threads (id, "resourceId", title, "createdAt", "updatedAt")
      VALUES ('thread-1', 'workspace-a', 'Thread', NOW(), NOW());

      INSERT INTO mastra_messages (id, thread_id, content, role, type, "createdAt")
      VALUES ('message-1', 'thread-1', '{}'::jsonb, 'user', 'text', NOW());

      INSERT INTO mastra_resources (id, "createdAt", "updatedAt")
      VALUES ('resource-1', NOW(), NOW());

      INSERT INTO mastra_observational_memory (
        id, "lookupKey", scope, "activeObservations", "originType", config,
        "generationCount", "pendingMessageTokens", "totalTokensObserved",
        "observationTokenCount", "isObserving", "isReflecting",
        "isBufferingObservation", "isBufferingReflection", "lastBufferedAtTokens",
        "createdAt", "updatedAt"
      )
      VALUES (
        'observation-1', 'workspace-a', 'resource', '', 'agent', '{}'::jsonb,
        0, 0, 0, 0, FALSE, FALSE, FALSE, FALSE, 0, NOW(), NOW()
      );

      CREATE TABLE mastra_vectors (
        index_name text NOT NULL,
        id text NOT NULL,
        PRIMARY KEY (index_name, id)
      );
      INSERT INTO mastra_vectors (index_name, id)
      VALUES
        ('assistant-memory', 'vector-1'),
        ('workspace-memory', 'vector-2'),
        ('assistant-memory', '__index_metadata__');
    `);
  }

  async function assertMastraResetTablesCleared(): Promise<void> {
    for (const table of TEST_MASTRA_RESET_TABLES) {
      expect(await countRows(table), table).toBe(0);
    }
  }

  // BST-992 convergence boundary, proven on real PGlite: Clear Database keeps
  // the factory-reset-only caches; the factory-reset purge wipes them but
  // preserves view_filter_presets' migration seeds (the purge never re-runs
  // migrations, so wiped seeds would be gone forever on web).
  it('clear keeps factory-reset-only caches; factory reset wipes them and keeps preset seeds', async () => {
    const presetSeeds = await countRows('view_filter_presets');
    expect(presetSeeds).toBeGreaterThan(0);
    // A USER-authored preset (is_default FALSE): must survive Clear Database
    // but die in the factory reset's targeted delete (review #2162 — desktop
    // convergence; the seeds themselves survive).
    await db.exec(
      `INSERT INTO view_filter_presets (name, is_default) VALUES ('sentinel-user-preset', FALSE)`
    );

    const { result } = renderHook(
      () => ({
        clearData: useClearAllData(),
        factoryReset: useFactoryReset(),
        repo: useFileRecordRepository(),
      }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.repo).not.toBeNull();
      expect(result.current.clearData).not.toBeNull();
      expect(result.current.factoryReset).not.toBeNull();
    });

    await expect(result.current.clearData?.()).resolves.toBeDefined();
    expect(await countRows('job_queue_metrics')).toBe(1);
    expect(await countRows('view_filter_presets')).toBe(presetSeeds + 1);

    await act(async () => {
      await result.current.factoryReset?.();
    });
    expect(await countRows('job_queue_metrics')).toBe(0);
    // Seeds intact, user preset gone: the targeted delete's exact boundary.
    expect(await countRows('view_filter_presets')).toBe(presetSeeds);
  });

  it('commits the direct clear when the lazy Mastra relations are absent', async () => {
    await assertMastraRelationPresence();

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

  it('commits the factory-reset purge when the lazy Mastra relations are absent', async () => {
    await assertMastraRelationPresence();

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

  it('direct clear empties every lazy Mastra memory table and every vector index', async () => {
    await seedMastraResetTables();
    expect(await countRows('mastra_vectors')).toBe(3);

    const { result } = renderHook(
      () => ({ clearData: useClearAllData(), repo: useFileRecordRepository() }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.repo).not.toBeNull();
      expect(result.current.clearData).not.toBeNull();
    });

    await expect(result.current.clearData?.()).resolves.toBeDefined();
    await assertMastraResetTablesCleared();
    await assertSentinelsCleared();
  });

  it('factory-reset purge empties every lazy Mastra memory table and every vector index', async () => {
    await seedMastraResetTables();
    expect(await countRows('mastra_vectors')).toBe(3);

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
    await assertMastraResetTablesCleared();
    await assertSentinelsCleared();
  });

  /**
   * The factory-reset tail used bare `catch (err) { logger.warn(...) }` blocks.
   * This proves why that could never be a tolerance: an FK violation on
   * `job_queue` (a GENUINE error, not a missing relation) aborts the
   * transaction, so `file_records`/`roots` and everything else after it fail
   * 25P02, each swallowed in turn, `purgeTablesTx` returns normally, and COMMIT
   * on an aborted transaction degrades to ROLLBACK WITHOUT raising — reset
   * reported success having cleared nothing. Narrowed to
   * `isMissingNamedRelationError`, the first real failure now propagates.
   */
  it('fails the factory reset loudly when a purge statement genuinely errors', async () => {
    await db.exec(`
      INSERT INTO job_queue (id, queue, job_type) VALUES ('job-1', 'q', 'embed');
      CREATE TABLE reset_fk_probe (
        id text PRIMARY KEY,
        job_id text NOT NULL REFERENCES job_queue(id) ON DELETE NO ACTION
      );
      INSERT INTO reset_fk_probe (id, job_id) VALUES ('probe-1', 'job-1');
    `);

    const { result } = renderHook(
      () => ({ factoryReset: useFactoryReset(), repo: useFileRecordRepository() }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.repo).not.toBeNull();
      expect(result.current.factoryReset).not.toBeNull();
    });

    await act(async () => {
      await expect(result.current.factoryReset?.()).rejects.toThrow(
        /violates foreign key constraint/iu
      );
    });
    // The rollback is honest: nothing was cleared AND the caller was told.
    expect(await countRows('prompt_items')).toBe(1);
  });

  /**
   * `clearViaPGlite` kept bare `try { DELETE } catch { logger.warn }` blocks
   * around roots / collection_indexing_stats / embedding_sets / job_queue /
   * run_outcomes / selection snapshots. Two defects in one shape:
   *
   *  1. NO SILENT FALLBACKS — they swallow EVERY error, not just 42P01.
   *  2. They cannot tolerate absence anyway. The 42P01 has already aborted the
   *     transaction, so `collection_indexing_stats` → `embedding_sets` →
   *     `job_queue` all fail 25P02 (each swallowed in turn) until the first
   *     NARROWED helper rethrows — and the caller is then told the transaction
   *     was aborted rather than which table was missing.
   */
  it('commits the direct clear when a migration-created relation is absent', async () => {
    await db.exec('DROP TABLE collection_indexing_stats');

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

  it('fails the direct clear loudly when a delete genuinely errors', async () => {
    await db.exec(`
      INSERT INTO roots (id, kind, display_name, path)
        VALUES ('root-1', 'path', 'probe root', '/tmp/clear-fk-probe');
      CREATE TABLE clear_fk_probe (
        id text PRIMARY KEY,
        root_id text NOT NULL REFERENCES roots(id) ON DELETE NO ACTION
      );
      INSERT INTO clear_fk_probe (id, root_id) VALUES ('probe-1', 'root-1');
    `);

    const { result } = renderHook(
      () => ({ clearData: useClearAllData(), repo: useFileRecordRepository() }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.repo).not.toBeNull();
      expect(result.current.clearData).not.toBeNull();
    });

    // The FK violation itself — NOT the misleading `25P02 current transaction is
    // aborted` that the swallowing tail surfaced instead.
    await expect(result.current.clearData?.()).rejects.toThrow(/violates foreign key constraint/iu);
    expect(await countRows('prompt_items')).toBe(1);
  });

  it('clears the workflow snapshot rows when the relation does exist', async () => {
    await db.exec(`CREATE TABLE ${MASTRA_WORKFLOW_TABLE} (run_id text primary key)`);
    await db.exec(`INSERT INTO ${MASTRA_WORKFLOW_TABLE} (run_id) VALUES ('suspended-run')`);

    const { result } = renderHook(
      () => ({ clearData: useClearAllData(), repo: useFileRecordRepository() }),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.repo).not.toBeNull();
      expect(result.current.clearData).not.toBeNull();
    });

    await expect(result.current.clearData?.()).resolves.toBeDefined();
    expect(await countRows(MASTRA_WORKFLOW_TABLE)).toBe(0);
    await assertSentinelsCleared();
  });
});
