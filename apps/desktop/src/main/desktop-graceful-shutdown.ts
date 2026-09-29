import { runShutdownSequence, type ShutdownStepOutcome } from '@brainstrike/effect-kit';
import { DB_HOST_CLOSE_BUDGET_MS } from '../db-host-close-budget';
import { type SerializedDesktopError, serializeDesktopError } from '../desktop-error-serialization';

/**
 * The ONE order desktop main tears down in. Each owner stops while everything
 * it depends on is still alive: renderers before the hosts they call, the
 * assistant server before the MCP host it uses, git and forge before the
 * database they read, and `database-drain` last: it stops everything that
 * issues database work. Two things deliberately sit OUTSIDE this sequence and
 * its budget: the database close itself (`DesktopShutdownRunPlan.closeDatabase`,
 * its own reserved slice that always runs) and the durable error-log close
 * (last of all, so the log can record every earlier failure). See
 * platform-contracts.md § "Graceful shutdown ownership".
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
  'database-drain',
] as const;

export type DesktopShutdownStepName = (typeof DESKTOP_SHUTDOWN_STEP_ORDER)[number];

export type DesktopShutdownTrigger = 'before-quit' | 'signal';

/**
 * How long past the step deadline AND the reserved database-close slice
 * (`DB_HOST_CLOSE_BUDGET_MS`) the backstop exits. The step deadline normally
 * fires first, aborting and naming the stuck step, and the close ladder bounds
 * itself; the backstop only acts when the orchestration itself failed (a
 * throwing `planRun`, say) and the steps never got their deadline.
 */
export const DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS = 250;

/** What the forced-exit log names as its trigger: the signal, or `before-quit`. */
export type DesktopForcedExitTrigger = NodeJS.Signals | 'before-quit';

export type DesktopShutdownStepRun = (signal: AbortSignal) => Promise<void> | void;

/** One run's step bodies, built when that run starts so they capture its state. */
export interface DesktopShutdownRunPlan {
  /**
   * The reserved database-close slice. Runs after the ordered steps whether they
   * finished or the deadline aborted one: the only step whose skip damages durable
   * state. It bounds itself (`DB_HOST_CLOSE_BUDGET_MS`); a failure is recorded as the
   * `database-close` step.
   */
  readonly closeDatabase: () => Promise<void>;
  /** Closes the durable NDJSON error log. Runs last, after the aggregate failure warn. */
  readonly closeErrorLogSink: () => void;
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
  /** Runs once, before the plan and any step: background work must stop restarting owners. */
  readonly retireBackgroundAdmission: () => void;
}

export interface DesktopGracefulShutdown {
  /**
   * Runs the ordered steps once. A later call, from any trigger, joins the
   * first run. Never rejects: step failures and an orchestration failure are
   * logged, and the process exit stays bounded either way.
   */
  run(trigger: DesktopShutdownTrigger, forcedExitTrigger: DesktopForcedExitTrigger): Promise<void>;
}

/** A failed step’s serialized failure record; null on success. */
function toFailure(outcome: ShutdownStepOutcome): SerializedDesktopError | null {
  return outcome.outcome === 'failed'
    ? { step: outcome.step, ...serializeDesktopError(outcome.error) }
    : null;
}

/** The reserved slice's own step name: it is not part of `DESKTOP_SHUTDOWN_STEP_ORDER`. */
const DATABASE_CLOSE_STEP = 'database-close' as const;

interface DatabaseCloseResult {
  readonly elapsedMs: number;
  readonly failure: SerializedDesktopError | null;
}

/** Runs the reserved database close. Never rejects: a failure is returned, to be recorded. */
async function runDatabaseClose(
  plan: DesktopShutdownRunPlan,
  now: () => number
): Promise<DatabaseCloseResult> {
  const startedAt = now();
  try {
    await plan.closeDatabase();
    return { elapsedMs: now() - startedAt, failure: null };
  } catch (error) {
    return {
      elapsedMs: now() - startedAt,
      failure: { step: DATABASE_CLOSE_STEP, ...serializeDesktopError(error) },
    };
  }
}

/**
 * The ONLY log of the failures, and it MUST precede the sink close: a closed
 * sink makes this very record a no-op in the NDJSON backstop. The close still
 * runs if the warn throws. Returns the failure of the warn or the close.
 */
function closeErrorLogSinkAfterFailureWarn(
  plan: DesktopShutdownRunPlan,
  failures: readonly SerializedDesktopError[],
  logger: DesktopShutdownLogger,
  trigger: DesktopShutdownTrigger
): SerializedDesktopError | null {
  try {
    try {
      if (failures.length > 0) {
        logger.warn('Graceful shutdown completed with cleanup failures', { failures, trigger });
      }
    } finally {
      plan.closeErrorLogSink();
    }
    return null;
  } catch (error) {
    return { step: 'error-log-sink', ...serializeDesktopError(error) };
  }
}

