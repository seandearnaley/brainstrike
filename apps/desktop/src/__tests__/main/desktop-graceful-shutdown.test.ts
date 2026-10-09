import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB_HOST_CLOSE_BUDGET_MS } from '../../db-host-close-budget';
import {
  createDesktopGracefulShutdown,
  DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS,
  DESKTOP_SHUTDOWN_STEP_ORDER,
  type DesktopGracefulShutdownOptions,
  type DesktopShutdownStepName,
  type DesktopShutdownStepRun,
} from '../../main/desktop-graceful-shutdown';

type StepOverrides = Partial<Record<DesktopShutdownStepName, DesktopShutdownStepRun>>;

interface HarnessExtras {
  /** The reserved database-close slice; it runs after the sequence, deadline or not. */
  readonly closeDatabase?: () => Promise<void> | void;
  readonly closeErrorLogSink?: () => void;
  readonly deadlineMs?: number;
  readonly drained?: () => boolean;
}

interface Harness {
  readonly events: string[];
  readonly logger: {
    readonly error: ReturnType<typeof vi.fn>;
    readonly info: ReturnType<typeof vi.fn>;
    readonly warn: ReturnType<typeof vi.fn>;
  };
  readonly options: DesktopGracefulShutdownOptions;
  readonly planRun: ReturnType<typeof vi.fn>;
}

function createHarness(overrides: StepOverrides = {}, extra: HarnessExtras = {}): Harness {
  const events: string[] = [];
  const logger = {
    error: vi.fn((message: string) => void events.push(`log:error:${message}`)),
    info: vi.fn((message: string) => void events.push(`log:info:${message}`)),
    warn: vi.fn((message: string) => void events.push(`log:warn:${message}`)),
  };
  const planRun = vi.fn(() => {
    events.push('plan');
    const steps = Object.fromEntries(
      DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => [
        name,
        (signal: AbortSignal) => {
          events.push(`step:${name}`);
          return overrides[name]?.(signal);
        },
      ])
    ) as Record<DesktopShutdownStepName, DesktopShutdownStepRun>;
    return {
      closeDatabase: async () => {
        events.push('close:database');
        await extra.closeDatabase?.();
      },
      closeErrorLogSink: () => {
        events.push('close:error-log-sink');
        extra.closeErrorLogSink?.();
      },
      isAssistantServerDrained: extra.drained ?? (() => true),
      steps,
    };
  });
  const options: DesktopGracefulShutdownOptions = {
    deadlineMs: extra.deadlineMs ?? 60_000,
    exitProcess: vi.fn((code: number) => void events.push(`exit:${code}`)),
    logger,
    markShuttingDown: vi.fn(() => void events.push('mark-shutting-down')),
    now: () => 0,
    planRun,
    retireBackgroundAdmission: vi.fn(() => void events.push('retire-admission')),
  };
  return { events, logger, options, planRun };
}

const stepEvents = (events: readonly string[]): string[] =>
  events.filter((event) => event.startsWith('step:'));

const FORCED_EXIT_LOG = 'log:error:Timed out waiting for graceful shutdown; forcing exit';

