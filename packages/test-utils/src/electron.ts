import { resolve } from 'node:path';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

interface IpcMainMock {
  __invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  handle: Mock<(channel: string, handler: IpcHandler) => void>;
  removeHandler: Mock<(channel: string) => void>;
}

export function createIpcMainMock(): IpcMainMock {
  const handlers = new Map<string, IpcHandler>();

  return {
    // Utility for tests: trigger an invoke handler directly
    __invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) {
        throw new Error(`No handler for channel: ${channel}`);
      }
      return handler({} as unknown, ...args);
    },
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
}

interface IpcRendererMock {
  invoke: Mock<(_channel: string, ..._args: unknown[]) => Promise<unknown>>;
  on: Mock;
  once: Mock;
  removeAllListeners: Mock;
  removeListener: Mock;
  send: Mock;
}

export function createIpcRendererMock(): IpcRendererMock {
  return {
    invoke: vi.fn<(_channel: string, ..._args: unknown[]) => Promise<unknown>>(
      async () => undefined as unknown
    ),
    on: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  };
}

interface ContextBridgeMock {
  exposeInMainWorld: Mock;
}

export function createContextBridgeMock(): ContextBridgeMock {
  return {
    exposeInMainWorld: vi.fn(),
  };
}

interface AppMock {
  commandLine: { appendSwitch: Mock<(key: string, value?: string) => void> };
  getAppPath: Mock<() => string>;
  getPath: Mock<(key: string) => string>;
  getVersion: Mock<() => string>;
  isPackaged: boolean;
  isReady: Mock<() => boolean>;
  on: Mock;
  once: Mock;
  quit: Mock;
  setPath: Mock<(key: string, value: string) => void>;
  whenReady: Mock<() => Promise<void>>;
}

export function createAppMock(opts?: {
  whenReadyResolved?: boolean;
  documentsPath?: string;
}): AppMock {
  const whenReadyResolved = opts?.whenReadyResolved ?? true;
  const whenReadyPromise = whenReadyResolved ? Promise.resolve() : new Promise<void>(() => {});
  const documentsPath = opts?.documentsPath ?? '/mock/documents';

  return {
    commandLine: { appendSwitch: vi.fn() },
    getAppPath: vi.fn(() => resolve('/app')),
    getPath: vi.fn((key: string) => (key === 'documents' ? documentsPath : '/mock/path')),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    isReady: vi.fn(() => whenReadyResolved),
    on: vi.fn(),
    once: vi.fn(),
    quit: vi.fn(),
    setPath: vi.fn(),
    whenReady: vi.fn(() => whenReadyPromise),
  };
}

interface ScreenMock {
  getAllDisplays: Mock<
    () => Array<{ workArea: { x: number; y: number; width: number; height: number } }>
  >;
  getPrimaryDisplay: Mock<
    () => { workArea: { x: number; y: number; width: number; height: number } }
  >;
}

export function createScreenMock(): ScreenMock {
  const defaultWorkArea = { height: 1080, width: 1920, x: 0, y: 0 };
  return {
    getAllDisplays: vi.fn(() => [{ workArea: defaultWorkArea }]),
    getPrimaryDisplay: vi.fn(() => ({ workArea: defaultWorkArea })),
  };
}

interface ElectronMocks {
  app: AppMock;
  contextBridge: ContextBridgeMock;
  ipcMain: IpcMainMock;
  ipcRenderer: IpcRendererMock;
  screen: ScreenMock;
}

export function installElectronModuleMocks(parts?: {
  app?: AppMock;
  ipcMain?: IpcMainMock;
  ipcRenderer?: IpcRendererMock;
  contextBridge?: ContextBridgeMock;
  screen?: ScreenMock;
}): ElectronMocks {
  const app = parts?.app ?? createAppMock();
  const ipcMain = parts?.ipcMain ?? createIpcMainMock();
  const ipcRenderer = parts?.ipcRenderer ?? createIpcRendererMock();
  const contextBridge = parts?.contextBridge ?? createContextBridgeMock();
  const screen = parts?.screen ?? createScreenMock();

  vi.doMock('electron', () => ({
    app,
    // biome-ignore lint/style/useNamingConvention: Electron API uses PascalCase
    BrowserWindow: vi.fn(),
    contextBridge,
    dialog: {},
    ipcMain,
    ipcRenderer,
    nativeTheme: { shouldUseDarkColors: false },
    screen,
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    shell: {},
  }));

  return { app, contextBridge, ipcMain, ipcRenderer, screen };
}

interface ElectronCjsMocks extends ElectronMocks {
  restore: () => void;
}

/**
 * Installs CommonJS require('electron') mocks by patching Node's Module._load.
 * Useful for code paths (like preload) that use CJS require.
 */
export function installElectronCjsMocks(parts?: {
  app?: AppMock;
  ipcMain?: IpcMainMock;
  ipcRenderer?: IpcRendererMock;
  contextBridge?: ContextBridgeMock;
  screen?: ScreenMock;
}): ElectronCjsMocks {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('node:module');
  const originalLoad = Module._load as (id: string, parent: unknown, isMain?: boolean) => unknown;

  const app = parts?.app ?? createAppMock();
  const ipcMain = parts?.ipcMain ?? createIpcMainMock();
  const ipcRenderer = parts?.ipcRenderer ?? createIpcRendererMock();
  const contextBridge = parts?.contextBridge ?? createContextBridgeMock();
  const screen = parts?.screen ?? createScreenMock();

  Module._load = ((id: string, parent: unknown, isMain?: boolean) => {
    if (id === 'electron') {
      return {
        app,
        contextBridge,
        ipcMain,
        ipcRenderer,
        screen,
      };
    }
    return originalLoad(id, parent, isMain);
  }) as typeof Module._load;

  const restore = () => {
    Module._load = originalLoad as typeof Module._load;
  };

  return { app, contextBridge, ipcMain, ipcRenderer, restore, screen };
}
