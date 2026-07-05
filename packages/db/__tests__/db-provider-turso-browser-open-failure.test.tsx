import { renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveBrainstrikeDbRuntimeSelection } from '../src/architecture/db-runtime-selection';
import {
  DbProvider,
  useDbInitializationStatus,
  useDbProviderError,
  useProfileBootstrapReport,
  useTokenCacheStore,
} from '../src/db-provider';
import { openTursoBrowserWasmDatabase } from '../src/turso/browser-wasm-client';

vi.mock('../src/turso/browser-wasm-client', () => ({
  openTursoBrowserWasmDatabase: vi.fn(async () => {
    throw new Error('openTursoBrowserWasmDatabase mock is not configured for this test');
  }),
}));

// Simulate a repository chunk-load failure (e.g. a code-split fetch failing
// after the WAL single-writer store was already re-opened). A throwing getter
// keeps the ORIGINAL error observable (vitest wraps factory-level throws in a
// generic mocking error).
vi.mock('../src/repositories/turso-token-cache-store.js', () => ({
  get TursoTokenCacheStore(): never {
    throw new Error('simulated turso-token-cache-store chunk load failure');
  },
}));

const openTursoBrowserWasmDatabaseMock = vi.mocked(openTursoBrowserWasmDatabase);

interface FakeBrowserTursoDatabase {
  readonly close: ReturnType<typeof vi.fn>;
  readonly exec: ReturnType<typeof vi.fn>;
  readonly prepare: ReturnType<typeof vi.fn>;
}

function createFakeBrowserTursoDatabase(): FakeBrowserTursoDatabase {
  const createStatement = (sql: string) => ({
    all: vi.fn(async () => {
      if (sql === 'PRAGMA journal_mode') {
        return [{ journal_mode: 'wal' }];
      }
      if (sql.includes('idx_file_chunk_content_grams_lookup')) {
        return [
          { name: 'file_chunk_content_index', type: 'table' },
          { name: 'file_chunk_content_grams', type: 'table' },
          { name: 'idx_file_chunk_content_grams_lookup', type: 'index' },
        ];
      }
      if (sql.includes('vector_distance_cos')) {
        return [{ cos_distance: 0, dot_distance: -1, extracted: '[1,0]', l2_distance: 0 }];
      }
      return [];
    }),
    close: vi.fn(async () => undefined),
    run: vi.fn(async () => ({ changes: 1, lastInsertRowid: 0 })),
  });

  return {
    close: vi.fn(async () => undefined),
    exec: vi.fn(async () => undefined),
    prepare: vi.fn(async (sql: string) => createStatement(sql)),
  };
}

function installBrowserWasmPrerequisites(): void {
  Object.defineProperty(globalThis, 'crossOriginIsolated', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, 'SharedArrayBuffer', {
    configurable: true,
    value: SharedArrayBuffer,
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      storage: {
        getDirectory: vi.fn(async () => ({})),
      },
    },
  });
}

function restoreDescriptor<T extends object>(
  target: T,
  property: PropertyKey,
  descriptor: PropertyDescriptor | undefined
): void {
  if (descriptor) {
    Object.defineProperty(target, property, descriptor);
    return;
  }
  Reflect.deleteProperty(target, property);
}

describe('DbProvider browser Turso WASM runtime — repository load failure after store open', () => {
  const originalCrossOriginIsolated = Object.getOwnPropertyDescriptor(
    globalThis,
    'crossOriginIsolated'
  );
  const originalSharedArrayBuffer = Object.getOwnPropertyDescriptor(
    globalThis,
    'SharedArrayBuffer'
  );
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  afterEach(() => {
    restoreDescriptor(globalThis, 'crossOriginIsolated', originalCrossOriginIsolated);
    restoreDescriptor(globalThis, 'SharedArrayBuffer', originalSharedArrayBuffer);
    restoreDescriptor(globalThis, 'navigator', originalNavigator);
    vi.restoreAllMocks();
  });

  it('closes the re-opened WAL single-writer store when a repository chunk fails to load', async () => {
    installBrowserWasmPrerequisites();
    const openedDatabases: FakeBrowserTursoDatabase[] = [];
    openTursoBrowserWasmDatabaseMock.mockImplementation(async () => {
      const database = createFakeBrowserTursoDatabase();
      openedDatabases.push(database);
      return database as unknown as Awaited<ReturnType<typeof openTursoBrowserWasmDatabase>>;
    });

    function browserTursoWrapper({ children }: { children: React.ReactNode }) {
      return (
        <DbProvider
          dbPath="brainstrike-test-web-turso.db"
          runtimeSelection={resolveBrainstrikeDbRuntimeSelection({
            platform: 'web',
            requestedEngine: 'turso',
            source: 'test',
          })}
        >
          {children}
        </DbProvider>
      );
    }

    const { result } = renderHook(
      () => ({
        error: useDbProviderError(),
        initializationStatus: useDbInitializationStatus(),
        profileBootstrapReport: useProfileBootstrapReport(),
        tokenCacheStore: useTokenCacheStore(),
      }),
      { wrapper: browserTursoWrapper }
    );

    await waitFor(
      () => {
        expect(result.current.initializationStatus).toBe('error');
      },
      { timeout: 10_000 }
    );

    expect(result.current.error?.message).toContain('turso-token-cache-store');
    expect(result.current.tokenCacheStore).toBeNull();

    // The bootstrap probe store (first open) closes as part of the readiness
    // run; the RE-OPENED long-lived store (second open) must ALSO be closed on
    // the failure path — leaking it can block any later open of the same OPFS
    // single-writer file in this session.
    expect(openedDatabases).toHaveLength(2);
    expect(openedDatabases[0]?.close).toHaveBeenCalledTimes(1);
    expect(openedDatabases[1]?.close).toHaveBeenCalledTimes(1);
  });
});
