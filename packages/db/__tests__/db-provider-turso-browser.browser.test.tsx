import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBrainstrikeDbRuntimeSelection } from '../src/architecture/db-runtime-selection.js';
import {
  DbProvider,
  useBrainstrikeExecutionDbClient,
  useBrainstrikeLiveQueryCapability,
  useBrainstrikeSchemaReadyCapability,
  useDbInitializationStatus,
  useDbProviderError,
  useFileChunkRepository,
  usePGliteDatabase,
  useProfileBootstrapReport,
  useTokenCacheStore,
  useViewFilterPresetsRepository,
} from '../src/db-provider.js';

/**
 * REAL browser proof for the provider-integration slice: DbProvider with an
 * explicit browser Turso runtime selection boots the real
 * @tursodatabase/database-wasm store over OPFS (no mocks), reaches a ready
 * WAL single-writer report, and a provider-constructed Turso repository
 * round-trips real data.
 */
describe('DbProvider browser Turso WASM runtime (real browser)', () => {
  const openedDbPaths: string[] = [];

  afterEach(async () => {
    // Give the provider's post-unmount close (setTimeout 0) a chance to run
    // before removing the OPFS entries.
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    for (const dbPath of openedDbPaths.splice(0)) {
      await removeOpfsFileIfPresent(dbPath);
      await removeOpfsFileIfPresent(`${dbPath}-wal`);
      await removeOpfsFileIfPresent(`${dbPath}-shm`);
    }
  });

  it('reaches ready through the provider and round-trips a view filter preset over OPFS', async () => {
    const dbPath = `brainstrike-provider-browser-turso-${crypto.randomUUID()}.db`;
    openedDbPaths.push(dbPath);
    const runtimeSelection = resolveBrainstrikeDbRuntimeSelection({
      platform: 'web',
      requestedEngine: 'turso',
      source: 'test',
    });
    expect(runtimeSelection.bootstrapRuntime).toEqual({
      engine: 'turso',
      host: 'browser',
      persistence: 'opfs',
    });

    function browserTursoWrapper({ children }: { children: React.ReactNode }) {
      return (
        <DbProvider dbPath={dbPath} runtimeSelection={runtimeSelection}>
          {children}
        </DbProvider>
      );
    }

    const { result, unmount } = renderHook(
      () => ({
        chunkRepository: useFileChunkRepository(),
        error: useDbProviderError(),
        executionDb: useBrainstrikeExecutionDbClient(),
        initializationStatus: useDbInitializationStatus(),
        liveQueryAvailable: useBrainstrikeLiveQueryCapability(),
        pgliteDb: usePGliteDatabase(),
        profileBootstrapReport: useProfileBootstrapReport(),
        schemaReady: useBrainstrikeSchemaReadyCapability(),
        tokenCacheStore: useTokenCacheStore(),
        viewFilterPresetsRepository: useViewFilterPresetsRepository(),
      }),
      { wrapper: browserTursoWrapper }
    );

    try {
      await waitFor(
        () => {
          expect(result.current.initializationStatus).toBe('ready');
        },
        // Real WASM + OPFS startup is slow (mirrors the bootstrap smoke).
        { timeout: 90_000 }
      );

      expect(result.current.error).toBeNull();
      expect(result.current.profileBootstrapReport).toMatchObject({
        capabilities: {
          concurrentWrites: false,
          journalMode: 'wal',
        },
        failure: null,
        phase: 'ready',
        ready: true,
        runtime: {
          engine: 'turso',
          host: 'browser',
          persistence: 'opfs',
        },
        search: {
          indexedSearch: 'available',
          ownershipMode: 'split-search-index-store',
        },
      });

      // Capability gates in a REAL browser: no PGlite handle, no live query,
      // schema readiness from the typed report, and the single-writer
      // execution client is exposed as the browser owner client.
      expect(result.current.pgliteDb).toBeNull();
      expect(result.current.liveQueryAvailable).toBe(false);
      expect(result.current.schemaReady).toBe(true);
      expect(result.current.executionDb?.runtimeEngine).toBe('turso');
      expect(result.current.executionDb?.sqlCapabilities.dialect).toBe('sqlite');
      expect(result.current.chunkRepository?.constructor.name).toBe('TursoFileChunkRepository');
      expect(result.current.tokenCacheStore?.constructor.name).toBe('TursoTokenCacheStore');

      // Real data round trip through the provider-constructed repository.
      const presetsRepository = result.current.viewFilterPresetsRepository;
      if (!presetsRepository) {
        throw new Error('Expected the provider-constructed Turso view filter presets repository.');
      }
      const created = await presetsRepository.create({
        description: 'real browser round trip',
        excludes: ['node_modules', 'dist'],
        includes: ['*.md', '*.ts'],
        name: 'Browser Turso Proof',
        useRegex: false,
      });
      expect(created.id).toBeTruthy();

      const fetched = await presetsRepository.getById(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.name).toBe('Browser Turso Proof');
      expect(fetched?.includes).toEqual(['*.md', '*.ts']);
      expect(fetched?.excludes).toEqual(['node_modules', 'dist']);

      const allPresets = await presetsRepository.findAll();
      expect(allPresets.map((preset) => preset.id)).toContain(created.id);
    } finally {
      unmount();
    }
  });
});

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
