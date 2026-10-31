import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_PUSH_CHANNEL,
} from '../../platform/desktop-ipc-channels';
import type {
  DesktopIpcChannelRegistration,
  DesktopIpcRegistry,
} from '../../platform/desktop-ipc-registry';

/**
 * Boots main.ts to capture its module-scope and ready-time IPC registries.
 * Checks that host profile startup precedes renderer creation without blocking it.
 * Verifies preload invokes are registered and native focus changes reach the renderer.
 */
const registryCapture = vi.hoisted(() => ({
  instances: [] as DesktopIpcRegistry[],
}));
const profileStartup = vi.hoisted(() => ({
  acquire: vi.fn<() => Promise<never>>(),
  events: [] as string[],
}));

vi.mock('../../native-index-activation', async () => {
  const actual = await vi.importActual<typeof import('../../native-index-activation')>(
    '../../native-index-activation'
  );
  return {
    ...actual,
    createNativeIndexActivation: (
      ...args: Parameters<typeof actual.createNativeIndexActivation>
    ) => ({
      ...actual.createNativeIndexActivation(...args),
      acquireProfile: profileStartup.acquire,
    }),
  };
});

vi.mock('../../platform/desktop-ipc-registry', async () => {
  const actual = await vi.importActual<typeof import('../../platform/desktop-ipc-registry')>(
    '../../platform/desktop-ipc-registry'
  );
  return {
    ...actual,
    createDesktopIpcRegistry: (
      options: Parameters<typeof actual.createDesktopIpcRegistry>[0]
    ): DesktopIpcRegistry => {
      const registry = actual.createDesktopIpcRegistry(options);
      registryCapture.instances.push(registry);
      return registry;
    },
  };
});

// ---- electron + module mocks: the workspace-open-lifecycle harness shape ----
const mockSession = {
  defaultSession: {
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn() },
  },
  fromPartition: vi.fn(() => ({
    clearStorageData: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  })),
};

type MockOnFn = ReturnType<typeof vi.fn>;

function fireHandlersRegisteredSoFar(onMock: MockOnFn, eventName: string): void {
  const handlers = onMock.mock.calls
    .filter((call) => call[0] === eventName)
    .map((call) => call[1] as () => void);
  for (const handler of handlers) {
    handler();
  }
}

let nextMockWebContentsId = 1;
let mockWindowCount = 0;

// Use function syntax for Vitest 4 constructor mocks
const mockBrowserWindow = vi.fn();
mockBrowserWindow.mockImplementation(function (this: Record<string, unknown>) {
  profileStartup.events.push('window');
  const webContents = {
    id: nextMockWebContentsId++,
    isDestroyed: vi.fn(() => false),
    isLoading: vi.fn(() => false),
    off: vi.fn(),
    on: vi.fn(),
    openDevTools: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const simulateLoad = () => {
    fireHandlersRegisteredSoFar(webContents.on, 'did-finish-load');
    fireHandlersRegisteredSoFar(webContents.on, 'did-stop-loading');
    return Promise.resolve();
  };
  Object.assign(this, {
    destroy: vi.fn(),
    getBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
    getNormalBounds: vi.fn(() => ({ height: 800, width: 1536, x: 0, y: 0 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    loadFile: vi.fn(simulateLoad),
    loadURL: vi.fn(simulateLoad),
    maximize: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    setFullScreen: vi.fn(),
    show: vi.fn(),
    webContents,
  });
  mockWindowCount += 1;
});
Object.assign(mockBrowserWindow, {
  getAllWindows: vi.fn(() => []),
  getFocusedWindow: vi.fn(() => null),
});

const mockApp = {
  commandLine: { appendSwitch: vi.fn(), getSwitchValue: vi.fn(() => '') },
  getAppMetrics: vi.fn(() => []),
  getAppPath: vi.fn(() => path.resolve('/mock/app')),
  getPath: vi.fn(() => '/tmp/brainstrike-test-logs'),
  getVersion: vi.fn(() => '0.0.0-test'),
  isPackaged: false,
  isReady: vi.fn(() => true),
  on: vi.fn(),
  quit: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  setAboutPanelOptions: vi.fn(),
  setPath: vi.fn(),
  whenReady: vi.fn(() => Promise.resolve()),
};

const mockIpcMain = {
  handle: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
};

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  clipboard: { writeText: vi.fn() },
  crashReporter: { start: vi.fn() },
  ipcMain: mockIpcMain,
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: { isStarted: vi.fn(() => true), start: vi.fn(() => 1), stop: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { height: 800, width: 1536, x: 0, y: 0 } }]),
  },
  session: mockSession,
  shell: { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() },
}));

const statSyncMock = vi.fn((): { isDirectory: () => boolean } => ({ isDirectory: () => true }));
const accessSyncMock = vi.fn();
const existsSyncMock = vi.fn(() => true);
vi.mock('node:fs', () => ({
  accessSync: accessSyncMock,
  constants: { W_OK: 0o200 },
  default: {
    accessSync: accessSyncMock,
    constants: { W_OK: 0o200 },
    existsSync: existsSyncMock,
    mkdirSync: vi.fn(),
    statSync: statSyncMock,
  },
  existsSync: existsSyncMock,
  statSync: statSyncMock,
}));

