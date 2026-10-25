import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { captureProcessSignalHandlers } from '../helpers/process-signal-capture';
import {
  applicationDomainCapture,
  bootWindow,
  createLoggerMock,
  installMainBootFixture,
  isDesktopShuttingDownMock,
  mockApp,
  nativeAcquire,
  nativeAcquireProfile,
  nativeAcquireRead,
  nativeCloseForShutdown,
  nativePrepareForPause,
  nativeRebuild,
  nativeReconfigureForReset,
  requireIndexConfig,
  requireMainLogger,
  shutdownPlanCapture,
} from './boot-order-fixture';

/** One named owner step of Main's quit plan; a missing one fails the test. */
function shutdownOwner(name: string): () => Promise<void> | void {
  const step = shutdownPlanCapture.current?.().owners[name];
  if (!step) {
    throw new Error(`Main's quit plan has no ${name} owner`);
  }
  return step;
}

describe('main boot order', () => {
  installMainBootFixture();
  it.each([false, true])(
    'closes the hidden embedding host beside the agent host, each keeping its own failure=%s',
    async (fail) => {
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
      const settle = (step: () => Promise<void> | void) =>
        Promise.resolve()
          .then(step)
          .then(
            () => null,
            (error: unknown) => error
          );
      // The quit runs its owners together: neither waits for the other.
      const nativeStep = settle(shutdownOwner('native-index'));
      const embeddingStep = settle(shutdownOwner('embedding-host'));
      onTestFinished(async () => {
        native.resolve();
        physical.resolve();
        await Promise.all([nativeStep, embeddingStep]);
        dispose.mockRestore();
      });
      await vi.waitFor(() => expect(nativeCloseForShutdown).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
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
      expect(await embeddingStep).toBe(fail ? embeddingError : null);
      expect(dispose).toHaveBeenCalledOnce();
    }
  );

  it('joins an accepted reset before quit while an earlier native transition is held', async () => {
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
    if (!(options?.onResetLocal && plan)) {
      throw new Error('Main reset callback and shutdown plan were not captured');
    }
    // The same trigger Main's config owner uses once a change is saved.
    await requireIndexConfig().reconfigure();
    await entered.promise;
    const reset = options.onResetLocal();
    let closed = false;
    const close = Promise.resolve(plan['factory-reset']()).then(() => {
      closed = true;
    });
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
      const resetPlatform = await import('../../desktop-reset-platform');
      const createReset = resetPlatform.createDesktopFactoryResetHandler;
      const compose = vi
        .spyOn(resetPlatform, 'createDesktopFactoryResetHandler')
        .mockImplementation((ports) =>
          createReset({
            ...ports,
            completeSuccessfulReset: async () => {
              // A settings change saved while the reset finishes applies through Main's owner.
              await requireIndexConfig().reconfigure();
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
        closing = Promise.resolve(plan['factory-reset']());
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
      // The same trigger Main's config owner uses once a change is saved.
      const applying = requireIndexConfig().reconfigure();
      expect(nativePrepareForPause).toHaveBeenCalledOnce();
      // The owner's update returns once the change is queued; it applies in the background.
      await expect(applying).resolves.toBeUndefined();
      if (kind === 'none') {
        await vi.waitFor(() => expect(reconfigure).toHaveBeenCalledOnce());
      } else if (kind === 'typed') {
        // A Pause its owner superseded is the requested outcome, not a failure.
        await vi.waitFor(() =>
          expect(requireMainLogger().info).toHaveBeenCalledWith(
            'Native index generation replaced or retired',
            { reason: failure.message }
          )
        );
        expect(requireMainLogger().error).not.toHaveBeenCalledWith(
          'Saved native index configuration could not activate',
          expect.anything()
        );
        expect(reconfigure).not.toHaveBeenCalled();
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

  it('rebuilds for saved chunking in the background and reports the rebuild failure', async () => {
    const failure = new Error('Native rebuild failed');
    nativeRebuild.current = vi.fn(async () => {
      throw failure;
    });
    await import('../../main');
    // The same trigger Main's config owner uses once a chunking change is saved.
    await expect(requireIndexConfig().rebuild()).resolves.toBeUndefined();
    await vi.waitFor(() =>
      expect(requireMainLogger().error).toHaveBeenCalledWith(
        'Search index rebuild for the new chunking failed',
        { error: failure }
      )
    );
  });

  it('starts profile and native acquisition before showing a reader-ready window without PG', async () => {
    const reader = Promise.withResolvers<void>();
    nativeAcquireRead.mockReturnValue(reader.promise);
    await import('../../main');
    await vi.waitFor(() => expect(nativeAcquireRead).toHaveBeenCalledOnce());
    expect(nativeAcquireProfile).toHaveBeenCalled();
    expect(nativeAcquire).toHaveBeenCalledOnce();
    expect(bootWindow().show).not.toHaveBeenCalled();
    reader.resolve();
    await vi.waitFor(() => expect(bootWindow().show).toHaveBeenCalledOnce());
  });

  it('shows the failure-capable shell when native reader startup fails', async () => {
    const failure = new Error('Native reader unavailable');
    nativeAcquireRead.mockRejectedValue(failure);
    await import('../../main');
    await vi.waitFor(() => expect(bootWindow().show).toHaveBeenCalledOnce());
    expect(
      requireMainLogger().error.mock.calls.some(
        ([, details]: [unknown, { error?: unknown; reason?: string; innerErrors?: unknown }]) =>
          details?.error === failure
      )
    ).toBe(true);
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
    expect(bootWindow().show).not.toHaveBeenCalled();
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
    expect(bootWindow().show).not.toHaveBeenCalled();
  });

  it('preserves profile startup failure without opening a retired database', async () => {
    const failure = new Error('Profile unavailable');
    nativeAcquireProfile.mockRejectedValue(failure);
    await import('../../main');
    await vi.waitFor(() => expect(bootWindow().show).toHaveBeenCalledOnce());
    expect(
      requireMainLogger().error.mock.calls.some(
        ([, details]: [unknown, { error?: unknown; reason?: string; innerErrors?: unknown }]) =>
          details?.error === failure
      )
    ).toBe(true);
  });

  it('reports one shared acquisition failure once across writer and reader startup', async () => {
    const failure = new Error('Shared native acquisition failure');
    nativeAcquire.mockRejectedValue(failure);
    nativeAcquireRead.mockRejectedValue(failure);
    await import('../../main');
    await vi.waitFor(() => expect(bootWindow().show).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(bootWindow().show).toHaveBeenCalledOnce());
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
    expect(bootWindow().show).not.toHaveBeenCalled();
  });

  it('joins native retirement before acknowledging the native shutdown step', async () => {
    await import('../../main');
    const held = Promise.withResolvers<void>();
    nativeCloseForShutdown.mockReturnValue(held.promise);
    let settled = false;
    const step = Promise.resolve(shutdownOwner('native-index')()).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(nativeCloseForShutdown).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    held.resolve();
    await step;
    expect(settled).toBe(true);
  });

  it('joins the actual application IPC resource from its filesystem shutdown step', async () => {
    await import('../../main');
    const close = applicationDomainCapture.close;
    if (!close) {
      throw new Error('Application filesystem shutdown owner was not registered.');
    }
    const retirement = Promise.withResolvers<void>();
    close.mockReturnValueOnce(retirement.promise);
    let settled = false;
    const step = Promise.resolve(shutdownOwner('file-system')()).then(() => {
      settled = true;
    });
    expect(close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(false);
    retirement.resolve();
    await step;
    expect(settled).toBe(true);
  });

  it('the agent host step joins the existing native owner and preserves failure identity', async () => {
    await import('../../main');
    const closeHost = shutdownOwner('native-index');
    await closeHost();
    expect(nativeCloseForShutdown).toHaveBeenCalledOnce();
    const failure = new Error('Native physical close failed');
    nativeCloseForShutdown.mockRejectedValueOnce(failure);
    await expect(Promise.resolve().then(closeHost)).rejects.toBe(failure);
  });

  it('retains undefined IPC cleanup failure while the agent host close remains available', async () => {
    await import('../../main');
    const close = applicationDomainCapture.close;
    const closeFiles = shutdownOwner('file-system');
    const closeHost = shutdownOwner('native-index');
    if (!close) {
      throw new Error('Shutdown plan was not registered');
    }
    close.mockRejectedValueOnce(undefined);
    await expect(Promise.resolve().then(closeFiles)).rejects.toBeUndefined();
    await closeHost();
    expect(nativeCloseForShutdown).toHaveBeenCalledOnce();
  });

  it('keeps a failed native join failed rather than reopening PG', async () => {
    await import('../../main');
    const closeHost = shutdownOwner('native-index');
    nativeCloseForShutdown.mockRejectedValueOnce(undefined);
    await expect(Promise.resolve().then(closeHost)).rejects.toBeUndefined();
  });

  describe('shutdown signal registration', () => {
    let capture: ReturnType<typeof captureProcessSignalHandlers>;

    beforeEach(() => {
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
      await vi.waitFor(() => expect(bootWindow().show).toHaveBeenCalled());

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

      expect(shutdownPlanCapture.run).toHaveBeenCalledExactlyOnceWith('signal');
      expect(requireMainLogger().info).toHaveBeenCalledWith(
        'Shutdown already in progress; ignoring signal',
        { signal: 'SIGTERM' }
      );
    });
  });
});
