import type { PGlite } from '@electric-sql/pglite';
import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbProvider, useFileRecordRepository } from '../src/db-provider';
import { migrate, PGVECTOR_EXTENSION_PRESENCE_QUERY } from '../src/migrations/bootstrap';
import * as wasmLoaderModule from '../src/wasm-loader';

vi.mock('../src/migrations/bootstrap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/migrations/bootstrap')>();
  return {
    ...actual,
    migrate: vi.fn(async () => undefined),
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return <DbProvider dbPath="memory://">{children}</DbProvider>;
}

describe('DbProvider init SQL contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the shared pgvector extension presence query during direct initialization', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql !== PGVECTOR_EXTENSION_PRESENCE_QUERY) {
        throw new Error(`Unexpected init SQL: ${sql}`);
      }

      return { rows: [{ '?column?': 1 }] };
    });

    const db = {
      close: vi.fn(async () => undefined),
      exec: vi.fn(async () => undefined),
      query,
    } as unknown as PGlite;

    vi.spyOn(wasmLoaderModule.wasmLoader, 'createPGliteClient').mockResolvedValue(db);

    const { result } = renderHook(() => useFileRecordRepository(), { wrapper });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(PGVECTOR_EXTENSION_PRESENCE_QUERY);
  });
});
