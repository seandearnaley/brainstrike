import type { PGlite } from '@electric-sql/pglite';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileRecord } from '../src/models/file-record';
import * as wasmLoaderModule from '../src/wasm-loader';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

function createTestRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  const now = new Date().toISOString();
  return {
    chunkingStrategy: overrides.chunkingStrategy ?? 'sentence',
    chunksCount: overrides.chunksCount ?? 0,
    createdAt: overrides.createdAt ?? now,
    id: overrides.id ?? `test-id-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'test-file.txt',
    path: overrides.path ?? '/tmp/test-file.txt',
    size: overrides.size ?? 1234,
    tokenCount: overrides.tokenCount ?? 0,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

describe('DbProvider integration', () => {
  let mockDb: PGlite | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (mockDb) {
      await mockDb.close();
      mockDb = undefined;
    }
  });

  it('migrates, creates and retrieves records via context repository', async () => {
    // October 2025: Fresh database per test
    const dataDir = createPGliteTestDataDir('pglite-test-db-provider-migration');
    mockDb = await wasmLoader.createPGlite(dataDir);
    await migrate(mockDb);
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);

    const { result } = renderHook(
      () => {
        const repo = useFileRecordRepository();
        return repo;
      },
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current).not.toBeNull();
        expect(result.current).toBeDefined();
      },
      {
        timeout: 10_000, // Reduced from 30s with snapshot pattern
      }
    );

    if (!result.current) {
      throw new Error('Repository should be available after migration');
    }
    const repo = result.current;

    const record = createTestRecord();
    await repo.create(record);
    const found = await repo.findById(record.id);
    expect(found).toEqual(record);
  }, 15_000); // Reduced timeout with snapshot pattern
});
