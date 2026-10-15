import type { EventEmitter } from 'node:events';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_RENDERER_DOCUMENT_URL,
  configureDesktopRendererTarget,
  createDesktopRendererTarget,
} from '../desktop-renderer-target';
import { DESKTOP_DEV_RENDERER_PORT } from '../desktop-renderer-url';
import { RendererHostLifecycle, type RendererHostStatusShape } from '../renderer-host-lifecycle';
import { assignWindowRole, getWindowRoleByWebContentsId } from '../window-role';

const { MockBrowserWindow } = vi.hoisted(() => ({
  MockBrowserWindow: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: vi.fn(() => path.resolve('/tmp/brainstrike')),
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
    active: status.active,
    lastError: status.lastError,
    runtimeId: status.runtimeId,
    state: status.state,
  };
}

function createWaitLifecycle(): RendererHostLifecycle<RendererHostStatusShape> {
  return new RendererHostLifecycle({
    createStatus,
    createStoppedStatus: () =>
      createStatus({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:stopped',
        state: 'stopped',
      }),
    mode: 'embedding-host',
    role: 'embedding-host',
    statusEventName: 'embedding-host:status',
    timeoutMessage: 'status timeout',
  });
}

function statusListenerCount(lifecycle: RendererHostLifecycle<RendererHostStatusShape>): number {
  return (
    lifecycle as unknown as {
      events: EventEmitter;
    }
  ).events.listenerCount('embedding-host:status');
}

function requireCallback(callback: (() => void) | null, description: string): () => void {
  if (!callback) {
    throw new Error(`expected ${description}`);
  }
  return callback;
}

function setAppPackaged(isPackaged: boolean): void {
  (app as unknown as { isPackaged: boolean }).isPackaged = isPackaged;
}

interface ExtendedStatus extends RendererHostStatusShape {
  readonly runtimeMetadata?: {
    readonly device: 'webgpu' | 'wasm';
    readonly fallbackApplied: boolean;
  };
}

function createFakeWindow(id: number): FakeWindow {
  const listeners: FakeListenerMap = {};
  const webContentsListeners: FakeListenerMap = {};
  // Mirror Electron: destroy() synchronously flips isDestroyed(), so guarded
  // double-destroy paths (dispose during in-flight startup) stay single-shot.
  let destroyed = false;
  return {
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    id,
    isDestroyed: vi.fn(() => destroyed),
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

const BUILT_RENDERER_PATH = path.resolve('/tmp/brainstrike/dist/renderer/index.html');
const DEV_RENDERER_URL = `http://localhost:${DESKTOP_DEV_RENDERER_PORT}`;
const DEV_RENDERER_TARGET = createDesktopRendererTarget({
  builtRendererPath: BUILT_RENDERER_PATH,
  devRendererUrl: DEV_RENDERER_URL,
  launchMode: 'dev-server',
});
const BUILT_RENDERER_TARGET = createDesktopRendererTarget({
  builtRendererPath: BUILT_RENDERER_PATH,
  devRendererUrl: DEV_RENDERER_URL,
  launchMode: 'built',
});

describe('RendererHostLifecycle', () => {
  const baseArgv = process.argv.filter((arg) => arg !== '--test-mode');

  beforeEach(() => {
    vi.clearAllMocks();
    // Default the suite to the dev-renderer target (how `pnpm dev` launches).
    // The hosts load the document named by the process-wide target `main.ts`
    // configures — the same object the visible window and the IPC
    // sender-frame allowlist use (BST-1641) — so built/packaged tests
    // configure the built target rather than driving argv.
    process.argv = [...baseArgv];
    configureDesktopRendererTarget(DEV_RENDERER_TARGET);
    Reflect.deleteProperty(process.env, 'CI');
    setAppPackaged(false);
  });

  it('preserves typed status extension fields across status snapshots', () => {
    const lifecycle = new RendererHostLifecycle<ExtendedStatus>({
      createStatus: (status) => createStatus(status),
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    lifecycle.setStatus({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:runtime',
      runtimeMetadata: {
        device: 'webgpu',
        fallbackApplied: false,
      },
      state: 'running',
    });

    expect(lifecycle.getStatus()).toMatchObject({
      runtimeId: 'embedding-host:runtime',
      runtimeMetadata: {
        device: 'webgpu',
        fallbackApplied: false,
      },
      state: 'running',
    });

    lifecycle.setStatus({
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:runtime',
      runtimeMetadata: {
        device: 'wasm',
        fallbackApplied: true,
      },
      state: 'running',
    });

    expect(lifecycle.getStatus()).toMatchObject({
      runtimeMetadata: {
        device: 'wasm',
        fallbackApplied: true,
      },
    });
  });

  it('fails at load time, before any load call, when no renderer target is configured', async () => {
    const hostWindow = createFakeWindow(40);
    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });
    configureDesktopRendererTarget(null);

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
          state: 'stopped',
        }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    const status = await lifecycle.ensureStarted();

    expect(status.state).toBe('error');
    expect(status.lastError).toBe('Desktop renderer target is not configured.');
    expect(hostWindow.loadFile).not.toHaveBeenCalled();
    expect(hostWindow.loadURL).not.toHaveBeenCalled();
  });

  it('assigns the host role before beginning renderer load', async () => {
    const hostWindow = createFakeWindow(41);
    hostWindow.loadURL.mockImplementation(async () => {
      expect(getWindowRoleByWebContentsId(41)).toBe('chunking-host');
      expectDeniedWindowOpenHandler(hostWindow);
    });

    const windows = [hostWindow];
    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => windows),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
          state: 'stopped',
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
          `^http://localhost:${DESKTOP_DEV_RENDERER_PORT}/\\?mode=chunking-host&runtimeId=chunking-host%3A`
        )
      )
    );
  });

  it('exposes the in-flight host window during renderer load so early status reports are accepted', async () => {
    // The host app can mount and send its one-shot 'running' status BEFORE
    // loadURL's promise settles. Managers gate acceptStatusReport on
    // getHostWindow(); if the loading window is not visible yet, that report
    // is dropped and ensureStarted waits out the full ready timeout, then
    // destroys a healthy host (the first-run "Timed out waiting for host
    // state transition" bug).
    const hostWindow = createFakeWindow(42);
    let hostWindowIdDuringLoad: number | undefined;
    let resolveLoad!: () => void;

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    hostWindow.loadURL.mockImplementation(() => {
      hostWindowIdDuringLoad = (lifecycle.getHostWindow() as unknown as FakeWindow | null)?.id;
      // Simulate the host renderer reporting 'running' mid-load (what the
      // manager's acceptStatusReport does once it can see this window).
      lifecycle.setStatus(
        createStatus({
          active: false,
          lastError: null,
          runtimeId: lifecycle.getStatus().runtimeId,
          state: 'running',
        })
      );
      return new Promise<void>((resolve) => {
        resolveLoad = resolve;
      });
    });

    const ensurePromise = lifecycle.ensureStarted({ waitForRunning: true });
    await vi.waitFor(() => {
      expect(hostWindowIdDuringLoad).toBe(42);
    });

    resolveLoad();
    const status = await ensurePromise;
    expect(status.state).toBe('running');
  });

  it('keeps hidden renderer hosts unthrottled for background worker runtime liveness', async () => {
    const hostWindow = createFakeWindow(410);
    hostWindow.loadURL.mockImplementation(async () => {
      expectDeniedWindowOpenHandler(hostWindow);
    });

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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

  it.each(['chunking-host', 'embedding-host'] as const)(
    'pins the %s window to the narrow hidden-host preload manifest',
    async (role) => {
      const hostWindow = createFakeWindow(411);
      hostWindow.loadURL.mockResolvedValue(undefined);
      MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
        Object.assign(this, hostWindow);
      });
      Object.assign(BrowserWindow, {
        getAllWindows: vi.fn(() => [hostWindow]),
      });
      const lifecycle = new RendererHostLifecycle({
        createStatus,
        createStoppedStatus: () =>
          createStatus({
            active: false,
            lastError: null,
            runtimeId: `${role}:stopped`,
            state: 'stopped',
          }),
        mode: role,
        role,
        statusEventName: `${role}:status`,
        timeoutMessage: 'timeout',
      });

      await lifecycle.ensureStarted({ waitForRunning: false });

      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          webPreferences: expect.objectContaining({
            additionalArguments: [`--brainstrike-hidden-renderer-role=${role}`],
            preload: path.resolve('/tmp/brainstrike/dist/hidden-preload.js'),
          }),
        })
      );
    }
  );

  it('encodes dev host query parameters before loading the renderer url', async () => {
    const hostWindow = createFakeWindow(42);
    hostWindow.loadURL.mockImplementation(async () => {
      expectDeniedWindowOpenHandler(hostWindow);
    });

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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

  it('loads host windows from the built renderer app document with strict query params', async () => {
    const hostWindow = createFakeWindow(142);
    hostWindow.loadURL.mockResolvedValue(undefined);
    // Built, test-built, and packaged launches all configure a built target.
    // The `pnpm start` regression (unpackaged + `--launch-mode=built` once
    // pointed the hosts at a dev server that wasn't running) is now pinned at
    // the single resolver: `desktop-launch-mode.test.ts`.
    configureDesktopRendererTarget(BUILT_RENDERER_TARGET);
    setAppPackaged(true);

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });

    const loaded = new URL(hostWindow.loadURL.mock.calls[0]?.[0]);
    expect(`${loaded.protocol}//${loaded.host}${loaded.pathname}`).toBe(APP_RENDERER_DOCUMENT_URL);
    expect(loaded.searchParams.get('mode')).toBe('embedding-host');
    expect(loaded.searchParams.get('runtimeId')).toMatch(/^embedding-host:/u);
    expect(hostWindow.loadFile).not.toHaveBeenCalled();
  });

  it('keeps sandbox enabled when only CI=true is present without --test-mode', async () => {
    const hostWindow = createFakeWindow(43);
    hostWindow.loadURL.mockResolvedValue(undefined);
    process.env['CI'] = 'true';

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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
    hostWindow.loadURL.mockResolvedValue(undefined);
    process.argv = [...baseArgv, '--test-mode'];
    setAppPackaged(true);

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow, visibleWindow]),
    });
    Object.defineProperty(app, 'isPackaged', { configurable: true, value: false });
    assignWindowRole(visibleWindow as never, 'visible-ui');

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
        state: 'running',
      })
    );

    expect(hostWindow.webContents.send).not.toHaveBeenCalled();
    expect(visibleWindow.webContents.send).toHaveBeenCalledWith('embedding-host:status', {
      active: true,
      lastError: null,
      runtimeId: lifecycle.getStatus().runtimeId,
      state: 'running',
    });
  });

  it('destroys an active host window when dispose is called directly', async () => {
    const hostWindow = createFakeWindow(53);
    hostWindow.loadURL.mockResolvedValue(undefined);

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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
    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
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
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
        state: 'running',
      })
    );
    await initialStart;
    lifecycle.setStatus(
      createStatus({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:old-runtime',
        state: 'stopped',
      })
    );

    const restartedStatus = await lifecycle.ensureStarted({ waitForRunning: false });

    expect(stoppedWindow.destroy).toHaveBeenCalledTimes(1);
    expect(restartedWindow.loadURL).toHaveBeenCalledTimes(1);
    expect(restartedStatus.state).toBe('starting');
    expect(restartedStatus.runtimeId).not.toBe('embedding-host:old-runtime');
  });

  it('lets a stopping host settle before replacing its window', async () => {
    const stoppingWindow = createFakeWindow(71);
    const restartedWindow = createFakeWindow(72);
    stoppingWindow.loadURL.mockResolvedValue(undefined);
    restartedWindow.loadURL.mockResolvedValue(undefined);
    const createdWindows = [stoppingWindow, restartedWindow];
    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      const nextWindow = createdWindows.shift();
      if (!nextWindow) {
        throw new Error('No fake BrowserWindow left to create');
      }
      Object.assign(this, nextWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [stoppingWindow, restartedWindow]),
    });
    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });
    const initialStart = lifecycle.ensureStarted({ waitForRunning: true });
    await Promise.resolve();
    const runtimeId = lifecycle.getStatus().runtimeId;
    lifecycle.setStatus(
      createStatus({ active: true, lastError: null, runtimeId, state: 'running' })
    );
    await initialStart;

    // The manager's stop() owns this window until the renderer reports stopped.
    lifecycle.setStatus(
      createStatus({ active: false, lastError: null, runtimeId, state: 'stopping' })
    );
    let settled = false;
    const restart = lifecycle.ensureStarted({ waitForRunning: false }).then((status) => {
      settled = true;
      return status;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(stoppingWindow.destroy).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    lifecycle.setStatus(
      createStatus({ active: false, lastError: null, runtimeId, state: 'stopped' })
    );
    const restarted = await restart;

    expect(stoppingWindow.destroy).toHaveBeenCalledTimes(1);
    expect(restartedWindow.loadURL).toHaveBeenCalledTimes(1);
    expect(restarted.state).toBe('starting');
    expect(restarted.runtimeId).not.toBe(runtimeId);
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
    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
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
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
        state: 'running',
      })
    );
    await initialStart;
    lifecycle.setStatus(
      createStatus({
        active: false,
        lastError: null,
        runtimeId: 'embedding-host:old-runtime',
        state: 'stopped',
      })
    );

    const firstRestart = lifecycle.ensureStarted({ waitForRunning: true });
    const secondRestart = lifecycle.ensureStarted({ waitForRunning: true });
    await Promise.resolve();

    expect(stoppedWindow.destroy).toHaveBeenCalledTimes(1);
    expect(restartedWindow.loadURL).toHaveBeenCalledTimes(1);

    requireCallback(resolveLoad, 'load resolver')();
    await Promise.resolve();
    lifecycle.setStatus(
      createStatus({
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
        state: 'running',
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

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
          state: 'stopped',
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

    requireCallback(resolveLoad, 'load resolver')();
    await Promise.resolve();
    lifecycle.setStatus(
      createStatus({
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
        state: 'running',
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
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
          state: 'stopped',
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
        active: true,
        lastError: null,
        runtimeId: 'chunking-host:runtime',
        state: 'running',
      })
    );

    await expect(waitPromise).rejects.toThrow(error);
    expect(
      (
        lifecycle as unknown as {
          events: EventEmitter;
        }
      ).events.listenerCount('chunking-host:status')
    ).toBe(0);
  });

  it('registers the status listener in the same turn and removes it on success', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = createWaitLifecycle();
      const wait = lifecycle.waitForStatus((status) => status.state === 'running', 1000);
      expect(statusListenerCount(lifecycle)).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      lifecycle.setStatus(
        createStatus({
          active: true,
          lastError: null,
          runtimeId: 'embedding-host:runtime',
          state: 'running',
        })
      );

      expect(statusListenerCount(lifecycle)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await expect(wait).resolves.toMatchObject({ state: 'running' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps each status waiter independent through timeout and disposal', async () => {
    vi.useFakeTimers();
    try {
      const lifecycle = createWaitLifecycle();
      const timedOut = lifecycle.waitForStatus((status) => status.state === 'running', 5);
      const disposed = lifecycle.waitForStatus((status) => status.state === 'running', 100);
      const timedOutFailure = timedOut.catch((error: unknown) => error);
      const disposedFailure = disposed.catch((error: unknown) => error);
      expect(statusListenerCount(lifecycle)).toBe(2);
      expect(vi.getTimerCount()).toBe(2);

      await vi.advanceTimersByTimeAsync(5);
      expect(((await timedOutFailure) as Error).message).toBe('status timeout');
      expect(statusListenerCount(lifecycle)).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      lifecycle.dispose();
      expect(((await disposedFailure) as Error).message).toContain('disposed');
      expect(statusListenerCount(lifecycle)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves an initial predicate throw and normalizes a later non-Error throw', async () => {
    const lifecycle = createWaitLifecycle();
    const sentinel = { reason: 'initial predicate failed' };
    await expect(
      lifecycle.waitForStatus(() => {
        throw sentinel;
      }, 100)
    ).rejects.toBe(sentinel);
    expect(statusListenerCount(lifecycle)).toBe(0);

    let calls = 0;
    const laterThrown = { toString: () => 'later predicate failed' };
    const wait = lifecycle.waitForStatus(() => {
      calls++;
      if (calls === 1) {
        return false;
      }
      throw laterThrown;
    }, 100);
    lifecycle.setStatus(
      createStatus({
        active: true,
        lastError: null,
        runtimeId: 'embedding-host:runtime',
        state: 'running',
      })
    );

    await expect(wait).rejects.toThrow('later predicate failed');
    expect(statusListenerCount(lifecycle)).toBe(0);
  });

  it('releases the readiness wait when its host window closes', async () => {
    vi.useFakeTimers();
    try {
      const hostWindow = createFakeWindow(73);
      hostWindow.loadURL.mockResolvedValue(undefined);
      MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
        Object.assign(this, hostWindow);
      });
      Object.assign(BrowserWindow, { getAllWindows: vi.fn(() => [hostWindow]) });
      const lifecycle = createWaitLifecycle();

      const startup = lifecycle.ensureStarted({ waitForRunning: true });
      await vi.waitFor(() => expect(statusListenerCount(lifecycle)).toBe(1));
      expect(hostWindow.listeners.closed).toBeDefined();
      hostWindow.listeners.closed?.();

      const status = await startup;
      expect(status.state).toBe('error');
      expect(status.lastError).toContain('window closed before its state transition completed');
      expect(statusListenerCount(lifecycle)).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the readiness wait when making its result snapshot throws', async () => {
    const failure = new Error('snapshot failed');
    let snapshotCalls = 0;
    const lifecycle = new RendererHostLifecycle({
      createStatus: (status) => {
        snapshotCalls++;
        if (snapshotCalls === 3) {
          throw failure;
        }
        return createStatus(status);
      },
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });
    const wait = lifecycle.waitForStatus((status) => status.state === 'running', 100);

    expect(() =>
      lifecycle.setStatus(
        createStatus({
          active: true,
          lastError: null,
          runtimeId: 'embedding-host:runtime',
          state: 'running',
        })
      )
    ).not.toThrow();
    await expect(wait).rejects.toBe(failure);
    expect(statusListenerCount(lifecycle)).toBe(0);
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

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
          state: 'stopped',
        }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    const startupPromise = lifecycle.ensureStarted({ waitForRunning: true });
    await Promise.resolve();
    requireCallback(resolveLoad, 'load resolver')();
    await Promise.resolve();
    await Promise.resolve();
    lifecycle.dispose();

    await expect(startupPromise).resolves.toEqual(
      expect.objectContaining({
        runtimeId: 'chunking-host:stopped',
        state: 'stopped',
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

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
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
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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
          active: true,
          lastError: null,
          runtimeId: lifecycle.getStatus().runtimeId,
          state: 'running',
        })
      )
    ).not.toThrow();
  });

  it('does not rebroadcast identical status snapshots', async () => {
    const hostWindow = createFakeWindow(83);
    const visibleWindow = createFakeWindow(84);
    hostWindow.loadURL.mockResolvedValue(undefined);

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
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
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
        state: 'running',
      })
    );
    lifecycle.setStatus(
      createStatus({
        active: true,
        lastError: null,
        runtimeId: lifecycle.getStatus().runtimeId,
        state: 'running',
      })
    );

    expect(visibleWindow.webContents.send).toHaveBeenCalledTimes(1);
  });

  it('destroys the host window when startup readiness fails after the window is created', async () => {
    vi.useFakeTimers();
    const hostWindow = createFakeWindow(91);
    hostWindow.loadURL.mockResolvedValue(undefined);

    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      Object.assign(this, hostWindow);
    });
    Object.assign(BrowserWindow, {
      getAllWindows: vi.fn(() => [hostWindow]),
    });

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
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

  it.each([false, true])(
    'destroys a newly created window if dispose races with in-flight startup (load rejects: %s)',
    async (rejectLoad) => {
      const hostWindow = createFakeWindow(92);
      let resolveLoad: (() => void) | null = null;
      hostWindow.loadURL.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            resolveLoad = () => (rejectLoad ? reject(new Error('ERR_FAILED (-2)')) : resolve());
          })
      );

      MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
        Object.assign(this, hostWindow);
      });
      Object.assign(BrowserWindow, {
        getAllWindows: vi.fn(() => [hostWindow]),
      });

      const lifecycle = new RendererHostLifecycle({
        createStatus,
        createStoppedStatus: () =>
          createStatus({
            active: false,
            lastError: null,
            runtimeId: 'embedding-host:stopped',
            state: 'stopped',
          }),
        mode: 'embedding-host',
        role: 'embedding-host',
        statusEventName: 'embedding-host:status',
        timeoutMessage: 'timeout',
      });

      const startupPromise = lifecycle.ensureStarted({ waitForRunning: true });
      await Promise.resolve();
      lifecycle.dispose();
      requireCallback(resolveLoad, 'load resolver')();

      await expect(startupPromise).resolves.toEqual(
        expect.objectContaining({
          state: 'stopped',
        })
      );
      expect(hostWindow.destroy).toHaveBeenCalledTimes(1);
      expect(getWindowRoleByWebContentsId(92)).toBeUndefined();
    }
  );

  it('retries document load on transient failure and succeeds on second attempt', async () => {
    vi.useFakeTimers();
    const failWindow = createFakeWindow(101);
    const successWindow = createFakeWindow(102);
    failWindow.loadURL.mockRejectedValue(new Error('ERR_FAILED (-2)'));
    successWindow.loadURL.mockResolvedValue(undefined);

    const createdWindows = [failWindow, successWindow];
    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
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
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
          state: 'stopped',
        }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    lifecycle.ensureStarted({ waitForRunning: false });

    await vi.waitFor(() => expect(failWindow.destroy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(successWindow.loadURL).toHaveBeenCalledTimes(1));
    expect(failWindow.destroy).toHaveBeenCalledTimes(1);
    expect(successWindow.loadURL).toHaveBeenCalledTimes(1);
    expect(getWindowRoleByWebContentsId(101)).toBeUndefined();
    vi.useRealTimers();
  });

  it('retries as soon as the failed window closes, without waiting out 300 ms', async () => {
    vi.useFakeTimers();
    const failedWindow = createFakeWindow(103);
    const nextWindow = createFakeWindow(104);
    failedWindow.loadURL.mockRejectedValue(new Error('transient load failure'));
    nextWindow.loadURL.mockResolvedValue(undefined);
    failedWindow.destroy.mockImplementation(() => {
      failedWindow.isDestroyed.mockReturnValue(true);
      failedWindow.listeners.closed?.();
    });
    const windows = [failedWindow, nextWindow];
    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      const window = windows.shift();
      if (!window) {
        throw new Error('No fake BrowserWindow left to create');
      }
      Object.assign(this, window);
    });
    Object.assign(BrowserWindow, { getAllWindows: vi.fn(() => [nextWindow]) });
    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'chunking-host:stopped',
          state: 'stopped',
        }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    const startedAt = Date.now();
    void lifecycle.ensureStarted({ waitForRunning: false });
    await vi.waitFor(() => expect(nextWindow.loadURL).toHaveBeenCalledTimes(1));

    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(failedWindow.destroy).toHaveBeenCalledOnce();
    expect(getWindowRoleByWebContentsId(103)).toBeUndefined();
    vi.useRealTimers();
  });

  it('does not retry a BrowserWindow construction failure', async () => {
    const failure = new Error('BrowserWindow construction failed');
    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
      throw failure;
    });
    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () =>
        createStatus({
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    const status = await lifecycle.ensureStarted({ waitForRunning: true });

    expect(status.state).toBe('error');
    expect(status.lastError).toBe(failure.message);
    expect(MockBrowserWindow).toHaveBeenCalledTimes(1);
  });

  it('gives up after 3 failed load attempts and sets error status', async () => {
    vi.useFakeTimers();
    const windows = [createFakeWindow(111), createFakeWindow(112), createFakeWindow(113)];
    for (const w of windows) {
      w.loadURL.mockRejectedValue(new Error('ERR_FAILED (-2)'));
    }

    const createdWindows = [...windows];
    MockBrowserWindow.mockImplementation(function (this: FakeWindow) {
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
          active: false,
          lastError: null,
          runtimeId: 'embedding-host:stopped',
          state: 'stopped',
        }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    lifecycle.ensureStarted({ waitForRunning: false });

    await vi.waitFor(() => expect(windows[0]?.destroy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(windows[1]?.destroy).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(() => expect(lifecycle.getStatus().state).toBe('error'));

    const finalStatus = lifecycle.getStatus();
    expect(finalStatus.state).toBe('error');
    expect(finalStatus.lastError).toContain('failed to load after 3 attempts');
    for (const w of windows) {
      expect(w.destroy).toHaveBeenCalledTimes(1);
    }
    vi.useRealTimers();
  });
});
