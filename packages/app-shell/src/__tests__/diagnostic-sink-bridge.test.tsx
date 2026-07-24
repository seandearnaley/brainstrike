import { error as logError } from '@brainstrike/utils/logger';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
});
