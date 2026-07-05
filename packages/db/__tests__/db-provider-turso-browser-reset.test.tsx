import { act, renderHook, waitFor } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBrainstrikeDbRuntimeSelection } from '../src/architecture/db-runtime-selection';
import {
  DbProvider,
  useClearAllData,
  useDbInitializationStatus,
  useDbProviderError,
  useFactoryReset,
  useViewFilterPresetsRepository,
} from '../src/db-provider';
import { openTursoBrowserWasmDatabase } from '../src/turso/browser-wasm-client';

vi.mock('../src/turso/browser-wasm-client', () => ({
  openTursoBrowserWasmDatabase: vi.fn(async () => {
    throw new Error('openTursoBrowserWasmDatabase mock is not configured for this test');
  }),
}));

const openTursoBrowserWasmDatabaseMock = vi.mocked(openTursoBrowserWasmDatabase);

const TEST_DB_PATH = 'brainstrike-test-web-turso-reset.db';
const OPFS_FAMILY = [
  TEST_DB_PATH,
  `${TEST_DB_PATH}-wal`,
  `${TEST_DB_PATH}-shm`,
  `${TEST_DB_PATH}-tshm`,
] as const;

/**
 * jsdom coverage-lane TWINS of the real-browser reset/durability proofs in
 * db-provider-turso-browser-reset.browser.test.tsx: the REAL bootstrap,
 * execution client, and provider reset/clear paths run against a scripted
 * WASM-surface fake (same pattern as db-provider-turso-browser.test.tsx).
 * The real-engine truth lives in the browser lane; these twins pin the
 * provider logic in the coverage-counted unit lanes and cover the failure
 * branches that are impractical to inject against real OPFS (close faults,
 * removeEntry faults, FK pragma readback faults).
 */

interface FakeBrowserTursoDatabaseOptions {
  /** Rejects the vendor close() call (factory-reset fail-closed path). */
  readonly closeError?: Error;
  /** Exact-match exec SQL → error to throw (clear-path failure injection). */
  readonly execFailures?: ReadonlyMap<string, Error>;
  /** COUNT(*) row values returned for the clear's count queries. */
  readonly fileChunkCount?: number;
  readonly fileRecordCount?: number;
  /** Value the `PRAGMA foreign_keys` readback reports (default 1 = ON). */
  readonly foreignKeysReadback?: number;
}

interface FakeBrowserTursoDatabase {
  readonly close: ReturnType<typeof vi.fn>;
  readonly exec: ReturnType<typeof vi.fn>;
  readonly execSql: readonly string[];
  readonly prepare: ReturnType<typeof vi.fn>;
}

/**
 * Scripted @tursodatabase/database-wasm surface. `callLog` records close and
 * OPFS removeEntry events in one shared sequence so ordering contracts
 * (close BEFORE delete) are assertable.
 */
function createFakeBrowserTursoDatabase(
  options: FakeBrowserTursoDatabaseOptions,
  callLog: string[]
): FakeBrowserTursoDatabase {
  const execSql: string[] = [];

  const routeAll = (sql: string): unknown[] => {
    if (sql === 'PRAGMA journal_mode') {
      return [{ journal_mode: 'wal' }];
    }
    if (sql === 'PRAGMA foreign_keys') {
      return [{ foreign_keys: options.foreignKeysReadback ?? 1 }];
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
    if (sql.includes('COUNT(*)') && sql.includes('FROM file_chunks')) {
      return [{ count: options.fileChunkCount ?? 0 }];
    }
    if (sql.includes('COUNT(*)') && sql.includes('FROM file_records')) {
      return [{ count: options.fileRecordCount ?? 0 }];
    }
    return [];
  };

  return {
    close: vi.fn(async () => {
      callLog.push('db.close');
      if (options.closeError) {
        throw options.closeError;
      }
    }),
    exec: vi.fn(async (sql: string) => {
      execSql.push(sql);
      const failure = options.execFailures?.get(sql);
      if (failure) {
        throw failure;
      }
    }),
    execSql,
    prepare: vi.fn(async (sql: string) => ({
      all: vi.fn(async () => routeAll(sql)),
      close: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ changes: 1, lastInsertRowid: 0 })),
    })),
  };
}

interface FakeOpfsRootOptions {
  /** File name → error thrown by removeEntry (NotFoundError is tolerated). */
  readonly removeEntryFailures?: ReadonlyMap<string, Error>;
}

