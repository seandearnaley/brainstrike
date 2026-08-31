import { beforeEach, describe, expect, it, vi } from 'vitest';

const resetDesktopApplicationDataMock = vi.hoisted(() => vi.fn());
const completeSuccessfulResetMock = vi.hoisted(() => vi.fn(async () => undefined));

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
      completeSuccessfulReset: completeSuccessfulResetMock,
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
    if (
      firstCleanupOrder === undefined ||
      waitOrder === undefined ||
      secondCleanupOrder === undefined ||
      resetOrder === undefined
    ) {
      throw new Error('Expected reset callbacks to record their invocation order.');
    }
    expect(firstCleanupOrder).toBeLessThan(waitOrder);
    expect(waitOrder).toBeLessThan(secondCleanupOrder);
    expect(secondCleanupOrder).toBeLessThan(resetOrder);
  });

  it('forwards errorLogFilePaths through to resetDesktopApplicationData unchanged', async () => {
    const errorLogFilePaths = [
      '/mock/logs/brainstrike-errors.ndjson',
      '/mock/logs/brainstrike-errors.ndjson.1',
    ];

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown: vi.fn(async () => undefined),
      completeSuccessfulReset: completeSuccessfulResetMock,
      errorLogFilePaths,
      logger: { error: vi.fn() },
      resetLocalDatabase: vi.fn(async () => undefined),
      runtimes: [],
      runWithDatabaseResetBarrier: vi.fn(async (work: () => Promise<void>) => {
        await work();
      }),
      userDataPath: '/mock/userData',
      waitForDatabaseWorkSchedulerIdle: vi.fn(async () => undefined),
    });

    await expect(handleReset()).resolves.toEqual({ success: true });

    expect(resetDesktopApplicationDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorLogFilePaths })
    );
  });

  it('returns a failed reset result without hiding the runtime shutdown error', async () => {
    const error = new Error('llm host refused to stop');
    resetDesktopApplicationDataMock.mockRejectedValueOnce(error);
    const logger = { error: vi.fn() };
    const resumeAfterReset = vi.fn(async () => undefined);

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown: vi.fn(async () => undefined),
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
      runtimes: [{ name: 'llm-host', stop: vi.fn(async () => undefined) }],
      runWithDatabaseResetBarrier: vi.fn(async (work: () => Promise<void>) => {
        await work();
      }),
      userDataPath: '/mock/userData',
      waitForDatabaseWorkSchedulerIdle: vi.fn(async () => undefined),
    });

    await expect(handleReset()).resolves.toEqual({
      message: 'llm host refused to stop',
      success: false,
    });
    expect(logger.error).toHaveBeenCalledWith('Failed to reset desktop application data:', error);
    expect(resumeAfterReset).toHaveBeenCalledOnce();
  });

  it('resumes MCP only after the enclosing data purge completes', async () => {
    const purge = Promise.withResolvers<void>();
    resetDesktopApplicationDataMock.mockImplementationOnce(async () => {
      await purge.promise;
      return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
    });
    const resumeAfterReset = vi.fn(async () => undefined);
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown: vi.fn(async () => undefined),
      logger: { error: vi.fn() },
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
      runtimes: [],
      runWithDatabaseResetBarrier: vi.fn(async (work: () => Promise<void>) => await work()),
      userDataPath: '/mock/userData',
      waitForDatabaseWorkSchedulerIdle: vi.fn(async () => undefined),
    });

    const result = handleReset();
    await vi.waitFor(() => expect(resetDesktopApplicationDataMock).toHaveBeenCalledOnce());
    expect(resumeAfterReset).not.toHaveBeenCalled();
    purge.resolve();
    await expect(result).resolves.toEqual({ success: true });
    expect(resumeAfterReset).toHaveBeenCalledOnce();
  });

  it('coalesces overlapping reset requests through one purge and one resume', async () => {
    const purge = Promise.withResolvers<void>();
    resetDesktopApplicationDataMock.mockImplementationOnce(async () => {
      await purge.promise;
      return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
    });
    const resumeAfterReset = vi.fn(async () => undefined);
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown: vi.fn(async () => undefined),
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { error: vi.fn() },
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
      runtimes: [],
      runWithDatabaseResetBarrier: vi.fn(async (work: () => Promise<void>) => await work()),
      userDataPath: '/mock/userData',
      waitForDatabaseWorkSchedulerIdle: vi.fn(async () => undefined),
    });

    const first = handleReset();
    const second = handleReset();
    await vi.waitFor(() => expect(resetDesktopApplicationDataMock).toHaveBeenCalledOnce());
    purge.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true },
      { success: true },
    ]);
    expect(resumeAfterReset).toHaveBeenCalledOnce();
  });

  it('preserves reset and resume failure messages together', async () => {
    resetDesktopApplicationDataMock.mockRejectedValueOnce(new Error('purge failed'));
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown: vi.fn(async () => undefined),
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { error: vi.fn() },
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset: vi.fn(async () => {
        throw new Error('watcher failed');
      }),
      runtimes: [],
      runWithDatabaseResetBarrier: vi.fn(async (work: () => Promise<void>) => await work()),
      userDataPath: '/mock/userData',
      waitForDatabaseWorkSchedulerIdle: vi.fn(async () => undefined),
    });

    await expect(handleReset()).resolves.toEqual({
      message: 'purge failed; reset runtime resume failed: watcher failed',
      success: false,
    });
  });

  it('attempts every runtime stop before reporting shutdown failures', async () => {
    resetDesktopApplicationDataMock.mockImplementationOnce(
      async ({ stopBackgroundRuntimes }: { stopBackgroundRuntimes: () => Promise<void> }) => {
        await stopBackgroundRuntimes();
        return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
      }
    );
    const stopFailure = new Error('embedding stop failed');
    const secondStopFailure = new Error('chunking stop failed');
    const logger = { error: vi.fn() };
    const embeddingHostStop = vi.fn(async () => {
      throw stopFailure;
    });
    const chunkingHostStop = vi.fn(async () => {
      throw secondStopFailure;
    });

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      cleanupLiveSubscriptionsForShutdown: vi.fn(async () => undefined),
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
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
      message: 'Failed to stop desktop reset runtimes: embedding-host, chunking-host',
      success: false,
    });
    expect(embeddingHostStop).toHaveBeenCalledTimes(1);
    expect(chunkingHostStop).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to reset desktop application data:',
      expect.objectContaining({ errors: [stopFailure, secondStopFailure] })
    );
  });
});
