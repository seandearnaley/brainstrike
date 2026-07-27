import {
  __resetDiagnosticsRetentionStoreForTests,
  useDiagnosticsRetentionStore,
} from '@brainstrike/preferences/stores/diagnostics-retention-store';
import {
  LogLevel,
  type LogRecord,
  error as logError,
  warn as logWarn,
} from '@brainstrike/utils/logger';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticSinkBridge } from '../diagnostics/diagnostic-sink-bridge';
import {
  resetDiagnosticSinkHealthStore,
  useDiagnosticSinkHealthStore,
} from '../diagnostics/diagnostic-sink-health-store';
import { DIAGNOSTIC_SINK_SCOPE } from '../diagnostics/diagnostic-sink-session';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Mock the db context to hand the bridge an in-memory query recorder.
const queries: { sql: string; params?: unknown[] | undefined }[] = [];
// Toggled by the "writer disables" test below to make every INSERT reject,
// driving the writer's own failure/retry accounting. Left false for every
// other test so their inserts continue to succeed unchanged.
let rejectInserts = false;
let deferredInsertFailure: Promise<never> | null = null;
function createDatabaseIdentity() {
  return {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ params, sql });
      if (rejectInserts && sql.includes('INSERT INTO brainstrike_diagnostic_events')) {
        if (deferredInsertFailure) {
          const failure = deferredInsertFailure;
          deferredInsertFailure = null;
          return failure;
        }
        throw new Error('simulated sink insert failure');
      }
      return { rows: [] };
    },
  };
}
let databaseIdentity = createDatabaseIdentity();
vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPGliteDatabase: () => databaseIdentity,
}));

function insertAttempts(): number {
  return queries.filter((entry) => entry.sql.includes('INSERT INTO brainstrike_diagnostic_events'))
    .length;
}

