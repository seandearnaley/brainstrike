// Test-only stub for the `electron` module.
//
// Desktop unit tests run in Node/jsdom, not in an Electron runtime. Importing
// the real `electron` package executes `electron/index.js`, which calls
// `getElectronPath()` and throws "Electron failed to install correctly" when
// the platform binary isn't present. In CI's affected-only Unit/Coverage jobs
// the binary is not always installed, so any test that transitively loads
// `electron` (even with a per-file `vi.mock('electron')`, the real module can
// still be resolved during hoisting) fails non-deterministically.
//
// Aliasing `electron` to this stub in the vitest config (see vitest.config.mts)
// guarantees the real, binary-dependent module is never loaded, making desktop
// unit tests independent of the Electron binary. Tests that need specific
// behavior still override individual members via `vi.mock('electron', ...)`.

const noop = (): void => undefined;

export const app = {
  isPackaged: false,
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  on: noop,
  once: noop,
  getAppPath: () => '/mock/app',
  getPath: () => '/mock/path',
  getName: () => 'Brainstrike',
  getVersion: () => '0.0.0-test',
  setPath: noop,
  quit: noop,
  requestSingleInstanceLock: () => true,
};

export class BrowserWindow {
  static getAllWindows(): unknown[] {
    return [];
  }
  loadURL = () => Promise.resolve();
  loadFile = () => Promise.resolve();
  on = noop;
  webContents = { on: noop, send: noop };
}

export const ipcMain = { handle: noop, on: noop, removeHandler: noop };
export const ipcRenderer = { invoke: () => Promise.resolve(), on: noop, send: noop };
export const contextBridge = { exposeInMainWorld: noop };
export const screen = {
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
};
export const safeStorage = {
  decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8'),
  encryptString: (text: string) => Buffer.from(text),
  isEncryptionAvailable: () => true,
  setUsePlainTextEncryption: noop,
  getSelectedStorageBackend: () => 'basic_text',
};
export const shell = { openExternal: () => Promise.resolve(), openPath: () => Promise.resolve('') };
export const dialog = { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) };
export const session = { defaultSession: { webRequest: { onHeadersReceived: noop } } };
export const Menu = { setApplicationMenu: noop, buildFromTemplate: () => ({}) };
export const nativeTheme = { shouldUseDarkColors: false, on: noop };
export const powerSaveBlocker = { start: () => 0, stop: noop, isStarted: () => false };

const electron = {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  contextBridge,
  screen,
  safeStorage,
  shell,
  dialog,
  session,
  Menu,
  nativeTheme,
  powerSaveBlocker,
};

export default electron;
