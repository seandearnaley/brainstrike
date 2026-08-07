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
  /** Every on-disk path the durable NDJSON error-log backstop (Flight
   * Recorder P2a) can occupy — forwarded to `resetDesktopApplicationData` so
   * factory reset purges it alongside the database, even though it lives
   * outside `userDataPath` and inside the otherwise-preserved `logs` folder. */
  readonly errorLogFilePaths?: readonly string[];
  readonly logger: DesktopResetLogger;
  readonly resetLocalDatabase: () => Promise<void>;
  readonly runtimes: readonly DesktopResetRuntime[];
  readonly runWithDatabaseResetBarrier: (work: () => Promise<void>) => Promise<void>;
  readonly userDataPath: string;
  readonly waitForDatabaseWorkSchedulerIdle: () => Promise<void>;
}

export interface DesktopFactoryResetResult {
  message?: string;
  success: boolean;
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
  throw new Error(`Failed to stop desktop reset runtimes: ${failedNames}`);
}

async function resetDesktopDatabaseProfile({
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
  errorLogFilePaths,
  logger,
  resetLocalDatabase,
  runtimes,
  runWithDatabaseResetBarrier,
  userDataPath,
  waitForDatabaseWorkSchedulerIdle,
}: CreateDesktopFactoryResetHandlerOptions): () => Promise<DesktopFactoryResetResult> {
  return async () => {
    try {
      await resetDesktopApplicationData({
        ...(errorLogFilePaths === undefined ? {} : { errorLogFilePaths }),
        resetDatabaseProfile: async () => {
          await resetDesktopDatabaseProfile({
            cleanupLiveSubscriptionsForShutdown,
            resetLocalDatabase,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to reset desktop application data:', error);
      return { message, success: false };
    }

    return { success: true };
  };
}
