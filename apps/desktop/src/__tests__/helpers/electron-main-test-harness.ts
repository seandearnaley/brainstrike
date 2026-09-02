import { vi } from 'vitest';

type IpcMainHandler = (...args: unknown[]) => unknown;
type IpcMainListener = (...args: unknown[]) => unknown;

const { default: electronTestStub } = await vi.importActual<
  typeof import('../electron-test-stub.mts')
>('../electron-test-stub.mts');

const ipcMainHandlers = new Map<string, IpcMainHandler>();
const ipcMainListeners = new Map<string, IpcMainListener[]>();
const mockAllWebContents: unknown[] = [];

function registerIpcMainHandler(channel: string, handler: IpcMainHandler): void {
  if (ipcMainHandlers.has(channel)) {
    throw new Error(`Attempted to register a second handler for '${channel}'`);
  }
  ipcMainHandlers.set(channel, handler);
}

function registerIpcMainListener(channel: string, listener: IpcMainListener): void {
  const listeners = ipcMainListeners.get(channel) ?? [];
  listeners.push(listener);
  ipcMainListeners.set(channel, listeners);
}

function removeIpcMainHandler(channel: string): void {
  ipcMainHandlers.delete(channel);
}

function removeIpcMainListener(channel: string, listener: IpcMainListener): void {
  const listeners = ipcMainListeners.get(channel);
  if (!listeners) {
    return;
  }
  const listenerIndex = listeners.indexOf(listener);
  if (listenerIndex === -1) {
    return;
  }
  listeners.splice(listenerIndex, 1);
  if (listeners.length === 0) {
    ipcMainListeners.delete(channel);
  }
}

function removeAllIpcMainListeners(channel?: string): void {
  if (channel === undefined) {
    ipcMainListeners.clear();
    return;
  }
  ipcMainListeners.delete(channel);
}

export const mockIpcMain = {
  ...electronTestStub.ipcMain,
  handle: vi.fn(registerIpcMainHandler),
  handleOnce: vi.fn(registerIpcMainHandler),
  on: vi.fn(registerIpcMainListener),
  once: vi.fn(registerIpcMainListener),
  removeAllListeners: vi.fn(removeAllIpcMainListeners),
  removeHandler: vi.fn(removeIpcMainHandler),
  removeListener: vi.fn(removeIpcMainListener),
};

const BrowserWindowMock = Object.assign(vi.fn(), {
  fromWebContents: vi.fn(() => null),
  getAllWindows: vi.fn(() => []),
});

