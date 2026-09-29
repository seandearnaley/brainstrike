import { EventEmitter, once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { closeElectronApp, type ElectronAppContext } from '../../e2e/utils/electron-helpers.mts';

it('keeps hidden renderer command listeners alive until application-owned shutdown', async () => {
  const exit = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    killed: false,
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
