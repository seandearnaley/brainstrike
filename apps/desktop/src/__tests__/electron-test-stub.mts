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

import { resolve } from 'node:path';

const noop = (): void => undefined;

const makeFn = (): ((...args: unknown[]) => undefined) => () => undefined;

export const app = {
  exit: noop,
  getAppPath: () => resolve('/mock/app'),
  getLocale: () => 'en-US',
  getName: () => 'Brainstrike',
  getPath: () => '/mock/path',
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  isReady: () => true,
  off: makeFn(),
  on: makeFn(),
  once: makeFn(),
  quit: noop,
  removeListener: makeFn(),
  requestSingleInstanceLock: () => true,
  setName: noop,
  setPath: noop,
  whenReady: () => Promise.resolve(),
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
  removeAllListeners: makeFn(),
  removeHandler: makeFn(),
};

export const ipcRenderer = {
  invoke: () => Promise.resolve(undefined),
  on: makeFn(),
  once: makeFn(),
  removeListener: makeFn(),
  send: makeFn(),
};

export const contextBridge = {
  exposeInMainWorld: makeFn(),
};

export const clipboard = {
  readText: () => Promise.resolve(''),
  writeText: (_text: string): Promise<void> => Promise.resolve(),
};

export const safeStorage = {
  decryptString: (buffer: Buffer) => Buffer.from(buffer).toString('utf-8'),
  encryptString: (text: string) => Buffer.from(text),
  getSelectedStorageBackend: () => 'basic_text',
  isEncryptionAvailable: () => true,
  setUsePlainTextEncryption: noop,
};

export const screen = {
  getAllDisplays: () => [{ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }],
  getPrimaryDisplay: () => ({ workArea: { height: 1080, width: 1920, x: 0, y: 0 } }),
};

const makePartitionSession = () => ({
  clearAuthCache: () => Promise.resolve(),
  clearData: () => Promise.resolve(),
  clearStorageData: () => Promise.resolve(),
  closeAllConnections: () => Promise.resolve(),
  on: makeFn(),
  setPermissionCheckHandler: makeFn(),
  setPermissionRequestHandler: makeFn(),
  webRequest: { onHeadersReceived: makeFn() },
});

export const session = {
  defaultSession: makePartitionSession(),
  fromPartition: () => makePartitionSession(),
};

export const Menu = {
  buildFromTemplate: makeFn(),
  setApplicationMenu: noop,
};

export const dialog = {
  showMessageBox: () => Promise.resolve({ response: 0 }),
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: () => Promise.resolve({ canceled: true, filePath: undefined }),
};

export const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
};

export const powerMonitor = {
  addListener: makeFn(),
  on: makeFn(),
};

export const powerSaveBlocker = {
  isStarted: () => false,
  start: () => 0,
  stop: noop,
};

export const webContents = {
  fromId: () => null,
  getAllWebContents: () => [],
};

export const utilityProcess = {
  fork: makeFn(),
};

/** An inert MessagePortMain pair: a unit test never transfers it to a real process. */
export class MessageChannelMain {
  readonly port1 = { close: noop, off: makeFn(), on: makeFn(), postMessage: noop, start: noop };
  readonly port2 = { close: noop, off: makeFn(), on: makeFn(), postMessage: noop, start: noop };
}

const electron = {
  app,
  BrowserWindow,
  clipboard,
  contextBridge,
  dialog,
  ipcMain,
  ipcRenderer,
  Menu,
  MessageChannelMain,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
  webContents,
};

export default electron;
