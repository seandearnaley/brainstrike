import { describe, expect, it, vi } from 'vitest';
import { captureProcessSignalHandlers } from '../helpers/process-signal-capture';
import {
  applicationDomainCapture,
  bootWindow,
  createLoggerMock,
  installMainBootFixture,
  mockApp,
  profileAcquire,
  profileRetire,
  requireMainLogger,
  shutdownPlanCapture,
} from './boot-order-fixture';

describe('main boot order', () => {
  installMainBootFixture();
  it('starts the host profile and shows the first window without waiting for it', async () => {
    await import('../../main');
    // Owner decision 7.3(i): the profile's start never resolves here, and the window still shows.
    await vi.waitFor(() => expect(bootWindow().show).toHaveBeenCalledOnce());
    expect(profileAcquire).toHaveBeenCalled();
  });

  it('logs a failed host profile start and still shows the window', async () => {
    const failure = new Error('Profile unavailable');
    profileAcquire.mockRejectedValue(failure);
    await import('../../main');
    await vi.waitFor(() => expect(bootWindow().show).toHaveBeenCalledOnce());
    expect(
      requireMainLogger().error.mock.calls.some(
        ([, details]: [unknown, { error?: unknown }]) => details?.error === failure
      )
    ).toBe(true);
  });

  it('logs each inner failure of an aggregated host profile start failure', async () => {
    const first = new Error('Physical child failure');
    const failure = new AggregateError([first, undefined], 'Host acquisition failed');
    profileAcquire.mockRejectedValue(failure);
    await import('../../main');
    await vi.waitFor(() => expect(bootWindow().show).toHaveBeenCalledOnce());
    const details = requireMainLogger().error.mock.calls.find(
      ([, value]: [unknown, { error?: unknown; innerErrors?: unknown }]) => value?.error === failure
    )?.[1];
    expect(details?.innerErrors).toEqual([
      { message: first.message, name: 'Error' },
      { message: 'undefined', name: 'undefined' },
    ]);
  });

  it('joins the host profile retirement before acknowledging the host-profile shutdown step', async () => {
    await import('../../main');
    const plan = shutdownPlanCapture.current?.();
    if (!plan) {
      throw new Error('Shutdown plan was not registered');
    }
    const held = Promise.withResolvers<void>();
    profileRetire.mockReturnValue(held.promise);
    let settled = false;
    const step = Promise.resolve(plan.steps['host-profile']()).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(profileRetire).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    held.resolve();
    await step;
    expect(settled).toBe(true);
  });

  it('joins the actual application IPC resource from its filesystem shutdown step', async () => {
    await import('../../main');
    const planRun = shutdownPlanCapture.current;
    const close = applicationDomainCapture.close;
    if (!(planRun && close)) {
      throw new Error('Application filesystem shutdown owner was not registered.');
    }
    const retirement = Promise.withResolvers<void>();
    close.mockReturnValueOnce(retirement.promise);
    let settled = false;
    const step = Promise.resolve(planRun().steps['file-system']()).then(() => {
      settled = true;
    });
    expect(close).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(settled).toBe(false);
    retirement.resolve();
    await step;
    expect(settled).toBe(true);
  });

  it('closes the database by retiring the host profile and keeps its failure identity', async () => {
    await import('../../main');
    const plan = shutdownPlanCapture.current?.();
    if (!plan) {
      throw new Error('Shutdown plan was not registered');
    }
    await plan.closeDatabase();
    expect(profileRetire).toHaveBeenCalledOnce();
    const failure = new Error('Host physical close failed');
    profileRetire.mockRejectedValueOnce(failure);
    await expect(plan.closeDatabase()).rejects.toBe(failure);
  });

  it('still retires the host profile after an undefined IPC cleanup failure', async () => {
    await import('../../main');
    const plan = shutdownPlanCapture.current?.();
    const close = applicationDomainCapture.close;
    if (!(plan && close)) {
      throw new Error('Shutdown plan was not registered');
    }
    close.mockRejectedValueOnce(undefined);
    await expect(plan.steps['file-system']()).rejects.toBeUndefined();
    await plan.closeDatabase();
    expect(profileRetire).toHaveBeenCalledOnce();
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
