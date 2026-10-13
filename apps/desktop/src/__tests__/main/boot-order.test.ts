import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { captureProcessSignalHandlers } from '../helpers/process-signal-capture';
import {
  agentClientCloseForShutdown,
  applicationDomainCapture,
  cleanupSubscriptionsMock,
  closeDatabaseMock,
  createLoggerMock,
  getDatabaseMock,
  installMainBootFixture,
  isDesktopShuttingDownMock,
  maintenanceCloseMock,
  maintenanceStartMock,
  maintenanceStopMock,
  mockApp,
  mockBrowserWindowInstance,
  nativeCloseForShutdown,
  nativePrepareForPause,
  nativeReconfigureForReset,
  probeMock,
  recoverInterruptedMaintenanceMock,
  requireMainLogger,
  shutdownPlanCapture,
  waitForDatabaseIdleMock,
} from './boot-order-fixture';

describe('main boot order', () => {
  installMainBootFixture();
  it('joins renderer borrowers before native retirement and retains independent failures', async () => {
    getDatabaseMock.mockResolvedValue({});
    const borrower = Promise.withResolvers<void>();
    const borrowerFailure = new Error('independent borrower retirement failure');
    const nativeFailure = new Error('independent native retirement failure');
    const close = agentClientCloseForShutdown.mockReturnValue(borrower.promise);
    nativeCloseForShutdown.mockResolvedValue(undefined);
    await import('../../main');
    const plan = shutdownPlanCapture.current?.();
    if (!plan) {
      throw new Error('Missing actual Main shutdown plan');
    }
    const step = Promise.resolve(plan.steps['native-index'](new AbortController().signal)).catch(
      (cause: unknown) => cause
    );
    onTestFinished(async () => {
      borrower.resolve();
      await step;
    });
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(nativeCloseForShutdown).not.toHaveBeenCalled();
    nativeCloseForShutdown.mockRejectedValue(nativeFailure);
    borrower.reject(borrowerFailure);
    const result = await step;
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([borrowerFailure, nativeFailure]);
    expect(nativeCloseForShutdown).toHaveBeenCalledOnce();
  });

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

  it('creates and shows the main window without waiting for DB init or the capability probe', async () => {
    let resolveDatabase: ((db: unknown) => void) | undefined;
    getDatabaseMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDatabase = resolve;
        })
    );

    await import('../../main');

    // The window must come up while getDatabase() is still pending.
    await vi.waitFor(() => {
      expect(mockBrowserWindowInstance.loadFile).toHaveBeenCalled();
      expect(mockBrowserWindowInstance.show).toHaveBeenCalled();
    });
    expect(maintenanceStartMock).not.toHaveBeenCalled();

    // Once the DB (and probe) complete, the maintenance schedulers start.
    resolveDatabase?.({});
    await vi.waitFor(() => {
      expect(probeMock).toHaveBeenCalledTimes(1);
      expect(maintenanceStartMock).toHaveBeenCalledTimes(1);
    });
    expect(recoverInterruptedMaintenanceMock).toHaveBeenCalledTimes(1);
    expect(recoverInterruptedMaintenanceMock.mock.invocationCallOrder[0]).toBeLessThan(
      probeMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
    expect(probeMock.mock.invocationCallOrder[0]).toBeLessThan(
      maintenanceStartMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('does not start maintenance when exclusive boot recovery fails', async () => {
    getDatabaseMock.mockResolvedValue({});
    recoverInterruptedMaintenanceMock.mockRejectedValueOnce(new Error('recovery failed'));

    await import('../../main');

    await vi.waitFor(() => expect(recoverInterruptedMaintenanceMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalled());
    expect(probeMock).not.toHaveBeenCalled();
    expect(maintenanceStartMock).not.toHaveBeenCalled();
    const mainLogger = createLoggerMock.mock.results
      .map((result) => result.value)
      .at(createLoggerMock.mock.calls.findIndex(([scope]) => scope === 'DesktopMain'));
    await vi.waitFor(() =>
      expect(mainLogger?.error).toHaveBeenCalledWith(
        'Failed to start desktop maintenance schedulers',
        { error: expect.objectContaining({ message: 'recovery failed' }) }
      )
    );
  });

  it('keeps a recovery teardown diagnostic quiet when shutdown begins during the query', async () => {
    getDatabaseMock.mockResolvedValue({});
    let rejectRecovery: ((error: Error) => void) | undefined;
    recoverInterruptedMaintenanceMock.mockImplementationOnce(
      () =>
        new Promise<number>((_resolve, reject) => {
          rejectRecovery = reject;
        })
    );

    await import('../../main');
    await vi.waitFor(() => expect(recoverInterruptedMaintenanceMock).toHaveBeenCalledTimes(1));
    isDesktopShuttingDownMock.mockReturnValue(true);
    rejectRecovery?.(new Error('DB host manager is retired.'));

    const mainLogger = createLoggerMock.mock.results
      .map((result) => result.value)
      .at(createLoggerMock.mock.calls.findIndex(([scope]) => scope === 'DesktopMain'));
    await vi.waitFor(() =>
      expect(mainLogger?.info).toHaveBeenCalledWith(
        'Dimension index maintenance initialization aborted by shutdown',
        { error: expect.objectContaining({ message: 'DB host manager is retired.' }) }
      )
    );
    expect(probeMock).not.toHaveBeenCalled();
    expect(maintenanceStartMock).not.toHaveBeenCalled();
    expect(mainLogger?.error).not.toHaveBeenCalledWith(
      'Failed to start desktop maintenance schedulers',
      expect.anything()
    );
  });

  it('keeps a database initialization teardown diagnostic quiet during shutdown', async () => {
    let rejectDatabase: ((error: Error) => void) | undefined;
    getDatabaseMock.mockImplementation(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          rejectDatabase = reject;
        })
    );

    await import('../../main');
    await vi.waitFor(() => expect(getDatabaseMock).toHaveBeenCalled());
    isDesktopShuttingDownMock.mockReturnValue(true);
    rejectDatabase?.(new Error('DB host manager is retired.'));

    const mainLogger = createLoggerMock.mock.results
      .map((result) => result.value)
      .at(createLoggerMock.mock.calls.findIndex(([scope]) => scope === 'DesktopMain'));
    await vi.waitFor(() =>
      expect(mainLogger?.info).toHaveBeenCalledWith(
        'Dimension index maintenance initialization aborted by shutdown',
        { error: expect.objectContaining({ message: 'DB host manager is retired.' }) }
      )
    );
    expect(recoverInterruptedMaintenanceMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
    expect(maintenanceStartMock).not.toHaveBeenCalled();
    expect(mainLogger?.error).not.toHaveBeenCalledWith(
      'Failed to start desktop maintenance schedulers',
      expect.anything()
    );
  });

  it('leaves an ordinary database initialization failure visible and stops maintenance', async () => {
    getDatabaseMock.mockRejectedValue(new Error('database initialization failed'));

    await import('../../main');

    const mainLogger = createLoggerMock.mock.results
      .map((result) => result.value)
      .at(createLoggerMock.mock.calls.findIndex(([scope]) => scope === 'DesktopMain'));
    await vi.waitFor(() =>
      expect(mainLogger?.error).toHaveBeenCalledWith(
        'Failed to start desktop maintenance schedulers',
        { error: expect.objectContaining({ message: 'database initialization failed' }) }
      )
    );
    expect(recoverInterruptedMaintenanceMock).not.toHaveBeenCalled();
    expect(probeMock).not.toHaveBeenCalled();
    expect(maintenanceStartMock).not.toHaveBeenCalled();
  });

  it('still starts the maintenance schedulers when the capability probe fails', async () => {
    getDatabaseMock.mockResolvedValue({});
    probeMock.mockRejectedValueOnce(new Error('probe exploded'));

    await import('../../main');

    await vi.waitFor(() => {
      expect(mockBrowserWindowInstance.show).toHaveBeenCalled();
      expect(maintenanceStartMock).toHaveBeenCalledTimes(1);
    });
  });

  it('logs each error from a partial maintenance graph acquisition', async () => {
    getDatabaseMock.mockResolvedValue({});
    maintenanceStartMock.mockRejectedValueOnce(
      new AggregateError([new Error('dimension timer failed'), undefined], 'Acquisition failed')
    );

    await import('../../main');

    const mainLogger = createLoggerMock.mock.results
      .map((result) => result.value)
      .at(createLoggerMock.mock.calls.findIndex(([scope]) => scope === 'DesktopMain'));
    await vi.waitFor(() =>
      expect(mainLogger?.error).toHaveBeenCalledWith(
        'Failed to start desktop maintenance schedulers',
        {
          error: expect.objectContaining({
            errors: [
              expect.objectContaining({ message: 'dimension timer failed' }),
              { message: 'undefined' },
            ],
          }),
        }
      )
    );
  });

  it('does not start maintenance after a probe finishes during shutdown', async () => {
    // The probe now runs concurrently with the app lifecycle. A short-lived
    // session (e2e apps, quick open/quit) can tear the DB down mid-probe;
    // that rejection is an EXPECTED teardown per desktop-shutdown-state and
    // must not produce an alarming error-level log on every fast quit.
    getDatabaseMock.mockResolvedValue({});
    const probe = Promise.withResolvers<Awaited<ReturnType<typeof probeMock>>>();
    probeMock.mockReturnValueOnce(probe.promise);

    await import('../../main');

    await vi.waitFor(() => expect(probeMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockBrowserWindowInstance.show).toHaveBeenCalled());
    isDesktopShuttingDownMock.mockReturnValue(true);
    probe.reject(new Error('db host disposed'));
    await vi.waitFor(() =>
      expect(requireMainLogger().info).toHaveBeenCalledWith(
        'Dimension index maintenance capability probe aborted by shutdown',
        { error: expect.objectContaining({ message: 'db host disposed' }) }
      )
    );
    expect(maintenanceStartMock).not.toHaveBeenCalled();

    const mainLogger = createLoggerMock.mock.results
      .map((result) => result.value)
      .at(createLoggerMock.mock.calls.findIndex(([scope]) => scope === 'DesktopMain'));
    const errorMessages = (mainLogger?.error.mock.calls ?? []).map(
      ([message]: [string]) => message
    );
    expect(errorMessages).not.toContain('Dimension index maintenance capability probe failed');
    const infoMessages = (mainLogger?.info.mock.calls ?? []).map(([message]: [string]) => message);
    expect(infoMessages).toContain(
      'Dimension index maintenance capability probe aborted by shutdown'
    );
  });

  it('fences the paired maintenance owner before joining trigger close and the database lane', async () => {
    getDatabaseMock.mockResolvedValue({});
    await import('../../main');
    const planRun = shutdownPlanCapture.current;
    if (!planRun) {
      throw new Error('Shutdown plan was not registered');
    }

    let releaseTriggerClose: (() => void) | undefined;
    maintenanceCloseMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTriggerClose = resolve;
        })
    );
    const step = planRun().steps['database-drain'](new AbortController().signal);

    expect(maintenanceStopMock).toHaveBeenCalledTimes(1);
    expect(maintenanceCloseMock).toHaveBeenCalledTimes(1);
    expect(waitForDatabaseIdleMock).not.toHaveBeenCalled();

    releaseTriggerClose?.();
    await step;
    expect(waitForDatabaseIdleMock).toHaveBeenCalledTimes(1);
    // The drain step never closes the database: that is the reserved slice's job.
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

  it('closes the database from the reserved slice alone, and a failed close rejects', async () => {
    getDatabaseMock.mockResolvedValue({});
    await import('../../main');
    const planRun = shutdownPlanCapture.current;
    if (!planRun) {
      throw new Error('Shutdown plan was not registered');
    }

    await planRun().closeDatabase();
    expect(closeDatabaseMock).toHaveBeenCalledTimes(1);
    expect(waitForDatabaseIdleMock).not.toHaveBeenCalled();

    closeDatabaseMock.mockRejectedValueOnce(new Error('DB host failed to close'));
    await expect(planRun().closeDatabase()).rejects.toThrow('DB host failed to close');
  });

  it('still drains the database when trigger cleanup rejects undefined', async () => {
    getDatabaseMock.mockResolvedValue({});
    await import('../../main');
    const planRun = shutdownPlanCapture.current;
    if (!planRun) {
      throw new Error('Shutdown plan was not registered');
    }
    maintenanceCloseMock.mockRejectedValueOnce(undefined);

    await expect(
      planRun().steps['database-drain'](new AbortController().signal)
    ).rejects.toMatchObject({
      errors: [undefined],
    });
    expect(cleanupSubscriptionsMock).toHaveBeenCalledTimes(2);
    expect(waitForDatabaseIdleMock).toHaveBeenCalledTimes(1);
  });

  it('retains the existing database failure path when the idle join rejects', async () => {
    getDatabaseMock.mockResolvedValue({});
    await import('../../main');
    const planRun = shutdownPlanCapture.current;
    if (!planRun) {
      throw new Error('Shutdown plan was not registered');
    }
    waitForDatabaseIdleMock.mockRejectedValueOnce(undefined);

    await expect(
      planRun().steps['database-drain'](new AbortController().signal)
    ).rejects.toBeUndefined();
    expect(cleanupSubscriptionsMock).toHaveBeenCalledTimes(1);
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