async function driveWriterFailures(
  attemptCount: number,
  code: string,
  messagePrefix: string
): Promise<void> {
  const attemptOffset = insertAttempts();
  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    logError(`${messagePrefix} ${attemptOffset + attempt}`, { code });
    await vi.waitFor(() => {
      expect(insertAttempts()).toBeGreaterThanOrEqual(attemptOffset + attempt);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function driveWriterToDisable(code: string, messagePrefix: string): Promise<void> {
  await driveWriterFailures(5, code, messagePrefix);
  await vi.waitFor(() => {
    expect(useDiagnosticSinkHealthStore.getState().disabledReason).not.toBeNull();
  });
}

describe('DiagnosticSinkBridge', () => {
  beforeEach(() => {
    queries.length = 0;
    deferredInsertFailure = null;
    rejectInserts = false;
    databaseIdentity = createDatabaseIdentity();
    resetDiagnosticSinkHealthStore();
    __resetDiagnosticsRetentionStoreForTests();
  });

  it('captures a warn+ log record into the diagnostic events table', async () => {
    render(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);
    logError('bridge test failure', { code: 'bridge_test' });
    await vi.waitFor(() => {
      const insert = queries.find((entry) =>
        entry.sql.includes('INSERT INTO brainstrike_diagnostic_events')
      );
      expect(insert).toBeDefined();
      expect(JSON.stringify(insert?.params)).toContain('bridge_test');
    });
  });

  it('flushes eagerly on error severity instead of waiting for the batch window', async () => {
    // No flushBatchSize override: uses the writer's default (32) so a lone
    // event only reaches the sink via the eager-flush path, not batching.
    render(<DiagnosticSinkBridge source="web-renderer" />);
    logError('eager flush error', { code: 'eager_flush_test' });

    // Default flushIntervalMs is 2000ms; a short timeout here proves the
    // insert landed via eager flush, not the interval timer.
    await vi.waitFor(
      () => {
        const insert = queries.find((entry) =>
          entry.sql.includes('INSERT INTO brainstrike_diagnostic_events')
        );
        expect(insert).toBeDefined();
        expect(JSON.stringify(insert?.params)).toContain('eager_flush_test');
      },
      { timeout: 500 }
    );

    // Let the error's in-flight drain loop fully settle (it sweeps up
    // anything enqueued while still draining) before establishing the
    // negative-case baseline — a real macrotask tick guarantees every
    // microtask-chained continuation from the eager flush has completed.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const insertCountAfterError = queries.filter((entry) =>
      entry.sql.includes('INSERT INTO brainstrike_diagnostic_events')
    ).length;

    // A lone warn must NOT trigger an eager flush — bounded negative check
    // well inside the 2000ms interval window.
    logWarn('bounded warn, should not flush yet', { code: 'warn_no_eager_flush' });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const insertCountAfterWarn = queries.filter((entry) =>
      entry.sql.includes('INSERT INTO brainstrike_diagnostic_events')
    ).length;
    expect(insertCountAfterWarn).toBe(insertCountAfterError);
  });

  it('runs the startup retention purge', async () => {
    render(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);
    await vi.waitFor(() => {
      expect(
        queries.some((entry) => entry.sql.includes('DELETE FROM brainstrike_diagnostic_events'))
      ).toBe(true);
    });
  });

  it("passes the user's CONFIGURED retention values to the startup purge, not the repository defaults", async () => {
    useDiagnosticsRetentionStore.getState().setMaxAgeDays(7);
    useDiagnosticsRetentionStore.getState().setMaxRows(5000);

    render(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);

    await vi.waitFor(() => {
      expect(
        queries.some((entry) => entry.sql.includes('DELETE FROM brainstrike_diagnostic_events'))
      ).toBe(true);
    });

    // The over-cap delete binds `maxRows` as its sole OFFSET param.
    const overCapDelete = queries.find(
      (entry) =>
        entry.sql.includes('DELETE FROM brainstrike_diagnostic_events') &&
        entry.sql.includes('OFFSET $1')
    );
    expect(overCapDelete?.params).toEqual([5000]);

    // The aged-rows delete binds an ISO cutoff derived from maxAgeDays; the
    // repository's untouched default would be 30 days out, so pinning to a
    // window around the CONFIGURED 7-day cutoff (rather than the 30-day
    // default) proves the store's value reached the purge call.
    const agedDelete = queries.find(
      (entry) =>
        entry.sql.includes('DELETE FROM brainstrike_diagnostic_events') &&
        entry.sql.includes('occurred_at <')
    );
    const cutoffIso = agedDelete?.params?.[0] as string;
    const cutoffMs = new Date(cutoffIso).getTime();
    const expectedCutoffMs = Date.now() - 7 * MS_PER_DAY;
    expect(Math.abs(cutoffMs - expectedCutoffMs)).toBeLessThan(5000);
  });

  it('enqueues a forwarded record into the same writer with a derived source', async () => {
    const captured: { listener: ((record: LogRecord) => void) | null } = { listener: null };
    const unsubscribe = vi.fn();

    render(
      <DiagnosticSinkBridge
        flushBatchSize={1}
        forwardedRecords={{
          subscribe: (listener) => {
            captured.listener = listener;
            return unsubscribe;
          },
        }}
        source="desktop-renderer"
      />
    );

    await vi.waitFor(() => {
      expect(captured.listener).not.toBeNull();
    });

    captured.listener?.({
      args: ['forwarded from hidden host'],
      bindings: { runtime: 'electron-renderer', sourceWindowRole: 'chunking-host' },
      level: LogLevel.ERROR,
      message: 'forwarded from hidden host',
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      const insert = queries.find((entry) =>
        entry.sql.includes('INSERT INTO brainstrike_diagnostic_events')
      );
      expect(insert).toBeDefined();
      expect(JSON.stringify(insert?.params)).toContain('chunking-host');
    });
  });

  it("derives the 'electron-main' source for records whose bindings.runtime is electron-main", async () => {
    const captured: { listener: ((record: LogRecord) => void) | null } = { listener: null };

    render(
      <DiagnosticSinkBridge
        flushBatchSize={1}
        forwardedRecords={{
          subscribe: (listener) => {
            captured.listener = listener;
            return () => {};
          },
        }}
        source="desktop-renderer"
      />
    );

    await vi.waitFor(() => {
      expect(captured.listener).not.toBeNull();
    });

    captured.listener?.({
      args: ['main process failure'],
      bindings: { runtime: 'electron-main' },
      level: LogLevel.ERROR,
      message: 'main process failure',
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      const insert = queries.find((entry) =>
        entry.sql.includes('INSERT INTO brainstrike_diagnostic_events')
      );
      expect(insert).toBeDefined();
      expect(JSON.stringify(insert?.params)).toContain('electron-main');
    });
  });

  it('respects the DiagnosticSink loop-guard for forwarded records', async () => {
    const captured: { listener: ((record: LogRecord) => void) | null } = { listener: null };

    render(
      <DiagnosticSinkBridge
        flushBatchSize={1}
        forwardedRecords={{
          subscribe: (listener) => {
            captured.listener = listener;
            return () => {};
          },
        }}
        source="desktop-renderer"
      />
    );

    await vi.waitFor(() => {
      expect(captured.listener).not.toBeNull();
    });

    // Self-referential record from the sink's own scope must never recurse
    // into an insert, forwarded or not.
    captured.listener?.({
      args: ['diagnostic sink self-loop'],
      bindings: { runtime: 'electron-main' },
      level: LogLevel.ERROR,
      message: 'diagnostic sink self-loop',
      scope: DIAGNOSTIC_SINK_SCOPE,
      timestamp: Date.now(),
    });

    captured.listener?.({
      args: ['forwarded normal failure'],
      bindings: { runtime: 'electron-main' },
      level: LogLevel.ERROR,
      message: 'forwarded normal failure',
      timestamp: Date.now(),
    });

    await vi.waitFor(() => {
      const insert = queries.find((entry) =>
        entry.sql.includes('INSERT INTO brainstrike_diagnostic_events')
      );
      expect(insert).toBeDefined();
      expect(JSON.stringify(insert?.params)).toContain('forwarded normal failure');
    });

    const sinkScopedInserts = queries.filter(
      (entry) =>
        entry.sql.includes('INSERT INTO brainstrike_diagnostic_events') &&
        JSON.stringify(entry.params).includes('diagnostic sink self-loop')
    );
    expect(sinkScopedInserts).toHaveLength(0);
  });

  it('unsubscribes from forwardedRecords on unmount', async () => {
    const captured: { listener: ((record: LogRecord) => void) | null } = { listener: null };
    const unsubscribe = vi.fn();

    const { unmount } = render(
      <DiagnosticSinkBridge
        flushBatchSize={1}
        forwardedRecords={{
          subscribe: (listener) => {
            captured.listener = listener;
            return unsubscribe;
          },
        }}
        source="desktop-renderer"
      />
    );

    await vi.waitFor(() => {
      expect(captured.listener).not.toBeNull();
    });

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('populates the sink health store once the writer disables from repeated flush failures', async () => {
    rejectInserts = true;
    render(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBeNull();

    // The writer's default maxConsecutiveFailures is 5
    // (packages/utils/src/diagnostics/diagnostic-event-writer.ts). With
    // flushBatchSize=1, one logError call enqueues + eagerly flushes exactly
    // one event per cycle. A failed flush's own cleanup (consecutiveFailures
    // increment, requeue, clearing the in-flight guard) finishes a few
    // microtask ticks AFTER `vi.waitFor` first observes the insert attempt,
    // so a next logError fired too early would see the writer still
    // "in flight" and its event would silently pile up in `pending` instead
    // of starting a new attempt. The macrotask boundary below (a real
    // `setTimeout`) forces that cleanup to fully settle before the next
    // attempt, so this genuinely drives 5 CONSECUTIVE writer-level failures
    // rather than asserting the health store directly.
    await driveWriterToDisable('bridge_disable_test', 'bridge disable drive');
    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toContain(
      'simulated sink insert failure'
    );

    // The writer is now disabled: further enqueues are no-ops, so no 6th
    // insert attempt should ever appear.
    logError('after disable, should not be attempted', { code: 'bridge_disable_test' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(insertAttempts()).toBe(5);
  });

  it('clears stale health on a new database writer and re-arms if the replacement fails', async () => {
    rejectInserts = true;
    const { rerender } = render(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);

    await driveWriterToDisable('bridge_replacement_test', 'bridge replacement drive');

    rejectInserts = false;
    databaseIdentity = createDatabaseIdentity();
    rerender(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);

    await vi.waitFor(() => {
      expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBeNull();
    });

    logError('replacement writer accepts events', { code: 'bridge_replacement_healthy' });
    await vi.waitFor(() => {
      expect(
        queries.some(
          (entry) =>
            entry.sql.includes('INSERT INTO brainstrike_diagnostic_events') &&
            JSON.stringify(entry.params).includes('bridge_replacement_healthy')
        )
      ).toBe(true);
    });

    rejectInserts = true;
    await driveWriterToDisable('bridge_replacement_test', 'bridge replacement drive');
    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toContain(
      'simulated sink insert failure'
    );
  });

  it('ignores a disable callback that settles after its writer is retired', async () => {
    rejectInserts = true;
    const { rerender } = render(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);

    await driveWriterFailures(4, 'bridge_retired_writer_test', 'bridge retired writer drive');

    const deferredInsert = {
      reject: (_cause: Error): void => {
        throw new Error('deferred insert rejection unavailable for test');
      },
    };
    deferredInsertFailure = new Promise<never>((_resolve, reject) => {
      deferredInsert.reject = reject;
    });
    logError('bridge retired writer pending failure', { code: 'bridge_retired_writer_test' });
    await vi.waitFor(() => {
      expect(insertAttempts()).toBe(5);
    });

    rejectInserts = false;
    databaseIdentity = createDatabaseIdentity();
    rerender(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);
    await vi.waitFor(() => {
      expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBeNull();
    });

    deferredInsert.reject(new Error('retired writer insert failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toBeNull();
  });

  it('does not clear a disabled warning when non-database props rebuild the writer', async () => {
    rejectInserts = true;
    const { rerender } = render(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);
    await driveWriterToDisable('bridge_same_database_test', 'bridge same database drive');

    rerender(<DiagnosticSinkBridge flushBatchSize={1} source="desktop-renderer" />);

    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toContain(
      'simulated sink insert failure'
    );
  });
});
