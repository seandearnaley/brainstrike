import { renderHook } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import { migrate } from '../src/migrations/bootstrap';
import type { FileRecord } from '../src/models/file-record';

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
  let repo: ReturnType<typeof useFileRecordRepository>;

  afterEach(async () => {
    if (repo) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (repo as any).db.close();
    }
  });

  it('migrates, creates and retrieves records via context repository', async () => {
    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });
    repo = result.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate((repo as any).db);

    const record = createTestRecord();
    await repo.create(record);
    const found = await repo.findById(record.id);
    expect(found).toEqual(record);
  });
});

