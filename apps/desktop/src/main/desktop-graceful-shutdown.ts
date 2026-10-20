import {
  runShutdownSequence,
  type ShutdownStepInFlight,
  type ShutdownStepOutcome,
} from '@brainstrike/effect-kit';
import { type SerializedDesktopError, serializeDesktopError } from '../desktop-error-serialization';

/**
 * The ONE order desktop main tears down in. Each owner stops while everything
 * it depends on is still alive: a factory reset in flight finishes first (it
 * needs its replacement renderer and reopens the agent host), renderers before
 * the hosts they call, the startup snapshot maintenance stopped and joined
 * before anything it reads (agent host, database, git) retires (BST-1859),
 * Main's child processes (shell, terminals, command sessions, LSP) reaped early, the agent host's admission fenced before Main's
 * MCP control closes (a host
 * starting after it would be refused), each @parcel/watcher owner (Explorer
 * roots, Notes Vault, git metadata) joining its native subscribes and
 * unsubscribes before Electron frees Main's Node environment (BST-2244), git
 * and forge before the database they read, and `database-drain` last: it stops everything that
 * issues database work. Two things deliberately sit OUTSIDE this sequence: the
 * database close itself (`DesktopShutdownRunPlan.closeDatabase`, which always
 * runs after it) and the durable error-log close (last of all, so the log can
 * record every earlier failure). See platform-contracts.md § "Graceful
 * shutdown ownership" and ADR-0026.
 */
export const DESKTOP_SHUTDOWN_STEP_ORDER = [
  'factory-reset',
  'snapshot-maintenance',
  'renderers',
  'main-catalog',
  'child-processes',
  'native-index',
  'mcp-runtime',
  'file-system',
  'notes-vault',
  'chunking-host',
  'parser-host',
  'embedding-host',
  'git-inventory',
  'forge',
  'git-commands',
  'database-drain',
] as const;

export type DesktopShutdownStepName = (typeof DESKTOP_SHUTDOWN_STEP_ORDER)[number];

export type DesktopShutdownTrigger = 'before-quit' | 'signal';

/**
 * Log only, never a timeout (ADR-0026 R4/R5): a step still running this long
 * after it started is named once at warn, and the run keeps waiting for it.
 * Nothing abandons a step, skips a later one or forces an exit.
 */
export const DESKTOP_SHUTDOWN_SLOW_STEP_MS = 10_000;

export type DesktopShutdownStepRun = () => Promise<void> | void;

/** One run's step bodies, built when that run starts so they capture its state. */
export interface DesktopShutdownRunPlan {
  /**
   * The database close. Runs after the ordered steps settle, whatever their
   * outcome; a failure is recorded as the `database-close` step.
   */
  readonly closeDatabase: () => Promise<void>;
  /** Closes the durable NDJSON error log. Runs last, after the aggregate failure warn. */
  readonly closeErrorLogSink: () => void;
  readonly steps: Readonly<Record<DesktopShutdownStepName, DesktopShutdownStepRun>>;
}

export interface DesktopShutdownLogger {
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
   * Runs the ordered steps once, each until it settles. A later call, from any
   * trigger, joins the first run. Never rejects: step failures are logged, and
   * an orchestration failure is logged and exits 1.
   */
  run(trigger: DesktopShutdownTrigger): Promise<void>;
}

/** A failed step’s serialized failure record; null on success. */
function toFailure(outcome: ShutdownStepOutcome): SerializedDesktopError | null {
  return outcome.outcome === 'failed'
    ? { step: outcome.step, ...serializeDesktopError(outcome.error) }
    : null;
}

/** The database close's own step name: it is not part of `DESKTOP_SHUTDOWN_STEP_ORDER`. */
const DATABASE_CLOSE_STEP = 'database-close' as const;

interface DatabaseCloseResult {
  readonly elapsedMs: number;
  readonly failure: SerializedDesktopError | null;
}

/** Runs the database close. Never rejects: a failure is returned, to be recorded. */
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
 * shutdown flag, retires background admission, runs `DESKTOP_SHUTDOWN_STEP_ORDER`
 * once, each step until it settles, then the database close, then closes the
 * durable error log. There is no deadline (ADR-0026 R4): Main exits 0 once every
 * owner settled, and a slow step is named at warn, never abandoned. Only an
 * orchestration that fails before any step can run exits 1.
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
    const failures: SerializedDesktopError[] = [];

    const recordSettled = (outcome: ShutdownStepOutcome): void => {
      const failure = toFailure(outcome);
      if (failure) {
        failures.push(failure);
      }
    };
    // Only a log: a logger that throws must not turn a slow step into a broken run.
    const reportSlow = ({ elapsedMs, step }: ShutdownStepInFlight): void => {
      try {
        logger.warn('Graceful shutdown step is slow', { elapsedMs, step, trigger });
      } catch {
        // The step is still joined; there is nowhere left to report this.
      }
    };

    const report = await runShutdownSequence(
      DESKTOP_SHUTDOWN_STEP_ORDER.map((name) => ({ name, run: plan.steps[name] })),
      {
        now: options.now,
        onSlow: reportSlow,
        onStepSettled: recordSettled,
        slowAfterMs: DESKTOP_SHUTDOWN_SLOW_STEP_MS,
      }
    );

    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- ordered after the sequence, not independent of it: `database-drain` stops everything that still issues database work, so it must finish before the close; running them together would close the database under admitted work.
    const databaseClose = await runDatabaseClose(plan, now);
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
    // Per-step durations are the record that explains a slow exit.
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
    run: async (trigger) => {
      // Latch before any teardown so work torn down mid-flight (an in-flight
      // embedding backfill, say) logs as a benign stop, not a failure.
      markShuttingDown();
      if (running) {
        await running;
        return;
      }
      running = runOnce(trigger).catch((error: unknown) => {
        // The orchestration broke before or between its steps: nothing is left
        // to join, so the failure is the exit. A throwing log never cancels it.
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
