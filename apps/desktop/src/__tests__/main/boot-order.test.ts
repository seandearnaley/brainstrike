import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureProcessSignalHandlers } from '../helpers/process-signal-capture';
import {
  bootWindow,
  createLoggerMock,
  installMainBootFixture,
  mockApp,
  requireMainLogger,
  shutdownPlanCapture,
} from './boot-order-fixture';

describe('main boot order', () => {
  installMainBootFixture();
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
