import { LogLevel, type LogRecord, error as logError } from '@brainstrike/utils/logger';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticSinkBridge } from '../diagnostics/diagnostic-sink-bridge';

// Mock the db context to hand the bridge an in-memory query recorder.
const queries: { sql: string; params?: unknown[] | undefined }[] = [];
vi.mock('@brainstrike/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPGliteDatabase: () => ({
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ params, sql });
      return { rows: [] };
    },
  }),
}));

describe('DiagnosticSinkBridge', () => {
  beforeEach(() => {
    queries.length = 0;
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

  it('runs the startup retention purge', async () => {
    render(<DiagnosticSinkBridge flushBatchSize={1} source="web-renderer" />);
    await vi.waitFor(() => {
      expect(
        queries.some((entry) => entry.sql.includes('DELETE FROM brainstrike_diagnostic_events'))
      ).toBe(true);
    });
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
});
