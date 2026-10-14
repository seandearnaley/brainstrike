import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const resetDesktopApplicationDataMock = vi.hoisted(() => vi.fn());
const completeSuccessfulResetMock = vi.hoisted(() => vi.fn(async () => undefined));
const resetPersistentStorageAfterDataDeletionMock = vi.hoisted(() => vi.fn(async () => undefined));

const prepareDatabaseProfileReset = vi.fn(async () => ({
  clearRootContents: async () => undefined,
  isReleased: false,
  release: () => undefined,
  root: '/mock/profile',
}));

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

  it('resets main-process storage after deleting application data and before replacing the renderer', async () => {
    const invocationOrder: string[] = [];
    resetDesktopApplicationDataMock.mockImplementationOnce(async () => {
      invocationOrder.push('application-data');
      return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
    });
    const resetPersistentStorageAfterDataDeletion = vi.fn(async () => {
      invocationOrder.push('main-storage');
    });
    const completeSuccessfulReset = vi.fn(async () => {
      invocationOrder.push('renderer-replacement');
    });

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({ success: true });
    expect(invocationOrder).toEqual(['application-data', 'main-storage', 'renderer-replacement']);
  });

  it('stops every hidden/background runtime and requires the profile lease before deletion', async () => {
    const resetLocalDatabase = vi.fn(async () => undefined);
    const embeddingHostStop = vi.fn(async () => undefined);
    const chunkingHostStop = vi.fn(async () => undefined);
    const llmHostStop = vi.fn(async () => undefined);

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase,
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      runTransition: (work) => work(),
      runtimes: [
        { name: 'embedding-host', stop: embeddingHostStop },
        { name: 'chunking-host', stop: chunkingHostStop },
        { name: 'llm-host', stop: llmHostStop },
      ],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({ success: true });

    expect(resetDesktopApplicationDataMock).toHaveBeenCalledWith({
      getProtectedPaths: expect.any(Function),
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
    expect(prepareDatabaseProfileReset).toHaveBeenCalledTimes(1);
    expect(resetLocalDatabase).toHaveBeenCalledWith(
      await prepareDatabaseProfileReset.mock.results[0]?.value
    );
    expect(prepareDatabaseProfileReset.mock.invocationCallOrder[0]).toBeLessThan(
      resetLocalDatabase.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('forwards errorLogFilePaths through to resetDesktopApplicationData unchanged', async () => {
    const errorLogFilePaths = [
      '/mock/logs/brainstrike-errors.ndjson',
      '/mock/logs/brainstrike-errors.ndjson.1',
    ];

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      errorLogFilePaths,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({ success: true });

    expect(resetDesktopApplicationDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorLogFilePaths })
    );
  });

  it('returns a failed reset result without hiding the runtime shutdown error', async () => {
    const error = new Error('llm host refused to stop');
    resetDesktopApplicationDataMock.mockRejectedValueOnce(error);
    const logger = { error: vi.fn(), info: vi.fn() };
    const resumeAfterReset = vi.fn(async () => undefined);

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      resumeAfterReset,
      runTransition: (work) => work(),
      runtimes: [{ name: 'llm-host', stop: vi.fn(async () => undefined) }],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({
      message: 'llm host refused to stop',
      success: false,
    });
    expect(logger.error).toHaveBeenCalledWith('Failed to reset desktop application data:', error);
    expect(resumeAfterReset).toHaveBeenCalledWith('failed', expect.any(AbortSignal));
  });

  it('resumes MCP only after purge and explicit renderer replacement complete', async () => {
    const purge = Promise.withResolvers<void>();
    const rendererReplacement = Promise.withResolvers<void>();
    resetDesktopApplicationDataMock.mockImplementationOnce(async () => {
      await purge.promise;
      return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
    });
    const resumeAfterReset = vi.fn(async () => undefined);
    const completeSuccessfulReset = vi.fn(async () => await rendererReplacement.promise);
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      resumeAfterReset,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    const result = handleReset.reset();
    await vi.waitFor(() => expect(resetDesktopApplicationDataMock).toHaveBeenCalledOnce());
    expect(resumeAfterReset).not.toHaveBeenCalled();
    purge.resolve();
    await vi.waitFor(() => expect(completeSuccessfulReset).toHaveBeenCalledOnce());
    expect(resumeAfterReset).not.toHaveBeenCalled();
    rendererReplacement.resolve();
    await expect(result).resolves.toEqual({ success: true });
    expect(resumeAfterReset).toHaveBeenCalledWith('succeeded', expect.any(AbortSignal));
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
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      resumeAfterReset,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    const first = handleReset.reset();
    const second = handleReset.reset();
    await vi.waitFor(() => expect(resetDesktopApplicationDataMock).toHaveBeenCalledOnce());
    purge.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true },
      { success: true },
    ]);
    expect(resetDesktopApplicationDataMock).toHaveBeenCalledOnce();
    expect(resumeAfterReset).toHaveBeenCalledOnce();
  });

  it('clears the coalescing slot so a failed reset can be retried', async () => {
    resetDesktopApplicationDataMock
      .mockRejectedValueOnce(new Error('first purge failed'))
      .mockResolvedValueOnce({ deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] });
    const resumeAfterReset = vi.fn(async () => undefined);
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      resumeAfterReset,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({
      message: 'first purge failed',
      success: false,
    });
    await expect(handleReset.reset()).resolves.toEqual({ success: true });

    expect(resetDesktopApplicationDataMock).toHaveBeenCalledTimes(2);
    expect(resumeAfterReset).toHaveBeenNthCalledWith(1, 'failed', expect.any(AbortSignal));
    expect(resumeAfterReset).toHaveBeenNthCalledWith(2, 'succeeded', expect.any(AbortSignal));
  });

  it.each([undefined, null, '', 0, false])(
    'preserves a falsy reset rejection reason (%s)',
    async (reason) => {
      resetDesktopApplicationDataMock.mockRejectedValueOnce(reason);
      const logger = { error: vi.fn(), info: vi.fn() };
      const resumeAfterReset = vi.fn(async () => undefined);
      const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
      const handleReset = createDesktopFactoryResetHandler({
        completeSuccessfulReset: completeSuccessfulResetMock,
        logger,
        prepareDatabaseProfileReset,
        resetLocalDatabase: vi.fn(async () => undefined),
        resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
        resumeAfterReset,
        runTransition: (work) => work(),
        runtimes: [],

        sessionDataPath: '/mock/userData/session-data',
        userDataPath: '/mock/userData',
      });

      await expect(handleReset.reset()).resolves.toEqual({
        message: String(reason),
        success: false,
      });
      expect(logger.error).toHaveBeenCalledWith(
        'Failed to reset desktop application data:',
        reason
      );
      expect(resumeAfterReset).toHaveBeenCalledWith('failed', expect.any(AbortSignal));
    }
  );

  it('preserves reset and resume failure messages together', async () => {
    const purgeFailure = new Error('purge failed');
    const resumeFailure = new Error('watcher failed');
    resetDesktopApplicationDataMock.mockRejectedValueOnce(purgeFailure);
    const resumeAfterReset = vi.fn(async () => {
      throw resumeFailure;
    });
    const logger = { error: vi.fn(), info: vi.fn() };
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      resumeAfterReset,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({
      message: 'purge failed; reset runtime resume failed: watcher failed',
      success: false,
    });
    expect(resumeAfterReset).toHaveBeenCalledWith('failed', expect.any(AbortSignal));
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to reset desktop application data:',
      expect.objectContaining({ errors: [purgeFailure, resumeFailure] })
    );
  });

  it('keeps admission closed when renderer replacement fails after a successful purge', async () => {
    const resumeAfterReset = vi.fn(async () => undefined);
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: vi.fn(async () => {
        throw new Error('renderer did not report ready');
      }),
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      resumeAfterReset,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({
      message: 'renderer did not report ready',
      success: false,
    });
    expect(resumeAfterReset).not.toHaveBeenCalled();
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
    const logger = { error: vi.fn(), info: vi.fn() };
    const embeddingHostStop = vi.fn(async () => {
      throw stopFailure;
    });
    const chunkingHostStop = vi.fn(async () => {
      throw secondStopFailure;
    });

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      runTransition: (work) => work(),
      runtimes: [
        { name: 'embedding-host', stop: embeddingHostStop },
        { name: 'chunking-host', stop: chunkingHostStop },
      ],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({
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

  it.each([new Error('profile deletion failed'), undefined])(
    'rejects terminal close with the original accepted reset failure (%s)',
    async (failure) => {
      const purge = Promise.withResolvers<void>();
      resetDesktopApplicationDataMock.mockImplementationOnce(() => purge.promise);
      const logger = { error: vi.fn(), info: vi.fn() };
      const resumeAfterReset = vi.fn(async () => undefined);
      const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
      const owner = createDesktopFactoryResetHandler({
        completeSuccessfulReset: completeSuccessfulResetMock,
        logger,
        prepareDatabaseProfileReset,
        resetLocalDatabase: async () => {},
        resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
        resumeAfterReset,
        runTransition: (work) => work(),
        runtimes: [],

        sessionDataPath: '/mock/userData/session-data',
        userDataPath: '/mock/userData',
      });
      const reset = owner.reset();
      expect(owner.reset()).toBe(reset);
      expect(owner.inFlight()).toBe(reset);
      const closing = Promise.allSettled([owner.close(), owner.close()]);
      const idle = owner.idle();
      onTestFinished(async () => {
        purge.resolve();
        await Promise.allSettled([reset, closing, idle]);
      });

      purge.reject(failure);

      const closed = await closing;
      expect(closed).toEqual([
        { reason: failure, status: 'rejected' },
        { reason: failure, status: 'rejected' },
      ]);
      for (const result of closed) {
        if (result.status !== 'rejected') {
          throw new Error('Terminal close concealed the reset failure');
        }
        expect(result.reason).toBe(failure);
      }
      await expect(reset).resolves.toEqual({
        message: failure instanceof Error ? failure.message : String(failure),
        success: false,
      });
      await idle;
      expect(owner.inFlight()).toBeNull();
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        'Failed to reset desktop application data:',
        failure
      );
      expect(logger.info).not.toHaveBeenCalled();
      expect(resumeAfterReset).not.toHaveBeenCalled();
      expect(completeSuccessfulResetMock).not.toHaveBeenCalled();
    }
  );

  it('cancels replacement readiness when quit arrives after deletion', async () => {
    const replacement = Promise.withResolvers<void>();
    const logger = { error: vi.fn(), info: vi.fn() };
    const resumeAfterReset = vi.fn(async () => undefined);
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: (signal: AbortSignal) => {
        signal.addEventListener('abort', () => replacement.resolve(), { once: true });
        return replacement.promise;
      },
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      resumeAfterReset,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    const reset = handleReset.reset();
    await vi.waitFor(() => expect(resetDesktopApplicationDataMock).toHaveBeenCalledOnce());
    let closed = false;
    const closing = handleReset.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    onTestFinished(async () => {
      replacement.resolve();
      await Promise.allSettled([reset, closing]);
    });
    await vi.waitFor(() => expect(closed).toBe(true));

    await closing;
    await expect(reset).resolves.toEqual({ success: true });
    expect(resumeAfterReset).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Desktop factory reset completed');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('joins queued repeated resets through deletion without reopening when quit arrives', async () => {
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const { createNativeRootDataDeletion } = await import('../native-root-data-deletion');
    const unexpected = (): never => {
      throw new Error('Unexpected root deletion operation');
    };
    const queue = createNativeRootDataDeletion({
      acquire: async () => {},
      captureOwner: async () => unexpected(),
      closeOwner: async () => {},
      deleteCanonicalRoot: async () => {},
      reserveRoot: unexpected,
      resume: async () => {},
      stopSources: async () => {},
    });
    const prior = Promise.withResolvers<void>();
    const replacement = Promise.withResolvers<void>();
    const predecessor = queue.transition(() => prior.promise);
    const stop = vi.fn(() => replacement.promise);
    resetDesktopApplicationDataMock.mockImplementation(async (options) => {
      await options.stopBackgroundRuntimes();
      return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
    });
    const resumeAfterReset = vi.fn(async () => {});
    const options = {
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: async () => {},
      resetPersistentStorageAfterDataDeletion: async () => {},
      resumeAfterReset,
      runTransition: queue.transition,
      runtimes: [{ name: 'physical-owner', stop }],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    };
    const owner = createDesktopFactoryResetHandler(options);
    const first = owner.reset();
    const repeated = owner.reset();
    expect(repeated).toBe(first);
    expect(owner.inFlight()).toBe(first);
    let closed = false;
    let idle = false;
    const close = owner.close().then(() => {
      closed = true;
    });
    const join = owner.idle().then(() => {
      idle = true;
    });
    onTestFinished(async () => {
      prior.resolve();
      replacement.resolve();
      await Promise.allSettled([predecessor, first, repeated, close, join]);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resetDesktopApplicationDataMock).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(closed).toBe(false);
    expect(idle).toBe(false);
    prior.resolve();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    expect(owner.inFlight()).toBe(first);
    expect(closed).toBe(false);
    expect(idle).toBe(false);
    replacement.resolve();
    await expect(first).resolves.toEqual({ success: true });
    await expect(repeated).resolves.toEqual({ success: true });
    await Promise.all([close, join]);
    expect(owner.inFlight()).toBeNull();
    expect(resetDesktopApplicationDataMock).toHaveBeenCalledOnce();
    expect(resumeAfterReset).not.toHaveBeenCalled();
    expect(completeSuccessfulResetMock).not.toHaveBeenCalled();
  });

  it('preserves refused transition admission without stopping or resetting any runtime', async () => {
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const refusal = new Error('Native root deletion owns admission; retry its cleanup first.');
    const stop = vi.fn(async () => {});
    const resumeAfterReset = vi.fn(async () => {});
    const options = {
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: async () => {},
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      resumeAfterReset,
      runTransition: vi.fn(async (): Promise<never> => {
        throw refusal;
      }),
      runtimes: [{ name: 'physical-owner', stop }],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    };
    const owner = createDesktopFactoryResetHandler(options);
    await expect(owner.reset()).rejects.toBe(refusal);
    await owner.close();
    expect(stop).not.toHaveBeenCalled();
    expect(resumeAfterReset).not.toHaveBeenCalled();
    expect(resetDesktopApplicationDataMock).not.toHaveBeenCalled();
  });

  it('refuses a reset once shutdown has closed it, touching nothing', async () => {
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await handleReset.close();

    await expect(handleReset.reset()).resolves.toEqual({
      message: 'The app is quitting: the factory reset did not start.',
      success: false,
    });
    expect(resetDesktopApplicationDataMock).not.toHaveBeenCalled();
  });

  it('stays busy until a reset in flight has reopened what it retired (BST-1930)', async () => {
    const replacement = Promise.withResolvers<void>();
    const resumeAfterReset = vi.fn(async () => undefined);
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: () => replacement.promise,
      logger: { error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resetPersistentStorageAfterDataDeletion: resetPersistentStorageAfterDataDeletionMock,
      resumeAfterReset,
      runTransition: (work) => work(),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });
    await handleReset.idle();

    const reset = handleReset.reset();
    await vi.waitFor(() => expect(resetDesktopApplicationDataMock).toHaveBeenCalledOnce());
    let idle = false;
    const waiting = handleReset.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    replacement.resolve();

    await waiting;
    expect(resumeAfterReset).toHaveBeenCalledWith('succeeded', expect.any(AbortSignal));
    await expect(reset).resolves.toEqual({ success: true });
  });
});

it('clears content through the same retirement owner without purging retained settings or sessions', async () => {
  const order: string[] = [];
  const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
  const clearRetainedContent = vi.fn(async () => {
    order.push('clear-content');
    return { deletedChunks: 3, deletedFiles: 2 };
  });
  const storageClear = vi.fn(async () => undefined);
  const reset = createDesktopFactoryResetHandler({
    clearRetainedContent,
    completeSuccessfulReset: async () => {
      order.push('replace');
    },
    logger: { error: vi.fn(), info: vi.fn() },
    prepareDatabaseProfileReset,
    resetLocalDatabase: vi.fn(async () => undefined),
    resetPersistentStorageAfterDataDeletion: storageClear,
    resumeAfterReset: async () => {
      order.push('resume');
    },
    runTransition: (work) => work(),
    runtimes: [
      {
        name: 'sources',
        stop: async () => {
          order.push('factory-only');
        },
        stopForContent: async () => {
          order.push('stop');
        },
      },
    ],
    sessionDataPath: '/retained/session',
    userDataPath: '/retained/profile',
  });
  const priorPurges = resetDesktopApplicationDataMock.mock.calls.length;
  await expect(reset.clearContent()).resolves.toEqual({
    deletedChunks: 3,
    deletedFiles: 2,
    success: true,
  });
  expect(order).toEqual(['stop', 'clear-content', 'replace', 'resume']);
  expect(resetDesktopApplicationDataMock).toHaveBeenCalledTimes(priorPurges);
  expect(storageClear).not.toHaveBeenCalled();
});

it('joins duplicate content clears but does not swallow a subsequent factory reset', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const clearRetainedContent = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { deletedChunks: null, deletedFiles: 1 };
  });
  resetDesktopApplicationDataMock.mockResolvedValue({
    deletedPaths: [],
    pendingDeletionPaths: [],
    preservedPaths: [],
  });
  const purgeCount = resetDesktopApplicationDataMock.mock.calls.length;
  const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
  const reset = createDesktopFactoryResetHandler({
    clearRetainedContent,
    completeSuccessfulReset: vi.fn(async () => undefined),
    logger: { error: vi.fn(), info: vi.fn() },
    prepareDatabaseProfileReset,
    resetLocalDatabase: vi.fn(async () => undefined),
    resetPersistentStorageAfterDataDeletion: vi.fn(async () => undefined),
    runTransition: (work) => work(),
    runtimes: [],
    sessionDataPath: '/retained/session',
    userDataPath: '/retained/profile',
  });
  const clear = reset.clearContent();
  await entered.promise;
  expect(reset.clearContent()).toBe(clear);
  const factory = reset.reset();
  expect(factory).not.toBe(clear);
  expect(resetDesktopApplicationDataMock).toHaveBeenCalledTimes(purgeCount);
  release.resolve();
  await expect(clear).resolves.toEqual({ deletedChunks: null, deletedFiles: 1, success: true });
  await expect(factory).resolves.toEqual({ success: true });
  expect(clearRetainedContent).toHaveBeenCalledTimes(1);
  expect(resetDesktopApplicationDataMock).toHaveBeenCalledTimes(purgeCount + 1);
});
