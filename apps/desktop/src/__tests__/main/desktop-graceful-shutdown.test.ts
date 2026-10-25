import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopGracefulShutdown,
  DESKTOP_SHUTDOWN_STEP_ORDER,
  type DesktopGracefulShutdownOptions,
  type DesktopShutdownStepName,
  type DesktopShutdownStepRun,
} from '../../main/desktop-graceful-shutdown';

type StepOverrides = Partial<Record<DesktopShutdownStepName, DesktopShutdownStepRun>>;

interface HarnessExtras {
  /** The database close; it runs after every step settled. */
  readonly closeDatabase?: () => Promise<void> | void;
  readonly closeErrorLogSink?: () => void;
  readonly now?: () => number;
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
        () => {
          events.push(`step:${name}`);
          return overrides[name]?.();
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
      steps,
    };
  });
  const options: DesktopGracefulShutdownOptions = {
    exitProcess: vi.fn((code: number) => void events.push(`exit:${code}`)),
    logger,
    markShuttingDown: vi.fn(() => void events.push('mark-shutting-down')),
    now: extra.now ?? (() => 0),
    planRun,
    retireBackgroundAdmission: vi.fn(() => void events.push('retire-admission')),
  };
  return { events, logger, options, planRun };
}

const stepEvents = (events: readonly string[]): string[] =>
  events.filter((event) => event.startsWith('step:'));

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop graceful shutdown', () => {
  it('retires admission, runs every step once in the canonical order, then closes the database and the log sink', async () => {
    const { events, logger, options } = createHarness();

    await createDesktopGracefulShutdown(options).run('before-quit');

    expect(events.slice(0, 3)).toEqual(['mark-shutting-down', 'retire-admission', 'plan']);
    expect(stepEvents(events)).toEqual(DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => `step:${name}`));
    // The database close follows the last sequence step; the sink closes last of all.
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
      'main-catalog',
      'native-index',
      'mcp-runtime',
      'file-system',
      'embedding-host',
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

    const shutdown = createDesktopGracefulShutdown(options).run('before-quit');
    // If the filesystem step is absent, the run completes and the assertions
    // still report the skipped ownership boundary instead of hanging this test.
    await Promise.race([entered.promise, shutdown]);

    expect(events).toContain('step:file-system');
    expect(events).not.toContain('step:embedding-host');
    expect(events).not.toContain('close:database');

    retirement.resolve();
    await shutdown;

    expect(events.indexOf('step:embedding-host')).toBeGreaterThan(
      events.indexOf('step:file-system')
    );
    expect(events).toContain('close:database');
  });

  it('isolates a failing step and logs every failure once, after the database close and before the sink closes', async () => {
    const { events, logger, options } = createHarness({
      'embedding-host': () => Promise.reject(new Error('stop failed')),
      'mcp-runtime': () => {
        throw new TypeError('unregister threw');
      },
    });

    await createDesktopGracefulShutdown(options).run('signal');

    expect(stepEvents(events)).toEqual(DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => `step:${name}`));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Graceful shutdown completed with cleanup failures', {
      failures: [
        expect.objectContaining({
          message: 'unregister threw',
          name: 'TypeError',
          step: 'mcp-runtime',
        }),
        expect.objectContaining({ message: 'stop failed', step: 'embedding-host' }),
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
          { elapsedMs: 0, failed: true, step: 'mcp-runtime' },
        ]),
      })
    );
    expect(options.exitProcess).not.toHaveBeenCalled();
  });

  it('closes the database even when the drain step failed, and reports both', async () => {
    const { events, logger, options } = createHarness({
      'database-drain': () => Promise.reject(new Error('idle join failed')),
    });

    await createDesktopGracefulShutdown(options).run('before-quit');

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

    await createDesktopGracefulShutdown(options).run('signal');

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

    await createDesktopGracefulShutdown(options).run('signal');

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

    const first = shutdown.run('before-quit');
    const second = shutdown.run('signal');
    open();
    await Promise.all([first, second]);

    expect(options.markShuttingDown).toHaveBeenCalledTimes(2);
    expect(options.retireBackgroundAdmission).toHaveBeenCalledTimes(1);
    expect(planRun).toHaveBeenCalledTimes(1);
    expect(stepEvents(events)).toHaveLength(DESKTOP_SHUTDOWN_STEP_ORDER.length);
    expect(events.filter((event) => event === 'close:database')).toHaveLength(1);
    // A later trigger after the run finished joins it too.
    await shutdown.run('signal');
    expect(planRun).toHaveBeenCalledTimes(1);
  });

  it('a renderers step that takes 15 s still runs file-system and exits 0', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { events, logger, options } = createHarness(
      { renderers: () => new Promise<void>((resolve) => setTimeout(resolve, 15_000)) },
      { now: () => Date.now() }
    );

    const running = createDesktopGracefulShutdown(options).run('before-quit');
    await vi.advanceTimersByTimeAsync(15_000);
    await running;

    expect(stepEvents(events)).toEqual(DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => `step:${name}`));
    expect(events).toContain('step:file-system');
    expect(events.slice(-2)).toEqual([
      'close:error-log-sink',
      'log:info:Graceful shutdown completed',
    ]);
    // Exit 0: Main quits normally once every owner settled; nothing forces an exit.
    expect(options.exitProcess).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    // A slow step is only waited for: nothing warns, fails or forces an exit.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Graceful shutdown completed',
      expect.objectContaining({
        steps: expect.arrayContaining([
          { elapsedMs: 15_000, failed: false, step: 'renderers' },
          { elapsedMs: 0, failed: false, step: 'file-system' },
        ]),
      })
    );
  });

  // The steps a 2-core Windows run found in flight when the old deadline forced exit 1.
  it.each(['main-catalog', 'native-index'] as const)(
    'a %s step that takes 15 s is joined, every later step runs, and nothing forces an exit',
    async (slow) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { events, logger, options } = createHarness(
        { [slow]: () => new Promise<void>((resolve) => setTimeout(resolve, 15_000)) },
        { now: () => Date.now() }
      );

      const running = createDesktopGracefulShutdown(options).run('signal');
      await vi.advanceTimersByTimeAsync(15_000);
      await running;

      expect(stepEvents(events)).toEqual(DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => `step:${name}`));
      expect(events).toContain('close:database');
      expect(options.exitProcess).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    }
  );

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
  ] as const)('logs a broken orchestration and exits 1 when %s throws', async (_name, broken) => {
    const { logger, options } = createHarness();
    const shutdown = createDesktopGracefulShutdown({ ...options, ...broken });

    // Callers go on to quit: the run never rejects.
    await expect(shutdown.run('signal')).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'Graceful shutdown orchestration failed',
      expect.objectContaining({ trigger: 'signal' })
    );
    expect(options.exitProcess).toHaveBeenCalledExactlyOnceWith(1);
    // A later trigger joins the failed run instead of rejecting or exiting again.
    await expect(shutdown.run('before-quit')).resolves.toBeUndefined();
    expect(options.exitProcess).toHaveBeenCalledOnce();
  });

  it('still exits 1 for a broken orchestration when logging it throws', async () => {
    const { logger, options } = createHarness();
    logger.error.mockImplementation(() => {
      throw new Error('logger broke');
    });
    const shutdown = createDesktopGracefulShutdown({
      ...options,
      planRun: () => {
        throw new Error('plan failed');
      },
    });

    await expect(shutdown.run('signal')).resolves.toBeUndefined();
    expect(options.exitProcess).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('still closes the error-log sink when the failure warn throws', async () => {
    const { events, logger, options } = createHarness(
      {},
      { closeDatabase: () => Promise.reject(new Error('close failed')) }
    );
    logger.warn.mockImplementation(() => {
      throw new Error('logger broke');
    });

    await createDesktopGracefulShutdown(options).run('before-quit');

    expect(events).toContain('close:error-log-sink');
    expect(logger.error).toHaveBeenCalledWith('Failed to close the durable NDJSON error log', {
      failure: expect.objectContaining({ message: 'logger broke', step: 'error-log-sink' }),
      trigger: 'before-quit',
    });
  });
});
