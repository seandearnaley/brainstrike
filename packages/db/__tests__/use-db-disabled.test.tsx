// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DbContext, type DbContextValue } from '../src/db-context';
import { createLiveQueryDrainRegistry } from '../src/db-reset-drain';
import {
  useDbInitializing,
  useDbProviderError,
  useDrizzleDb,
  useFactoryReset,
  useFileChunkRepository,
  useFileRecordRepository,
  usePGliteDatabase,
  useViewFilterPresetsRepository,
} from '../src/use-db';

it.each([
  usePGliteDatabase,
  useFileRecordRepository,
  useFileChunkRepository,
  useFactoryReset,
  useDrizzleDb,
  useViewFilterPresetsRepository,
])('a platform capability can disable %s without a DbProvider', (useRepository) => {
  const { result } = renderHook(() => useRepository({ enabled: false }));
  expect(result.current).toBeNull();
});

describe('disabled web database consumer', () => {
  it.each([
    usePGliteDatabase,
    useFileRecordRepository,
    useFileChunkRepository,
    useFactoryReset,
    useDrizzleDb,
    useViewFilterPresetsRepository,
  ])('disabled %s does not initialize PG, while enabled web still does', (useRepository) => {
    const initializeDatabase = vi.fn(async () => {});
    const context: DbContextValue = {
      chunkRepository: null,
      clearAllData: async () => ({ deletedChunks: 0, deletedFiles: 0 }),
      clearQueuesAndEmbeddingSets: async () => {},
      db: null,
      drizzleDb: null,
      embeddingSetsRepository: null,
      error: null,
      factoryReset: async () => {},
      fileRecordRepository: null,
      initializationStatus: 'idle',
      initializeDatabase,
      initializing: false,
      liveQueryDrainRegistry: createLiveQueryDrainRegistry(),
      ready: true,
      vectorEnabled: false,
      viewFilterPresetsRepository: null,
    };
    const { result, rerender } = renderHook(({ enabled }) => useRepository({ enabled }), {
      initialProps: { enabled: false },
      wrapper: ({ children }: { children: ReactNode }) => (
        <DbContext.Provider value={context}>{children}</DbContext.Provider>
      ),
    });
    expect(result.current).toBeNull();
    expect(initializeDatabase).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(initializeDatabase).toHaveBeenCalledOnce();
  });
});

it('disabled native status hooks do not require a provider', () => {
  const { result } = renderHook(() => ({
    error: useDbProviderError({ enabled: false }),
    initializing: useDbInitializing({ enabled: false }),
  }));
  expect(result.current).toEqual({ error: null, initializing: false });
});
