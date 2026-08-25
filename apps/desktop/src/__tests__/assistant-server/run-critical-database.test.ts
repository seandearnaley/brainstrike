import { MASTRA_WORKFLOW_TABLE } from '@brainstrike/agent/pglite-mastra-memory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunCriticalDatabase,
  runCriticalDatabaseOperation,
} from '../../assistant-server/run-critical-database';
import { DbHostRequestTimeoutError } from '../../db-host-manager';
import {
  getDesktopDatabaseWorkSchedulerSnapshot,
  resetDesktopDatabaseWorkSchedulerForTests,
  runDesktopScheduledDatabaseWork,
} from '../../platform/desktop-database-work';

describe('run-critical database work', () => {
  afterEach(() => {
    resetDesktopDatabaseWorkSchedulerForTests();
  });

  it('queues run-critical work as foreground under database saturation', async () => {
    resetDesktopDatabaseWorkSchedulerForTests({ foregroundQuietMs: 0 });
    let releaseBackground!: () => void;
    const backgroundStarted = new Promise<void>((resolve) => {
      void runDesktopScheduledDatabaseWork(
        { label: 'saturating-background-work', priority: 'background' },
        async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseBackground = release;
          });
        }
      );
    });
    await backgroundStarted;

    const operation = vi.fn(async () => 'snapshot');
    const criticalWork = runCriticalDatabaseOperation({
      label: 'assistant-workflow-snapshot-read',
      operation,
      retry: 'none',
    });
    await Promise.resolve();

    expect(operation).not.toHaveBeenCalled();
    expect(getDesktopDatabaseWorkSchedulerSnapshot()).toMatchObject({
      queued: { background: 0, foreground: 1, normal: 0 },
      queuedLabels: {
        foreground: ['assistant-workflow-snapshot-read'],
      },
      runningPriority: 'background',
    });

    releaseBackground();
    await expect(criticalWork).resolves.toBe('snapshot');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries one eligible saturated-host timeout and reports the retry', async () => {
    const timeout = new DbHostRequestTimeoutError({
      pendingCount: 2,
      requestKind: 'query',
      timeoutMs: 30_000,
      willTerminateHost: false,
    });
    const operation = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce('snapshot');
    const onRetry = vi.fn();

    await expect(
      runCriticalDatabaseOperation({
        label: 'assistant-workflow-snapshot-read',
        onRetry,
        operation,
        retry: 'idempotent',
      })
    ).resolves.toBe('snapshot');

    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith({ attempt: 2, error: timeout });
  });

  it.each([
    {
      error: new Error('arbitrary database failure'),
      name: 'an arbitrary failure',
    },
    {
      error: new DbHostRequestTimeoutError({
        pendingCount: 1,
        requestKind: 'query',
        timeoutMs: 30_000,
        willTerminateHost: false,
      }),
      name: 'a potentially wedged host timeout',
    },
    {
      error: new DbHostRequestTimeoutError({
        pendingCount: 2,
        requestKind: 'transaction:start',
        timeoutMs: 30_000,
        willTerminateHost: true,
      }),
      name: 'a terminating host timeout',
    },
  ])('surfaces $name without retrying', async ({ error }) => {
    const operation = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();

    await expect(
      runCriticalDatabaseOperation({
        label: 'assistant-workflow-snapshot-read',
        onRetry,
        operation,
        retry: 'idempotent',
      })
    ).rejects.toBe(error);

    expect(operation).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('surfaces the typed failure after exactly one retry is exhausted', async () => {
    const firstTimeout = new DbHostRequestTimeoutError({
      pendingCount: 2,
      requestKind: 'query',
      timeoutMs: 30_000,
      willTerminateHost: false,
    });
    const terminalTimeout = new DbHostRequestTimeoutError({
      pendingCount: 2,
      requestKind: 'query',
      timeoutMs: 30_000,
      willTerminateHost: false,
    });
    const operation = vi
      .fn()
      .mockRejectedValueOnce(firstTimeout)
      .mockRejectedValueOnce(terminalTimeout);
    const onRetry = vi.fn();

    await expect(
      runCriticalDatabaseOperation({
        label: 'assistant-run-event-write',
        onRetry,
        operation,
        retry: 'idempotent',
      })
    ).rejects.toBe(terminalTimeout);

    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('retries only workflow snapshot reads and survives an evidence sink failure', async () => {
    const timeout = new DbHostRequestTimeoutError({
      pendingCount: 3,
      requestKind: 'query',
      timeoutMs: 30_000,
      willTerminateHost: false,
    });
    const query = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValueOnce({ rows: [] });
    const eventSink = vi.fn(() => {
      throw new Error('evidence sink failed');
    });
    const database = createRunCriticalDatabase(
      {
        exec: vi.fn(),
        query,
      },
      { eventSink, runId: 'run-saturated' }
    );

    await expect(
      database.query(`SELECT snapshot FROM ${MASTRA_WORKFLOW_TABLE} WHERE run_id = $1`, [
        'run-saturated',
      ])
    ).resolves.toEqual({ rows: [] });

    expect(query).toHaveBeenCalledTimes(2);
    expect(eventSink).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'run.database.retried',
        metadata: expect.objectContaining({
          attempt: 2,
          operation: 'assistant-run-database-query',
          pendingCount: 3,
        }),
        runId: 'run-saturated',
        status: 'info',
      })
    );
  });
});
