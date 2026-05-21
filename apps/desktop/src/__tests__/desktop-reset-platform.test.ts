import { beforeEach, describe, expect, it, vi } from 'vitest';

const resetDesktopApplicationDataMock = vi.hoisted(() => vi.fn());

vi.mock('../desktop-factory-reset', () => ({
  resetDesktopApplicationData: resetDesktopApplicationDataMock,
}));

describe('createDesktopFactoryResetHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDesktopApplicationDataMock.mockResolvedValue({
      deletedPaths: [],
      pendingDeletionPaths: [],
      preservedPaths: [],
    });
  });

  it('stops every hidden/background runtime before draining and resetting the database profile', async () => {
    const cleanupLiveSubscriptionsForShutdown = vi.fn(async () => undefined);
    const resetLocalDatabase = vi.fn(async () => undefined);
    const waitForDatabaseWorkSchedulerIdle = vi.fn(async () => undefined);
    const runWithDatabaseResetBarrier = vi.fn(async (work: () => Promise<void>) => {
      await work();
    });
    const embeddingHostStop = vi.fn(async () => undefined);
    const chunkingHostStop = vi.fn(async () => undefined);
    const llmHostStop = vi.fn(async () => undefined);

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown,
      logger: { error: vi.fn() },
      resetLocalDatabase,
      runtimes: [
        { name: 'embedding-host', stop: embeddingHostStop },
        { name: 'chunking-host', stop: chunkingHostStop },
        { name: 'llm-host', stop: llmHostStop },
      ],
      runWithDatabaseResetBarrier,
      userDataPath: '/mock/userData',
      waitForDatabaseWorkSchedulerIdle,
    });

    await expect(handleReset()).resolves.toEqual({ success: true });

    expect(resetDesktopApplicationDataMock).toHaveBeenCalledWith({
      resetDatabaseProfile: expect.any(Function),
      stopBackgroundRuntimes: expect.any(Function),
      userDataPath: '/mock/userData',
    });

    const resetOptions = resetDesktopApplicationDataMock.mock.calls[0]?.[0] as
      | {
          resetDatabaseProfile?: () => Promise<void>;
          stopBackgroundRuntimes?: () => Promise<void>;
        }
      | undefined;
    if (
      typeof resetOptions?.stopBackgroundRuntimes !== 'function' ||
      typeof resetOptions.resetDatabaseProfile !== 'function'
    ) {
      throw new Error('Desktop reset callbacks were not provided.');
    }

    await resetOptions.stopBackgroundRuntimes();
    expect(embeddingHostStop).toHaveBeenCalledTimes(1);
    expect(chunkingHostStop).toHaveBeenCalledTimes(1);
    expect(llmHostStop).toHaveBeenCalledTimes(1);

    await resetOptions.resetDatabaseProfile();
    expect(runWithDatabaseResetBarrier).toHaveBeenCalledTimes(1);
    expect(cleanupLiveSubscriptionsForShutdown).toHaveBeenCalledTimes(2);
    expect(waitForDatabaseWorkSchedulerIdle).toHaveBeenCalledTimes(1);
    expect(resetLocalDatabase).toHaveBeenCalledTimes(1);

    const firstCleanupOrder = cleanupLiveSubscriptionsForShutdown.mock.invocationCallOrder[0];
    const waitOrder = waitForDatabaseWorkSchedulerIdle.mock.invocationCallOrder[0];
    const secondCleanupOrder = cleanupLiveSubscriptionsForShutdown.mock.invocationCallOrder[1];
    const resetOrder = resetLocalDatabase.mock.invocationCallOrder[0];
    expect(firstCleanupOrder).toBeLessThan(waitOrder);
    expect(waitOrder).toBeLessThan(secondCleanupOrder);
    expect(secondCleanupOrder).toBeLessThan(resetOrder);
  });

  it('returns a failed reset result without hiding the runtime shutdown error', async () => {
    const error = new Error('llm host refused to stop');
    resetDesktopApplicationDataMock.mockRejectedValueOnce(error);
    const logger = { error: vi.fn() };

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown: vi.fn(async () => undefined),
      logger,
      resetLocalDatabase: vi.fn(async () => undefined),
      runtimes: [{ name: 'llm-host', stop: vi.fn(async () => undefined) }],
      runWithDatabaseResetBarrier: vi.fn(async (work: () => Promise<void>) => {
        await work();
      }),
      userDataPath: '/mock/userData',
      waitForDatabaseWorkSchedulerIdle: vi.fn(async () => undefined),
    });

    await expect(handleReset()).resolves.toEqual({
      success: false,
      message: 'llm host refused to stop',
    });
    expect(logger.error).toHaveBeenCalledWith('Failed to reset desktop application data:', error);
  });

  it('attempts every runtime stop before reporting shutdown failures', async () => {
    resetDesktopApplicationDataMock.mockImplementationOnce(
      async ({ stopBackgroundRuntimes }: { stopBackgroundRuntimes: () => Promise<void> }) => {
        await stopBackgroundRuntimes();
        return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
      }
    );
    const stopFailure = new Error('stop failed');
    const embeddingHostStop = vi.fn(async () => {
      throw stopFailure;
    });
    const chunkingHostStop = vi.fn(async () => undefined);

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown: vi.fn(async () => undefined),
      logger: { error: vi.fn() },
      resetLocalDatabase: vi.fn(async () => undefined),
      runtimes: [
        { name: 'embedding-host', stop: embeddingHostStop },
        { name: 'chunking-host', stop: chunkingHostStop },
      ],
      runWithDatabaseResetBarrier: vi.fn(async (work: () => Promise<void>) => {
        await work();
      }),
      userDataPath: '/mock/userData',
      waitForDatabaseWorkSchedulerIdle: vi.fn(async () => undefined),
    });

    await expect(handleReset()).resolves.toEqual({
      success: false,
      message: 'Failed to stop desktop reset runtimes: embedding-host',
    });
    expect(embeddingHostStop).toHaveBeenCalledTimes(1);
    expect(chunkingHostStop).toHaveBeenCalledTimes(1);
  });
});
