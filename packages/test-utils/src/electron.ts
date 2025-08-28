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
    invoke: vi.fn(async (_channel: string, ..._args: unknown[]) => undefined),
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
    send: vi.fn(),
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
}) {
  const app = parts?.app ?? createAppMock();
  const ipcMain = parts?.ipcMain ?? createIpcMainMock();
  const ipcRenderer = parts?.ipcRenderer ?? createIpcRendererMock();

  vi.mock('electron', () => ({
    app,
    ipcMain,
    ipcRenderer,
    // biome-ignore lint/style/useNamingConvention: Electron API uses PascalCase
    BrowserWindow: vi.fn(),
    session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } },
    dialog: {},
    shell: {},
    nativeTheme: { shouldUseDarkColors: false },
  }));

  return { app, ipcMain, ipcRenderer } as const;
}
