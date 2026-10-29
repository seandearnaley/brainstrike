import { resolve } from 'node:path';
import { type Mock, vi } from 'vitest';
import { DESKTOP_IPC_PUSH_CHANNEL, type DesktopIpcPush } from '../../platform/desktop-ipc-channels';

const { default: electronTestStub } = await vi.importActual<
  typeof import('../electron-test-stub.mts')
>('../electron-test-stub.mts');

const mockAllWebContents: unknown[] = [];

/**
 * Main's one IPC dispatcher registers here (`desktop-ipc-registry.ts`); find it
 * and call a method through it with `invokeDesktopIpc` from
 * `desktop-ipc-sender-test-helpers.ts`.
 */
export const mockIpcMain = {
  ...electronTestStub.ipcMain,
  handle: vi.fn(),
};

const BrowserWindowMock = Object.assign(vi.fn(), {
  fromWebContents: vi.fn(() => null),
  getAllWindows: vi.fn(() => []),
});

const electronMainMockSurface = {
  ...electronTestStub,
  app: {
    ...electronTestStub.app,
    getAppPath: vi.fn(() => resolve('/mock/app')),
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
  ipcRenderer: { ...electronTestStub.ipcRenderer, invoke: vi.fn(), on: vi.fn() },
  Menu: {
    ...electronTestStub.Menu,
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
  safeStorage: {
    ...electronTestStub.safeStorage,
    decryptStringAsync: vi.fn(async (buffer: Buffer) => ({
      result: Buffer.from(buffer).toString('utf-8'),
      shouldReEncrypt: false,
    })),
    encryptStringAsync: vi.fn(async (text: string) => Buffer.from(text)),
    getSelectedStorageBackend: vi.fn(() => 'basic_text'),
    isAsyncEncryptionAvailable: vi.fn(async () => true),
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
      clearAuthCache: vi.fn(async () => undefined),
      clearData: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
      on: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      webRequest: { onHeadersReceived: vi.fn() },
    },
    fromPartition: vi.fn(() => ({
      clearAuthCache: vi.fn(async () => undefined),
      clearData: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
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
  electronMainMock.app.getAppPath.mockImplementation(() => resolve('/mock/app'));
  electronMainMock.app.getName.mockImplementation(() => 'Brainstrike');
  electronMainMock.app.getPath.mockImplementation(() => '/mock/path');
  electronMainMock.app.getVersion.mockImplementation(() => '0.0.0-test');
  electronMainMock.app.isReady.mockImplementation(() => true);
  electronMainMock.app.whenReady.mockImplementation(() => Promise.resolve());
  electronMainMock.BrowserWindow.fromWebContents.mockImplementation(() => null);
  electronMainMock.BrowserWindow.getAllWindows.mockImplementation(() => []);
  electronMainMock.dialog.showMessageBox.mockImplementation(async () => ({ response: 0 }));
  electronMainMock.safeStorage.decryptStringAsync.mockImplementation(async (buffer: Buffer) => ({
    result: Buffer.from(buffer).toString('utf-8'),
    shouldReEncrypt: false,
  }));
  electronMainMock.safeStorage.encryptStringAsync.mockImplementation(async (text: string) =>
    Buffer.from(text)
  );
  electronMainMock.safeStorage.getSelectedStorageBackend.mockImplementation(() => 'basic_text');
  electronMainMock.safeStorage.isAsyncEncryptionAvailable.mockImplementation(async () => true);
  electronMainMock.screen.getAllDisplays.mockImplementation(() => [
    { workArea: { height: 1080, width: 1920, x: 0, y: 0 } },
  ]);
  electronMainMock.screen.getPrimaryDisplay.mockImplementation(() => ({
    workArea: { height: 1080, width: 1920, x: 0, y: 0 },
  }));
  electronMainMock.session.fromPartition.mockImplementation(() => ({
    clearAuthCache: vi.fn(async () => undefined),
    clearData: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn() },
  }));
  electronMainMock.shell.openPath.mockResolvedValue('');
  electronMainMock.webContents.getAllWebContents.mockImplementation(() => [...mockAllWebContents]);
}

export function resetElectronMainTestHarness(): void {
  resetOwnedMockFunctions(electronMainMock);
  mockAllWebContents.length = 0;
  restoreOwnedMockImplementations();
}

export function setMockWebContents(contents: readonly unknown[]): void {
  mockAllWebContents.length = 0;
  mockAllWebContents.push(...contents);
}

export interface RecordedRendererEvent extends DesktopIpcPush {
  readonly channel: string;
}

type RendererSendMock = Mock<(channel: string, push: DesktopIpcPush) => void>;

export interface RecordingWindow {
  /** Every `webContents.send` this window received, in call order. */
  readonly events: RecordedRendererEvent[];
  readonly id: number;
  isDestroyed(): boolean;
  /** Payloads pushed for `method` on the push channel, in call order. */
  payloadsFor(method: string): unknown[];
  /**
   * Clears BOTH records of the traffic — the `events` log and the mock's own
   * call log. They are two views of the same sends, so clearing one alone
   * (`vi.clearAllMocks()` empties the call log but not `events`;
   * `events.length = 0` does the reverse) leaves a window that answers
   * `toHaveBeenCalledTimes` and `payloadsFor` differently. Clears in place, so
   * an alias taken earlier (`const sentEvents = window.events`) stays valid.
   */
  reset(): void;
  /** Same mock as `webContents.send`, hoisted for terser assertions. */
  readonly send: RendererSendMock;
  readonly webContents: {
    readonly id: number;
    isDestroyed(): boolean;
    readonly send: RendererSendMock;
  };
}

let nextRecordingWindowId = 1;

/**
 * A `BrowserWindow`-shaped stand-in that records what main sent to the
 * renderer.
 *
 * The listing-routed main -> renderer broadcasts iterate
 * `BrowserWindow.getAllWindows()` (`ipc-mcp.ts`, `mcp/lifecycle-control.ts`,
 * `ipc-domains/db-ipc.ts`, `assistant-server/workspace-context-broadcast.ts` and
 * eight sites in `main.ts`), and every one is a `for (const window of …)` loop.
 * That is not every send site in the app (BST-1624): the mcp bridges iterate
 * the separate `getAppWindows()` registry.
 * A test that asserts what the renderer was told therefore needs at least one
 * window in that listing: with `getAllWindows: () => []` the loop body never
 * runs, and the assertion — `.not.toHaveBeenCalled()` above all — passes
 * whether or not production sends anything (BST-1622).
 *
 * The harness default stays `[]` on purpose. Most desktop tests never look at
 * renderer traffic, and an empty listing is the honest stub for them; hand one
 * of these to `getAllWindows` only in the tests that do look.
 *
 * `scripts/desktop-window-broadcast-assertion-guard.mjs` enforces the pairing.
 */
export function createRecordingWindow(
  options: {
    /** Model a window torn down mid-broadcast: senders must skip it. */
    destroyed?: boolean;
    id?: number;
    webContentsDestroyed?: boolean;
    webContentsId?: number;
  } = {}
): RecordingWindow {
  const events: RecordedRendererEvent[] = [];
  const windowId = options.id ?? nextRecordingWindowId++;
  const webContentsId = options.webContentsId ?? windowId;
  const destroyed = options.destroyed === true;
  const send: RendererSendMock = vi.fn((channel: string, push: DesktopIpcPush) => {
    events.push({ channel, ...push });
  });
  return {
    events,
    id: windowId,
    isDestroyed: () => destroyed,
    payloadsFor: (method: string) =>
      events
        .filter((event) => event.channel === DESKTOP_IPC_PUSH_CHANNEL && event.method === method)
        .map((event) => event.payload),
    reset: () => {
      events.length = 0;
      send.mockClear();
    },
    send,
    webContents: {
      id: webContentsId,
      isDestroyed: () => options.webContentsDestroyed ?? destroyed,
      send,
    },
  };
}