const backstopMs = (deadlineMs: number): number =>
  deadlineMs + DB_HOST_CLOSE_BUDGET_MS + DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS;

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop graceful shutdown', () => {
  it('retires admission, runs every step once in the canonical order, then closes the database and the log sink', async () => {
    const { events, logger, options } = createHarness();

    await createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');

    expect(events.slice(0, 3)).toEqual(['mark-shutting-down', 'retire-admission', 'plan']);
    expect(stepEvents(events)).toEqual(DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => `step:${name}`));
    // The reserved slice follows the last sequence step; the sink closes last of all.
    expect(events.slice(-3)).toEqual([
      'close:database',
      'close:error-log-sink',
      'log:info:Graceful shutdown completed',
    ]);
    expect(events.indexOf('close:database')).toBeGreaterThan(events.indexOf('step:database-drain'));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Graceful shutdown completed', {
      steps: [
        ...DESKTOP_SHUTDOWN_STEP_ORDER.map((step) => ({ elapsedMs: 0, failed: false, step })),
        { elapsedMs: 0, failed: false, step: 'database-close' },
      ],
      stepsMs: 0,
      trigger: 'before-quit',
    });
    expect(options.exitProcess).not.toHaveBeenCalled();
  });

  it('pins the documented order: a reset in flight first, the database drain last, no log-sink step', () => {
    expect(DESKTOP_SHUTDOWN_STEP_ORDER).toEqual([
      'factory-reset',
      'renderers',
      'assistant-server',
      'native-index',
      'mcp-runtime',
      'file-system',
      'chunking-host',
      'parser-host',
      'embedding-host',
      'llm-host',
      'git-inventory',
      'forge',
      'database-drain',
    ]);
  });

  it('joins filesystem retirement before stopping inference hosts or closing the database', async () => {
    const retirement = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const { events, options } = createHarness({
      'file-system': async () => {
        entered.resolve();
        await retirement.promise;
      },
    });

    const shutdown = createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');
    // If the filesystem step is absent, the run completes and the assertions
    // still report the skipped ownership boundary instead of hanging this test.
    await Promise.race([entered.promise, shutdown]);

    expect(events).toContain('step:file-system');
    expect(events).not.toContain('step:chunking-host');
    expect(events).not.toContain('step:embedding-host');
    expect(events).not.toContain('close:database');

    retirement.resolve();
    await shutdown;

    expect(events.indexOf('step:chunking-host')).toBeGreaterThan(
      events.indexOf('step:file-system')
    );
    expect(events).toContain('close:database');
  });

  it('isolates a failing step and logs every failure once, after the database close and before the sink closes', async () => {
    const { events, logger, options } = createHarness({
      'embedding-host': () => Promise.reject(new Error('stop timed out')),
      forge: () => {
        throw new TypeError('unregister threw');
      },
    });

    await createDesktopGracefulShutdown(options).run('signal', 'SIGTERM');

    expect(stepEvents(events)).toEqual(DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => `step:${name}`));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Graceful shutdown completed with cleanup failures', {
      failures: [
        expect.objectContaining({ message: 'stop timed out', step: 'embedding-host' }),
        expect.objectContaining({ message: 'unregister threw', name: 'TypeError', step: 'forge' }),
      ],
      trigger: 'signal',
    });
    const warnAt = events.indexOf('log:warn:Graceful shutdown completed with cleanup failures');
    expect(warnAt).toBeGreaterThan(events.indexOf('close:database'));
    expect(warnAt).toBeLessThan(events.indexOf('close:error-log-sink'));
    expect(logger.info).toHaveBeenCalledWith(
      'Graceful shutdown completed',
      expect.objectContaining({
        steps: expect.arrayContaining([
          { elapsedMs: 0, failed: true, step: 'embedding-host' },
          { elapsedMs: 0, failed: true, step: 'forge' },
        ]),
      })
    );
  });

  it('closes the database even when the drain step failed, and reports both', async () => {
    const { events, logger, options } = createHarness({
      'database-drain': () => Promise.reject(new Error('idle join failed')),
    });

    await createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');

    expect(events).toContain('close:database');
    expect(logger.warn).toHaveBeenCalledWith('Graceful shutdown completed with cleanup failures', {
      failures: [expect.objectContaining({ message: 'idle join failed', step: 'database-drain' })],
      trigger: 'before-quit',
    });
  });

  it('records a failed database close as the database-close step in the aggregate warn', async () => {
    const { events, logger, options } = createHarness(
      {},
      { closeDatabase: () => Promise.reject(new Error('DB host failed to close')) }
    );

    await createDesktopGracefulShutdown(options).run('signal', 'SIGINT');

    expect(logger.warn).toHaveBeenCalledWith('Graceful shutdown completed with cleanup failures', {
      failures: [
        expect.objectContaining({ message: 'DB host failed to close', step: 'database-close' }),
      ],
      trigger: 'signal',
    });
    expect(events).toContain('close:error-log-sink');
    expect(logger.info).toHaveBeenCalledWith(
      'Graceful shutdown completed',
      expect.objectContaining({
        steps: expect.arrayContaining([{ elapsedMs: 0, failed: true, step: 'database-close' }]),
      })
    );
    expect(options.exitProcess).not.toHaveBeenCalled();
  });

  it('records McpShutdownOrderingError when MCP closed before the assistant server drained', async () => {
    const { logger, options } = createHarness(
      { 'mcp-runtime': () => Promise.reject(new Error('host close failed')) },
      { drained: () => false }
    );

    await createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');

    expect(logger.warn).toHaveBeenCalledWith(
      'Graceful shutdown completed with cleanup failures',
      expect.objectContaining({
        // The step's own failure first, then the ordering violation.
        failures: [
          expect.objectContaining({ message: 'host close failed', step: 'mcp-runtime' }),
          {
            message: 'Closed MCP host before assistant-server drain completed',
            name: 'McpShutdownOrderingError',
            step: 'mcp-runtime',
          },
        ],
      })
    );
  });

  it('reads the drain state after the MCP step, not when the run starts', async () => {
    let drained = false;
    const { logger, options } = createHarness(
      {
        'assistant-server': () => {
          drained = true;
        },
      },
      { drained: () => drained }
    );

    await createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs a failed sink close on its own and keeps it out of the aggregate failures', async () => {
    const { logger, options } = createHarness(
      {},
      {
        closeDatabase: () => Promise.reject(new Error('close failed')),
        closeErrorLogSink: () => {
          throw new Error('sink close failed');
        },
      }
    );

    await createDesktopGracefulShutdown(options).run('signal', 'SIGINT');

    expect(logger.warn).toHaveBeenCalledWith('Graceful shutdown completed with cleanup failures', {
      failures: [expect.objectContaining({ message: 'close failed', step: 'database-close' })],
      trigger: 'signal',
    });
    expect(logger.error).toHaveBeenCalledWith('Failed to close the durable NDJSON error log', {
      failure: expect.objectContaining({ message: 'sink close failed', step: 'error-log-sink' }),
      trigger: 'signal',
    });
  });

  it('joins a run already in flight: marks again, but never re-retires or re-plans', async () => {
    const { promise: gate, resolve: open } = Promise.withResolvers<void>();
    const { events, options, planRun } = createHarness({ renderers: () => gate });
    const shutdown = createDesktopGracefulShutdown(options);

    const first = shutdown.run('before-quit', 'before-quit');
    const second = shutdown.run('signal', 'SIGTERM');
    open();
    await Promise.all([first, second]);

    expect(options.markShuttingDown).toHaveBeenCalledTimes(2);
    expect(options.retireBackgroundAdmission).toHaveBeenCalledTimes(1);
    expect(planRun).toHaveBeenCalledTimes(1);
    expect(stepEvents(events)).toHaveLength(DESKTOP_SHUTDOWN_STEP_ORDER.length);
    expect(events.filter((event) => event === 'close:database')).toHaveLength(1);
  });

  it('at the deadline: logs the forced exit, still closes the database, and only then exits 1', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let embeddingSignal: AbortSignal | undefined;
    const closing = Promise.withResolvers<void>();
    const { events, logger, options } = createHarness(
      {
        'embedding-host': (signal) => {
          embeddingSignal = signal;
          return new Promise<void>(() => undefined);
        },
      },
      { closeDatabase: () => closing.promise, deadlineMs: 20 }
    );

    const running = createDesktopGracefulShutdown(options).run('signal', 'SIGTERM');
    await vi.advanceTimersByTimeAsync(20);

    expect(logger.error).toHaveBeenCalledWith(
      'Timed out waiting for graceful shutdown; forcing exit',
      { inFlightStep: { elapsedMs: 0, step: 'embedding-host' }, trigger: 'SIGTERM' }
    );
    expect(embeddingSignal?.aborted).toBe(true);
    // The database close is reserved: it runs although the deadline passed, and the exit waits for it.
    await vi.waitFor(() => expect(events).toContain('close:database'));
    expect(options.exitProcess).not.toHaveBeenCalled();
    closing.resolve();
    await running;

    expect(options.exitProcess).toHaveBeenCalledExactlyOnceWith(1);
    expect(
      events.filter((event) => event.startsWith('close:') || event.startsWith('exit:'))
    ).toEqual(['close:database', 'exit:1']);
    expect(events.indexOf(FORCED_EXIT_LOG)).toBeLessThan(events.indexOf('close:database'));
    expect(events.indexOf('close:database')).toBeLessThan(events.indexOf('exit:1'));
    // Nothing after the stuck owner runs, no completion is claimed, and the sink stays open.
    expect(events).not.toContain('step:llm-host');
    expect(events).not.toContain('close:error-log-sink');
    expect(logger.info).not.toHaveBeenCalled();
    // The step deadline handled it, so the backstop was cleared: one exit.
    await vi.advanceTimersByTimeAsync(backstopMs(20));
    expect(options.exitProcess).toHaveBeenCalledTimes(1);
  });

  it('a database close that fails after the deadline is logged, and the exit is still 1', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { logger, options } = createHarness(
      { forge: () => new Promise<void>(() => undefined) },
      { closeDatabase: () => Promise.reject(new Error('DB host failed to close')), deadlineMs: 20 }
    );

    const running = createDesktopGracefulShutdown(options).run('signal', 'SIGINT');
    await vi.advanceTimersByTimeAsync(20);
    await running;

    expect(logger.error).toHaveBeenCalledWith('Database close failed during a forced shutdown', {
      failure: expect.objectContaining({
        message: 'DB host failed to close',
        step: 'database-close',
      }),
      trigger: 'signal',
    });
    expect(options.exitProcess).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('still exits 1 at the deadline when logging the failed database close throws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { logger, options } = createHarness(
      { forge: () => new Promise<void>(() => undefined) },
      { closeDatabase: () => Promise.reject(new Error('DB host failed to close')), deadlineMs: 20 }
    );
    logger.error.mockImplementation(() => {
      throw new Error('logger broke');
    });

    const running = createDesktopGracefulShutdown(options).run('signal', 'SIGINT');
    await vi.advanceTimersByTimeAsync(20);
    await running;

    // A throwing logger must never cancel the exit, here or at the deadline log.
    expect(options.exitProcess).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('clears the backstop when every step finishes in time', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { options } = createHarness({}, { deadlineMs: 20 });

    await createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');
    await vi.advanceTimersByTimeAsync(backstopMs(20));

    expect(options.exitProcess).not.toHaveBeenCalled();
  });

  it.each([
    [
      'planRun',
      {
        planRun: () => {
          throw new Error('plan failed');
        },
      },
    ],
    [
      'retireBackgroundAdmission',
      {
        retireBackgroundAdmission: () => {
          throw new Error('retire failed');
        },
      },
    ],
  ] as const)('resolves and still bounds the exit when %s throws', async (_name, broken) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { logger, options } = createHarness({}, { deadlineMs: 5000 });
    const shutdown = createDesktopGracefulShutdown({ ...options, ...broken });

    // Callers go on to quit: the run never rejects.
    await expect(shutdown.run('signal', 'SIGTERM')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Graceful shutdown orchestration failed',
      expect.objectContaining({ trigger: 'signal' })
    );
    expect(options.exitProcess).not.toHaveBeenCalled();

    // The backstop covers the owner steps AND the reserved database-close slice.
    vi.advanceTimersByTime(5000 + DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS);
    expect(options.exitProcess).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DB_HOST_CLOSE_BUDGET_MS);

    expect(options.exitProcess).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Timed out waiting for graceful shutdown; forcing exit',
      { backstop: true, inFlightStep: null, trigger: 'SIGTERM' }
    );
    // A later trigger joins the failed run instead of rejecting.
    await expect(shutdown.run('before-quit', 'before-quit')).resolves.toBeUndefined();
  });

  it('does not re-arm the backstop for a trigger after the run finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { options } = createHarness({}, { deadlineMs: 20 });
    const shutdown = createDesktopGracefulShutdown(options);

    await shutdown.run('before-quit', 'before-quit');
    // A late signal after before-quit completed joins the finished run.
    await shutdown.run('signal', 'SIGTERM');
    await vi.advanceTimersByTimeAsync(backstopMs(20));

    expect(options.exitProcess).not.toHaveBeenCalled();
  });

  it('still forces the exit when logging the forced exit throws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { logger, options } = createHarness({}, { deadlineMs: 5000 });
    logger.error.mockImplementation(() => {
      throw new Error('logger broke');
    });
    const shutdown = createDesktopGracefulShutdown({
      ...options,
      planRun: () => {
        throw new Error('plan failed');
      },
    });

    await shutdown.run('signal', 'SIGTERM');
    vi.advanceTimersByTime(backstopMs(5000));

    expect(options.exitProcess).toHaveBeenCalledWith(1);
  });

  it('still closes the error-log sink when the failure warn throws', async () => {
    const { events, logger, options } = createHarness(
      {},
      { closeDatabase: () => Promise.reject(new Error('close failed')) }
    );
    logger.warn.mockImplementation(() => {
      throw new Error('logger broke');
    });

    await createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');

    expect(events).toContain('close:error-log-sink');
    expect(logger.error).toHaveBeenCalledWith('Failed to close the durable NDJSON error log', {
      failure: expect.objectContaining({ message: 'logger broke', step: 'error-log-sink' }),
      trigger: 'before-quit',
    });
  });
});
