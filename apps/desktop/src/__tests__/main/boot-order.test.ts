import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { captureProcessSignalHandlers } from '../helpers/process-signal-capture';
import {
  applicationDomainCapture,
  closeDatabaseMock,
  createLoggerMock,
  getDatabaseMock,
  installMainBootFixture,
  isDesktopShuttingDownMock,
  maintenanceStartMock,
  mockApp,
  mockBrowserWindowInstance,
  nativeAcquire,
  nativeAcquireProfile,
  nativeAcquireRead,
  nativeCloseForShutdown,
  nativePrepareForPause,
  nativeReconfigureForReset,
  probeMock,
  recoverInterruptedMaintenanceMock,
  requireMainLogger,
  shutdownPlanCapture,
} from './boot-order-fixture';

describe('main boot order', () => {
  installMainBootFixture();
  it.each([false, true])(
    'starts and retains hidden disposal beside native close with independent failure=%s',
    async (fail) => {
      getDatabaseMock.mockResolvedValue({});
      const native = Promise.withResolvers<void>();
      const physical = Promise.withResolvers<void>();
      nativeCloseForShutdown.mockReturnValue(native.promise);
      const { EmbeddingHostManager } = await import('../../embedding-host-manager');
      const dispose = vi
        .spyOn(EmbeddingHostManager.prototype, 'dispose')
        .mockReturnValue(physical.promise);
      await import('../../main');
      const plan = shutdownPlanCapture.current?.();
      if (!plan) {
        throw new Error('Missing actual Main shutdown plan');
      }
      const signal = new AbortController().signal;
      let nativeSettled = false;
      const nativeStep = Promise.resolve(plan.steps['native-index'](signal)).then(
        () => {
          nativeSettled = true;
          return null;
        },
        (error: unknown) => {
          nativeSettled = true;
          return error;
        }
      );
      onTestFinished(async () => {
        native.resolve();
        physical.resolve();
        await nativeStep;
        dispose.mockRestore();
      });
      await vi.waitFor(() => expect(nativeCloseForShutdown).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
      expect(nativeSettled).toBe(false);
      const nativeError = new Error('Independent native retirement failure');
      const embeddingError = new Error('Independent physical embedding retirement failure');
      if (fail) {
        native.reject(nativeError);
        physical.reject(embeddingError);
      } else {
        native.resolve();
        physical.resolve();
      }
      expect(await nativeStep).toBe(fail ? nativeError : null);
      const embeddingStep = Promise.resolve(plan.steps['embedding-host'](signal)).catch(
        (error: unknown) => error
      );
      expect(await embeddingStep).toBe(fail ? embeddingError : undefined);
      expect(dispose).toHaveBeenCalledOnce();
    }
  );

  it('joins an accepted reset before quit while an earlier native transition is held', async () => {
    getDatabaseMock.mockResolvedValue({});
    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    nativeReconfigureForReset.current = () => {
      entered.resolve();
      return held.promise;
    };
    const resetData = await import('../../desktop-factory-reset');
    const purge = vi.spyOn(resetData, 'resetDesktopApplicationData').mockResolvedValue({
      deletedPaths: [],
      pendingDeletionPaths: [],
      preservedPaths: [],
    });
    const resetPlatform = await import('../../desktop-reset-platform');
    const createReset = resetPlatform.createDesktopFactoryResetHandler;
    const compose = vi
      .spyOn(resetPlatform, 'createDesktopFactoryResetHandler')
      .mockImplementation((ports) =>
        createReset({
          ...ports,
          completeSuccessfulReset: async () => {},
          resetPersistentStorageAfterDataDeletion: async () => {},
          resumeAfterReset: async () => {},
          runtimes: [],
        })
      );
    onTestFinished(() => {
      purge.mockRestore();
      compose.mockRestore();
    });
    await import('../../main');
    const options = applicationDomainCapture.options;
    const plan = shutdownPlanCapture.current?.();
    if (!(options?.onStorageChanged && options.onResetLocal && plan)) {
      throw new Error('Main reset and storage callbacks were not captured');
    }
    const { NATIVE_INDEX_SETTINGS_KEY } = await import('../../native-index-settings');
    options.onStorageChanged(NATIVE_INDEX_SETTINGS_KEY);
    await entered.promise;
    const reset = options.onResetLocal();
    let closed = false;
    const close = Promise.resolve(plan.steps['factory-reset'](new AbortController().signal)).then(
      () => {
        closed = true;
      }
    );
    onTestFinished(async () => {
      held.resolve();
      await Promise.allSettled([reset, close]);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    held.resolve();
    await expect(reset).resolves.toEqual({ success: true });
    await close;
    expect(purge).toHaveBeenCalledOnce();
  });

  it.each(['completed', 'replacement-failed', 'resume-failed', 'quit'] as const)(
    'defers a reset renderer native-settings notification through replacement and reopen: %s',
    async (outcome) => {
      getDatabaseMock.mockResolvedValue({});
      const notified = Promise.withResolvers<void>();
      const replacement = Promise.withResolvers<void>();
      const resuming = Promise.withResolvers<void>();
      const resumed = Promise.withResolvers<void>();
      let reopened = false;
      const failure =
        outcome === 'resume-failed'
          ? new AggregateError(
              [new Error('Native resume failed'), new Error('MCP resume failed')],
              'Reset resume failed'
            )
          : new Error('Replacement renderer failed');
      const { NativeAuthorityTransitionError } = await import('../../native-authority-transition');
      nativePrepareForPause.mockImplementation(async () => {
        if (!reopened) {
          throw new NativeAuthorityTransitionError(
            'Native Pause was superseded by terminal retirement.'
          );
        }
        return null;
      });
      const reconfigure = vi.fn(async () => {});
      nativeReconfigureForReset.current = reconfigure;
      const resetData = await import('../../desktop-factory-reset');
      const purge = vi.spyOn(resetData, 'resetDesktopApplicationData').mockResolvedValue({
        deletedPaths: [],
        pendingDeletionPaths: [],
        preservedPaths: [],
      });
      const { NATIVE_INDEX_SETTINGS_KEY } = await import('../../native-index-settings');
      const resetPlatform = await import('../../desktop-reset-platform');
      const createReset = resetPlatform.createDesktopFactoryResetHandler;
      const compose = vi
        .spyOn(resetPlatform, 'createDesktopFactoryResetHandler')
        .mockImplementation((ports) =>
          createReset({
            ...ports,
            completeSuccessfulReset: async () => {
              applicationDomainCapture.options?.onStorageChanged?.(NATIVE_INDEX_SETTINGS_KEY);
              notified.resolve();
              await replacement.promise;
            },
            resetPersistentStorageAfterDataDeletion: async () => {},
            resumeAfterReset: async () => {
              resuming.resolve();
              await resumed.promise;
              reopened = true;
            },
            runtimes: [],
          })
        );
      await import('../../main');
      const reset = applicationDomainCapture.options?.onResetLocal?.();
      if (!reset) {
        throw new Error('Main reset callback was not captured');
      }
      onTestFinished(async () => {
        replacement.resolve();
        resumed.resolve();
        await reset;
        purge.mockRestore();
        compose.mockRestore();
      });
      await notified.promise;
      expect(nativePrepareForPause).not.toHaveBeenCalled();
      expect(reconfigure).not.toHaveBeenCalled();
      let closing: Promise<void> | undefined;
      if (outcome === 'quit') {
        isDesktopShuttingDownMock.mockReturnValue(true);
        const plan = shutdownPlanCapture.current?.();
        if (!plan) {
          throw new Error('Missing actual Main shutdown plan');
        }
        closing = Promise.resolve(plan.steps['factory-reset'](new AbortController().signal));
      }
      if (outcome === 'replacement-failed') {
        replacement.reject(failure);
      } else if (outcome === 'quit') {
        replacement.resolve();
      } else {
        replacement.resolve();
        await resuming.promise;
        expect(nativePrepareForPause).not.toHaveBeenCalled();
        if (outcome === 'resume-failed') {
          resumed.reject(failure);
        } else {
          resumed.resolve();
        }
      }
      if (outcome === 'replacement-failed' || outcome === 'resume-failed') {
        await expect(reset).resolves.toEqual({ message: failure.message, success: false });
        expect(requireMainLogger().error).toHaveBeenCalledWith(
          'Failed to reset desktop application data:',
          failure
        );
      } else {
        await expect(reset).resolves.toEqual({ success: true });
      }
      await closing;
      if (outcome === 'completed') {
        await vi.waitFor(() => expect(reconfigure).toHaveBeenCalledOnce());
        expect(nativePrepareForPause).toHaveBeenCalledOnce();
      } else {
        expect(nativePrepareForPause).not.toHaveBeenCalled();
        expect(reconfigure).not.toHaveBeenCalled();
      }
      expect(requireMainLogger().error).not.toHaveBeenCalledWith(
        'Saved native index configuration could not activate',
        expect.anything()
      );
    }
  );

  it.each(['none', 'typed', 'independent'] as const)(
    'prepares saved settings synchronously outside reset and preserves failure=%s',
    async (kind) => {
      getDatabaseMock.mockResolvedValue({});
      const { NativeAuthorityTransitionError } = await import('../../native-authority-transition');
      const failure =
        kind === 'typed'
          ? new NativeAuthorityTransitionError(
              'Native Pause was superseded by terminal retirement.'
            )
          : new Error('Independent settings read failed');
      if (kind !== 'none') {
        nativePrepareForPause.mockRejectedValue(failure);
      }
      const reconfigure = vi.fn(async () => {});
      nativeReconfigureForReset.current = reconfigure;
      await import('../../main');
      const { NATIVE_INDEX_SETTINGS_KEY } = await import('../../native-index-settings');
      applicationDomainCapture.options?.onStorageChanged?.(NATIVE_INDEX_SETTINGS_KEY);
      expect(nativePrepareForPause).toHaveBeenCalledOnce();
      if (kind === 'none') {
        await vi.waitFor(() => expect(reconfigure).toHaveBeenCalledOnce());
      } else {
        await vi.waitFor(() =>
          expect(requireMainLogger().error).toHaveBeenCalledWith(
            'Saved native index configuration could not activate',
            { error: failure }
          )
        );
        expect(reconfigure).not.toHaveBeenCalled();
      }
    }
  );

  it('starts profile and native acquisition before showing a reader-ready window without PG', async () => {
    const reader = Promise.withResolvers<void>();
    nativeAcquireRead.mockReturnValue(reader.promise);
    await import('../../main');
    await vi.waitFor(() => expect(nativeAcquireRead).toHaveBeenCalledOnce());
    expect(nativeAcquireProfile).toHaveBeenCalled();
    expect(nativeAcquire).toHaveBeenCalledOnce();
    expect(mockBrowserWindowInstance.show).not.toHaveBeenCalled();
    reader.resolve();
    await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalledOnce());
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
    expect(maintenanceStartMock).not.toHaveBeenCalled();
    expect(recoverInterruptedMaintenanceMock).not.toHaveBeenCalled();
  });

  it('shows the failure-capable shell when native reader startup fails', async () => {
    const failure = new Error('Native reader unavailable');
    nativeAcquireRead.mockRejectedValue(failure);
    await import('../../main');
    await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalledOnce());
    expect(
      requireMainLogger().error.mock.calls.some(
        ([, details]: [unknown, { error?: unknown; reason?: string; innerErrors?: unknown }]) =>
          details?.error === failure
      )
    ).toBe(true);
    expect(getDatabaseMock).not.toHaveBeenCalled();
  });

  it('keeps owned native startup retirement informational during terminal shutdown', async () => {
    const reader = Promise.withResolvers<void>();
    nativeAcquireRead.mockReturnValue(reader.promise);
    await import('../../main');
    await vi.waitFor(() => expect(nativeAcquireRead).toHaveBeenCalledOnce());
    const { NativeAuthorityTransitionError } = await import('../../native-authority-transition');
    const failure = new NativeAuthorityTransitionError('Native owner retired');
    isDesktopShuttingDownMock.mockReturnValue(true);
    reader.reject(failure);
    await vi.waitFor(() =>
      expect(
        requireMainLogger().info.mock.calls.some(
          ([, details]: [unknown, { error?: unknown; reason?: string; innerErrors?: unknown }]) =>
            details?.reason === failure.message
        )
      ).toBe(true)
    );
    expect(
      requireMainLogger().error.mock.calls.some(
        ([, details]: [unknown, { error?: unknown; reason?: string; innerErrors?: unknown }]) =>
          details?.error === failure
      )
    ).toBe(false);
    expect(mockBrowserWindowInstance.show).not.toHaveBeenCalled();
  });

  it('keeps an independent reader failure visible during shutdown', async () => {
    const reader = Promise.withResolvers<void>();
    nativeAcquireRead.mockReturnValue(reader.promise);
    await import('../../main');
    await vi.waitFor(() => expect(nativeAcquireRead).toHaveBeenCalledOnce());
    const failure = new Error('Independent read failure');
    isDesktopShuttingDownMock.mockReturnValue(true);
    reader.reject(failure);
    await vi.waitFor(() =>
      expect(
        requireMainLogger().error.mock.calls.some(
          ([, details]: [unknown, { error?: unknown; reason?: string; innerErrors?: unknown }]) =>
            details?.error === failure
        )
      ).toBe(true)
    );
    expect(mockBrowserWindowInstance.show).not.toHaveBeenCalled();
  });

  it('preserves profile startup failure without opening a retired database', async () => {
    const failure = new Error('Profile unavailable');
    nativeAcquireProfile.mockRejectedValue(failure);
    await import('../../main');
    await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalledOnce());
    expect(
      requireMainLogger().error.mock.calls.some(
        ([, details]: [unknown, { error?: unknown; reason?: string; innerErrors?: unknown }]) =>
          details?.error === failure
      )
    ).toBe(true);
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(maintenanceStartMock).not.toHaveBeenCalled();
  });

  it('reports one shared acquisition failure once across writer and reader startup', async () => {
    const failure = new Error('Shared native acquisition failure');
    nativeAcquire.mockRejectedValue(failure);
    nativeAcquireRead.mockRejectedValue(failure);
    await import('../../main');
    await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalledOnce());
    expect(
      requireMainLogger().error.mock.calls.filter(
        ([, details]: [unknown, { error?: unknown; reason?: string; innerErrors?: unknown }]) =>
          details?.error === failure
      )
    ).toHaveLength(1);
  });

  it('retains each independent partial native acquisition failure', async () => {
    const first = new Error('Physical child failure');
    const failure = new AggregateError([first, undefined], 'Native acquisition failed');
    nativeAcquire.mockRejectedValue(failure);
    await import('../../main');
    await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalledOnce());
    const details = requireMainLogger().error.mock.calls.find(
      ([, value]: [unknown, { error?: unknown; innerErrors?: unknown }]) => value?.error === failure
    )?.[1];
    expect(details?.error).toBe(failure);
    expect(failure.errors).toEqual([first, undefined]);
    expect(details?.innerErrors).toEqual([
      { message: first.message, name: 'Error' },
      { message: 'undefined', name: 'undefined' },
    ]);
  });

  it('does not create a window when reader startup completes after shutdown begins', async () => {
    const reader = Promise.withResolvers<void>();
    nativeAcquireRead.mockReturnValue(reader.promise);
    await import('../../main');
    await vi.waitFor(() => expect(nativeAcquireRead).toHaveBeenCalledOnce());
    isDesktopShuttingDownMock.mockReturnValue(true);
    reader.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockBrowserWindowInstance.show).not.toHaveBeenCalled();
    expect(maintenanceStartMock).not.toHaveBeenCalled();
  });

  it('joins native retirement before acknowledging the native shutdown step', async () => {
    await import('../../main');
    const plan = shutdownPlanCapture.current?.();
    if (!plan) {
      throw new Error('Shutdown plan was not registered');
    }
    const held = Promise.withResolvers<void>();
    nativeCloseForShutdown.mockReturnValue(held.promise);
    let settled = false;
    const step = Promise.resolve(plan.steps['native-index'](new AbortController().signal)).then(
      () => {
        settled = true;
      }
    );
    await vi.waitFor(() => expect(nativeCloseForShutdown).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    held.resolve();
    await step;
    expect(settled).toBe(true);
    expect(closeDatabaseMock).not.toHaveBeenCalled();
  });

  it('joins the actual application IPC resource from its filesystem shutdown step', async () => {
    getDatabaseMock.mockResolvedValue({});
    await import('../../main');
    const planRun = shutdownPlanCapture.current;
    const close = applicationDomainCapture.close;
    if (!(planRun && close)) {
      throw new Error('Application filesystem shutdown owner was not registered.');
    }
    const retirement = Promise.withResolvers<void>();
    close.mockReturnValueOnce(retirement.promise);
    let settled = false;
    const step = Promise.resolve(planRun().steps['file-system'](new AbortController().signal)).then(
      () => {
        settled = true;
      }
    );
    expect(close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(false);
    retirement.resolve();
    await step;
    expect(settled).toBe(true);
  });

  it('reserved close joins the existing native owner and preserves failure identity', async () => {
    await import('../../main');
    const plan = shutdownPlanCapture.current?.();
    if (!plan) {
      throw new Error('Shutdown plan was not registered');
    }
    await plan.closeDatabase();
    expect(nativeCloseForShutdown).toHaveBeenCalledOnce();
    const failure = new Error('Native physical close failed');
    nativeCloseForShutdown.mockRejectedValueOnce(failure);
    await expect(plan.closeDatabase()).rejects.toBe(failure);
    expect(closeDatabaseMock).not.toHaveBeenCalled();
  });

  it('retains undefined IPC cleanup failure while reserved native retirement remains available', async () => {
    await import('../../main');
    const plan = shutdownPlanCapture.current?.();
    const close = applicationDomainCapture.close;
    if (!(plan && close)) {
      throw new Error('Shutdown plan was not registered');
    }
    close.mockRejectedValueOnce(undefined);
    await expect(plan.steps['file-system'](new AbortController().signal)).rejects.toBeUndefined();
    await plan.closeDatabase();
    expect(nativeCloseForShutdown).toHaveBeenCalledOnce();
  });

  it('keeps a failed reserved native join failed rather than reopening PG', async () => {
    await import('../../main');
    const plan = shutdownPlanCapture.current?.();
    if (!plan) {
      throw new Error('Shutdown plan was not registered');
    }
    nativeCloseForShutdown.mockRejectedValueOnce(undefined);
    await expect(plan.closeDatabase()).rejects.toBeUndefined();
    expect(getDatabaseMock).not.toHaveBeenCalled();
    expect(closeDatabaseMock).not.toHaveBeenCalled();
  });

  describe('shutdown signal registration', () => {
    let capture: ReturnType<typeof captureProcessSignalHandlers>;

    beforeEach(() => {
      getDatabaseMock.mockResolvedValue({});
      capture = captureProcessSignalHandlers();
    });

    afterEach(() => {
      capture.restore();
      // Kept until here, not restored right after the import: `main.ts` reads the launch flag
      // from the `whenReady` callback, which runs after the import returns.
      process.argv = process.argv.filter((arg) => arg !== '--test-mode');
    });

    const importMainInE2eMode = async (): Promise<void> => {
      process.argv.push('--test-mode');
      await import('../../main');
    };

    it('installs no handlers under NODE_ENV=test, so importing main never touches the test process', async () => {
      await import('../../main');
      await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalled());

      expect(capture.handlers.size).toBe(0);
    });

    it('installs persistent SIGINT, SIGTERM and SIGHUP handlers in an E2E launch, which also runs under NODE_ENV=test', async () => {
      // `when-exit`, through electron-store, registers a once-listener at import time.
      const dependencyListener = vi.fn();
      capture.handlers.set('SIGINT', [dependencyListener]);

      await importMainInE2eMode();

      await vi.waitFor(() =>
        expect([...capture.handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM'])
      );
      for (const listeners of capture.handlers.values()) {
        expect(listeners).toHaveLength(1);
      }
      // Replaced, not stacked behind: a dead libuv watcher would never fire ours.
      expect(capture.handlers.get('SIGINT')).not.toContain(dependencyListener);
    });

    it('reads the E2E launch flag when ready fires, not when main is imported', async () => {
      // A real `whenReady` resolves after the import returns.
      const ready = Promise.withResolvers<void>();
      mockApp.whenReady.mockReturnValueOnce(ready.promise);

      await importMainInE2eMode();
      expect(capture.handlers.size).toBe(0);
      ready.resolve();

      await vi.waitFor(() =>
        expect([...capture.handlers.keys()].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM'])
      );
    });

    it("waits for app ready: a listener registered earlier is replaced by Electron's own one-shot handler", async () => {
      mockApp.whenReady.mockReturnValueOnce(new Promise(() => undefined));

      await importMainInE2eMode();

      expect(capture.handlers.size).toBe(0);
    });

    describe('when installing the handlers throws', () => {
      // The smallest seam that proves boot survives: main.ts itself, with the install's own
      // `process.removeAllListeners` made to throw for SIGINT (libuv refusing to arm, say).
      const failInstall = (): void => {
        const passThrough = vi.mocked(process.removeAllListeners).getMockImplementation();
        vi.mocked(process.removeAllListeners).mockImplementation(((event?: string | symbol) => {
          if (event === 'SIGINT') {
            throw new Error('libuv could not arm the watcher');
          }
          return passThrough?.(event);
        }) as typeof process.removeAllListeners);
      };
      const defaultLogger = createLoggerMock.getMockImplementation();

      afterEach(() => {
        if (defaultLogger) {
          createLoggerMock.mockImplementation(defaultLogger);
        }
      });

      // The E2E-mode boot (the only one that installs) does not show a window under these mocks, so
      // "boot went on" is the boot `try` being entered: its first statement logs this.
      const bootWentOn = (): void => {
        expect(requireMainLogger().debug).toHaveBeenCalledWith(
          'App ready, starting initialization...'
        );
      };

      it('logs it at error and still boots', async () => {
        failInstall();

        await importMainInE2eMode();

        await vi.waitFor(bootWentOn);
        expect(requireMainLogger().error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to install the shutdown signal handlers'),
          {
            // SIGINT failed before its listeners were removed, so Electron's handler still quits.
            error: expect.objectContaining({
              cause: expect.objectContaining({ message: 'libuv could not arm the watcher' }),
              failedSignal: 'SIGINT',
              installed: [],
              name: 'ShutdownSignalInstallError',
              removedListeners: false,
            }),
          }
        );
      });

      it('still boots when that log itself throws', async () => {
        failInstall();
        createLoggerMock.mockImplementation((scope: string) => ({
          debug: vi.fn(),
          error: vi.fn((message: unknown) => {
            if (
              scope === 'DesktopMain' &&
              typeof message === 'string' &&
              message.startsWith('Failed to install')
            ) {
              throw new Error('logger broke');
            }
          }),
          info: vi.fn(),
          trace: vi.fn(),
          warn: vi.fn(),
        }));

        await importMainInE2eMode();

        await vi.waitFor(bootWentOn);
      });
    });

    it('starts one graceful run from the first signal and logs later signals instead of re-running', async () => {
      await importMainInE2eMode();
      await vi.waitFor(() => expect(capture.handlers.size).toBe(3));
      const listeners = (signal: string) => capture.handlers.get(signal) ?? [];

      listeners('SIGINT')[0]?.('SIGINT');
      await vi.waitFor(() => expect(shutdownPlanCapture.run).toHaveBeenCalledTimes(1));
      listeners('SIGTERM')[0]?.('SIGTERM');
      listeners('SIGINT')[0]?.('SIGINT');

      expect(shutdownPlanCapture.run).toHaveBeenCalledExactlyOnceWith('signal', 'SIGINT');
      expect(requireMainLogger().info).toHaveBeenCalledWith(
        'Shutdown already in progress; ignoring signal',
        { signal: 'SIGTERM' }
      );
    });
  });
});