function createFakeOpfsRoot(options: FakeOpfsRootOptions, callLog: string[]) {
  const removeEntry = vi.fn(async (name: string) => {
    callLog.push(`removeEntry:${name}`);
    const failure = options.removeEntryFailures?.get(name);
    if (failure) {
      throw failure;
    }
  });
  return { removeEntry };
}

function installBrowserWasmPrerequisites(opfsRoot: { removeEntry: unknown }): void {
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
        getDirectory: vi.fn(async () => opfsRoot),
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

function browserTursoWrapper({ children }: { children: React.ReactNode }) {
  return (
    <DbProvider
      dbPath={TEST_DB_PATH}
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

function useBrowserTursoResetProbe() {
  return {
    clearAllData: useClearAllData(),
    error: useDbProviderError(),
    factoryReset: useFactoryReset(),
    initializationStatus: useDbInitializationStatus(),
    viewFilterPresetsRepository: useViewFilterPresetsRepository(),
  };
}

interface RenderedResetHarness {
  readonly callLog: string[];
  readonly openedDatabases: FakeBrowserTursoDatabase[];
  readonly result: {
    readonly current: ReturnType<typeof useBrowserTursoResetProbe>;
  };
  readonly unmount: () => void;
}

/**
 * Boots the provider through the REAL bootstrap + provider open against
 * scripted fakes. Store #0 is the bootstrap probe (closed by the bootstrap),
 * store #1 is the provider's long-lived single-writer store.
 */
function renderResetHarness(input: {
  readonly databaseOptions?: FakeBrowserTursoDatabaseOptions;
  readonly opfsOptions?: FakeOpfsRootOptions;
}): RenderedResetHarness {
  const callLog: string[] = [];
  const openedDatabases: FakeBrowserTursoDatabase[] = [];
  installBrowserWasmPrerequisites(createFakeOpfsRoot(input.opfsOptions ?? {}, callLog));
  openTursoBrowserWasmDatabaseMock.mockImplementation(async (options) => {
    expect(options.path).toBe(TEST_DB_PATH);
    const database = createFakeBrowserTursoDatabase(input.databaseOptions ?? {}, callLog);
    openedDatabases.push(database);
    return database as unknown as Awaited<ReturnType<typeof openTursoBrowserWasmDatabase>>;
  });

  const { result, unmount } = renderHook(useBrowserTursoResetProbe, {
    wrapper: browserTursoWrapper,
  });
  return { callLog, openedDatabases, result, unmount };
}

async function waitForReady(harness: RenderedResetHarness): Promise<void> {
  await waitFor(
    () => {
      expect(harness.result.current.initializationStatus).toBe('ready');
    },
    { timeout: 10_000 }
  );
  expect(harness.result.current.error).toBeNull();
}

const CLEAR_DELETE_ORDER = [
  'DELETE FROM file_chunks',
  'DELETE FROM selection_snapshot_files',
  'DELETE FROM selection_snapshots',
  'DELETE FROM file_records',
  'DELETE FROM roots',
  'DELETE FROM collection_indexing_stats',
  'DELETE FROM embedding_sets',
  'DELETE FROM job_queue',
  'DELETE FROM brainstrike_assistant_run_usage',
] as const;

describe('DbProvider browser Turso reset ownership (jsdom coverage twins)', () => {
  const originalCrossOriginIsolated = Object.getOwnPropertyDescriptor(
    globalThis,
    'crossOriginIsolated'
  );
  const originalSharedArrayBuffer = Object.getOwnPropertyDescriptor(
    globalThis,
    'SharedArrayBuffer'
  );
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    restoreDescriptor(globalThis, 'crossOriginIsolated', originalCrossOriginIsolated);
    restoreDescriptor(globalThis, 'SharedArrayBuffer', originalSharedArrayBuffer);
    restoreDescriptor(globalThis, 'navigator', originalNavigator);
    vi.restoreAllMocks();
  });

  it('clearAllData composes the desktop clear statement list in one transaction, returns counts, and skips missing optional relations', async () => {
    const harness = renderResetHarness({
      databaseOptions: {
        execFailures: new Map([
          [
            'DELETE FROM brainstrike_assistant_run_usage',
            new Error('no such table: brainstrike_assistant_run_usage'),
          ],
        ]),
        fileChunkCount: 3,
        fileRecordCount: 2,
      },
    });
    try {
      await waitForReady(harness);
      const clearAllData = harness.result.current.clearAllData;
      if (!clearAllData) {
        throw new Error('Expected clearAllData from the ready provider.');
      }

      // Count contract: the pre-delete row counts come back as numbers.
      await expect(clearAllData()).resolves.toEqual({ deletedChunks: 3, deletedFiles: 2 });

      // Composition contract on the LONG-LIVED store (index 1; index 0 is the
      // bootstrap probe): one BEGIN..COMMIT containing the desktop statement
      // list in order, with the missing optional relation swallowed (the
      // failing DELETE was still issued, then skipped — not rethrown).
      const longLived = harness.openedDatabases[1];
      if (!longLived) {
        throw new Error('Expected the provider to open the long-lived store.');
      }
      const begin = longLived.execSql.indexOf('BEGIN');
      const commit = longLived.execSql.indexOf('COMMIT');
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThan(begin);
      expect(longLived.execSql.slice(begin + 1, commit)).toEqual([...CLEAR_DELETE_ORDER]);
      expect(longLived.execSql).not.toContain('ROLLBACK');
    } finally {
      harness.unmount();
    }
  });

  it('clearAllData rethrows real (non-missing-relation) errors and rolls the transaction back', async () => {
    const harness = renderResetHarness({
      databaseOptions: {
        execFailures: new Map([['DELETE FROM embedding_sets', new Error('disk I/O error')]]),
        fileChunkCount: 1,
        fileRecordCount: 1,
      },
    });
    try {
      await waitForReady(harness);
      const clearAllData = harness.result.current.clearAllData;
      if (!clearAllData) {
        throw new Error('Expected clearAllData from the ready provider.');
      }

      await expect(clearAllData()).rejects.toThrow('disk I/O error');

      const longLived = harness.openedDatabases[1];
      expect(longLived?.execSql).toContain('ROLLBACK');
      expect(longLived?.execSql).not.toContain('COMMIT');
      // The failing statement stopped the composition: nothing after
      // embedding_sets was issued.
      expect(longLived?.execSql).not.toContain('DELETE FROM job_queue');
    } finally {
      harness.unmount();
    }
  });

  it('factoryReset closes the store BEFORE deleting the OPFS family, tolerates NotFound sidecars, and resets state pending reload', async () => {
    const harness = renderResetHarness({
      opfsOptions: {
        removeEntryFailures: new Map([
          [`${TEST_DB_PATH}-shm`, new DOMException('missing', 'NotFoundError')],
          [`${TEST_DB_PATH}-tshm`, new DOMException('missing', 'NotFoundError')],
        ]),
      },
    });
    try {
      await waitForReady(harness);
      expect(harness.result.current.viewFilterPresetsRepository).not.toBeNull();
      const factoryReset = harness.result.current.factoryReset;
      if (!factoryReset) {
        throw new Error('Expected factoryReset from the ready provider.');
      }

      // The bootstrap probe's close is already in the log; assert on the
      // events the reset itself appends.
      const resetLogStart = harness.callLog.length;
      await act(async () => {
        await factoryReset();
      });

      // Ordering contract: the single-writer handle is released BEFORE any
      // OPFS deletion, then every family member is attempted in order.
      expect(harness.callLog.slice(resetLogStart)).toEqual([
        'db.close',
        ...OPFS_FAMILY.map((name) => `removeEntry:${name}`),
      ]);

      // State reset pending reload: repositories drop, status returns to
      // idle, and re-initialization stays blocked (no third store opens even
      // though the hooks' lazy-init effects fire again).
      await waitFor(() => {
        expect(harness.result.current.initializationStatus).toBe('idle');
      });
      expect(harness.result.current.viewFilterPresetsRepository).toBeNull();
      expect(harness.result.current.factoryReset).toBeNull();
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(harness.openedDatabases).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  it('factoryReset fails closed when the store close cannot release the OPFS handle, leaving no half-cleared state', async () => {
    const closeError = new Error('close blocked by in-flight statement');
    // Only the long-lived store (second open) must fail to close — the
    // bootstrap probe closes normally, so inject the failure lazily.
    const harness = renderResetHarness({});
    try {
      await waitForReady(harness);
      const longLived = harness.openedDatabases[1];
      if (!longLived) {
        throw new Error('Expected the provider to open the long-lived store.');
      }
      longLived.close.mockImplementation(async () => {
        harness.callLog.push('db.close');
        throw closeError;
      });
      const factoryReset = harness.result.current.factoryReset;
      if (!factoryReset) {
        throw new Error('Expected factoryReset from the ready provider.');
      }

      await expect(factoryReset()).rejects.toThrow(
        'Browser Turso factory reset could not release the OPFS single-writer store handle: close blocked by in-flight statement'
      );

      // Fail closed means NOTHING was half-cleared: no OPFS deletion was
      // attempted and the provider state was not reset.
      expect(harness.callLog.filter((entry) => entry.startsWith('removeEntry:'))).toEqual([]);
      expect(harness.result.current.initializationStatus).toBe('ready');
      expect(harness.result.current.viewFilterPresetsRepository).not.toBeNull();
    } finally {
      harness.unmount();
    }
  });

  it('factoryReset rethrows non-NotFound OPFS delete failures with per-file diagnostics and skips the state reset', async () => {
    const harness = renderResetHarness({
      opfsOptions: {
        removeEntryFailures: new Map([
          [
            TEST_DB_PATH,
            new DOMException('access handle still open', 'NoModificationAllowedError'),
          ],
          [`${TEST_DB_PATH}-tshm`, new DOMException('missing', 'NotFoundError')],
        ]),
      },
    });
    try {
      await waitForReady(harness);
      const factoryReset = harness.result.current.factoryReset;
      if (!factoryReset) {
        throw new Error('Expected factoryReset from the ready provider.');
      }

      // The per-file diagnostic names the failing file and carries the
      // underlying error text (DOMException stringification varies between
      // jsdom and real browsers, so match the load-bearing parts).
      await expect(factoryReset()).rejects.toThrow(
        /Browser Turso factory reset failed to delete OPFS store files: brainstrike-test-web-turso-reset\.db \([^)]*access handle still open\)/
      );

      // NotFound entries were tolerated (every family member was attempted;
      // only the genuinely failing file is reported) and the provider state
      // reset never ran.
      expect(harness.callLog.filter((entry) => entry.startsWith('removeEntry:'))).toEqual(
        OPFS_FAMILY.map((name) => `removeEntry:${name}`)
      );
      expect(harness.result.current.initializationStatus).toBe('ready');
    } finally {
      harness.unmount();
    }
  });

  it('factoryReset deletes stale prior-session OPFS files even when no connection was initialized', async () => {
    const callLog: string[] = [];
    installBrowserWasmPrerequisites(createFakeOpfsRoot({}, callLog));
    // The store never opens this session: bootstrap hangs at store open, so
    // connectionRef stays null while the provider itself is mounted/ready.
    openTursoBrowserWasmDatabaseMock.mockImplementation(
      () =>
        new Promise(() => {
          // Never resolves — simulates a wedged prior-session store open.
        })
    );

    const { result, unmount } = renderHook(useBrowserTursoResetProbe, {
      wrapper: browserTursoWrapper,
    });
    try {
      await waitFor(
        () => {
          expect(result.current.factoryReset).not.toBeNull();
        },
        { timeout: 10_000 }
      );
      const factoryReset = result.current.factoryReset;
      if (!factoryReset) {
        throw new Error('Expected factoryReset while initialization is still pending.');
      }

      await act(async () => {
        await factoryReset();
      });

      // No connection to close, but the OPFS family from the previous
      // session is still deleted and the provider resets pending reload.
      expect(callLog).toEqual(OPFS_FAMILY.map((name) => `removeEntry:${name}`));
      await waitFor(() => {
        expect(result.current.initializationStatus).toBe('idle');
      });
    } finally {
      unmount();
    }
  });

  it('fails initialization closed when the long-lived store cannot verify foreign keys ON, closing the re-opened store', async () => {
    const harness = renderResetHarness({
      databaseOptions: { foreignKeysReadback: 0 },
    });
    try {
      await waitFor(
        () => {
          expect(harness.result.current.initializationStatus).toBe('error');
        },
        { timeout: 10_000 }
      );

      expect(harness.result.current.error?.message).toContain(
        'Browser Turso store failed to enable foreign keys (PRAGMA foreign_keys reported 0)'
      );
      // Store #0 (bootstrap probe) closed normally; store #1 (the provider
      // re-open) was closed by the fail-closed cleanup — no leaked
      // single-writer handle.
      expect(harness.openedDatabases).toHaveLength(2);
      expect(harness.openedDatabases[0]?.close).toHaveBeenCalledTimes(1);
      expect(harness.openedDatabases[1]?.close).toHaveBeenCalledTimes(1);
      expect(harness.result.current.viewFilterPresetsRepository).toBeNull();
    } finally {
      harness.unmount();
    }
  });
});
