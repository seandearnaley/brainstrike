import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBrainstrikeDbRuntimeSelection } from '../src/architecture/db-runtime-selection.js';
import {
  DbProvider,
  useBrainstrikeExecutionDbClient,
  useClearAllData,
  useDbInitializationStatus,
  useDbProviderError,
  useEmbeddingSetsRepository,
  useFactoryReset,
  useFileChunkRepository,
  useFileRecordRepository,
  useViewFilterPresetsRepository,
} from '../src/db-provider.js';

/**
 * REAL browser proof for the browser Turso reset-ownership slice (the
 * "backup/export ownership" browser-cutover gate):
 *
 * 1. `clearAllData` is a SQL-only live-handle clear that mirrors the desktop
 *    Turso `db:clearAll` semantics — deletes file/chunk/root/set/queue/
 *    snapshot/usage rows inside one transaction, sidecar gram/index tables
 *    cascade via foreign keys, `no such table` is treated as a missing
 *    optional relation, and seeded default view filter presets survive.
 * 2. `factoryReset` is a true fresh start (FACTORY RESET CONTRACT): it closes
 *    the WAL single-writer store (releasing the OPFS access handle), deletes
 *    the OPFS db file family, and leaves state so the next boot bootstraps a
 *    fresh store.
 */
describe('DbProvider browser Turso reset ownership (real browser)', () => {
  const openedDbPaths: string[] = [];

  afterEach(async () => {
    // Give the provider's post-unmount close (setTimeout 0) a chance to run
    // before removing the OPFS entries.
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    for (const dbPath of openedDbPaths.splice(0)) {
      for (const fileName of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-tshm`]) {
        await removeOpfsFileIfPresent(fileName);
      }
    }
  });

  it('clearAllData mirrors the desktop Turso db:clearAll semantics over the browser owner client', async () => {
    const dbPath = `brainstrike-browser-turso-clear-${crypto.randomUUID()}.db`;
    openedDbPaths.push(dbPath);
    const { result, unmount } = renderBrowserTursoProviderProbe(dbPath);

    try {
      await waitFor(
        () => {
          expect(result.current.initializationStatus).toBe('ready');
        },
        { timeout: 90_000 }
      );
      expect(result.current.error).toBeNull();

      const executionDb = result.current.executionDb?.db;
      const embeddingSets = result.current.embeddingSetsRepository;
      const fileRecords = result.current.fileRecordRepository;
      const chunkRepository = result.current.chunkRepository;
      const presetsRepository = result.current.viewFilterPresetsRepository;
      const clearAllData = result.current.clearAllData;
      if (
        !(
          executionDb &&
          embeddingSets &&
          fileRecords &&
          chunkRepository &&
          presetsRepository &&
          clearAllData
        )
      ) {
        throw new Error('Expected the ready browser Turso provider surfaces.');
      }

      // Seed through the provider-constructed repositories plus raw inserts
      // for the rows the repositories do not own (mirrors the desktop
      // db:clearAll real-engine test fixture).
      await executionDb.exec?.(
        `INSERT INTO roots (id, kind, display_name, path, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ['root-clear', 'path', 'Clear Fixture', '/workspace/root-clear', 'live', now()]
      );
      const embeddingSet = await embeddingSets.getOrCreateSet(
        'local::browser-clear-model',
        'browser-clear-model',
        3,
        'cosine'
      );
      await fileRecords.createWithContent({
        content: 'const answer = 42;',
        contentHash: 'hash-file-clear',
        createdAt: now(),
        embeddingSetId: embeddingSet.id,
        id: 'file-clear',
        name: 'index.ts',
        path: 'src/index.ts',
        size: 42,
        tokenCount: 8,
        updatedAt: now(),
      });
      await chunkRepository.insert({
        chunkIndex: 0,
        chunkSize: 18,
        chunkType: 'code',
        content: 'const answer = 42;',
        contentHash: 'hash-chunk-clear',
        createdAt: now(),
        embedding: [0.1, 0.2, 0.3],
        embeddingSetId: embeddingSet.id,
        fileRecordId: 'file-clear',
        id: 'chunk-clear',
        tokenCount: 4,
        updatedAt: now(),
      });
      await executionDb.exec?.(
        `INSERT INTO job_queue (id, queue, job_type, payload, chunk_id, embedding_set_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [
          'job-clear',
          'embeddings',
          'embed_chunk',
          '{"chunkId":"chunk-clear"}',
          'chunk-clear',
          embeddingSet.id,
        ]
      );
      await executionDb.exec?.('INSERT INTO selection_snapshots (id) VALUES (?)', [
        'snapshot-clear',
      ]);
      await executionDb.exec?.(
        'INSERT INTO selection_snapshot_files (snapshot_id, file_path) VALUES (?, ?)',
        ['snapshot-clear', 'src/index.ts']
      );
      await executionDb.exec?.(
        `INSERT INTO brainstrike_assistant_run_usage (
           id, thread_id, run_id, resource_id, model, provider, input_tokens, output_tokens, root_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'usage-clear',
          'thread-clear',
          'run-clear',
          'resource-clear',
          'model-clear',
          'test',
          11,
          7,
          'root-clear',
        ]
      );

      // Sidecars exist before the clear so the cascade assertion is honest.
      await expect(countRows(executionDb, 'file_record_name_grams')).resolves.toBeGreaterThan(0);
      await expect(countRows(executionDb, 'file_chunk_content_grams')).resolves.toBeGreaterThan(0);

      const cleared = await clearAllData();
      expect(cleared).toEqual({ deletedChunks: 1, deletedFiles: 1 });

      const clearedTables = [
        'brainstrike_assistant_run_usage',
        'collection_indexing_stats',
        'embedding_sets',
        'file_chunk_content_grams',
        'file_chunk_content_index',
        'file_chunks',
        'file_record_name_grams',
        'file_record_name_index',
        'file_records',
        'job_queue',
        'roots',
        'selection_snapshot_files',
        'selection_snapshots',
      ] as const;
      for (const table of clearedTables) {
        await expect(countRows(executionDb, table)).resolves.toBe(0);
      }

      // Seeded default view filter presets survive a SQL-only clear.
      const presets = await presetsRepository.findAll();
      expect(presets.length).toBeGreaterThan(0);

      // Missing optional relations are tolerated (`no such table`), matching
      // the desktop Postgres 42P01 handling.
      await executionDb.exec?.('DROP TABLE brainstrike_assistant_run_usage');
      await expect(clearAllData()).resolves.toEqual({ deletedChunks: 0, deletedFiles: 0 });
    } finally {
      unmount();
    }
  });

  it('factoryReset closes the store, deletes the OPFS file family, and the next boot is fresh', async () => {
    const dbPath = `brainstrike-browser-turso-reset-${crypto.randomUUID()}.db`;
    openedDbPaths.push(dbPath);
    const first = renderBrowserTursoProviderProbe(dbPath);

    try {
      await waitFor(
        () => {
          expect(first.result.current.initializationStatus).toBe('ready');
        },
        { timeout: 90_000 }
      );
      expect(first.result.current.error).toBeNull();

      const fileRecords = first.result.current.fileRecordRepository;
      const presetsRepository = first.result.current.viewFilterPresetsRepository;
      const factoryReset = first.result.current.factoryReset;
      if (!(fileRecords && presetsRepository && factoryReset)) {
        throw new Error('Expected the ready browser Turso provider surfaces.');
      }

      await fileRecords.createWithContent({
        content: 'stale row that must not survive a factory reset',
        contentHash: 'hash-file-reset',
        createdAt: now(),
        id: 'file-reset-marker',
        name: 'stale.ts',
        path: 'src/stale.ts',
        size: 48,
        tokenCount: 9,
        updatedAt: now(),
      });
      await presetsRepository.create({
        description: 'must not survive the reset',
        excludes: [],
        includes: ['*.stale'],
        name: 'Reset Marker Preset',
        useRegex: false,
      });

      // The store file family exists while the store is open.
      await expectOpfsEntryPresent(dbPath);

      await factoryReset();

      // True fresh start: the OPFS db file family is gone and the provider is
      // back to an uninitialized state pending the reload.
      for (const fileName of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-tshm`]) {
        await expectOpfsEntryAbsent(fileName);
      }
      await waitFor(() => {
        expect(first.result.current.initializationStatus).toBe('idle');
      });
    } finally {
      first.unmount();
    }

    // Simulate the post-reset reload: a fresh provider on the same path must
    // bootstrap a brand new store with none of the pre-reset rows.
    const second = renderBrowserTursoProviderProbe(dbPath);
    try {
      await waitFor(
        () => {
          expect(second.result.current.initializationStatus).toBe('ready');
        },
        { timeout: 90_000 }
      );
      expect(second.result.current.error).toBeNull();

      const fileRecords = second.result.current.fileRecordRepository;
      const presetsRepository = second.result.current.viewFilterPresetsRepository;
      if (!(fileRecords && presetsRepository)) {
        throw new Error('Expected the ready browser Turso provider surfaces after reset.');
      }
      await expect(fileRecords.findById('file-reset-marker')).resolves.toBeNull();
      const presets = await presetsRepository.findAll();
      expect(presets.map((preset) => preset.name)).not.toContain('Reset Marker Preset');
      // Seeded defaults exist again — the fresh bootstrap re-applied the
      // schema baseline.
      expect(presets.length).toBeGreaterThan(0);
    } finally {
      second.unmount();
    }
  });
});

function now(): string {
  return new Date().toISOString();
}

function useBrowserTursoResetProbe() {
  return {
    chunkRepository: useFileChunkRepository(),
    clearAllData: useClearAllData(),
    embeddingSetsRepository: useEmbeddingSetsRepository(),
    error: useDbProviderError(),
    executionDb: useBrainstrikeExecutionDbClient(),
    factoryReset: useFactoryReset(),
    fileRecordRepository: useFileRecordRepository(),
    initializationStatus: useDbInitializationStatus(),
    viewFilterPresetsRepository: useViewFilterPresetsRepository(),
  };
}

function renderBrowserTursoProviderProbe(dbPath: string) {
  const runtimeSelection = resolveBrainstrikeDbRuntimeSelection({
    platform: 'web',
    requestedEngine: 'turso',
    source: 'test',
  });

  function browserTursoWrapper({ children }: { children: React.ReactNode }) {
    return (
      <DbProvider dbPath={dbPath} runtimeSelection={runtimeSelection}>
        {children}
      </DbProvider>
    );
  }

  return renderHook(useBrowserTursoResetProbe, { wrapper: browserTursoWrapper });
}

async function countRows(
  executionDb: {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  tableName: string
): Promise<number> {
  const result = await executionDb.query<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM ${tableName}`
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function expectOpfsEntryPresent(fileName: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await expect(root.getFileHandle(fileName)).resolves.toBeTruthy();
}

async function expectOpfsEntryAbsent(fileName: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  await expect(root.getFileHandle(fileName)).rejects.toMatchObject({ name: 'NotFoundError' });
}

async function removeOpfsFileIfPresent(fileName: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry(fileName);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      return;
    }
    throw error;
  }
}
