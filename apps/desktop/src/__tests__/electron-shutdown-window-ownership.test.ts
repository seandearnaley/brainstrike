import { EventEmitter, once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { closeElectronApp, type ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';

it("keeps the window's command listeners alive until application-owned shutdown", async () => {
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

/** An app whose quit writes `lines` to stdout, exits 0, then closes its pipes. */
/** Each string is a stdout line; a `[stream, text]` pair is a raw chunk on that stream. */
function appQuittingWith(output: readonly (string | readonly ['stdout' | 'stderr', string])[]) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const exit = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stderr,
    stdout,
  });
  const app = {
    close: vi.fn(async () => {
      for (const chunk of output) {
        if (typeof chunk === 'string') {
          stdout.emit('data', Buffer.from(`${chunk}\n`));
        } else {
          (chunk[0] === 'stdout' ? stdout : stderr).emit('data', Buffer.from(chunk[1]));
        }
      }
      exit.exitCode = 0;
      exit.emit('exit', 0, null);
      exit.emit('close', 0, null);
    }),
    process: () => exit,
  };
  return { app, exit };
}

it('fails a quit that exited 0 after a failed shutdown step (ADR-0026 R4)', async () => {
  const report =
    '{"level":40,"msg":"Graceful shutdown completed with cleanup failures","failures":[{"step":"host-profile"}]}';
  const { app, exit } = appQuittingWith(['{"level":30,"msg":"Closing"}', report]);
  const outcome = await closeElectronApp({ app } as unknown as ElectronAppContext).catch(
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain(report);
  expect(exit.stdout.listenerCount('data')).toBe(0);
});

it('fails a quit whose failure record arrived in two chunks around a stderr chunk', async () => {
  const report =
    '{"level":40,"failures":[{"step":"host-profile"}],"msg":"Graceful shutdown completed with cleanup failures"}';
  const { app } = appQuittingWith([
    ['stdout', report.slice(0, 60)],
    ['stderr', 'renderer warning\n'],
    ['stdout', `${report.slice(60)}\n`],
  ]);
  const outcome = await closeElectronApp({ app } as unknown as ElectronAppContext).catch(
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toContain(report);
});

it('accepts a quit whose every shutdown step succeeded', async () => {
  const { app } = appQuittingWith(['{"level":30,"msg":"Graceful shutdown completed","steps":[]}']);
  await closeElectronApp({ app } as unknown as ElectronAppContext);
});
