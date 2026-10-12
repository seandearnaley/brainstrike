import type { ProfileResetLease } from '@brainstrike/host-lease';
import { RootLock } from '@brainstrike/state-store';
import { disposeActiveBrowserPaneViews } from './browser/browser-pane-host';
import { clearDesktopBrowserSessions } from './browser/browser-session';
import { resetDesktopApplicationData } from './desktop-factory-reset';

export interface DesktopResetRuntime {
  readonly name: string;
  readonly stop: () => Promise<unknown>;
}

export interface DesktopResetLogger {
  readonly error: (message: string, error: unknown) => void;
  readonly info: (message: string) => void;
}

export interface CreateDesktopFactoryResetHandlerOptions {
  readonly cleanupLiveSubscriptionsForShutdown: () => Promise<void>;
  /** Replaces the stale visible renderer and resolves only after its explicit
   * renderer-ready acknowledgement. MCP admission remains closed while this
   * promise is pending. Terminal quit cancels readiness through the signal. */
  readonly completeSuccessfulReset: (signal: AbortSignal) => Promise<void>;
  /** Every on-disk path the durable NDJSON error-log backstop (Flight
   * Recorder P2a) can occupy — forwarded to `resetDesktopApplicationData` so
   * factory reset purges it alongside the database, even though it lives
   * outside `userDataPath` and inside the otherwise-preserved `logs` folder. */
  readonly errorLogFilePaths?: readonly string[];
  readonly logger: DesktopResetLogger;
  readonly prepareDatabaseProfileReset?: () => Promise<ProfileResetLease>;
  readonly resetLocalDatabase: (lease?: ProfileResetLease) => Promise<void>;
  /** Clears the long-lived main-process storage cache after userData has been
   * deleted, before a replacement renderer can read or repersist stale data. */
  readonly resetPersistentStorageAfterDataDeletion: () => Promise<void>;
  readonly resumeAfterReset?: (
    outcome: 'failed' | 'succeeded',
    signal: AbortSignal
  ) => Promise<void>;
  /** The same Main transition queue owns retirement, purge and reopen; the
   * reset owner retains its accepted request while waiting for this admission. */
  readonly runTransition: (
    work: () => Promise<DesktopFactoryResetResult>
  ) => Promise<DesktopFactoryResetResult>;
  readonly runtimes: readonly DesktopResetRuntime[];
  readonly runWithDatabaseResetBarrier: (work: () => Promise<void>) => Promise<void>;
  /** Electron owns this dedicated container; clear its sessions before purge. */
  readonly sessionDataPath: string;
  readonly userDataPath: string;
  readonly waitForDatabaseWorkSchedulerIdle: () => Promise<void>;
}

export interface DesktopFactoryResetResult {
  message?: string;
  success: boolean;
}

export interface DesktopFactoryReset {
  /** Joins accepted deletion with its original failure, cancels replacement
   * startup and refuses new resets. */
  close(): Promise<void>;
  /**
   * Settles once no reset is in flight, its reopen included. A reset retires the
   * profile only until it reopens it: whoever needs the profile meanwhile waits.
   */
  idle(): Promise<void>;
  /** The accepted reset, including its reopen or original failed outcome. */
  inFlight(): Promise<DesktopFactoryResetResult> | null;
  reset(): Promise<DesktopFactoryResetResult>;
}

type ResetFailure =
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'none' };

const NO_RESET_FAILURE: ResetFailure = { kind: 'none' };

function combineResetFailure(failure: unknown, resumeFailure: unknown): unknown {
  const resetMessage = failure instanceof Error ? failure.message : String(failure);
  const resumeMessage =
    resumeFailure instanceof Error ? resumeFailure.message : String(resumeFailure);
  return new AggregateError(
    [failure, resumeFailure],
    `${resetMessage}; reset runtime resume failed: ${resumeMessage}`
  );
}

