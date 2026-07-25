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
vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPGliteDatabase: () => ({
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ params, sql });
      if (rejectInserts && sql.includes('INSERT INTO brainstrike_diagnostic_events')) {
        throw new Error('simulated sink insert failure');
      }
      return { rows: [] };
    },
  }),
}));

describe('DiagnosticSinkBridge', () => {
  beforeEach(() => {
    queries.length = 0;
    rejectInserts = false;
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

    const insertAttempts = () =>
      queries.filter((entry) => entry.sql.includes('INSERT INTO brainstrike_diagnostic_events'))
        .length;

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
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      logError(`bridge disable drive ${attempt}`, { code: 'bridge_disable_test' });
      // Sequential await is required: each attempt must observably land
      // before the next enqueue, or several events would bunch into one
      // flush cycle and understate the failure count.
      await vi.waitFor(() => {
        expect(insertAttempts()).toBe(attempt);
      });
      // Forces the macrotask boundary described above between each attempt.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    await vi.waitFor(() => {
      expect(useDiagnosticSinkHealthStore.getState().disabledReason).not.toBeNull();
    });
    expect(useDiagnosticSinkHealthStore.getState().disabledReason).toContain(
      'simulated sink insert failure'
    );

    // The writer is now disabled: further enqueues are no-ops, so no 6th
    // insert attempt should ever appear.
    logError('after disable, should not be attempted', { code: 'bridge_disable_test' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(insertAttempts()).toBe(5);
  });
});
