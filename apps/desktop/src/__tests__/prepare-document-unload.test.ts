import { EventEmitter } from 'node:events';
import { LIFECYCLE_DELAYS_ENV } from '@brainstrike/host-lease/lifecycle-delays';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { RendererExitedError } from '../desktop-shutdown-state';
import { createLifecycleDelaySeam } from '../lifecycle-delay-seam';
import { DESKTOP_IPC_CHANNELS, DESKTOP_IPC_PUSH_CHANNEL } from '../platform/desktop-ipc-channels';
import { prepareDocumentUnload, RENDERER_CLOSE_PREPARATION_MS } from '../prepare-document-unload';

const channels = vi.hoisted(() => ({
  created: [] as Array<{
    port1: EventEmitter & { close: () => void };
    port2: { close: () => void };
  }>,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: { isPackaged: false },
    MessageChannelMain: class {
      port1 = Object.assign(new EventEmitter(), { close: vi.fn(), start: vi.fn() });
      port2 = { close: vi.fn() };
      constructor() {
        channels.created.push(this);
      }
    },
  };
});

const noDelays = createLifecycleDelaySeam({}, () => true);

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

function expectReleased(window: ReturnType<typeof windowFixture>): void {
  const channel = channels.created[0];
  expect(channel?.port1.close).toHaveBeenCalledOnce();
  expect(channel?.port1.eventNames()).toEqual([]);
  expect(window.listenerCount('closed')).toBe(0);
  expect(window.webContents.listenerCount('render-process-gone')).toBe(0);
  expect(window.webContents.listenerCount('unresponsive')).toBe(0);
}