async function resumeDesktopResetRuntime({
  failure,
  rendererReplacementSucceeded,
  resetDataSucceeded,
  resumeAfterReset,
  signal,
}: {
  signal: AbortSignal;
  failure: ResetFailure;
  rendererReplacementSucceeded: boolean;
  resetDataSucceeded: boolean;
  resumeAfterReset: CreateDesktopFactoryResetHandlerOptions['resumeAfterReset'];
}): Promise<ResetFailure> {
  if (signal.aborted || (resetDataSucceeded && !rendererReplacementSucceeded)) {
    return failure;
  }
  try {
    await resumeAfterReset?.(resetDataSucceeded ? 'succeeded' : 'failed', signal);
    return failure;
  } catch (error) {
    if (signal.aborted && error === signal.reason) {
      return failure;
    }
    return {
      error: failure.kind === 'none' ? error : combineResetFailure(failure.error, error),
      kind: 'failed',
    };
  }
}

async function stopDesktopResetRuntimes(runtimes: readonly DesktopResetRuntime[]): Promise<void> {
  const results = await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
  const failures = results
    .map((result, index) => ({ result, runtime: runtimes[index] }))
    .filter(
      (entry): entry is { result: PromiseRejectedResult; runtime: DesktopResetRuntime } =>
        entry.result.status === 'rejected'
    );
  if (failures.length === 0) {
    return;
  }
  const failedNames = failures.map(({ runtime }) => runtime.name).join(', ');
  throw new AggregateError(
    failures.map(({ result }) => result.reason),
    `Failed to stop desktop reset runtimes: ${failedNames}`
  );
}

/**
 * The ONLY sanctioned way to reset the desktop database: barrier out new
 * scheduler submissions, drain live subscriptions and queued DB work, then
 * reset. Exported (BST-1330) so the developer-menu reset shares this exact
 * sequence instead of calling resetLocalDatabase() bare — the undrained call
 * was the one desktop close path that could deliberately hit the in-host
 * live-refresh race.
 */
export async function resetDesktopDatabaseProfile({
  cleanupLiveSubscriptionsForShutdown,
  resetLocalDatabase,
  runWithDatabaseResetBarrier,
  waitForDatabaseWorkSchedulerIdle,
}: Pick<
  CreateDesktopFactoryResetHandlerOptions,
  | 'cleanupLiveSubscriptionsForShutdown'
  | 'resetLocalDatabase'
  | 'runWithDatabaseResetBarrier'
  | 'waitForDatabaseWorkSchedulerIdle'
>): Promise<void> {
  await runWithDatabaseResetBarrier(async () => {
    await cleanupLiveSubscriptionsForShutdown();
    await waitForDatabaseWorkSchedulerIdle();
    // New live subscriptions may be created while waiting for scheduled DB work to drain.
    // Run cleanup again before deleting database state so reset cannot race a live query.
    await cleanupLiveSubscriptionsForShutdown();
    await resetLocalDatabase();
  });
}

