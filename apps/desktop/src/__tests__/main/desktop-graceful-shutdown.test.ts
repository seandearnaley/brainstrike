import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDesktopGracefulShutdown,
  DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS,
  DESKTOP_SHUTDOWN_STEP_ORDER,
  type DesktopGracefulShutdownOptions,
  type DesktopShutdownStepName,
  type DesktopShutdownStepRun,
} from '../../main/desktop-graceful-shutdown';

type StepOverrides = Partial<Record<DesktopShutdownStepName, DesktopShutdownStepRun>>;

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

function createHarness(
  overrides: StepOverrides = {},
  extra: { readonly deadlineMs?: number; readonly drained?: () => boolean } = {}
): Harness {
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
    return { isAssistantServerDrained: extra.drained ?? (() => true), steps };
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

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop graceful shutdown', () => {
  it('retires admission, then runs every step once in the canonical order', async () => {
    const { events, logger, options } = createHarness();

    await createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');

    expect(events.slice(0, 3)).toEqual(['mark-shutting-down', 'retire-admission', 'plan']);
    expect(stepEvents(events)).toEqual(DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => `step:${name}`));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Graceful shutdown completed', {
      steps: DESKTOP_SHUTDOWN_STEP_ORDER.map((step) => ({ elapsedMs: 0, failed: false, step })),
      stepsMs: 0,
      trigger: 'before-quit',
    });
    expect(options.exitProcess).not.toHaveBeenCalled();
  });

  it('pins the documented order: renderers first, database before the error log', () => {
    expect(DESKTOP_SHUTDOWN_STEP_ORDER).toEqual([
      'renderers',
      'assistant-server',
      'mcp-runtime',
      'chunking-host',
      'parser-host',
      'embedding-host',
      'llm-host',
      'git-inventory',
      'forge',
      'database',
      'error-log-sink',
    ]);
  });

  it('isolates a failing step and logs every failure once, before the sink closes', async () => {
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
    expect(warnAt).toBeGreaterThan(events.indexOf('step:database'));
    expect(warnAt).toBeLessThan(events.indexOf('step:error-log-sink'));
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
    const { logger, options } = createHarness({
      database: () => Promise.reject(new Error('close failed')),
      'error-log-sink': () => {
        throw new Error('sink close failed');
      },
    });

    await createDesktopGracefulShutdown(options).run('signal', 'SIGINT');

    expect(logger.warn).toHaveBeenCalledWith('Graceful shutdown completed with cleanup failures', {
      failures: [expect.objectContaining({ message: 'close failed', step: 'database' })],
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
  });

  it('forces an exit at the deadline, naming the in-flight step and aborting it', async () => {
    let embeddingSignal: AbortSignal | undefined;
    const { events, logger, options } = createHarness(
      {
        'embedding-host': (signal) => {
          embeddingSignal = signal;
          return new Promise<void>(() => undefined);
        },
      },
      { deadlineMs: 20 }
    );

    await createDesktopGracefulShutdown(options).run('signal', 'SIGTERM');

    expect(logger.error).toHaveBeenCalledWith(
      'Timed out waiting for graceful shutdown; forcing exit',
      { inFlightStep: { elapsedMs: 0, step: 'embedding-host' }, trigger: 'SIGTERM' }
    );
    expect(options.exitProcess).toHaveBeenCalledWith(1);
    expect(embeddingSignal?.aborted).toBe(true);
    // Nothing after the stuck owner runs, and no completion is claimed.
    expect(events).not.toContain('step:llm-host');
    expect(logger.info).not.toHaveBeenCalled();
    // The step deadline handled it, so the backstop was cleared: one exit.
    await wait(20 + DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS + 50);
    expect(options.exitProcess).toHaveBeenCalledTimes(1);
  });

  it('clears the backstop when every step finishes in time', async () => {
    const { options } = createHarness({}, { deadlineMs: 20 });

    await createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');
    await wait(20 + DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS + 50);

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

    vi.advanceTimersByTime(5000 + DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS);

    expect(options.exitProcess).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Timed out waiting for graceful shutdown; forcing exit',
      { backstop: true, inFlightStep: null, trigger: 'SIGTERM' }
    );
    // A later trigger joins the failed run instead of rejecting.
    await expect(shutdown.run('before-quit', 'before-quit')).resolves.toBeUndefined();
  });

  it('still closes the error-log sink when the failure warn throws', async () => {
    const { events, logger, options } = createHarness({
      database: () => Promise.reject(new Error('close failed')),
    });
    logger.warn.mockImplementation(() => {
      throw new Error('logger broke');
    });

    await createDesktopGracefulShutdown(options).run('before-quit', 'before-quit');

    expect(events).toContain('step:error-log-sink');
    expect(logger.error).toHaveBeenCalledWith('Failed to close the durable NDJSON error log', {
      failure: expect.objectContaining({ message: 'logger broke', step: 'error-log-sink' }),
      trigger: 'before-quit',
    });
  });
});