/**
 * Builds desktop main's one graceful-shutdown runner. `run()` latches the
 * shutdown flag, retires background admission, and runs
 * `DESKTOP_SHUTDOWN_STEP_ORDER` once under `deadlineMs`, then ALWAYS runs the
 * reserved database-close slice, then closes the durable error log (or, after a
 * deadline, exits 1). An unref'd backstop keeps the exit bounded even if the
 * orchestration itself fails.
 */
export function createDesktopGracefulShutdown(
  options: DesktopGracefulShutdownOptions
): DesktopGracefulShutdown {
  const { deadlineMs, exitProcess, logger, markShuttingDown, planRun } = options;
  const now = options.now ?? Date.now;
  let running: Promise<void> | null = null;
  let backstop: ReturnType<typeof setTimeout> | null = null;

  // A throwing logger must never cancel the exit, and rethrowing its error
  // from a timer would only add an uncaught exception to a dying process.
  const logForcedExit = (data: Record<string, unknown>): void => {
    try {
      logger.error('Timed out waiting for graceful shutdown; forcing exit', data);
    } catch {
      // The exit that follows is what matters; there is nowhere left to report this.
    }
  };

  // Armed before anything that can throw, so a broken orchestration still
  // exits within the budget. Unref'd: it never holds the process open itself.
  const armBackstop = (forcedExitTrigger: DesktopForcedExitTrigger): void => {
    if (backstop) {
      return;
    }
    backstop = setTimeout(
      () => {
        logForcedExit({ backstop: true, inFlightStep: null, trigger: forcedExitTrigger });
        exitProcess(1);
      },
      deadlineMs + DB_HOST_CLOSE_BUDGET_MS + DESKTOP_SHUTDOWN_BACKSTOP_GRACE_MS
    );
    backstop.unref?.();
  };

  const runOnce = async (
    trigger: DesktopShutdownTrigger,
    forcedExitTrigger: DesktopForcedExitTrigger
  ): Promise<void> => {
    options.retireBackgroundAdmission();
    const plan = planRun();
    const failures: SerializedDesktopError[] = [];

    const recordSettled = (outcome: ShutdownStepOutcome): void => {
      const failure = toFailure(outcome);
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

    const report = await runShutdownSequence(
      DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => ({ name, run: plan.steps[name] })),
      {
        deadlineMs,
        now: options.now,
        // Only logs: the exit waits for the database close below.
        onDeadline: (inFlight) => {
          logForcedExit({ inFlightStep: inFlight, trigger: forcedExitTrigger });
        },
        onStepSettled: recordSettled,
      }
    );

    // The one step whose skip damages durable state (every other skipped step
    // loses only in-memory work): it runs after the steps finished AND after
    // the deadline aborted one.
    const databaseClose = await runDatabaseClose(plan, now);
    if (report.timedOut) {
      if (databaseClose.failure) {
        logger.error('Database close failed during a forced shutdown', {
          failure: databaseClose.failure,
          trigger,
        });
      }
      exitProcess(1);
      return;
    }
    if (databaseClose.failure) {
      failures.push(databaseClose.failure);
    }

    const sinkFailure = closeErrorLogSinkAfterFailureWarn(plan, failures, logger, trigger);
    if (sinkFailure) {
      logger.error('Failed to close the durable NDJSON error log', {
        failure: sinkFailure,
        trigger,
      });
    }
    // Per-step durations are the only record that explains a slow (but not
    // forced) exit; the forced-exit path logs the in-flight step instead.
    const completed = [
      ...report.steps.map(({ elapsedMs, outcome, step }) => ({
        elapsedMs,
        failed: outcome === 'failed',
        step,
      })),
      {
        elapsedMs: databaseClose.elapsedMs,
        failed: databaseClose.failure !== null,
        step: DATABASE_CLOSE_STEP,
      },
    ];
    logger.info('Graceful shutdown completed', {
      steps: completed,
      stepsMs: completed.reduce((total, step) => total + step.elapsedMs, 0),
      trigger,
    });
  };

  return {
    run: async (trigger, forcedExitTrigger) => {
      // Only the first run arms it: a later trigger joins a run that already
      // has one, or that finished and cleared it.
      if (!running) {
        armBackstop(forcedExitTrigger);
      }
      // Latch before any teardown so work torn down mid-flight (an in-flight
      // embedding backfill, say) logs as a benign stop, not a failure.
      markShuttingDown();
      if (running) {
        await running;
        return;
      }
      running = runOnce(trigger, forcedExitTrigger).then(
        () => {
          // Finished, or the step deadline already forced the exit.
          if (backstop) {
            clearTimeout(backstop);
            backstop = null;
          }
        },
        (error: unknown) => {
          // The steps may not have run; the armed backstop keeps the exit
          // bounded, and callers still go on to quit — even if this log throws.
          try {
            logger.error('Graceful shutdown orchestration failed', {
              error: serializeDesktopError(error),
              trigger,
            });
          } catch {
            // run() must not reject; the backstop still bounds the exit.
          }
        }
      );
      await running;
    },
  };
}
