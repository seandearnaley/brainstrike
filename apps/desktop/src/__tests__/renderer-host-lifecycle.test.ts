import type { EventEmitter } from 'node:events';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_DEV_RENDERER_PORT } from '../desktop-renderer-url';
import { RendererHostLifecycle, type RendererHostStatusShape } from '../renderer-host-lifecycle';
import { assignWindowRole, getWindowRoleByWebContentsId } from '../window-role';

const { MockBrowserWindow } = vi.hoisted(() => ({
  MockBrowserWindow: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => '/tmp/brainstrike'),
    isPackaged: false,
  },
  BrowserWindow: MockBrowserWindow,
}));

interface FakeListenerMap {
  closed?: () => void;
  didFailLoad?: (
    event: unknown,
    errorCode: number,
    errorDescription: string,
    url: string,
    isMainFrame: boolean
  ) => void;
  renderProcessGone?: (event: unknown, details: { exitCode: number; reason: string }) => void;
}

interface FakeWindow {
  destroy: ReturnType<typeof vi.fn>;
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  listeners: FakeListenerMap;
  loadFile: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  webContents: {
    id: number;
    listeners: FakeListenerMap;
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
  };
}

type WindowOpenHandler = () => { action: 'allow' | 'deny' };

function getWindowOpenHandler(fakeWindow: FakeWindow): WindowOpenHandler {
  const [handler] = fakeWindow.webContents.setWindowOpenHandler.mock.calls[0] ?? [];
  return handler as WindowOpenHandler;
}

function expectDeniedWindowOpenHandler(fakeWindow: FakeWindow): void {
  expect(fakeWindow.webContents.setWindowOpenHandler).toHaveBeenCalledOnce();
  expect(getWindowOpenHandler(fakeWindow)()).toEqual({ action: 'deny' });
}

function createStatus(status: RendererHostStatusShape): RendererHostStatusShape {
  return {
    state: status.state,
    active: status.active,
    lastError: status.lastError,
    runtimeId: status.runtimeId,
  };
}

function createFakeWindow(id: number): FakeWindow {
  const listeners: FakeListenerMap = {};
  const webContentsListeners: FakeListenerMap = {};
  return {
    destroy: vi.fn(),
    id,
    isDestroyed: vi.fn(() => false),
    listeners,
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    on: vi.fn((event: string, listener: () => void) => {
      if (event === 'closed') {
        listeners.closed = listener;
      }
    }),
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'closed') {
        listeners.closed = listener;
      }
    }),
    webContents: {
      id,
      listeners: webContentsListeners,
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'render-process-gone') {
          webContentsListeners.renderProcessGone = listener as FakeListenerMap['renderProcessGone'];
        }
        if (event === 'did-fail-load') {
          webContentsListeners.didFailLoad = listener as FakeListenerMap['didFailLoad'];
        }
      }),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    },
  };
}

