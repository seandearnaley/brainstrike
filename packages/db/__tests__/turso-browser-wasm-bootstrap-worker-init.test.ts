import { addLogListener, LogLevel } from '@brainstrike/utils/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openTursoBrowserWasmStoreWithBoundedWorkerInitRetry,
  runTursoBrowserWasmBootstrap,
} from '../src/bootstrap/turso-browser-wasm-bootstrap.js';

/**
 * Store-open reliability contract for the browser Turso WASM bootstrap.
 *
 * turso's connect() -> initThreadPool() exercises @emnapi/core's async-work
 * pool, whose initWorkers has an unguarded `PThread.pthreads[tid].whenLoaded`
 * dereference. On slow CI that startup race surfaces as
 * `TypeError: Cannot read properties of undefined (reading 'whenLoaded')`
 * during store open. The bootstrap must retry ONLY that narrow vendor-glue
 * signature a bounded number of times (logged, never silent) and fail closed
 * immediately on every other open error.
 */

const WORKER_INIT_FAULT_MESSAGE = "Cannot read properties of undefined (reading 'whenLoaded')";
const BOOTSTRAP_LOG_SCOPE = 'DB:TursoBrowserWasmBootstrap';

describe('Turso browser WASM bootstrap worker-init fault handling', () => {
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
    installBrowserWasmPrerequisites();
  });

  afterEach(() => {
    restoreDescriptor(globalThis, 'crossOriginIsolated', originalCrossOriginIsolated);
    restoreDescriptor(globalThis, 'SharedArrayBuffer', originalSharedArrayBuffer);
    restoreDescriptor(globalThis, 'navigator', originalNavigator);
  });

  it('retries a transient emnapi worker-init fault, logs the retry, and proceeds past store.open', async () => {
    const database = createMockBrowserTursoDatabase();
    let openAttempts = 0;
    const openDatabase = vi.fn(async (_path: string) => {
      openAttempts += 1;
      if (openAttempts === 1) {
        throw new TypeError(WORKER_INIT_FAULT_MESSAGE);
      }
      return database;
    });
    const retryWarnings: string[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.level === LogLevel.WARN && record.scope === BOOTSTRAP_LOG_SCOPE) {
        retryWarnings.push(record.message ?? '');
      }
    });

    try {
      const report = await runTursoBrowserWasmBootstrap({
        dbPath: 'brainstrike-web-turso.db',
        generatedAt: createClock(),
        openDatabase,
        profileId: 'web-turso',
      });

      expect(openDatabase).toHaveBeenCalledTimes(2);
      expect(report.bootstrapReport).toMatchObject({ phase: 'ready', ready: true });
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'store.open',
            message: expect.stringContaining('emnapi worker-init'),
            status: 'passed',
          }),
          expect.objectContaining({ id: 'primary-store.journal-mode', status: 'passed' }),
          expect.objectContaining({ id: 'schema.baseline', status: 'passed' }),
          expect.objectContaining({ id: 'store.close', status: 'passed' }),
        ])
      );
      expect(retryWarnings).toHaveLength(1);
      expect(retryWarnings[0]).toContain('emnapi worker-init');
    } finally {
      unsubscribe();
    }
  });

  it('fails closed at store.open after bounded retries when the worker-init fault persists', async () => {
    const openDatabase = vi.fn(async (_path: string) => {
      throw new TypeError(WORKER_INIT_FAULT_MESSAGE);
    });

    const report = await runTursoBrowserWasmBootstrap({
      dbPath: 'brainstrike-web-turso.db',
      generatedAt: createClock(),
      openDatabase,
      profileId: 'web-turso',
    });

    // Initial attempt + 2 bounded retries.
    expect(openDatabase).toHaveBeenCalledTimes(3);
    expect(report.bootstrapReport).toMatchObject({
      failure: {
        code: 'turso_browser_wasm_bootstrap_failed',
        message: expect.stringContaining('emnapi worker-init'),
        phase: 'opening-store',
      },
      phase: 'failed',
      ready: false,
    });
    expect(report.bootstrapReport.failure?.message).toContain('retries were exhausted');
    expect(report.bootstrapReport.failure?.message).toContain('whenLoaded');
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: 'store.open',
        message: expect.stringContaining('emnapi worker-init'),
        status: 'failed',
      })
    );
  });

  it('chains the original worker-init fault as cause on the retry-exhaustion error', async () => {
    // The bootstrap report layer sanitizes failures to message/name strings,
    // so the cause chain is asserted at the store-open seam directly.
    const originalFault = new TypeError(WORKER_INIT_FAULT_MESSAGE);
    const openDatabase = vi.fn(async (_path: string) => {
      throw originalFault;
    });

    let thrown: unknown = null;
    try {
      await openTursoBrowserWasmStoreWithBoundedWorkerInitRetry(
        openDatabase,
        'brainstrike-web-turso.db'
      );
    } catch (error) {
      thrown = error;
    }

    expect(openDatabase).toHaveBeenCalledTimes(3);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('retries were exhausted');
    expect((thrown as Error).cause).toBe(originalFault);
  });

  it('does not retry open errors outside the worker-init signature', async () => {
    const openDatabase = vi.fn(async (_path: string) => {
      throw new Error('disk full');
    });
    const retryWarnings: string[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.level === LogLevel.WARN && record.scope === BOOTSTRAP_LOG_SCOPE) {
        retryWarnings.push(record.message ?? '');
      }
    });

    try {
      const report = await runTursoBrowserWasmBootstrap({
        dbPath: 'brainstrike-web-turso.db',
        generatedAt: createClock(),
        openDatabase,
        profileId: 'web-turso',
      });

      expect(openDatabase).toHaveBeenCalledTimes(1);
      expect(retryWarnings).toEqual([]);
      expect(report.bootstrapReport).toMatchObject({
        failure: {
          code: 'turso_browser_wasm_bootstrap_failed',
          message: 'disk full',
          phase: 'opening-store',
        },
        phase: 'failed',
        ready: false,
      });
      expect(report.checks).toContainEqual(
        expect.objectContaining({ id: 'store.open', message: 'disk full', status: 'failed' })
      );
    } finally {
      unsubscribe();
    }
  });
});

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

function createMockBrowserTursoDatabase() {
  const createStatement = (sql: string) => ({
    all: vi.fn(async (_params?: readonly unknown[]) => {
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
    run: vi.fn(async (_params?: readonly unknown[]) => undefined),
  });

  return {
    close: vi.fn(async () => undefined),
    exec: vi.fn(async () => undefined),
    prepare: vi.fn(async (sql: string) => createStatement(sql)),
  };
}

function createClock(): () => string {
  let tick = 0;
  return () => `2026-07-04T00:00:0${tick++}.000Z`;
}
