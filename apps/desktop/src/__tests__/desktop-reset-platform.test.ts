import { BoundaryFailureError } from '@brainstrike/assistant-contract/boundary-failure';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { MessageConnection } from 'vscode-jsonrpc';
import { PROFILE_CLOSED_FOR_QUIT, PROFILE_CLOSED_FOR_RESET } from '../desktop-shutdown-state';
import { MainMcpHostControl } from '../mcp/main-host-control';

const resetDesktopApplicationDataMock = vi.hoisted(() => vi.fn());
const completeSuccessfulResetMock = vi.hoisted(() => vi.fn(async () => undefined));

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

  it('replaces the renderer only after deleting application data', async () => {
    const invocationOrder: string[] = [];
    resetDesktopApplicationDataMock.mockImplementationOnce(async () => {
      invocationOrder.push('application-data');
      return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
    });
    const completeSuccessfulReset = vi.fn(async () => {
      invocationOrder.push('renderer-replacement');
    });

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({ success: true });
    expect(invocationOrder).toEqual(['application-data', 'renderer-replacement']);
    expect(completeSuccessfulReset).toHaveBeenCalledWith(expect.any(AbortSignal), 'factory');
  });

  it('stops every background runtime and requires the profile lease before deletion', async () => {
    const resetLocalDatabase = vi.fn(async () => undefined);
    const mcpRuntimeStop = vi.fn(async () => undefined);
    const appUpdateStop = vi.fn(async () => undefined);
    const parserHostStop = vi.fn(async () => undefined);

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase,
      runtimes: [
        { name: 'mcp-runtime', stop: mcpRuntimeStop },
        { name: 'app-update', stop: appUpdateStop },
        { name: 'parser-host', stop: parserHostStop },
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
    expect(mcpRuntimeStop).toHaveBeenCalledTimes(1);
    expect(appUpdateStop).toHaveBeenCalledTimes(1);
    expect(parserHostStop).toHaveBeenCalledTimes(1);

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
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({ success: true });

    expect(resetDesktopApplicationDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorLogFilePaths })
    );
  });

  it("gives Factory Reset its managed worktrees' archive, and Clear Database none", async () => {
    const archiveManagedWorktrees = vi.fn(async () => ({
      ok: true as const,
      value: { archived: [], retained: [] },
    }));
    const clearRetainedContent = vi.fn(async () => undefined);

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      archiveManagedWorktrees,
      clearRetainedContent,
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({ success: true });
    await expect(handleReset.clearContent()).resolves.toEqual({ success: true });

    expect(resetDesktopApplicationDataMock).toHaveBeenCalledTimes(1);
    expect(resetDesktopApplicationDataMock).toHaveBeenCalledWith(
      expect.objectContaining({ archiveManagedWorktrees })
    );
    expect(clearRetainedContent).toHaveBeenCalledTimes(1);
    expect(archiveManagedWorktrees).not.toHaveBeenCalled();
  });

  it('returns a failed reset result without hiding the runtime shutdown error', async () => {
    const error = new Error('llm host refused to stop');
    resetDesktopApplicationDataMock.mockRejectedValueOnce(error);
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
    const resumeAfterReset = vi.fn(async () => undefined);

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
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
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
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
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
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
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
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
      const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
      const resumeAfterReset = vi.fn(async () => undefined);
      const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
      const handleReset = createDesktopFactoryResetHandler({
        completeSuccessfulReset: completeSuccessfulResetMock,
        logger,
        prepareDatabaseProfileReset,
        resetLocalDatabase: vi.fn(async () => undefined),
        resumeAfterReset,
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
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
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
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
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
    const stopFailure = new Error('MCP runtime stop failed');
    const secondStopFailure = new Error('chunking stop failed');
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
    const mcpRuntimeStop = vi.fn(async () => {
      throw stopFailure;
    });
    const appUpdateStop = vi.fn(async () => {
      throw secondStopFailure;
    });

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      runtimes: [
        { name: 'mcp-runtime', stop: mcpRuntimeStop },
        { name: 'app-update', stop: appUpdateStop },
      ],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({
      message: 'Failed to stop desktop reset runtimes: mcp-runtime, app-update',
      success: false,
    });
    expect(mcpRuntimeStop).toHaveBeenCalledTimes(1);
    expect(appUpdateStop).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to reset desktop application data:',
      expect.objectContaining({ errors: [stopFailure, secondStopFailure] })
    );
  });

  it.each([
    ['not running', () => undefined],
    [
      'still starting',
      (control: MainMcpHostControl) => {
        // Bound but never ready: a request reaching it would fail the reset.
        control.bind({
          sendRequest: () => Promise.reject(new Error('the starting host answered')),
        } as unknown as MessageConnection);
      },
    ],
  ])('completes the wipe when the agent host is %s (BST-2400)', async (_state, arrange) => {
    resetDesktopApplicationDataMock.mockImplementationOnce(
      async ({
        resetDatabaseProfile,
        stopBackgroundRuntimes,
      }: {
        resetDatabaseProfile: () => Promise<void>;
        stopBackgroundRuntimes: () => Promise<void>;
      }) => {
        await stopBackgroundRuntimes();
        await resetDatabaseProfile();
        return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
      }
    );
    const clearRootContents = vi.fn(async () => undefined);
    const lease = {
      clearRootContents,
      isReleased: false,
      release: () => undefined,
      root: '/mock/profile',
    };
    const control = new MainMcpHostControl();
    arrange(control);

    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset: async () => lease,
      resetLocalDatabase: async (owned) => {
        await owned?.clearRootContents();
      },
      runtimes: [{ name: 'mcp-runtime', stop: () => control.resetSettings() }],
      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({ success: true });
    expect(clearRootContents).toHaveBeenCalledOnce();
  });

  it.each([new Error('profile deletion failed'), undefined])(
    'rejects terminal close with the original accepted reset failure (%s)',
    async (failure) => {
      const purge = Promise.withResolvers<void>();
      resetDesktopApplicationDataMock.mockImplementationOnce(() => purge.promise);
      const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
      const resumeAfterReset = vi.fn(async () => undefined);
      const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
      const owner = createDesktopFactoryResetHandler({
        completeSuccessfulReset: completeSuccessfulResetMock,
        logger,
        prepareDatabaseProfileReset,
        resetLocalDatabase: async () => {},
        resumeAfterReset,
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
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
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
      resumeAfterReset,
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

  it('ends a reset whose deletion completed, but whose resume quit refused, as complete (BST-2278)', async () => {
    // Quit fences profile admission before its factory-reset step runs: the resume that
    // reopens the profile after the deletion borrows through that admission and is refused.
    const quitRefusal = new BoundaryFailureError(PROFILE_CLOSED_FOR_QUIT);
    const resumeAfterReset = vi.fn(async () => {
      throw quitRefusal;
    });
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toEqual({ success: true });
    expect(resumeAfterReset).toHaveBeenCalledWith('succeeded', expect.any(AbortSignal));
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'Factory reset complete; resume skipped because the app is quitting',
      quitRefusal
    );
    expect(logger.info).toHaveBeenCalledWith('Desktop factory reset completed');
  });

  it.each([
    ['a profile closed for a reset', new BoundaryFailureError(PROFILE_CLOSED_FOR_RESET)],
    ['an untyped failure', new Error('watcher failed')],
  ] as const)('keeps a resume failure with %s a reset failure', async (_name, resumeFailure) => {
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset: vi.fn(async () => {
        throw resumeFailure;
      }),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toMatchObject({ success: false });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to reset desktop application data:',
      resumeFailure
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('keeps a failed deletion a reset failure when quit also refuses its resume', async () => {
    const purgeFailure = new Error('purge failed');
    resetDesktopApplicationDataMock.mockRejectedValueOnce(purgeFailure);
    const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn() };
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger,
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset: vi.fn(async () => {
        throw new BoundaryFailureError(PROFILE_CLOSED_FOR_QUIT);
      }),
      runtimes: [],

      sessionDataPath: '/mock/userData/session-data',
      userDataPath: '/mock/userData',
    });

    await expect(handleReset.reset()).resolves.toMatchObject({ success: false });
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to reset desktop application data:',
      expect.objectContaining({ errors: [purgeFailure, expect.any(Error)] })
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('joins repeated resets through deletion without reopening when quit arrives', async () => {
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const replacement = Promise.withResolvers<void>();
    const stop = vi.fn(() => replacement.promise);
    resetDesktopApplicationDataMock.mockImplementation(async (options) => {
      await options.stopBackgroundRuntimes();
      return { deletedPaths: [], pendingDeletionPaths: [], preservedPaths: [] };
    });
    const resumeAfterReset = vi.fn(async () => {});
    const options = {
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: async () => {},
      resumeAfterReset,
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
      replacement.resolve();
      await Promise.allSettled([first, repeated, close, join]);
    });
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

  it('refuses a reset once shutdown has closed it, touching nothing', async () => {
    const { createDesktopFactoryResetHandler } = await import('../desktop-reset-platform');
    const handleReset = createDesktopFactoryResetHandler({
      completeSuccessfulReset: completeSuccessfulResetMock,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
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
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
      prepareDatabaseProfileReset,
      resetLocalDatabase: vi.fn(async () => undefined),
      resumeAfterReset,
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
  });
  const reset = createDesktopFactoryResetHandler({
    clearRetainedContent,
    completeSuccessfulReset: async (_signal, mode) => {
      order.push(`replace:${mode}`);
    },
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
    prepareDatabaseProfileReset,
    resetLocalDatabase: vi.fn(async () => undefined),
    resumeAfterReset: async () => {
      order.push('resume');
    },
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
  await expect(reset.clearContent()).resolves.toEqual({ success: true });
  // A content clear keeps configuration, so the renderer's storage is not wiped.
  expect(order).toEqual(['stop', 'clear-content', 'replace:content', 'resume']);
  expect(resetDesktopApplicationDataMock).toHaveBeenCalledTimes(priorPurges);
});

it('joins duplicate content clears but does not swallow a subsequent factory reset', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const clearRetainedContent = vi.fn(async () => {
    entered.resolve();
    await release.promise;
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
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn() },
    prepareDatabaseProfileReset,
    resetLocalDatabase: vi.fn(async () => undefined),
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
  await expect(clear).resolves.toEqual({ success: true });
  await expect(factory).resolves.toEqual({ success: true });
  expect(clearRetainedContent).toHaveBeenCalledTimes(1);
  expect(resetDesktopApplicationDataMock).toHaveBeenCalledTimes(purgeCount + 1);
});
