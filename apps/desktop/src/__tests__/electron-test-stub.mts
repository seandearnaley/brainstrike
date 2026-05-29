/**
 * Test-only stub for the `electron` module.
 *
 * The real `electron` package entrypoint (node_modules/electron/index.js)
 * exports ONLY the absolute path to the prebuilt Electron binary, and it
 * THROWS ("Electron failed to install correctly") when that binary is not on
 * disk. None of the runtime named exports (`app`, `ipcMain`, `safeStorage`,
 * `BrowserWindow`, …) exist there — they are injected by the Electron runtime
 * at launch. In a Vitest (plain Node) process the real module is therefore
 * both useless and a liability: every desktop test already replaces it with
 * `vi.mock('electron', …)`, and on machines/CI where the binary is absent the
 * mere act of resolving it crashes the whole test file before any mock runs.
 *
 * Aliasing `electron` to this stub in `vitest.config.mts` guarantees the real
 * `index.js` is never evaluated, so desktop unit tests no longer depend on the
 * Electron binary being installed. Per-test `vi.mock('electron', …)` calls
 * still override this stub for the modules under test; this file only supplies
 * inert defaults for transitively-imported electron surfaces that a given test
 * did not bother to mock.
 */

const noop = (): void => undefined;

const makeFn = (): ((...args: unknown[]) => undefined) => () => undefined;

export const app = {
  isPackaged: false,
  whenReady: () => Promise.resolve(),
  isReady: () => true,
  on: makeFn(),
  once: makeFn(),
  off: makeFn(),
  removeListener: makeFn(),
  getAppPath: () => '/mock/app',
  getPath: () => '/mock/path',
  getName: () => 'Brainstrike',
  getVersion: () => '0.0.0-test',
  getLocale: () => 'en-US',
  setName: noop,
  quit: noop,
  exit: noop,
  requestSingleInstanceLock: () => true,
  setPath: noop,
};

export const BrowserWindow = class {
  static getAllWindows(): unknown[] {
    return [];
  }
  static fromWebContents(): null {
    return null;
  }
};

export const ipcMain = {
  handle: makeFn(),
  handleOnce: makeFn(),
  on: makeFn(),
  once: makeFn(),
  removeHandler: makeFn(),
  removeAllListeners: makeFn(),
};

export const ipcRenderer = {
  invoke: () => Promise.resolve(undefined),
  on: makeFn(),
  once: makeFn(),
  send: makeFn(),
  removeListener: makeFn(),
};

export const contextBridge = {
  exposeInMainWorld: makeFn(),
};

export const clipboard = {
  readText: () => '',
  writeText: noop,
};

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text: string) => Buffer.from(text),
  decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8'),
  setUsePlainTextEncryption: noop,
  getSelectedStorageBackend: () => 'basic_text',
};

export const screen = {
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
};

export const session = {
  defaultSession: {
    webRequest: { onHeadersReceived: makeFn() },
  },
};

export const Menu = {
  setApplicationMenu: noop,
  buildFromTemplate: makeFn(),
};

export const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
  showMessageBox: () => Promise.resolve({ response: 0 }),
};

export const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
};

export const powerMonitor = {
  on: makeFn(),
  addListener: makeFn(),
};

export const powerSaveBlocker = {
  start: () => 0,
  stop: noop,
  isStarted: () => false,
};

export const webContents = {
  getAllWebContents: () => [],
  fromId: () => null,
};

export const utilityProcess = {
  fork: makeFn(),
};

const electron = {
  app,
  BrowserWindow,
  ipcMain,
  ipcRenderer,
  contextBridge,
  clipboard,
  safeStorage,
  screen,
  session,
  Menu,
  dialog,
  shell,
  powerMonitor,
  powerSaveBlocker,
  webContents,
  utilityProcess,
};

export default electron;
