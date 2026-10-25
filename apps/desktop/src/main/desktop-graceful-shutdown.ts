import { type SerializedDesktopError, serializeDesktopError } from '../desktop-error-serialization';

/**
 * Desktop quit (ADR-0031). A content clear in flight finishes first, then the
 * visible renderers flush their durable writers and close while the agent host
 * still serves them. Every other owner then closes together, the agent host
 * included (its stdin ends, a 5 s grace, then a kill): none waits on another,
 * because the host closes at the end of its stdin whatever Main has closed. The
 * durable error log closes last, so it records every earlier failure. See
 * platform-contracts.md § "Graceful shutdown ownership".
 */
type DesktopShutdownTrigger = 'before-quit' | 'signal';

export type DesktopShutdownStepRun = () => Promise<void> | void;

/** One run's step bodies, built when that run starts so they capture its state. */
export interface DesktopShutdownRunPlan {
  /** Closes the durable NDJSON error log. Runs last, after the aggregate failure warn. */
  readonly closeErrorLogSink: () => void;
  /** Finishes a content clear in flight; runs first. */
  readonly 'factory-reset': DesktopShutdownStepRun;
  /** Every other owner, closed together once the renderers have closed. */
  readonly owners: Readonly<Record<string, DesktopShutdownStepRun>>;
  /** The visible renderers flush and close, while the agent host still serves them. */
  readonly renderers: DesktopShutdownStepRun;
}

interface DesktopShutdownLogger {
  error(message: string, data: Record<string, unknown>): void;
  info(message: string, data: Record<string, unknown>): void;
  warn(message: string, data: Record<string, unknown>): void;
}

export interface DesktopGracefulShutdownOptions {
  /** Called only when the orchestration itself fails, so no step could run: exits 1. */
  readonly exitProcess: (code: number) => void;
  readonly logger: DesktopShutdownLogger;
  /** Latched on every call, including a call that joins a run already in flight. */
  readonly markShuttingDown: () => void;
  readonly now?: (() => number) | undefined;
  readonly planRun: () => DesktopShutdownRunPlan;
  /** Runs once, before the plan and any step: background work must stop restarting owners. */
  readonly retireBackgroundAdmission: () => void;
}

export interface DesktopGracefulShutdown {
  /**
   * Runs the quit once, each step until it settles. A later call, from any
   * trigger, joins the first run. Never rejects: step failures are logged, and
   * an orchestration failure is logged and exits 1.
   */
  run(trigger: DesktopShutdownTrigger): Promise<void>;
}

interface DesktopShutdownStepRecord {
  readonly elapsedMs: number;
  readonly failed: boolean;
  readonly step: string;
}

/**
 * Builds desktop main's one quit runner. Each step runs until it settles, and a
 * failed step is recorded while the rest still run. Then the failures are logged
 * at warn and the durable error log closes last. The per-step durations are
 * logged once at the end.
 */
export function createDesktopGracefulShutdown(
  options: DesktopGracefulShutdownOptions
): DesktopGracefulShutdown {
  const { exitProcess, logger, markShuttingDown, planRun } = options;
  const now = options.now ?? Date.now;
  let running: Promise<void> | null = null;

  const runOnce = async (trigger: DesktopShutdownTrigger): Promise<void> => {
    options.retireBackgroundAdmission();
    const plan = planRun();
    const steps: DesktopShutdownStepRecord[] = [];
    const failures: SerializedDesktopError[] = [];
    const runStep = async (step: string, body: DesktopShutdownStepRun): Promise<void> => {
      const startedAt = now();
      try {
        await body();
        steps.push({ elapsedMs: now() - startedAt, failed: false, step });
      } catch (error) {
        steps.push({ elapsedMs: now() - startedAt, failed: true, step });
        failures.push({ step, ...serializeDesktopError(error) });
      }
    };

    await runStep('factory-reset', plan['factory-reset']);
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- not independent: a content clear in flight finishes before its renderers close.
    await runStep('renderers', plan.renderers);
    // The renderers' last writes go through the agent host, so it closes after them.
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- not independent: see above.
    await Promise.all(Object.entries(plan.owners).map(([name, body]) => runStep(name, body)));

    // The warn is the only log of the failures, so it precedes the sink close.
    try {
      try {
        if (failures.length > 0) {
          logger.warn('Graceful shutdown completed with cleanup failures', { failures, trigger });
        }
      } finally {
        plan.closeErrorLogSink();
      }
    } catch (error) {
      logger.error('Failed to close the durable NDJSON error log', {
        failure: { step: 'error-log-sink', ...serializeDesktopError(error) },
        trigger,
      });
    }
    logger.info('Graceful shutdown completed', {
      steps,
      stepsMs: steps.reduce((total, step) => total + step.elapsedMs, 0),
      trigger,
    });
  };

  return {
    run: async (trigger) => {
      // Latch before any teardown so work torn down mid-flight logs as a benign stop.
      markShuttingDown();
      running ??= runOnce(trigger).catch((error: unknown) => {
        // The orchestration broke before or between its steps: the failure is the exit.
        try {
          logger.error('Graceful shutdown orchestration failed', {
            error: serializeDesktopError(error),
            trigger,
          });
        } catch {
          // The exit below is what matters; there is nowhere left to report this.
        }
        exitProcess(1);
      });
      await running;
    },
  };
}