const electronMainMockSurface = {
  ...electronTestStub,
  app: {
    ...electronTestStub.app,
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
  BrowserWindow: BrowserWindowMock,
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: {
    ...electronTestStub.dialog,
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
  ipcMain: mockIpcMain,
  ipcRenderer: { ...electronTestStub.ipcRenderer, invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
  Menu: {
    ...electronTestStub.Menu,
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
  safeStorage: {
    ...electronTestStub.safeStorage,
    decryptString: vi.fn((buffer: Buffer) => Buffer.from(buffer).toString('utf-8')),
    encryptString: vi.fn((text: string) => Buffer.from(text)),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    isEncryptionAvailable: vi.fn(() => true),
    setUsePlainTextEncryption: vi.fn(),
  },
  screen: {
    ...electronTestStub.screen,
    getAllDisplays: vi.fn(() => [{ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }]),
    getPrimaryDisplay: vi.fn(() => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } })),
  },
  session: {
    ...electronTestStub.session,
    defaultSession: {
      on: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
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
    ...electronTestStub.shell,
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  },
  webContents: {
    ...electronTestStub.webContents,
    getAllWebContents: vi.fn(() => [...mockAllWebContents]),
  },
};

export const electronMainMock = Object.assign(electronMainMockSurface, {
  default: electronMainMockSurface,
});

function resetOwnedMockFunctions(value: unknown, seen = new Set<unknown>()): void {
  const isTraversable =
    (typeof value === 'object' && value !== null) || typeof value === 'function';
  if (!isTraversable || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (vi.isMockFunction(value)) {
    value.mockReset();
  }
  for (const nestedValue of Object.values(value)) {
    resetOwnedMockFunctions(nestedValue, seen);
  }
}

function restoreOwnedMockImplementations(): void {
  mockIpcMain.handle.mockImplementation(registerIpcMainHandler);
  mockIpcMain.handleOnce.mockImplementation(registerIpcMainHandler);
  mockIpcMain.on.mockImplementation(registerIpcMainListener);
  mockIpcMain.once.mockImplementation(registerIpcMainListener);
  mockIpcMain.removeAllListeners.mockImplementation(removeAllIpcMainListeners);
  mockIpcMain.removeHandler.mockImplementation(removeIpcMainHandler);
  mockIpcMain.removeListener.mockImplementation(removeIpcMainListener);
  electronMainMock.app.getAppPath.mockImplementation(() => '/mock/app');
  electronMainMock.app.getName.mockImplementation(() => 'Brainstrike');
  electronMainMock.app.getPath.mockImplementation(() => '/mock/path');
  electronMainMock.app.getVersion.mockImplementation(() => '0.0.0-test');
  electronMainMock.app.isReady.mockImplementation(() => true);
  electronMainMock.app.whenReady.mockImplementation(() => Promise.resolve());
  electronMainMock.BrowserWindow.fromWebContents.mockImplementation(() => null);
  electronMainMock.BrowserWindow.getAllWindows.mockImplementation(() => []);
  electronMainMock.dialog.showMessageBox.mockImplementation(async () => ({ response: 0 }));
  electronMainMock.safeStorage.decryptString.mockImplementation((buffer: Buffer) =>
    Buffer.from(buffer).toString('utf-8')
  );
  electronMainMock.safeStorage.encryptString.mockImplementation((text: string) =>
    Buffer.from(text)
  );
  electronMainMock.safeStorage.getSelectedStorageBackend.mockImplementation(() => 'basic_text');
  electronMainMock.safeStorage.isEncryptionAvailable.mockImplementation(() => true);
  electronMainMock.screen.getAllDisplays.mockImplementation(() => [
    { workArea: { height: 1080, width: 1920, x: 0, y: 0 } },
  ]);
  electronMainMock.screen.getPrimaryDisplay.mockImplementation(() => ({
    workArea: { height: 1080, width: 1920, x: 0, y: 0 },
  }));
  electronMainMock.session.fromPartition.mockImplementation(() => ({
    clearStorageData: vi.fn(async () => undefined),
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn() },
  }));
  electronMainMock.shell.openPath.mockResolvedValue('');
  electronMainMock.webContents.getAllWebContents.mockImplementation(() => [...mockAllWebContents]);
}

export function getRegisteredIpcMainHandler(channel: string): IpcMainHandler {
  const handler = ipcMainHandlers.get(channel);
  if (!handler) {
    throw new Error(`No ipcMain.handle registration found for channel: ${channel}`);
  }
  return handler;
}

export function getRegisteredIpcMainListener(channel: string): IpcMainListener {
  const listeners = ipcMainListeners.get(channel);
  if (!listeners || listeners.length === 0) {
    throw new Error(`No ipcMain.on registration found for channel: ${channel}`);
  }
  if (listeners.length > 1) {
    throw new Error(`Multiple ipcMain.on registrations found for channel: ${channel}`);
  }
  const listener = listeners[0];
  if (!listener) {
    throw new Error(`No ipcMain.on registration found for channel: ${channel}`);
  }
  return listener;
}

export function resetElectronMainTestHarness(): void {
  resetOwnedMockFunctions(electronMainMock);
  ipcMainHandlers.clear();
  ipcMainListeners.clear();
  mockAllWebContents.length = 0;
  restoreOwnedMockImplementations();
}

export function setMockWebContents(contents: readonly unknown[]): void {
  mockAllWebContents.length = 0;
  mockAllWebContents.push(...contents);
}
