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
 * roots, git metadata) joining its native subscribes and
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
  'embedding-host',
  'git-inventory',
  'forge',
  'database-drain',
] as const;

export type DesktopShutdownStepName = (typeof DESKTOP_SHUTDOWN_STEP_ORDER)[number];

type DesktopShutdownTrigger = 'before-quit' | 'signal';

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
   * Runs the ordered steps once, each until it settles. A later call, from any
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
 * Builds desktop main's one graceful-shutdown runner: plain ordered awaits. Each
 * step runs until it settles, and a failed step is recorded while the next one
 * still runs. Then the database closes, the failures are logged at warn, and the
 * durable error log closes last. The per-step durations are logged once at the end.
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

    // Ordered, not independent: each step stops an owner the later ones still use.
    for (const name of DESKTOP_SHUTDOWN_STEP_ORDER) {
      await runStep(name, plan.steps[name]);
    }
    // react-doctor-disable-next-line react-doctor/server-sequential-independent-await -- ordered after the steps, not independent of them: `database-drain` stops everything that still issues database work, so it must finish before the close.
    await runStep('database-close', plan.closeDatabase);

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