const { createLoggerMock } = vi.hoisted(() => ({
  createLoggerMock: vi.fn((_scope: string) => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return { ...actual, createLogger: createLoggerMock };
});

vi.mock('../../window-state', async () => {
  const actual = await vi.importActual<typeof import('../../window-state')>('../../window-state');
  return {
    ...actual,
    readStoredWindowState: vi.fn(() => null),
    registerWindowStatePersistence: vi.fn(() => vi.fn()),
  };
});

vi.mock('electron-store', () => {
  const MockElectronStore = vi.fn();
  MockElectronStore.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return { default: MockElectronStore };
});

const REAL_PROCESS_ARGV = process.argv;

describe('global desktop IPC manifest (BST-1648 step 5)', () => {
  let union: DesktopIpcChannelRegistration[] = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    registryCapture.instances = [];
    profileStartup.events = [];
    profileStartup.acquire.mockImplementation(() => {
      profileStartup.events.push('profile');
      return new Promise<never>(() => undefined);
    });
    mockWindowCount = 0;
    process.env['CI'] = 'false';
    process.argv = ['/node_modules/electron/dist/electron', '/mock/app'];

    await import('../../main');
    // The ready block registers mcp → main-platform → (createMainWindow)
    // browser last; the window's construction is the "boot finished" signal.
    await vi.waitFor(() => {
      expect(mockWindowCount).toBe(1);
      expect(
        registryCapture.instances.flatMap((registry) => registry.getSnapshot())
      ).toContainEqual(expect.objectContaining({ channel: DESKTOP_IPC_CHANNELS.browser.listTabs }));
    });
    union = registryCapture.instances.flatMap((registry) => [...registry.getSnapshot()]);
  });

  afterEach(() => {
    for (const registry of registryCapture.instances) {
      registry.unregisterAll();
    }
    process.argv = REAL_PROCESS_ARGV;
  });

  it('boots the full per-domain registry set (module scope + app.whenReady())', () => {
    expect(registryCapture.instances).toHaveLength(25);
    expect(union.map((entry) => entry.channel)).toEqual(
      expect.arrayContaining([
        DESKTOP_IPC_CHANNELS.appUpdates.setBetaUpdates,
        DESKTOP_IPC_CHANNELS.clipboard.writeText,
        DESKTOP_IPC_CHANNELS.mcp.configSelectPath,
        DESKTOP_IPC_CHANNELS.browser.listTabs,
      ])
    );
  });

  it('starts the shared host profile before the renderer without waiting for host readiness', () => {
    // M3 startup waited for the renderer's first thread request to launch its
    // host, putting utility startup after the visible shell's own startup.
    expect(profileStartup.events[0]).toBe('profile');
    // No acquisition here ever settles, so the window opened without waiting for the host.
    expect(profileStartup.events).toContain('window');
  });

  it('exposes no preload channel that main does not handle (BST-2023)', async () => {
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const groups: Record<string, Record<string, string>> = DESKTOP_IPC_CHANNELS;
    const preload = readFileSync(path.resolve(import.meta.dirname, '../../preload.ts'), 'utf8');
    const expected = [
      ...preload.matchAll(
        /ipcRenderer\.invoke(?:<[^>]*>)?\(\s*DESKTOP_IPC_CHANNELS\.(\w+)\.(\w+)/gu
      ),
    ].map(([, group = '', name = '']) => {
      const channel = groups[group]?.[name];
      expect(channel, `${group}.${name}`).toBeDefined();
      return channel;
    });
    expect(expected.length).toBeGreaterThanOrEqual(30);
    const registered = new Set<string>([
      ...union.map(({ channel }) => channel),
      DESKTOP_IPC_CHANNELS.storage.clearAllForE2e,
      DESKTOP_IPC_CHANNELS.storage.seedMainOwnedForE2e,
    ]);
    expect(expected.filter((channel) => channel === undefined || !registered.has(channel))).toEqual(
      []
    );
  });

  it("publishes the main window's native focus and blur to its renderer on the window-focus push channel (BST-1864)", () => {
    const [mainWindow] = mockBrowserWindow.mock.instances as unknown as Array<{
      on: MockOnFn;
      webContents: { send: MockOnFn };
    }>;
    expect(mainWindow).toBeDefined();
    if (!mainWindow) {
      return;
    }
    const send = mainWindow.webContents.send;
    send.mockClear();

    fireHandlersRegisteredSoFar(mainWindow.on, 'blur');
    expect(send).toHaveBeenCalledWith(DESKTOP_IPC_PUSH_CHANNEL, {
      method: DESKTOP_IPC_CHANNELS.windowFocus.changed,
      payload: false,
    });
    fireHandlersRegisteredSoFar(mainWindow.on, 'focus');
    expect(send).toHaveBeenCalledWith(DESKTOP_IPC_PUSH_CHANNEL, {
      method: DESKTOP_IPC_CHANNELS.windowFocus.changed,
      payload: true,
    });
  });
});
