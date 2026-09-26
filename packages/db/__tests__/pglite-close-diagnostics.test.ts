import { addLogListener, configureLogger, type LogRecord, resetLogger } from '@brainstrike/logging';
import { logRecordToDiagnosticEvent } from '@brainstrike/utils/diagnostics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabaseWorkScheduler } from '../src/database-work-scheduler';
import { createPgliteDirectTransport } from '../src/pglite-direct-transport';

const { close, closeCached, createPGliteClient } = vi.hoisted(() => {
  const close = vi.fn<() => Promise<void>>();
  return {
    close,
    closeCached: vi.fn<() => Promise<void>>(),
    createPGliteClient: vi.fn(async () => ({ close })),
  };
});
vi.mock('../src/wasm-loader', () => ({
  wasmLoader: { closeCached, createPGliteClient, ensureWasmLoaded: vi.fn(async () => {}) },
}));

beforeEach(() => {
  vi.clearAllMocks();
  close.mockResolvedValue();
  closeCached.mockResolvedValue();
  configureLogger({ console: false });
});
afterEach(() => resetLogger());

describe.each(['memory://', 'opfs-ahp://private-profile'])(
  'close diagnostics for %s',
  (dataDir) => {
    it.each([
      { error: undefined, expected: false, label: 'successful close' },
      { error: new Error('PGlite is closed'), expected: false, label: 'already closed' },
      {
        error: new Error('filesystem closed unexpectedly'),
        expected: true,
        label: 'unexpected error mentioning closed',
      },
      { error: 'disk failure', expected: true, label: 'non-Error rejection' },
    ])('$label', async ({ error, expected }) => {
      const cached = dataDir.startsWith('opfs-ahp:');
      if (error !== undefined) {
        (cached ? closeCached : close).mockRejectedValue(error);
      }
      const records: LogRecord[] = [];
      const unsubscribe = addLogListener((record) => records.push(record));
      try {
        const transport = createPgliteDirectTransport({ getDataDir: () => dataDir });
        // A client constructed after disposal must close without installing a DB.
        await expect(
          transport.open({ isDisposed: () => true, scheduler: createDatabaseWorkScheduler() })
        ).resolves.toBeNull();
        expect(cached ? closeCached : close).toHaveBeenCalledTimes(1);
        expect(cached ? close : closeCached).not.toHaveBeenCalled();
        const events = records.flatMap((record) => {
          const event = logRecordToDiagnosticEvent(record, {
            appVersion: 'test',
            makeId: () => 'event',
            platform: 'test',
            sessionId: 'session',
            source: 'renderer',
          });
          return event ? [event] : [];
        });
        expect(events).toHaveLength(expected ? 1 : 0);
        if (expected) {
          expect(events[0]).toMatchObject({
            code: 'database_close_failed',
            context: { storage: cached ? 'browser-persistent' : 'direct' },
            scope: 'DbProvider',
            severity: 'error',
          });
          expect(JSON.stringify(events)).not.toContain('private-profile');
        }
      } finally {
        unsubscribe();
      }
    });
  }
);
