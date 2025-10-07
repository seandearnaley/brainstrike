import { vi } from 'vitest';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>;

export function createIpcMainMock() {
  const handlers = new Map<string, IpcHandler>();

  return {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    // Utility for tests: trigger an invoke handler directly
    __invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for channel: ${channel}`);
      return handler({} as unknown, ...args);
    },
  } as const;
}

export function createIpcRendererMock() {
  return {
    invoke: vi.fn<(_channel: string, ..._args: unknown[]) => Promise<unknown>>(async () => {
      return undefined as unknown;
    }),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    send: vi.fn(),
  } as const;
}

export function createContextBridgeMock() {
  return {
    exposeInMainWorld: vi.fn(),
  } as const;
}

export function createAppMock(opts?: { whenReadyResolved?: boolean; documentsPath?: string }) {
  const whenReadyResolved = opts?.whenReadyResolved ?? true;
  const whenReadyPromise = whenReadyResolved ? Promise.resolve() : new Promise<void>(() => {});
  const documentsPath = opts?.documentsPath ?? '/mock/documents';

  return {
    whenReady: vi.fn(() => whenReadyPromise),
    getAppPath: vi.fn(() => '/app'),
    getPath: vi.fn((key: string) => (key === 'documents' ? documentsPath : '/mock/path')),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    quit: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  } as const;
}

export function installElectronModuleMocks(parts?: {
  app?: ReturnType<typeof createAppMock>;
  ipcMain?: ReturnType<typeof createIpcMainMock>;
  ipcRenderer?: ReturnType<typeof createIpcRendererMock>;
  contextBridge?: ReturnType<typeof createContextBridgeMock>;
}) {
  const app = parts?.app ?? createAppMock();
  const ipcMain = parts?.ipcMain ?? createIpcMainMock();
  const ipcRenderer = parts?.ipcRenderer ?? createIpcRendererMock();
  const contextBridge = parts?.contextBridge ?? createContextBridgeMock();

  vi.mock('electron', () => ({
    app,
    ipcMain,
    ipcRenderer,
    contextBridge,
    // biome-ignore lint/style/useNamingConvention: Electron API uses PascalCase
    BrowserWindow: vi.fn(),
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    dialog: {},
    shell: {},
    nativeTheme: { shouldUseDarkColors: false },
  }));

  return { app, ipcMain, ipcRenderer, contextBridge } as const;
}

/**
 * Installs CommonJS require('electron') mocks by patching Node's Module._load.
 * Useful for code paths (like preload) that use CJS require.
 */
export function installElectronCjsMocks(parts?: {
  app?: ReturnType<typeof createAppMock>;
  ipcMain?: ReturnType<typeof createIpcMainMock>;
  ipcRenderer?: ReturnType<typeof createIpcRendererMock>;
  contextBridge?: ReturnType<typeof createContextBridgeMock>;
}) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('node:module');
  const originalLoad = Module._load as (id: string, parent: unknown, isMain?: boolean) => unknown;

  const app = parts?.app ?? createAppMock();
  const ipcMain = parts?.ipcMain ?? createIpcMainMock();
  const ipcRenderer = parts?.ipcRenderer ?? createIpcRendererMock();
  const contextBridge = parts?.contextBridge ?? createContextBridgeMock();

  Module._load = ((id: string, parent: unknown, isMain?: boolean) => {
    if (id === 'electron') {
      return {
        app,
        ipcMain,
        ipcRenderer,
        contextBridge,
      };
    }
    return originalLoad(id, parent, isMain);
  }) as typeof Module._load;

  const restore = () => {
    Module._load = originalLoad as typeof Module._load;
  };

  return { app, ipcMain, ipcRenderer, contextBridge, restore } as const;
}
