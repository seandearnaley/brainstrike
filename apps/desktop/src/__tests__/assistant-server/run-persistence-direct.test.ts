/**
 * Main's run-event writer, driven directly (BST-972 A1 made the database
 * provider a literal argument, so no module mocks, no HTTP harness and no real
 * PGlite are needed; the schema-backed half lives in
 * run-event-schema-provenance).
 */
import type { AssistantRunEvent } from '@brainstrike/agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordDesktopAssistantRunEvent } from '../../assistant-server/run-persistence';
import { DbHostRequestTimeoutError } from '../../db-host-manager';
import { resetDesktopDatabaseWorkSchedulerForTests } from '../../platform/desktop-database-work';

const mockDesktopDatabase = {
  query: vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>(),
};

beforeEach(() => {
  resetDesktopDatabaseWorkSchedulerForTests();
  mockDesktopDatabase.query.mockReset();
  mockDesktopDatabase.query.mockResolvedValue({ rows: [] });
});

describe('run-event persistence', () => {
  it('upserts one event with retry evidence when the timed-out insert later completes', async () => {
    const persistedEvents = new Map<string, string | null>();
    let completeTimedOutInsert!: () => void;
    const timedOutInsertCompletion = new Promise<void>((resolve) => {
      completeTimedOutInsert = resolve;
    });
    const timeout = new DbHostRequestTimeoutError({
      pendingCount: 2,
      requestKind: 'query',
      timeoutMs: 30_000,
      willTerminateHost: false,
    });
    mockDesktopDatabase.query.mockImplementation(async (sql, params) => {
      if (!sql.includes('INSERT INTO brainstrike_assistant_run_events')) {
        return { rows: [] };
      }
      const eventId = params?.[0];
      const metadata = params?.[7];
      if (typeof eventId !== 'string') {
        throw new Error('Expected a run-event id.');
      }
      if (mockDesktopDatabase.query.mock.calls.length === 1) {
        void timedOutInsertCompletion.then(() => {
          persistedEvents.set(eventId, typeof metadata === 'string' ? metadata : null);
        });
        throw timeout;
      }
      await timedOutInsertCompletion;
      persistedEvents.set(eventId, typeof metadata === 'string' ? metadata : null);
      return { rows: [] };
    });

    const event = {
      id: 'event-idempotent-retry',
      kind: 'run.step.started',
      label: 'Step started',
      metadata: { authorization: 'must-not-persist' },
      status: 'running',
      timestamp: '2026-08-25T00:00:00.000Z',
    } satisfies AssistantRunEvent;
    const write = recordDesktopAssistantRunEvent(
      'run-idempotent-retry',
      event,
      async () => mockDesktopDatabase
    );
    await vi.waitFor(() => expect(mockDesktopDatabase.query).toHaveBeenCalledTimes(2));
    expect(persistedEvents.size).toBe(0);
    completeTimedOutInsert();
    await write;

    expect(mockDesktopDatabase.query).toHaveBeenCalledTimes(2);
    expect(mockDesktopDatabase.query.mock.calls[0]?.[1]?.[0]).toBe('event-idempotent-retry');
    expect(mockDesktopDatabase.query.mock.calls[1]?.[1]?.[0]).toBe('event-idempotent-retry');
    expect(persistedEvents.size).toBe(1);
    const persistedMetadata = JSON.parse(persistedEvents.get('event-idempotent-retry') ?? '{}');
    expect(persistedMetadata).not.toHaveProperty('authorization');
    expect(persistedMetadata).toMatchObject({
      databaseRetry: {
        attempt: 2,
        reason: 'host-saturated-timeout',
      },
    });
  });
});
