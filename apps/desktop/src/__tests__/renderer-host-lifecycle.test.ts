import { app, BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RendererHostLifecycle, type RendererHostStatusShape } from '../renderer-host-lifecycle';
import { getWindowRoleByWebContentsId } from '../window-role';

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
  };
}

function createStatus(status: RendererHostStatusShape): RendererHostStatusShape {
  return {
    state: status.state,
    active: status.active,
    lastError: status.lastError,
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
    },
  };
}

describe('RendererHostLifecycle', () => {
  const baseArgv = process.argv.filter((arg) => arg !== '--test-mode');

  beforeEach(() => {
    vi.clearAllMocks();
    process.argv = [...baseArgv];
    Reflect.deleteProperty(process.env, 'CI');
  });

  it('assigns the host role before beginning renderer load', async () => {
    const hostWindow = createFakeWindow(41);
    hostWindow.loadURL.mockImplementation(async () => {
      expect(getWindowRoleByWebContentsId(41)).toBe('chunking-host');
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
      createStoppedStatus: () => createStatus({ state: 'stopped', active: false, lastError: null }),
      mode: 'chunking-host',
      role: 'chunking-host',
      statusEventName: 'chunking-host:status',
      timeoutMessage: 'timeout',
    });

    const status = await lifecycle.ensureStarted({ waitForRunning: false });

    expect(status.state).toBe('starting');
    expect(hostWindow.loadURL).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/localhost:8081\?mode=chunking-host&runtimeId=chunking-host:/)
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

    const lifecycle = new RendererHostLifecycle({
      createStatus,
      createStoppedStatus: () => createStatus({ state: 'stopped', active: false, lastError: null }),
      mode: 'embedding-host',
      role: 'embedding-host',
      statusEventName: 'embedding-host:status',
      timeoutMessage: 'timeout',
    });

    await lifecycle.ensureStarted({ waitForRunning: false });
    hostWindow.webContents.send.mockClear();
    visibleWindow.webContents.send.mockClear();
    lifecycle.setStatus(createStatus({ state: 'running', active: true, lastError: null }));

    expect(hostWindow.webContents.send).not.toHaveBeenCalled();
    expect(visibleWindow.webContents.send).toHaveBeenCalledWith('embedding-host:status', {
      state: 'running',
      active: true,
      lastError: null,
    });
  });
});
