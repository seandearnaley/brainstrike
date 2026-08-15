import { vi } from 'vitest';

type IpcMainHandler = (...args: unknown[]) => unknown;
type IpcMainListener = (...args: unknown[]) => unknown;

const ipcMainHandlers = new Map<string, IpcMainHandler>();
const ipcMainListeners = new Map<string, IpcMainListener>();
const mockAllWebContents: unknown[] = [];

export const mockIpcMain = {
  handle: vi.fn((channel: string, handler: IpcMainHandler) => {
    ipcMainHandlers.set(channel, handler);
  }),
  on: vi.fn((channel: string, listener: IpcMainListener) => {
    ipcMainListeners.set(channel, listener);
  }),
  removeHandler: vi.fn((channel: string) => {
    ipcMainHandlers.delete(channel);
  }),
  removeListener: vi.fn((channel: string, listener: IpcMainListener) => {
    if (ipcMainListeners.get(channel) === listener) {
      ipcMainListeners.delete(channel);
    }
  }),
};

export const electronMainMock = {
  app: {
    getAppPath: vi.fn(() => '/mock/app'),
    getName: vi.fn(() => 'Brainstrike'),
    getPath: vi.fn(() => '/mock/path'),
    getVersion: vi.fn(() => '0.0.0-test'),
    isPackaged: false,
    isReady: vi.fn(() => true),
    on: vi.fn(),
    quit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  BrowserWindow: vi.fn(),
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: {
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  ipcMain: mockIpcMain,
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
  safeStorage: {
    decryptString: vi.fn((buffer: Buffer) => Buffer.from(buffer).toString('utf-8')),
    encryptString: vi.fn((text: string) => Buffer.from(text)),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    isEncryptionAvailable: vi.fn(() => true),
    setUsePlainTextEncryption: vi.fn(),
  },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }]),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } })),
  },
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived: vi.fn() },
    },
    fromPartition: vi.fn(() => ({
      clearStorageData: vi.fn(async () => undefined),
      on: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: { onHeadersReceived: vi.fn() },
    })),
  },
  shell: {
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  },
  webContents: {
    getAllWebContents: vi.fn(() => mockAllWebContents),
  },
};

export function getRegisteredIpcMainHandler(channel: string): IpcMainHandler {
  const handler = ipcMainHandlers.get(channel);
  if (!handler) {
    throw new Error(`No ipcMain.handle registration found for channel: ${channel}`);
  }
  return handler;
}

export function getRegisteredIpcMainListener(channel: string): IpcMainListener {
  const listener = ipcMainListeners.get(channel);
  if (!listener) {
    throw new Error(`No ipcMain.on registration found for channel: ${channel}`);
  }
  return listener;
}

export function resetElectronMainTestHarness(): void {
  vi.clearAllMocks();
  ipcMainHandlers.clear();
  ipcMainListeners.clear();
  mockAllWebContents.length = 0;
}

export function setMockWebContents(contents: readonly unknown[]): void {
  mockAllWebContents.length = 0;
  mockAllWebContents.push(...contents);
}