beforeEach(() => {
  channels.created.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

test('waits for its private producer ACK before releasing the close owner', async () => {
  const window = windowFixture();
  let prepared = false;
  const preparing = prepareDocumentUnload(window, noDelays).then(() => {
    prepared = true;
  });
  expect(window.webContents.mainFrame.postMessage).toHaveBeenCalledWith(
    DESKTOP_IPC_PUSH_CHANNEL,
    { method: DESKTOP_IPC_CHANNELS.agent.prepareClose, payload: null },
    [channels.created[0]?.port2]
  );
  await Promise.resolve();
  expect(prepared).toBe(false);
  channels.created[0]?.port1.emit('message', { data: { prepared: true } });
  await preparing;
  expect(prepared).toBe(true);
  expect(window.destroy).not.toHaveBeenCalled();
  expectReleased(window);
});

test.each(['negative ACK', 'port loss', 'send failure'])(
  '%s fails visibly at once and releases every Main-owned reply resource',
  async (failure) => {
    const window = windowFixture();
    if (failure === 'send failure') {
      window.webContents.mainFrame.postMessage.mockImplementation(() => {
        throw new Error('send failed');
      });
    }
    const preparing = prepareDocumentUnload(window, noDelays);
    const rejected = expect(preparing).rejects.toBeInstanceOf(Error);
    const channel = channels.created[0];
    if (!channel) {
      throw new Error('The close owner created no reply channel');
    }
    if (failure === 'negative ACK') {
      channel.port1.emit('message', { data: { prepared: false } });
    } else if (failure === 'port loss') {
      channel.port1.emit('close');
    }
    await rejected;
    expectReleased(window);
    expect(window.destroy).not.toHaveBeenCalled();
    if (failure === 'send failure') {
      expect(channel.port2.close).toHaveBeenCalledOnce();
    }
  }
);

test("a negative ACK names each producer failure the renderer's preload reported", async () => {
  const window = windowFixture();
  const preparing = prepareDocumentUnload(window, noDelays);
  const rejected = expect(preparing).rejects.toThrow(
    'Renderer producers did not acknowledge close preparation: Durable writers failed to flush before unload (thread workspace write refused)'
  );
  channels.created[0]?.port1.emit('message', {
    data: {
      failures: ['Durable writers failed to flush before unload (thread workspace write refused)'],
      prepared: false,
    },
  });
  await rejected;
  expectReleased(window);
});

test.each([
  ['render-process-gone', 'Renderer exited before acknowledging its producers'],
  ['unresponsive', 'Renderer became unresponsive before acknowledging its producers'],
] as const)(
  'a renderer that reports %s is destroyed and its closed joined',
  async (event, message) => {
    const window = windowFixture();
    const preparing = prepareDocumentUnload(window, noDelays);
    const rejected = expect(preparing).rejects.toThrow(message);
    let destroyedDuringDispatch: boolean | undefined;
    // The remaining listeners still read the window during this event's dispatch.
    const readsWindow = (): void => {
      destroyedDuringDispatch = window.isDestroyed();
    };
    window.webContents.on(event, readsWindow);
    window.webContents.emit(event);
    await rejected;
    window.webContents.off(event, readsWindow);
    expect(destroyedDuringDispatch).toBe(false);
    expect(window.destroy).toHaveBeenCalledOnce();
    expectReleased(window);
  }
);

// BST-2285 (ADR-0026 R2): a renderer whose channel closed, whose frame can take no message,
// whose process exited or whose window closed has ended; a signal to Main's process group does
// all of these. Its typed exit lets quit treat it as a retirement; a live renderer's refusal or
// hang stays a plain failure.
test.each([
  ['port loss', true],
  ['send failure', true],
  ['render-process-gone', true],
  ['window closed', true],
  ['negative ACK', false],
  ['unresponsive', false],
] as const)('%s settles as the renderer exit: %s', async (failure, exited) => {
  const window = windowFixture();
  if (failure === 'send failure') {
    window.webContents.mainFrame.postMessage.mockImplementation(() => {
      throw new Error('send failed');
    });
  }
  const outcome = prepareDocumentUnload(window, noDelays).catch((error: unknown) => error);
  const channel = channels.created[0];
  if (failure === 'port loss') {
    channel?.port1.emit('close');
  } else if (failure === 'negative ACK') {
    channel?.port1.emit('message', { data: { prepared: false } });
  } else if (failure === 'window closed') {
    window.emit('closed');
  } else if (failure === 'render-process-gone' || failure === 'unresponsive') {
    window.webContents.emit(failure);
  }
  const error = await outcome;
  expect(error).toBeInstanceOf(Error);
  expect(error instanceof RendererExitedError).toBe(exited);
  expectReleased(window);
});

test('escalates a renderer that never answers to destroy after its ladder, then joins closed', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const window = windowFixture();
  // destroy() guarantees `closed`, which may arrive after the call returns.
  window.destroy.mockImplementation(() => undefined);
  let outcome: unknown;
  const preparing = prepareDocumentUnload(window, noDelays).catch((error: unknown) => {
    outcome = error;
  });

  await vi.advanceTimersByTimeAsync(RENDERER_CLOSE_PREPARATION_MS - 1);
  expect(window.destroy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(window.destroy).toHaveBeenCalledOnce();
  // A port closed by the dying renderer does not settle it: only `closed` does.
  channels.created[0]?.port1.emit('close');
  await Promise.resolve();
  expect(outcome).toBeUndefined();

  window.emit('closed');
  await preparing;
  expect(outcome).toEqual(
    new Error(
      `Renderer did not acknowledge close preparation within ${RENDERER_CLOSE_PREPARATION_MS} ms`
    )
  );
  expectReleased(window);
  expect(vi.getTimerCount()).toBe(0);
});

test('a slow ACK (E2E renderer-flush point) still resolves inside the ladder', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const window = windowFixture();
  const delays = createLifecycleDelaySeam(
    { [LIFECYCLE_DELAYS_ENV]: 'renderer-flush:12000' },
    () => true
  );
  let prepared = false;
  const preparing = prepareDocumentUnload(window, delays).then(() => {
    prepared = true;
  });
  channels.created[0]?.port1.emit('message', { data: { prepared: true } });
  // The renderer may close its end after it acknowledged.
  channels.created[0]?.port1.emit('close');
  await vi.advanceTimersByTimeAsync(11_999);
  expect(prepared).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await preparing;
  expect(prepared).toBe(true);
  expect(window.destroy).not.toHaveBeenCalled();
  expectReleased(window);
});
