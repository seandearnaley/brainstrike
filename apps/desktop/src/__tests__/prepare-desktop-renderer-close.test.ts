import { EventEmitter } from 'node:events';
import { beforeEach, expect, test, vi } from 'vitest';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { prepareDesktopRendererClose } from '../prepare-desktop-renderer-close';

const channels = vi.hoisted(() => ({
  created: [] as Array<{
    port1: EventEmitter & { close: () => void };
    port2: { close: () => void };
  }>,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    MessageChannelMain: class {
      port1 = Object.assign(new EventEmitter(), { close: vi.fn(), start: vi.fn() });
      port2 = { close: vi.fn() };
      constructor() {
        channels.created.push(this);
      }
    },
  };
});

function windowFixture() {
  const window = new EventEmitter();
  const contents = new EventEmitter();
  let destroyed = false;
  return Object.assign(window, {
    destroy: vi.fn(() => {
      destroyed = true;
      window.emit('closed');
    }),
    isDestroyed: () => destroyed,
    webContents: Object.assign(contents, {
      mainFrame: { postMessage: vi.fn() },
    }),
  });
}

beforeEach(() => {
  channels.created.length = 0;
});

test('waits for its private producer ACK before releasing the close owner', async () => {
  const window = windowFixture();
  const controller = new AbortController();
  let prepared = false;
  const preparing = prepareDesktopRendererClose(window, controller.signal).then(() => {
    prepared = true;
  });
  expect(window.webContents.mainFrame.postMessage).toHaveBeenCalledWith(
    DESKTOP_IPC_CHANNELS.agent.prepareClose,
    null,
    [channels.created[0]?.port2]
  );
  await Promise.resolve();
  expect(prepared).toBe(false);
  channels.created[0]?.port1.emit('message', { data: { prepared: true } });
  await preparing;
  expect(prepared).toBe(true);
  expect(channels.created[0]?.port1.close).toHaveBeenCalledOnce();
  expect(window.listenerCount('closed')).toBe(0);
  expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
});

test.each(['negative ACK', 'port loss', 'deadline', 'renderer crash', 'send failure'])(
  '%s fails visibly and releases every Main-owned reply resource',
  async (failure) => {
    const window = windowFixture();
    const controller = new AbortController();
    if (failure === 'send failure') {
      window.webContents.mainFrame.postMessage.mockImplementation(() => {
        throw new Error('send failed');
      });
    }
    const preparing = prepareDesktopRendererClose(window, controller.signal);
    const rejected = expect(preparing).rejects.toBeInstanceOf(Error);
    const channel = channels.created[0];
    if (!channel) {
      throw new Error('The close owner created no reply channel');
    }
    switch (failure) {
      case 'negative ACK':
        channel.port1.emit('message', { data: { prepared: false } });
        break;
      case 'port loss':
        channel.port1.emit('close');
        break;
      case 'deadline':
        controller.abort(new Error('existing shutdown deadline'));
        break;
      case 'renderer crash':
        window.webContents.emit('render-process-gone');
        break;
      case 'send failure':
        break;
      default:
        throw new Error('Unknown close control');
    }
    await rejected;
    expect(channel.port1.close).toHaveBeenCalledOnce();
    expect(channel.port1.eventNames()).toEqual([]);
    expect(window.listenerCount('closed')).toBe(0);
    expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
    if (failure === 'send failure') {
      expect(channel.port2.close).toHaveBeenCalledOnce();
    }
    if (failure === 'renderer crash') {
      expect(window.destroy).toHaveBeenCalledOnce();
    }
  }
);

test('lets the remaining crash listeners read the window before destroying it', async () => {
  const window = windowFixture();
  const preparing = prepareDesktopRendererClose(window, new AbortController().signal);
  const rejected = expect(preparing).rejects.toBeInstanceOf(Error);
  let destroyedDuringDispatch: boolean | undefined;
  window.webContents.on('render-process-gone', () => {
    destroyedDuringDispatch = window.isDestroyed();
  });
  window.webContents.emit('render-process-gone');
  await rejected;
  expect(destroyedDuringDispatch).toBe(false);
  expect(window.destroy).toHaveBeenCalledOnce();
});
