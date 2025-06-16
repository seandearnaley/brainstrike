import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import { migrate } from '../src/migrations/bootstrap';
import type { FileRecord } from '../src/models/file-record';
import { PGlite } from '@electric-sql/pglite';
import * as wasmLoaderModule from '../src/wasm-loader';

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath=":memory:">{children}</DbProvider>;
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
    ...overrides,
  };
}

describe('DbProvider integration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('migrates, creates and retrieves records via context repository', async () => {
    // Mock the wasmLoader to return a real PGlite instance without WASM loading
    const mockDb = new PGlite(':memory:');
    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGlite').mockResolvedValue(mockDb);
    const { result } = renderHook(() => {
      try {
        return useFileRecordRepository();
      } catch {
        return null;
      }
    }, { wrapper });
    
    await waitFor(() => {
      expect(result.current).not.toBeNull();
      expect(result.current).toBeDefined();
    }, {
      timeout: 10000, // 10 seconds timeout for CI
    });
    
    const repo = result.current!;

    const record = createTestRecord();
    await repo.create(record);
    const found = await repo.findById(record.id);
    expect(found).toEqual(record);
  });
});

