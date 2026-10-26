import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopGracefulShutdown,
  type DesktopGracefulShutdownOptions,
  type DesktopShutdownStepRun,
} from '../../main/desktop-graceful-shutdown';

/** Main's quit owners, as main.ts plans them. */
const OWNERS = [
  'agent-host',
  'agent-host-clients',
  'embedding-host',
  'file-system',
  'main-catalog',
  'mcp-runtime',
  'native-index',
  'process-sampler',
] as const;

type StepName = 'factory-reset' | 'renderers' | (typeof OWNERS)[number];
type StepOverrides = Partial<Record<StepName, DesktopShutdownStepRun>>;

interface HarnessExtras {
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
    warn: vi.fn(
      (message: string, _data?: Record<string, unknown>) => void events.push(`log:warn:${message}`)
    ),
  };
  const step =
    (name: StepName): DesktopShutdownStepRun =>
    () => {
      events.push(`step:${name}`);
      return overrides[name]?.();
    };
  const planRun = vi.fn(() => {
    events.push('plan');
    return {
      closeErrorLogSink: () => {
        events.push('close:error-log-sink');
        extra.closeErrorLogSink?.();
      },
      'factory-reset': step('factory-reset'),
      owners: Object.fromEntries(OWNERS.map((name) => [name, step(name)])),
      renderers: step('renderers'),
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

const EVERY_STEP = ['factory-reset', 'renderers', ...OWNERS].map((name) => `step:${name}`);

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop graceful shutdown', () => {
  it('retires admission, closes a reset in flight, then the renderers, then every owner, then the log sink', async () => {
    const { events, logger, options } = createHarness();

    await createDesktopGracefulShutdown(options).run('before-quit');

    expect(events.slice(0, 3)).toEqual(['mark-shutting-down', 'retire-admission', 'plan']);
    expect(stepEvents(events)).toEqual(EVERY_STEP);
    // The sink closes last of all.
    expect(events.slice(-2)).toEqual([
      'close:error-log-sink',
      'log:info:Graceful shutdown completed',
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Graceful shutdown completed', {
      steps: ['factory-reset', 'renderers', ...OWNERS].map((step) => ({
        elapsedMs: 0,
        failed: false,
        step,
      })),
      stepsMs: 0,
      trigger: 'before-quit',
    });
    expect(options.exitProcess).not.toHaveBeenCalled();
  });

  it('closes no owner before the renderers have closed, and every owner without waiting on another', async () => {
    const renderers = Promise.withResolvers<void>();
    const host = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const { events, options } = createHarness({
      'agent-host': async () => {
        entered.resolve();
        await host.promise;
      },
      renderers: () => renderers.promise,
    });

    const shutdown = createDesktopGracefulShutdown(options).run('before-quit');
    await vi.waitFor(() => expect(events).toContain('step:renderers'));
    expect(stepEvents(events)).toEqual(['step:factory-reset', 'step:renderers']);

    renderers.resolve();
    await entered.promise;
    // The agent host's close is held; every other owner closes beside it.
    expect(stepEvents(events)).toEqual(EVERY_STEP);
    expect(events).not.toContain('close:error-log-sink');

    host.resolve();
    await shutdown;
    expect(events).toContain('close:error-log-sink');
  });

  it('joins a reset in flight before the renderers close', async () => {
    const reset = Promise.withResolvers<void>();
    const { events, options } = createHarness({ 'factory-reset': () => reset.promise });

    const shutdown = createDesktopGracefulShutdown(options).run('before-quit');
    await vi.waitFor(() => expect(events).toContain('step:factory-reset'));
    await Promise.resolve();
    expect(events).not.toContain('step:renderers');

    reset.resolve();
    await shutdown;
    expect(stepEvents(events)).toEqual(EVERY_STEP);
  });

  it('isolates a failing step and logs every failure once, before the sink closes', async () => {
    const { events, logger, options } = createHarness({
      'embedding-host': () => Promise.reject(new Error('stop failed')),
      'mcp-runtime': () => {
        throw new TypeError('unregister threw');
      },
      renderers: () => Promise.reject(new Error('flush failed')),
    });

    await createDesktopGracefulShutdown(options).run('signal');

    expect(stepEvents(events)).toEqual(EVERY_STEP);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Graceful shutdown completed with cleanup failures', {
      failures: expect.arrayContaining([
        expect.objectContaining({ message: 'flush failed', step: 'renderers' }),
        expect.objectContaining({
          message: 'unregister threw',
          name: 'TypeError',
          step: 'mcp-runtime',
        }),
        expect.objectContaining({ message: 'stop failed', step: 'embedding-host' }),
      ]),
      trigger: 'signal',
    });
    // Each failure once, and nothing else in the aggregate.
    expect(logger.warn.mock.calls[0]?.[1]?.['failures']).toHaveLength(3);
    const warnAt = events.indexOf('log:warn:Graceful shutdown completed with cleanup failures');
    expect(warnAt).toBeLessThan(events.indexOf('close:error-log-sink'));
    expect(logger.info).toHaveBeenCalledWith(
      'Graceful shutdown completed',
      expect.objectContaining({
        steps: expect.arrayContaining([
          { elapsedMs: 0, failed: true, step: 'embedding-host' },
          { elapsedMs: 0, failed: true, step: 'mcp-runtime' },
          { elapsedMs: 0, failed: true, step: 'renderers' },
        ]),
      })
    );
    expect(options.exitProcess).not.toHaveBeenCalled();
  });

  it('logs a failed sink close on its own and keeps it out of the aggregate failures', async () => {
    const { logger, options } = createHarness(
      { 'native-index': () => Promise.reject(new Error('close failed')) },
      {
        closeErrorLogSink: () => {
          throw new Error('sink close failed');
        },
      }
    );

    await createDesktopGracefulShutdown(options).run('signal');

    expect(logger.warn).toHaveBeenCalledWith('Graceful shutdown completed with cleanup failures', {
      failures: [expect.objectContaining({ message: 'close failed', step: 'native-index' })],
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
    expect(stepEvents(events)).toEqual(EVERY_STEP);
    // A later trigger after the run finished joins it too.
    await shutdown.run('signal');
    expect(planRun).toHaveBeenCalledTimes(1);
  });

  // The steps a 2-core Windows run found in flight when the old deadline forced exit 1.
  it.each(['renderers', 'main-catalog', 'native-index'] as const)(
    'a %s step that takes 15 s is joined, every other step runs, and nothing forces an exit',
    async (slow) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const { events, logger, options } = createHarness(
        { [slow]: () => new Promise<void>((resolve) => setTimeout(resolve, 15_000)) },
        { now: () => Date.now() }
      );

      const running = createDesktopGracefulShutdown(options).run('signal');
      await vi.advanceTimersByTimeAsync(15_000);
      await running;

      expect(stepEvents(events)).toEqual(EVERY_STEP);
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
          steps: expect.arrayContaining([{ elapsedMs: 15_000, failed: false, step: slow }]),
        })
      );
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
    const { events, logger, options } = createHarness({
      'native-index': () => Promise.reject(new Error('close failed')),
    });
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