describe('RendererHostLifecycle', () => {
  const baseArgv = process.argv.filter((arg) => arg !== '--test-mode');

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = [...baseArgv];
    Reflect.deleteProperty(process.env, 'CI');
    app.isPackaged = false;
  });

  it('assigns the host role before beginning renderer load', async () => {
    const hostWindow = createFakeWindow(41);
    hostWindow.loadURL.mockImplementation(async () => {
      expect(getWindowRoleByWebContentsId(41)).toBe('chunking-host');
      expectDeniedWindowOpenHandler(hostWindow);
    });

    const windows = [hostWindow];
    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => windows),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
        }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    const status = await lifecycle.ensureStarted({ waitForRunning: false });

    expect(status.state).toBe('starting');
    expect(hostWindow.loadURL).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `^http://localhost:${DESKTOP_DEV_RENDERER_PORT}\\?mode=chunking-host&runtimeId=chunking-host%3A`
        )
      )
    );
  });

  it('keeps hidden renderer hosts unthrottled for background worker runtime liveness', async () => {
    const hostWindow = createFakeWindow(410);
    hostWindow.loadURL.mockImplementation(async () => {
      expectDeniedWindowOpenHandler(hostWindow);
    });

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });

    expect(BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          backgroundThrottling: false,
        }),
      })
    );
  });

  it('encodes dev host query parameters before loading the renderer url', async () => {
    const hostWindow = createFakeWindow(42);
    hostWindow.loadURL.mockImplementation(async () => {
      expectDeniedWindowOpenHandler(hostWindow);
    });

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });

    expect(hostWindow.loadURL).toHaveBeenCalledWith(expect.stringContaining('mode=embedding-host'));
    expect(hostWindow.loadURL).toHaveBeenCalledWith(
      expect.stringMatching(/runtimeId=embedding-host%3A/)
    );
  });

  it('loads packaged host windows from the renderer file with strict query params', async () => {
    const hostWindow = createFakeWindow(142);
    hostWindow.loadFile.mockResolvedValue(undefined);
    app.isPackaged = true;

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });

    expect(hostWindow.loadFile).toHaveBeenCalledWith(
      path.join('/tmp/brainstrike/dist/renderer/index.html'),
      expect.objectContaining({
        query: expect.objectContaining({
          mode: 'embedding-host',
          runtimeId: expect.stringContaining('embedding-host:'),
        }),
      })
    );
    expect(hostWindow.loadURL).not.toHaveBeenCalled();
  });

  it('keeps sandbox enabled when only CI=true is present without --test-mode', async () => {
    const hostWindow = createFakeWindow(43);
    hostWindow.loadURL.mockResolvedValue(undefined);
    process.env['CI'] = 'true';

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });

    expect(MockBrowserWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          sandbox: true,
        }),
      })
    );
  });

  it('disables sandbox only when --test-mode is explicitly present', async () => {
    const hostWindow = createFakeWindow(44);
    hostWindow.loadURL.mockResolvedValue(undefined);
    process.env['CI'] = 'true';
    process.argv = [...baseArgv, '--test-mode'];

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });

    expect(MockBrowserWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          sandbox: false,
        }),
      })
    );
  });

  it('keeps sandbox enabled in packaged builds even if --test-mode is present', async () => {
    const hostWindow = createFakeWindow(45);
    hostWindow.loadFile.mockResolvedValue(undefined);
    process.argv = [...baseArgv, '--test-mode'];
    vi.mocked(app).isPackaged = true;

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });

    expect(MockBrowserWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          sandbox: true,
        }),
      })
    );
  });

  it('broadcasts status updates to non-host windows only', async () => {
    const hostWindow = createFakeWindow(51);
    const visibleWindow = createFakeWindow(52);
    hostWindow.loadURL.mockResolvedValue(undefined);

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow, visibleWindow]),
    });
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
    assignWindowRole(visibleWindow as never, 'visible-ui');

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });
    hostWindow.webContents.send.mockClear();
    visibleWindow.webContents.send.mockClear();
    lifecycle.setStatus(
      createStatus({
        state: 'running',
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
      })
    );

    expect(hostWindow.webContents.send).not.toHaveBeenCalled();
    expect(visibleWindow.webContents.send).toHaveBeenCalledWith('embedding-host:status', {
      state: 'running',
      active: true,
      lastError: null,
      runtimeId: lifecycle.getStatus().runtimeId,
    });
  });

  it('destroys an active host window when dispose is called directly', async () => {
    const hostWindow = createFakeWindow(53);
    hostWindow.loadURL.mockResolvedValue(undefined);

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    lifecycle.dispose();

    expect(hostWindow.destroy).toHaveBeenCalledTimes(1);
    expect(lifecycle.getHostWindow()).toBeNull();
    expect(getWindowRoleByWebContentsId(53)).toBeUndefined();
  });

  it('recreates an existing stopped host window instead of waiting forever', async () => {
    const stoppedWindow = createFakeWindow(61);
    const restartedWindow = createFakeWindow(62);
    stoppedWindow.loadURL.mockResolvedValue(undefined);
    restartedWindow.loadURL.mockResolvedValue(undefined);

    const createdWindows = [stoppedWindow, restartedWindow];
    MockBrowserWindow.mockImplementation(function () {
      const nextWindow = createdWindows.shift();
      if (!nextWindow) {
        throw new Error('No fake BrowserWindow left to create');
      }
      Object.assign(this, nextWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [stoppedWindow, restartedWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    const initialStart = lifecycle.ensureStarted({ waitForRunning: true });
    await Promise.resolve();
    lifecycle.setStatus(
      createStatus({
        state: 'running',
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
      })
    );
    await initialStart;
    lifecycle.setStatus(
      createStatus({
        state: 'stopped',
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:old-runtime',
      })
    );

    const restartedStatus = await lifecycle.ensureStarted({ waitForRunning: false });

    expect(stoppedWindow.destroy).toHaveBeenCalledTimes(1);
    expect(restartedWindow.loadURL).toHaveBeenCalledTimes(1);
    expect(restartedStatus.state).toBe('starting');
    expect(restartedStatus.runtimeId).not.toBe('embedding-host:old-runtime');
  });

  it('serializes concurrent restart calls when replacing a stopped host window', async () => {
    const stoppedWindow = createFakeWindow(63);
    const restartedWindow = createFakeWindow(64);
    let resolveLoad: (() => void) | null = null;
    stoppedWindow.loadURL.mockResolvedValue(undefined);
    restartedWindow.loadURL.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );

    const createdWindows = [stoppedWindow, restartedWindow];
    MockBrowserWindow.mockImplementation(function () {
      const nextWindow = createdWindows.shift();
      if (!nextWindow) {
        throw new Error('No fake BrowserWindow left to create');
      }
      Object.assign(this, nextWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [stoppedWindow, restartedWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    const initialStart = lifecycle.ensureStarted({ waitForRunning: true });
    await Promise.resolve();
    lifecycle.setStatus(
      createStatus({
        state: 'running',
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
      })
    );
    await initialStart;
    lifecycle.setStatus(
      createStatus({
        state: 'stopped',
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:old-runtime',
      })
    );

    const firstRestart = lifecycle.ensureStarted({ waitForRunning: true });
    const secondRestart = lifecycle.ensureStarted({ waitForRunning: true });
    await Promise.resolve();

    expect(stoppedWindow.destroy).toHaveBeenCalledTimes(1);
    expect(restartedWindow.loadURL).toHaveBeenCalledTimes(1);

    resolveLoad?.();
    await Promise.resolve();
    lifecycle.setStatus(
      createStatus({
        state: 'running',
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
      })
    );

    const [firstStatus, secondStatus] = await Promise.all([firstRestart, secondRestart]);
    expect(firstStatus.state).toBe('running');
    expect(secondStatus.state).toBe('running');
    expect(firstStatus.runtimeId).toBe(secondStatus.runtimeId);
  });

  it('serializes concurrent startup calls before the host window exists', async () => {
    const hostWindow = createFakeWindow(71);
    let resolveLoad: (() => void) | null = null;
    hostWindow.loadURL.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
        }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    const firstStart = lifecycle.ensureStarted({ waitForRunning: true });
    const secondStart = lifecycle.ensureStarted({ waitForRunning: true });
    await Promise.resolve();

    expect(MockBrowserWindow).toHaveBeenCalledTimes(1);
    expect(hostWindow.loadURL).toHaveBeenCalledTimes(1);

    resolveLoad?.();
    await Promise.resolve();
    lifecycle.setStatus(
      createStatus({
        state: 'running',
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
      })
    );

    const [firstStatus, secondStatus] = await Promise.all([firstStart, secondStart]);
    expect(firstStatus.state).toBe('running');
    expect(secondStatus.state).toBe('running');
    expect(firstStatus.runtimeId).toBe(secondStatus.runtimeId);
  });

  it('cleans up waitForStatus listeners when the predicate throws', async () => {
    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
        }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    const error = new Error('predicate exploded');
    const waitPromise = lifecycle.waitForStatus(() => {
      throw error;
    }, 10_000);

    lifecycle.setStatus(
      createStatus({
        state: 'running',
        active: true,
        lastError: null,
        runtimeId: 'chunking-host:runtime',
      })
    );

    await expect(waitPromise).rejects.toThrow(error);
    expect(
      (
        lifecycle as RendererHostLifecycle<RendererHostStatusShape> & {
          events: EventEmitter;
        }
      ).events.listenerCount('chunking-host:status')
    ).toBe(0);
  });

  it('resolves in-flight startup waits promptly when dispose is called', async () => {
    const hostWindow = createFakeWindow(72);
    let resolveLoad: (() => void) | null = null;
    hostWindow.loadURL.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
        }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    const startupPromise = lifecycle.ensureStarted({ waitForRunning: true });
    await Promise.resolve();
    resolveLoad?.();
    await Promise.resolve();
    await Promise.resolve();
    lifecycle.dispose();

    await expect(startupPromise).resolves.toEqual(
      expect.objectContaining({
        state: 'stopped',
        runtimeId: 'chunking-host:stopped',
      })
    );
  });

  it('ignores windows destroyed between enumeration and status broadcast', async () => {
    const hostWindow = createFakeWindow(81);
    const visibleWindow = createFakeWindow(82);
    hostWindow.loadURL.mockResolvedValue(undefined);
    visibleWindow.webContents.send.mockImplementation(() => {
      throw new Error('window destroyed during send');
    });

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow, visibleWindow]),
    });
    assignWindowRole(visibleWindow as never, 'visible-ui');

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });

    expect(() =>
      lifecycle.setStatus(
        createStatus({
          state: 'running',
          active: true,
          lastError: null,
          runtimeId: lifecycle.getStatus().runtimeId,
        })
      )
    ).not.toThrow();
  });

  it('does not rebroadcast identical status snapshots', async () => {
    const hostWindow = createFakeWindow(83);
    const visibleWindow = createFakeWindow(84);
    hostWindow.loadURL.mockResolvedValue(undefined);

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow, visibleWindow]),
    });
    assignWindowRole(visibleWindow as never, 'visible-ui');

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });
    visibleWindow.webContents.send.mockClear();

    lifecycle.setStatus(
      createStatus({
        state: 'running',
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
      })
    );
    lifecycle.setStatus(
      createStatus({
        state: 'running',
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
      })
    );

    expect(visibleWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('destroys the host window when startup readiness fails after the window is created', async () => {
    vi.useFakeTimers();
    const hostWindow = createFakeWindow(91);
    hostWindow.loadURL.mockResolvedValue(undefined);

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    const startupPromise = lifecycle.ensureStarted({ waitForRunning: true });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_001);
    const status = await startupPromise;

    expect(status.state).toBe('error');
    expect(hostWindow.destroy).toHaveBeenCalledTimes(1);
    expect(lifecycle.getHostWindow()).toBeNull();
    vi.useRealTimers();
  });

  it('destroys a newly created window if dispose races with in-flight startup', async () => {
    const hostWindow = createFakeWindow(92);
    let resolveLoad: (() => void) | null = null;
    hostWindow.loadURL.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = resolve;
        })
    );

    MockBrowserWindow.mockImplementation(function () {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    const startupPromise = lifecycle.ensureStarted({ waitForRunning: true });
    await Promise.resolve();
    lifecycle.dispose();
    resolveLoad?.();

    await expect(startupPromise).resolves.toEqual(
      expect.objectContaining({
        state: 'stopped',
      })
    );
    expect(hostWindow.destroy).toHaveBeenCalledTimes(1);
    expect(getWindowRoleByWebContentsId(92)).toBeUndefined();
  });

  it('retries loadFile on transient failure and succeeds on second attempt', async () => {
    vi.useFakeTimers();
    const failWindow = createFakeWindow(101);
    const successWindow = createFakeWindow(102);
    failWindow.loadURL.mockRejectedValue(new Error('ERR_FAILED (-2)'));
    successWindow.loadURL.mockResolvedValue(undefined);

    const createdWindows = [failWindow, successWindow];
    MockBrowserWindow.mockImplementation(function () {
      const nextWindow = createdWindows.shift();
      if (!nextWindow) {
        throw new Error('No fake BrowserWindow left to create');
      }
      Object.assign(this, nextWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [successWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
        }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    lifecycle.ensureStarted({ waitForRunning: false });

    // Flush microtasks: first attempt starts and fails
    await vi.advanceTimersByTimeAsync(0);
    // Advance past the 300ms retry delay
    await vi.advanceTimersByTimeAsync(300);

    expect(failWindow.destroy).toHaveBeenCalledTimes(1);
    expect(successWindow.loadURL).toHaveBeenCalledTimes(1);
    expect(getWindowRoleByWebContentsId(101)).toBeUndefined();
    vi.useRealTimers();
  });

  it('gives up after 3 failed load attempts and sets error status', async () => {
    vi.useFakeTimers();
    const windows = [createFakeWindow(111), createFakeWindow(112), createFakeWindow(113)];
    for (const w of windows) {
      w.loadURL.mockRejectedValue(new Error('ERR_FAILED (-2)'));
    }

    const createdWindows = [...windows];
    MockBrowserWindow.mockImplementation(function () {
      const nextWindow = createdWindows.shift();
      if (!nextWindow) {
        throw new Error('No fake BrowserWindow left to create');
      }
      Object.assign(this, nextWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => []),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          state: 'stopped',
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    lifecycle.ensureStarted({ waitForRunning: false });

    // Flush microtasks: first attempt fails, 300ms delay pending
    await vi.advanceTimersByTimeAsync(0);
    // Advance past first retry delay; second attempt fails, another 300ms delay
    await vi.advanceTimersByTimeAsync(300);
    // Advance past second retry delay; third attempt fails, no more retries
    await vi.advanceTimersByTimeAsync(300);

    const finalStatus = lifecycle.getStatus();
    expect(finalStatus.state).toBe('error');
    expect(finalStatus.lastError).toContain('failed to load after 3 attempts');
    for (const w of windows) {
      expect(w.destroy).toHaveBeenCalledTimes(1);
    }
    vi.useRealTimers();
  });
});
