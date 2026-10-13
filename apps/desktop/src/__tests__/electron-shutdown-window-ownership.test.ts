import { EventEmitter, once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { closeElectronApp, type ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';

it('keeps hidden renderer command listeners alive until application-owned shutdown', async () => {
  const exit = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    killed: false,
    signalCode: null as NodeJS.Signals | null,
  });
  const windowEvents = new EventEmitter();
  const appEvents = new EventEmitter();
  let commandListenerAvailable = true;
  let listenerAtShutdown = false;
  const window = {
    close: vi.fn(async () => {
      commandListenerAvailable = false;
      windowEvents.emit('close');
    }),
    isClosed: () => false,
    waitForEvent: (name: string) => once(windowEvents, name),
  };
  const app = {
    close: vi.fn(async () => {
      listenerAtShutdown = commandListenerAvailable;
      exit.exitCode = 0;
      exit.emit('exit', 0, null);
      appEvents.emit('close');
    }),
    process: () => exit,
    waitForEvent: (name: string) => once(appEvents, name),
    windows: () => [window],
  };
  await closeElectronApp({ app, window } as unknown as ElectronAppContext);
  expect(listenerAtShutdown).toBe(true);
  expect(window.close).not.toHaveBeenCalled();
  expect(app.close).toHaveBeenCalledOnce();
});

afterEach(() => vi.useRealTimers());

it('does not treat a CDP close or a sent signal as physical process exit', async () => {
  const exit = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    killed: true,
    signalCode: null as NodeJS.Signals | null,
  });
  const app = {
    close: vi.fn(async () => undefined),
    process: () => exit,
    waitForEvent: vi.fn(async () => undefined),
  };
  let settled = false;
  const closing = closeElectronApp({ app } as unknown as ElectronAppContext).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  exit.exitCode = 0;
  exit.emit('exit', 0, null);
  await closing;
});

it('joins SIGTERM cleanup but still reports a failed graceful shutdown', async () => {
  const failure = new Error('graceful close failed');
  const exit = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: vi.fn((_signal: NodeJS.Signals) => true),
    signalCode: null as NodeJS.Signals | null,
  });
  const app = {
    close: vi.fn(async () => {
      throw failure;
    }),
    process: () => exit,
  };
  let settled = false;
  const outcome = closeElectronApp({ app } as unknown as ElectronAppContext).catch(
    (error: unknown) => {
      settled = true;
      return error;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(exit.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  expect(settled).toBe(false);
  exit.exitCode = 0;
  exit.emit('exit', 0, null);
  expect(await outcome).toBe(failure);
});

it('preserves both shutdown and signal-refusal errors', async () => {
  const closeFailure = new Error('graceful close failed');
  const signalFailure = new Error('signal EPERM');
  const exit = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    kill: vi.fn((_signal: NodeJS.Signals) => {
      exit.emit('error', signalFailure);
      return false;
    }),
    signalCode: null as NodeJS.Signals | null,
  });
  const app = {
    close: vi.fn(async () => {
      throw closeFailure;
    }),
    process: () => exit,
  };
  const outcome = await closeElectronApp({ app } as unknown as ElectronAppContext).catch(
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(AggregateError);
  expect((outcome as AggregateError).errors).toEqual([closeFailure, signalFailure]);
  expect(exit.listenerCount('error')).toBe(0);
  expect(exit.listenerCount('exit')).toBe(0);
});
