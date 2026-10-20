import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { reloadDesktopWindows } from '../create-window';
import { assignWindowRole } from '../window-role';

const channels = vi.hoisted(() => ({
  created: [] as Array<{ port1: EventEmitter & { close: () => void } }>,
}));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: { isPackaged: false },
    BrowserWindow: class {},
    MessageChannelMain: class {
      port1 = Object.assign(new EventEmitter(), { close: vi.fn(), start: vi.fn() });
      port2 = { close: vi.fn() };
      constructor() {
        channels.created.push(this);
      }
    },
    screen: {},
  };
});
let nextId = 100_000;
const fixtures: Array<{ destroy(): void; isDestroyed(): boolean }> = [];
function windowFixture() {
  const window = new EventEmitter();
  let destroyed = false;
  const contents = Object.assign(new EventEmitter(), {
    id: nextId++,
    mainFrame: { postMessage: vi.fn() },
    reload: vi.fn(),
    reloadIgnoringCache: vi.fn(),
  });
  const result = Object.assign(window, {
    destroy: vi.fn(() => {
      destroyed = true;
      window.emit('closed');
    }),
    isDestroyed: () => destroyed,
    webContents: contents,
  });
  assignWindowRole(result as unknown as BrowserWindow, 'visible-ui');
  fixtures.push(result);
  return result;
}
function start(
  windows: ReturnType<typeof windowFixture>[],
  overrides: Partial<Parameters<typeof reloadDesktopWindows>[2]> = {}
) {
  const reportFailure = vi.fn(async () => undefined);
  const operation = reloadDesktopWindows(
    windows as unknown as BrowserWindow[],
    { reason: 'test-reload', source: 'main' },
    {
      deadlineMs: 5000,
      reportFailure,
      shouldReload: () => true,
      ...overrides,
    }
  );
  // Observe rejections immediately while the controlled native boundary remains held.
  void operation.catch(() => undefined);
  return { operation, reportFailure };
}
async function waitForPreparations(count = 1) {
  await vi.waitFor(() => expect(channels.created).toHaveLength(count));
}
function ack(index = 0, prepared = true) {
  const channel = channels.created[index];
  if (!channel) {
    throw new Error('No private renderer preparation channel');
  }
  channel.port1.emit('message', { data: { prepared } });
}
function expectClean(window: ReturnType<typeof windowFixture>) {
  expect(window.webContents.eventNames()).toEqual([]);
  // assignWindowRole owns the sole remaining close listener until native close.
  expect(window.listenerCount('closed')).toBe(window.isDestroyed() ? 0 : 1);
  for (const { port1 } of channels.created) {
    expect(port1.close).toHaveBeenCalledOnce();
    expect(port1.eventNames()).toEqual([]);
  }
}
beforeEach(() => {
  channels.created.length = 0;
});
afterEach(() => {
  for (const window of fixtures.splice(0)) {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
  vi.useRealTimers();
});

test('joins one document preparation, permits owned unload only after ACK, and retires listeners', async () => {
  const window = windowFixture();
  const first = start([window]);
  const second = start([window]);
  expect(second.operation).toBe(first.operation);
  await waitForPreparations();
  const before = { preventDefault: vi.fn() };
  window.webContents.emit('will-prevent-unload', before);
  expect(before.preventDefault).not.toHaveBeenCalled();
  expect(window.webContents.reload).not.toHaveBeenCalled();
  window.webContents.reload.mockImplementation(() => {
    const event = { preventDefault: vi.fn() };
    window.webContents.emit('will-prevent-unload', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    window.webContents.emit('did-navigate');
  });
  ack();
  await first.operation;
  expect(window.webContents.reload).toHaveBeenCalledOnce();
  expect(first.reportFailure).not.toHaveBeenCalled();
  expectClean(window);
});

test.each(['negative ACK', 'port loss', 'deadline'])(
  '%s reports failure and retires only the matching terminal window',
  async (failure) => {
    const window = windowFixture();
    const other = windowFixture();
    const run = start([window], { deadlineMs: failure === 'deadline' ? 25 : 5000 });
    await waitForPreparations();
    if (failure === 'negative ACK') {
      ack(0, false);
    }
    if (failure === 'port loss') {
      channels.created[0]?.port1.emit('close');
    }
    await expect(run.operation).rejects.toBeInstanceOf(Error);
    expect(run.reportFailure).toHaveBeenCalledWith(window, 'preparation');
    expect(window.destroy).toHaveBeenCalledOnce();
    expect(window.webContents.reload).not.toHaveBeenCalled();
    expect(other.destroy).not.toHaveBeenCalled();
    expectClean(window);
  }
);

test('a late private ACK cannot reload or destroy a replacement document', async () => {
  const window = windowFixture();
  const run = start([window]);
  await waitForPreparations();
  window.webContents.emit('did-navigate');
  ack();
  await expect(run.operation).rejects.toMatchObject({
    failure: { code: 'desktop.reload-superseded' },
  });
  expect(window.webContents.reload).not.toHaveBeenCalled();
  expect(window.destroy).not.toHaveBeenCalled();
  expect(run.reportFailure).not.toHaveBeenCalled();
  expectClean(window);
});

test.each(['negative ACK', 'deadline'])(
  'a delayed %s failure dialog and late ACK cannot destroy a replacement document',
  async (control) => {
    const window = windowFixture();
    const dialog = Promise.withResolvers<void>();
    const reportFailure = vi.fn(() => dialog.promise);
    const run = start([window], { deadlineMs: control === 'deadline' ? 25 : 5000, reportFailure });
    await waitForPreparations();
    if (control === 'negative ACK') {
      ack(0, false);
    }
    await vi.waitFor(() => expect(reportFailure).toHaveBeenCalledOnce());
    window.webContents.emit('did-navigate');
    ack();
    dialog.resolve();
    await expect(run.operation).rejects.toBeInstanceOf(Error);
    expect(window.destroy).not.toHaveBeenCalled();
    expect(window.webContents.reload).not.toHaveBeenCalled();
    expectClean(window);
  }
);

test('prepares every retiring document before the existing reset owner clears its profile', async () => {
  const windows = [windowFixture(), windowFixture()];
  const beforeReload = vi.fn(async () => {
    expect(
      channels.created.every(({ port1 }) => vi.mocked(port1.close).mock.calls.length === 1)
    ).toBe(true);
    expect(
      windows.every(({ webContents }) => webContents.reloadIgnoringCache.mock.calls.length === 0)
    ).toBe(true);
  });
  for (const window of windows) {
    window.webContents.reloadIgnoringCache.mockImplementation(() => {
      window.webContents.emit('did-navigate');
    });
  }
  const run = start(windows, { beforeReload, ignoreCache: true });
  await waitForPreparations(2);
  ack(0);
  await Promise.resolve();
  expect(beforeReload).not.toHaveBeenCalled();
  ack(1);
  await run.operation;
  expect(beforeReload).toHaveBeenCalledOnce();
  for (const window of windows) {
    expect(window.webContents.reloadIgnoringCache).toHaveBeenCalledOnce();
    expectClean(window);
  }
});

test('refuses an overlapping reset before profile clearing while an ordinary reload is held', async () => {
  const window = windowFixture();
  window.webContents.reload.mockImplementation(() => {
    window.webContents.emit('did-navigate');
  });
  const ordinary = start([window]);
  await waitForPreparations();
  const beforeReload = vi.fn(async () => undefined);
  const reset = start([window], { beforeReload });
  await expect(reset.operation).rejects.toMatchObject({
    failure: { code: 'desktop.reload-in-progress' },
  });
  expect(beforeReload).not.toHaveBeenCalled();
  expect(reset.reportFailure).toHaveBeenCalledWith(window, 'admission');
  expect(window.destroy).not.toHaveBeenCalled();
  ack();
  await ordinary.operation;
});

test('a replacement document can request its own reload while the retired document reply is late', async () => {
  const window = windowFixture();
  const old = start([window]);
  await waitForPreparations();
  window.webContents.emit('did-navigate');
  const fresh = start([window]);
  expect(fresh.operation).not.toBe(old.operation);
  await waitForPreparations(2);
  window.webContents.reload.mockImplementation(() => {
    window.webContents.emit('did-navigate');
  });
  ack(0);
  await expect(old.operation).rejects.toMatchObject({ code: 'desktop.reload-superseded' });
  expect(window.destroy).not.toHaveBeenCalled();
  ack(1);
  await fresh.operation;
  expect(window.webContents.reload).toHaveBeenCalledOnce();
  expectClean(window);
});

test('does not reload a replacement generation after the reset owner returns', async () => {
  const window = windowFixture();
  const reset = Promise.withResolvers<void>();
  const beforeReload = vi.fn(() => reset.promise);
  const run = start([window], { beforeReload, ignoreCache: true });
  await waitForPreparations();
  ack();
  await vi.waitFor(() => expect(beforeReload).toHaveBeenCalledOnce());
  window.webContents.emit('did-navigate');
  reset.resolve();
  await expect(run.operation).rejects.toMatchObject({ code: 'desktop.reload-superseded' });
  expect(window.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
  expect(window.destroy).not.toHaveBeenCalled();
  expectClean(window);
});

test('a failed reset is visible and retires the terminal documents without a success reload', async () => {
  const window = windowFixture();
  const run = start([window], {
    beforeReload: async () => {
      throw new Error('profile clear failed');
    },
    ignoreCache: true,
  });
  await waitForPreparations();
  ack();
  await expect(run.operation).rejects.toThrow('profile clear failed');
  expect(run.reportFailure).toHaveBeenCalledWith(window, 'replacement');
  expect(window.webContents.reloadIgnoringCache).not.toHaveBeenCalled();
  expect(window.destroy).toHaveBeenCalledOnce();
  expectClean(window);
});

test('a native load failure is visible and retires only its matching terminal document', async () => {
  const window = windowFixture();
  window.webContents.reload.mockImplementation(() => {
    window.webContents.emit('did-fail-load', {}, -2, 'failed', '', true);
  });
  const run = start([window]);
  await waitForPreparations();
  ack();
  await expect(run.operation).rejects.toThrow('replacement document failed to load');
  expect(run.reportFailure).toHaveBeenCalledWith(window, 'replacement');
  expect(window.destroy).toHaveBeenCalledOnce();
  expectClean(window);
});

test('uses the existing shutdown owner to cancel replacement after preparation', async () => {
  const window = windowFixture();
  const run = start([window], { shouldReload: () => false });
  await waitForPreparations();
  ack();
  await run.operation;
  expect(window.webContents.reload).not.toHaveBeenCalled();
  expect(window.destroy).not.toHaveBeenCalled();
  expect(run.reportFailure).not.toHaveBeenCalled();
  expectClean(window);
});
