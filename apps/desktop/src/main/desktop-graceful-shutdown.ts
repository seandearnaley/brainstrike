import { runShutdownSequence, type ShutdownStepOutcome } from '@brainstrike/effect-kit';
import { type SerializedDesktopError, serializeDesktopError } from '../desktop-error-serialization';

/**
 * The ONE order desktop main tears down in. Each owner stops while everything
 * it depends on is still alive: renderers before the hosts they call, the
 * assistant server before the MCP host it uses, git and forge before the
 * database they read, and the durable error log last so it can record every
 * earlier failure. See platform-contracts.md § "Graceful shutdown ownership".
 */
export const DESKTOP_SHUTDOWN_STEP_ORDER = [
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
] as const;

export type DesktopShutdownStepName = (typeof DESKTOP_SHUTDOWN_STEP_ORDER)[number];

export type DesktopShutdownTrigger = 'before-quit' | 'signal';

/** What the forced-exit log names as its trigger: the signal, or `before-quit`. */
export type DesktopForcedExitTrigger = NodeJS.Signals | 'before-quit';

export type DesktopShutdownStepRun = (signal: AbortSignal) => Promise<void> | void;

/** One run's step bodies, built when that run starts so they capture its state. */
export interface DesktopShutdownRunPlan {
  /** Read after 'mcp-runtime' settles; false records `McpShutdownOrderingError`. */
  readonly isAssistantServerDrained: () => boolean;
  readonly steps: Readonly<Record<DesktopShutdownStepName, DesktopShutdownStepRun>>;
}

export interface DesktopShutdownLogger {
  error(message: string, data: Record<string, unknown>): void;
  info(message: string, data: Record<string, unknown>): void;
  warn(message: string, data: Record<string, unknown>): void;
}

export interface DesktopGracefulShutdownOptions {
  /** The single forced-exit budget for every step (`SIGNAL_SHUTDOWN_TIMEOUT_MS`). */
  readonly deadlineMs: number;
  readonly exitProcess: (code: number) => void;
  readonly logger: DesktopShutdownLogger;
  /** Latched on every call, including a call that joins a run already in flight. */
  readonly markShuttingDown: () => void;
  readonly now?: (() => number) | undefined;
  readonly planRun: () => DesktopShutdownRunPlan;
  /** Runs once, before any step: background work must stop restarting owners. */
  readonly retireBackgroundAdmission: () => void;
}

export interface DesktopGracefulShutdown {
  /**
   * Runs the ordered steps once. A later call, from any trigger, joins the
   * first run. Resolves even when steps fail; the failures are logged.
   */
  run(trigger: DesktopShutdownTrigger, forcedExitTrigger: DesktopForcedExitTrigger): Promise<void>;
}

function toFailure(outcome: ShutdownStepOutcome): SerializedDesktopError | null {
  return outcome.outcome === 'failed'
    ? { step: outcome.step, ...serializeDesktopError(outcome.error) }
    : null;
}

export function createDesktopGracefulShutdown(
  options: DesktopGracefulShutdownOptions
): DesktopGracefulShutdown {
  const { deadlineMs, exitProcess, logger, markShuttingDown, planRun } = options;
  let running: Promise<void> | null = null;

  const runOnce = async (
    trigger: DesktopShutdownTrigger,
    forcedExitTrigger: DesktopForcedExitTrigger
  ): Promise<void> => {
    const plan = planRun();
    const failures: SerializedDesktopError[] = [];
    // A holder, not a `let`: it is assigned inside the settle callback, which
    // control-flow narrowing cannot see.
    const sink: { closeFailure: SerializedDesktopError | null } = { closeFailure: null };

    const recordSettled = (outcome: ShutdownStepOutcome): void => {
      const failure = toFailure(outcome);
      if (outcome.step === 'error-log-sink') {
        // Not added to `failures`: the aggregate warn that reads them has
        // already run, and the sink that just failed is the NDJSON backstop.
        sink.closeFailure = failure;
        return;
      }
      if (failure) {
        failures.push(failure);
      }
      if (outcome.step === 'mcp-runtime' && !plan.isAssistantServerDrained()) {
        failures.push({
          message: 'Closed MCP host before assistant-server drain completed',
          name: 'McpShutdownOrderingError',
          step: 'mcp-runtime',
        });
      }
    };

    const steps = DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => ({
      name,
      run:
        name === 'error-log-sink'
          ? (signal: AbortSignal) => {
              // The ONLY log of the failures above, and it MUST precede the
              // sink close: a closed sink makes this very record a no-op in
              // the NDJSON backstop.
              if (failures.length > 0) {
                logger.warn('Graceful shutdown completed with cleanup failures', {
                  failures,
                  trigger,
                });
              }
              return plan.steps[name](signal);
            }
          : plan.steps[name],
    }));

    const report = await runShutdownSequence(steps, {
      deadlineMs,
      now: options.now,
      onDeadline: (inFlight) => {
        logger.error('Timed out waiting for graceful shutdown; forcing exit', {
          inFlightStep: inFlight,
          trigger: forcedExitTrigger,
        });
        exitProcess(1);
      },
      onStepSettled: recordSettled,
    });
    if (report.timedOut) {
      return;
    }

    if (sink.closeFailure) {
      logger.error('Failed to close the durable NDJSON error log', {
        failure: sink.closeFailure,
        trigger,
      });
    }
    // Per-step durations are the only record that explains a slow (but not
    // forced) exit; the forced-exit path logs the in-flight step instead.
    const completed = report.steps.map(({ elapsedMs, outcome, step }) => ({
      elapsedMs,
      failed: outcome === 'failed',
      step,
    }));
    logger.info('Graceful shutdown completed', {
      steps: completed,
      stepsMs: completed.reduce((total, step) => total + step.elapsedMs, 0),
      trigger,
    });
  };

  return {
    run: async (trigger, forcedExitTrigger) => {
      // Latch before any teardown so work torn down mid-flight (an in-flight
      // embedding backfill, say) logs as a benign stop, not a failure.
      markShuttingDown();
      if (running) {
        await running;
        return;
      }
      options.retireBackgroundAdmission();
      running = runOnce(trigger, forcedExitTrigger);
      await running;
    },
  };
}