export function createDesktopFactoryResetHandler({
  cleanupLiveSubscriptionsForShutdown,
  completeSuccessfulReset,
  errorLogFilePaths,
  logger,
  prepareDatabaseProfileReset = async () => {
    const database = await import('./db-main');
    return await database.prepareDatabaseProfileReset();
  },
  resetLocalDatabase,
  resetPersistentStorageAfterDataDeletion,
  resumeAfterReset,
  runtimes,
  runTransition,
  runWithDatabaseResetBarrier,
  sessionDataPath,
  userDataPath,
  waitForDatabaseWorkSchedulerIdle,
}: CreateDesktopFactoryResetHandlerOptions): DesktopFactoryReset {
  const shutdown = new AbortController();
  let profileResetLease: ProfileResetLease | null = null;
  const runReset = async (): Promise<DesktopFactoryResetResult> => {
    let failure: ResetFailure = NO_RESET_FAILURE;
    let resetDataSucceeded = false;
    let rendererReplacementSucceeded = false;
    try {
      await resetDesktopApplicationData({
        ...(errorLogFilePaths === undefined ? {} : { errorLogFilePaths }),
        getProtectedPaths: () => {
          if (!profileResetLease || profileResetLease.isReleased) {
            throw new Error('Desktop factory reset requires an owned profile reset lease');
          }
          return [RootLock.dirOf(profileResetLease.root), sessionDataPath];
        },
        resetDatabaseProfile: async () => {
          await resetDesktopDatabaseProfile({
            cleanupLiveSubscriptionsForShutdown,
            resetLocalDatabase: async () => {
              profileResetLease ??= await prepareDatabaseProfileReset();
              await resetLocalDatabase(profileResetLease);
            },
            runWithDatabaseResetBarrier,
            waitForDatabaseWorkSchedulerIdle,
          });
        },
        stopBackgroundRuntimes: async () => {
          await stopDesktopResetRuntimes(runtimes);
          // Browser pane (BST-1174). Order matters: CLOSE the live
          // `WebContentsView`s first, THEN clear the partition. A still-running
          // view can rewrite cookies/localStorage into `persist:browser-pane`
          // between the clear and the reset's reload, leaving site state behind
          // (codex P1) — disposing the views makes the storage quiescent before
          // we wipe it. Electron owns the live session container; its API
          // clears both sessions without renaming Chromium's locked files.
          disposeActiveBrowserPaneViews();
          await clearDesktopBrowserSessions();
        },
        userDataPath,
      });
      resetDataSucceeded = true;
      await resetPersistentStorageAfterDataDeletion();
      profileResetLease?.release();
      profileResetLease = null;
      if (!shutdown.signal.aborted) {
        await completeSuccessfulReset(shutdown.signal);
        rendererReplacementSucceeded = !shutdown.signal.aborted;
      }
    } catch (error) {
      failure = { error, kind: 'failed' };
    }

    // While continuing the app, a failed purge restores its runtime snapshot. A successful
    // purge may reopen only after the replacement renderer explicitly reports
    // ready. Terminal quit never reopens; unrelated failures stay visible.
    failure = await resumeDesktopResetRuntime({
      failure,
      rendererReplacementSucceeded,
      resetDataSucceeded,
      resumeAfterReset,
      signal: shutdown.signal,
    });
    if (failure.kind === 'failed') {
      logger.error('Failed to reset desktop application data:', failure.error);
      throw failure.error;
    }

    logger.info('Desktop factory reset completed');
    return { success: true };
  };
  let resetInFlight: {
    readonly completion: Promise<DesktopFactoryResetResult>;
    readonly result: Promise<DesktopFactoryResetResult>;
  } | null = null;
  return {
    // Quit joins accepted deletion but cancels replacement readiness/startup.
    // The same signal fences subsequent reset requests; purge never observes it.
    close: async () => {
      shutdown.abort(new Error('Factory reset replacement cancelled by terminal quit'));
      await resetInFlight?.completion;
    },
    idle: async () => {
      while (resetInFlight) {
        await resetInFlight.result;
      }
    },
    inFlight: () => resetInFlight?.result ?? null,
    reset: () => {
      if (shutdown.signal.aborted) {
        return Promise.resolve({
          message: 'The app is quitting: the factory reset did not start.',
          success: false,
        });
      }
      if (resetInFlight) {
        return resetInFlight.result;
      }
      let admitted = false;
      const completion = runTransition(() => {
        admitted = true;
        return runReset();
      });
      // Only the renderer boundary converts an accepted reset's rejection to a
      // result envelope. Terminal close must join its original completion.
      const result = completion
        .catch((error: unknown): DesktopFactoryResetResult => {
          if (!admitted) {
            throw error;
          }
          return {
            message: error instanceof Error ? error.message : String(error),
            success: false,
          };
        })
        .finally(() => {
          resetInFlight = null;
        });
      resetInFlight = { completion, result };
      return result;
    },
  };
}
