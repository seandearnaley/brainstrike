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
