import { PGlite } from '@electric-sql/pglite';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import type { FileRecord } from '../src/models/file-record';
import * as wasmLoaderModule from '../src/wasm-loader';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

function createTestRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? `test-id-${Math.random().toString(36).slice(2)}`,
    name: overrides.name ?? 'test-file.txt',
    path: overrides.path ?? '/tmp/test-file.txt',
    size: overrides.size ?? 1234,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    tokenCount: overrides.tokenCount ?? 0,
    ...overrides,
  };
}

describe('DbProvider integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('migrates, creates and retrieves records via context repository', async () => {
    // Mock the wasmLoader to return a real PGlite instance without WASM loading
    const mockDb = new PGlite();
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
        timeout: 30000, // Allow slower CI runners (up to 30 s)
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
  });
});
