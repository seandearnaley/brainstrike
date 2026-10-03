import type { ProfileResetLease } from '@brainstrike/host-lease';
import { RootLock } from '@brainstrike/state-store';
import { disposeActiveBrowserPaneViews } from './browser/browser-pane-host';
import { clearBrowserPaneSession } from './browser/browser-session';
import { resetDesktopApplicationData } from './desktop-factory-reset';

export interface DesktopResetRuntime {
  readonly name: string;
  readonly stop: () => Promise<unknown>;
}

export interface DesktopResetLogger {
  readonly error: (message: string, error: unknown) => void;
}

export interface CreateDesktopFactoryResetHandlerOptions {
  readonly cleanupLiveSubscriptionsForShutdown: () => Promise<void>;
  /** Replaces the stale visible renderer and resolves only after its explicit
   * renderer-ready acknowledgement. MCP admission remains closed while this
   * promise is pending. */
  readonly completeSuccessfulReset: () => Promise<void>;
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
  readonly resumeAfterReset?: (outcome: 'failed' | 'succeeded') => Promise<void>;
  readonly runtimes: readonly DesktopResetRuntime[];
  readonly runWithDatabaseResetBarrier: (work: () => Promise<void>) => Promise<void>;
  readonly userDataPath: string;
  readonly waitForDatabaseWorkSchedulerIdle: () => Promise<void>;
}

export interface DesktopFactoryResetResult {
  message?: string;
  success: boolean;
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
}: {
  failure: ResetFailure;
  rendererReplacementSucceeded: boolean;
  resetDataSucceeded: boolean;
  resumeAfterReset: CreateDesktopFactoryResetHandlerOptions['resumeAfterReset'];
}): Promise<ResetFailure> {
  if (resetDataSucceeded && !rendererReplacementSucceeded) {
    return failure;
  }
  try {
    await resumeAfterReset?.(resetDataSucceeded ? 'succeeded' : 'failed');
    return failure;
  } catch (error) {
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
  runWithDatabaseResetBarrier,
  userDataPath,
  waitForDatabaseWorkSchedulerIdle,
}: CreateDesktopFactoryResetHandlerOptions): () => Promise<DesktopFactoryResetResult> {
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
          return [RootLock.dirOf(profileResetLease.root)];
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
          // we wipe it. The partition itself is also deleted on disk with the
          // userData directory below.
          disposeActiveBrowserPaneViews();
          await clearBrowserPaneSession();
        },
        userDataPath,
      });
      resetDataSucceeded = true;
      await resetPersistentStorageAfterDataDeletion();
      profileResetLease?.release();
      profileResetLease = null;
      await completeSuccessfulReset();
      rendererReplacementSucceeded = true;
    } catch (error) {
      failure = { error, kind: 'failed' };
    }

    // A failed purge must restore the pre-reset runtime snapshot. A successful
    // purge may reopen only after the replacement renderer explicitly reports
    // ready. If renderer replacement itself fails, keep admission closed.
    failure = await resumeDesktopResetRuntime({
      failure,
      rendererReplacementSucceeded,
      resetDataSucceeded,
      resumeAfterReset,
    });
    if (failure.kind === 'failed') {
      const message =
        failure.error instanceof Error ? failure.error.message : String(failure.error);
      logger.error('Failed to reset desktop application data:', failure.error);
      return { message, success: false };
    }

    return { success: true };
  };
  let resetInFlight: Promise<DesktopFactoryResetResult> | null = null;
  return async () => {
    resetInFlight ??= runReset().finally(() => {
      resetInFlight = null;
    });
    return await resetInFlight;
  };
}
