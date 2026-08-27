import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

/**
 * BST-1393 Layer 3: argv / macOS `open-file` / `second-instance` all funnel
 * into the SAME `workspace-open-queue`, which holds requests until a
 * renderer is listening and then delivers them over `workspace:open-path`.
 * This harness mirrors `boot-order.test.ts`'s mock shape (read at HEAD) —
 * see that file's own header comment for the "Vitest 4 constructor mock"
 * pattern this reuses — with one deliberate departure documented at
 * `simulateLoad` below: `loadFile`/`loadURL` must fire `did-finish-load` to
 * the listeners registered AT THE MOMENT they are called, not to whichever
 * listener the test manually invokes after the fact. The first version of
 * this file did the latter and passed against code that never attached the
 * queue in production (L3 review 2026-08-27) — a mock that resolves the load
 * promise without ever emitting the event it is named for hides exactly the
 * ordering bug the review found.
 */

const mockSession = {
  defaultSession: {
    webRequest: {
      onHeadersReceived: vi.fn(),
    },
  },
  // The embedded browser pane (`browser-session.ts`) resolves its own
  // partitioned session during `createMainWindow`'s `createBrowserPaneHost`
  // call — needed for that call to resolve at all, not for anything this
  // file asserts on.
  fromPartition: vi.fn(() => ({
    clearStorageData: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  })),
};

type MockOnFn = ReturnType<typeof vi.fn>;

/**
 * Fires every handler registered for `eventName` on `onMock` AS OF THIS CALL
 * — i.e. models Electron's real contract for `loadFile`/`loadURL`, whose
 * returned promise resolves AT `did-finish-load`. A listener subscribed
 * AFTER this runs (the bug the review found) is never invoked, exactly like
 * the real API.
 */
function fireHandlersRegisteredSoFar(onMock: MockOnFn, eventName: string): void {
  const handlers = onMock.mock.calls
    .filter((args) => args[0] === eventName)
    .map((args) => args[1] as () => void);
  for (const handler of handlers) {
    handler();
  }
}

interface MockWindowInstance {
  readonly destroy: ReturnType<typeof vi.fn>;
  readonly getBounds: ReturnType<typeof vi.fn>;
  readonly getNormalBounds: ReturnType<typeof vi.fn>;
  readonly isDestroyed: ReturnType<typeof vi.fn>;
  readonly isFullScreen: ReturnType<typeof vi.fn>;
  readonly isMaximized: ReturnType<typeof vi.fn>;
  readonly loadFile: ReturnType<typeof vi.fn>;
  readonly loadURL: ReturnType<typeof vi.fn>;
  readonly maximize: ReturnType<typeof vi.fn>;
  readonly on: ReturnType<typeof vi.fn>;
  readonly once: ReturnType<typeof vi.fn>;
  readonly setFullScreen: ReturnType<typeof vi.fn>;
  readonly show: ReturnType<typeof vi.fn>;
  readonly webContents: {
    readonly isDestroyed: ReturnType<typeof vi.fn>;
    readonly isLoading: ReturnType<typeof vi.fn>;
    readonly off: ReturnType<typeof vi.fn>;
    readonly on: ReturnType<typeof vi.fn>;
    readonly openDevTools: ReturnType<typeof vi.fn>;
    readonly send: ReturnType<typeof vi.fn>;
    readonly setWindowOpenHandler: ReturnType<typeof vi.fn>;
  };
}

/**
 * Every window this test run has created, oldest first — `BrowserWindow` is
 * mocked to build a genuinely FRESH instance per call (own `webContents`,
 * own `isDestroyed`), unlike `boot-order.test.ts`'s single shared instance.
 * A shared instance can't distinguish "the queue re-attached to the new
 * window" from "the queue was already attached and nothing regressed" —
 * exactly the distinction the `app.on('activate')` regression test needs.
 */
let mockWindowInstances: MockWindowInstance[] = [];

function latestWindow(): MockWindowInstance {
  const win = mockWindowInstances.at(-1);
  if (!win) {
    throw new Error('No window has been created yet');
  }
  return win;
}

function createMockWindowInstance(): MockWindowInstance {
  const webContents = {
    isDestroyed: vi.fn(() => false),
    isLoading: vi.fn(() => false),
    off: vi.fn(),
    on: vi.fn(),
    openDevTools: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  // `loadFile`/`loadURL` resolve AT `did-finish-load` in real Electron — fire
  // it to whoever is subscribed right now, then resolve, so a listener
  // registered after this call (the ordering bug) is provably never invoked.
  const simulateLoad = () => {
    fireHandlersRegisteredSoFar(webContents.on, 'did-finish-load');
    return Promise.resolve();
  };
  return {
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
  };
}

// Use function syntax for Vitest 4 constructor mocks
const mockBrowserWindow = vi.fn();
mockBrowserWindow.mockImplementation(function (this: Record<string, unknown>) {
  const instance = createMockWindowInstance();
  mockWindowInstances.push(instance);
  Object.assign(this, instance);
});
Object.assign(mockBrowserWindow, {
  getAllWindows: vi.fn(() => []),
});

const mockApp = {
  commandLine: { appendSwitch: vi.fn() },
  getAppMetrics: vi.fn(() => []),
  getAppPath: vi.fn(() => '/mock/app'),
  getPath: vi.fn(() => '/tmp/brainstrike-test-logs'),
  getVersion: vi.fn(() => '0.0.0-test'),
  isPackaged: false,
  isReady: vi.fn(() => true),
  on: vi.fn(),
  quit: vi.fn(),
  requestSingleInstanceLock: vi.fn(() => true),
  whenReady: vi.fn(() => Promise.resolve()),
};

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  clipboard: { writeText: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: {
    isStarted: vi.fn(() => true),
    start: vi.fn(() => 1),
    stop: vi.fn(),
  },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { height: 800, width: 1536, x: 0, y: 0 } }]),
  },
  session: mockSession,
  shell: {
    openPath: vi.fn().mockResolvedValue(''),
    showItemInFolder: vi.fn(),
  },
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
  return {
    ...actual,
    createLogger: createLoggerMock,
  };
});

vi.mock('../../assistant-server', () => ({
  startAssistantServer: vi.fn(async () => ({
    stop: vi.fn(),
    url: 'http://127.0.0.1:0',
  })),
}));

vi.mock('../../window-state', async () => {
  const actual = await vi.importActual<typeof import('../../window-state')>('../../window-state');
  return {
    ...actual,
    readStoredWindowState: vi.fn(() => null),
    registerWindowStatePersistence: vi.fn(() => vi.fn()),
  };
});

// Use function syntax for Vitest 4 constructor mocks
vi.mock('electron-store', () => {
  const MockElectronStore = vi.fn();
  MockElectronStore.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return { default: MockElectronStore };
});

const { getDatabaseMock } = vi.hoisted(() => ({
  getDatabaseMock: vi.fn(),
}));

vi.mock('../../db-main', async () => {
  const actual = await vi.importActual<typeof import('../../db-main')>('../../db-main');
  return {
    ...actual,
    getDatabase: getDatabaseMock,
  };
});

const { probeMock } = vi.hoisted(() => ({
  probeMock: vi.fn(async () => ({
    hnswIndexBuild: true,
    maintenanceSettings: { maintenanceWorkMem: null, maxParallelMaintenanceWorkers: null },
    progressReporting: true,
  })),
}));

vi.mock('../../dimension-index-maintenance-capabilities', async () => {
  const actual = await vi.importActual<
    typeof import('../../dimension-index-maintenance-capabilities')
  >('../../dimension-index-maintenance-capabilities');
  return {
    ...actual,
    probeDimensionIndexRuntimeCapabilities: probeMock,
  };
});

const { isDesktopShuttingDownMock } = vi.hoisted(() => ({
  isDesktopShuttingDownMock: vi.fn(() => false),
}));

vi.mock('../../desktop-shutdown-state', async () => {
  const actual = await vi.importActual<typeof import('../../desktop-shutdown-state')>(
    '../../desktop-shutdown-state'
  );
  return {
    ...actual,
    isDesktopShuttingDown: isDesktopShuttingDownMock,
  };
});

vi.mock('../../database-maintenance-scheduler', () => ({
  createDesktopDatabaseMaintenanceScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../../dimension-index-maintenance-scheduler', () => ({
  createDesktopDimensionIndexMaintenanceScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

function findHandler<T extends (...args: never[]) => unknown>(
  onMock: MockOnFn,
  eventName: string
): T {
  const call = onMock.mock.calls.find((args) => args[0] === eventName);
  if (!call) {
    throw new Error(`No handler registered for "${eventName}"`);
  }
  return call[1] as T;
}

/**
 * `'activate'` has more than one subscriber: `create-window.ts` registers a
 * per-window crash-recovery handler (removed on that window's `'closed'`)
 * BEFORE `main.ts`'s own "recreate the window" handler is registered for the
 * whole app's lifetime. `findHandler` would grab the FIRST — the wrong one —
 * so the activate-recreation test needs the LAST registration instead.
 */
function findLastHandler<T extends (...args: never[]) => unknown>(
  onMock: MockOnFn,
  eventName: string
): T {
  const calls = onMock.mock.calls.filter((args) => args[0] === eventName);
  const call = calls.at(-1);
  if (!call) {
    throw new Error(`No handler registered for "${eventName}"`);
  }
  return call[1] as T;
}

const OPEN_PATH_CHANNEL = DESKTOP_IPC_CHANNELS.workspace.openPath;

describe('main workspace-open lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockWindowInstances = [];
    mockApp.isPackaged = false;
    getDatabaseMock.mockResolvedValue({});
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    process.env['CI'] = 'false';
    process.argv = process.argv.filter(
      (arg) =>
        arg !== '--test-mode' &&
        !arg.startsWith('--brainstrike-desktop-launch-mode') &&
        !arg.startsWith('/work/')
    );
  });

  it('registers the open-file listener at module scope, before app.whenReady() ever resolves', async () => {
    // If registration ever moved inside `app.whenReady().then(...)`, this
    // never-resolving promise would mean the `.then` callback never runs —
    // the ONLY way to discriminate "at module scope" from "asserted by name
    // only" (a whenReady that resolves immediately can't tell them apart,
    // since `await import(...)` drains microtasks either way).
    mockApp.whenReady.mockReturnValueOnce(new Promise(() => undefined));

    await import('../../main');

    expect(mockApp.on).toHaveBeenCalledWith('open-file', expect.any(Function));
  });

  it('queues an open-file request fired before the window loads, then delivers it once the window is created', async () => {
    await import('../../main');

    // Fires BEFORE any renderer is listening — the whole point of the queue.
    // Registering this handler is itself proof of module-scope registration
    // (a separate, dedicated test above pins that property against a
    // never-resolving whenReady; this test focuses on delivery).
    const openFileHandler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    const preventDefault = vi.fn();
    openFileHandler({ preventDefault }, '/Users/dev/repo');
    expect(preventDefault).toHaveBeenCalledTimes(1);

    // The window's `loadFile`/`loadURL` mock fires `did-finish-load` to
    // whichever listeners exist AT THAT MOMENT (see `simulateLoad`) — the
    // queue's attach listener is registered inside `createMainWindow`, AFTER
    // that call resolves, so delivery here can ONLY happen via the
    // `isLoading()` fallback attach. No test-driven event firing: this
    // proves production wiring, not the harness poking the code from outside.
    await vi.waitFor(() => {
      expect(latestWindow().webContents.send).toHaveBeenCalledExactlyOnceWith(OPEN_PATH_CHANNEL, {
        origin: 'open-file',
        path: '/Users/dev/repo',
      });
    });
  });

  it('second-instance argv is enqueued and delivered end to end, not just accepted by arity', async () => {
    await import('../../main');

    const secondInstanceHandler = findHandler<
      (event: unknown, argv: string[], workingDirectory: string) => void
    >(mockApp.on, 'second-instance');
    // A handler that ignores its argv (`(_e, _argv, _cwd) => {}`) would still
    // satisfy an arity check — assert the real property: the path it names
    // reaches the delivery channel.
    expect(secondInstanceHandler.length).toBeGreaterThanOrEqual(3);

    // Unpackaged (`app.isPackaged === false` in this harness) skips argv[0]
    // AND argv[1] — the same electron-binary + app-path convention as a
    // normal dev launch (folder-argv.test.ts's "skips the app-path argument
    // on an UNPACKAGED launch" case). Two throwaway entries are required
    // before the real path or `resolveFolderCandidatesFromArgv` slices it away.
    secondInstanceHandler(
      {},
      ['/node_modules/electron/dist/electron', '/repo/apps/desktop', '/work/second-instance-repo'],
      '/cwd'
    );

    await vi.waitFor(() => {
      expect(latestWindow().webContents.send).toHaveBeenCalledWith(OPEN_PATH_CHANNEL, {
        origin: 'second-instance',
        path: '/work/second-instance-repo',
      });
    });
  });

  it('enqueues and delivers a launch-argv folder exactly once', async () => {
    process.argv = [...process.argv, '/work/argv-repo'];

    await import('../../main');

    await vi.waitFor(() => {
      expect(latestWindow().webContents.send).toHaveBeenCalledExactlyOnceWith(OPEN_PATH_CHANNEL, {
        origin: 'argv',
        path: '/work/argv-repo',
      });
    });

    // A later, unrelated did-finish-load (e.g. a genuine reload) must not
    // redeliver the same request — the queue's one-shot consume, exercised
    // through the real wiring rather than the queue's own unit test.
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-finish-load');
    expect(latestWindow().webContents.send).toHaveBeenCalledTimes(1);
  });

  // Self-limiting, like the mid-reload test above: this test's assertion
  // ("nothing was sent") also holds pre-fix, but for the WRONG reason — the
  // still-broken initial attach (Critical 1) means nothing is ever sent
  // regardless of the path's shape. It falsifies the filter's removal only
  // GIVEN the attach fix; `workspace-open-queue.test.ts`'s
  // `filterDirectoryOpenCandidates` unit tests falsify the filter itself in
  // isolation, independent of any window-creation wiring.
  it('skips a FILE path delivered by open-file (macOS "Open With…") instead of forwarding it', async () => {
    statSyncMock.mockReturnValue({ isDirectory: () => false });
    await import('../../main');

    const openFileHandler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    openFileHandler({ preventDefault: vi.fn() }, '/Users/dev/document.txt');

    await vi.waitFor(() => {
      expect(latestWindow()).toBeDefined();
    });
    expect(latestWindow().webContents.send).not.toHaveBeenCalledWith(
      OPEN_PATH_CHANNEL,
      expect.anything()
    );
  });

  // This test's own falsifying power is scoped to the detach/re-attach pair
  // in ISOLATION: it correctly catches a future regression that removes
  // `did-start-loading` → `detach()` while the initial-attach wiring stays
  // correct (a target that stayed attached would deliver BEFORE the
  // reload-finished assertion below, failing the "not delivered yet" check).
  // It is not a substitute for the queue's own `detach()` unit tests
  // (`workspace-open-queue.test.ts`), which falsify the primitive without
  // depending on the surrounding window-creation wiring at all — run against
  // this file's OWN pre-fix commit, the still-broken initial attach (§3.1)
  // means nothing is ever attached to begin with, which masks this specific
  // property rather than exercising it.
  it('a request arriving mid-reload buffers via did-start-loading detach, then delivers once the reload finishes', async () => {
    await import('../../main');

    await vi.waitFor(() => {
      expect(latestWindow().webContents.on).toHaveBeenCalledWith(
        'did-start-loading',
        expect.any(Function)
      );
    });

    // Simulate a reload beginning: the renderer's WorkspaceConnectHost
    // subscription is gone until the new document re-mounts it.
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-start-loading');

    const openFileHandler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    openFileHandler({ preventDefault: vi.fn() }, '/Users/dev/mid-reload-repo');

    // Not delivered while "reloading" — sending now would hit a page with no
    // listener, exactly the loss the review flagged.
    expect(latestWindow().webContents.send).not.toHaveBeenCalledWith(
      OPEN_PATH_CHANNEL,
      expect.anything()
    );

    // The reload finishes.
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-finish-load');

    expect(latestWindow().webContents.send).toHaveBeenCalledWith(OPEN_PATH_CHANNEL, {
      origin: 'open-file',
      path: '/Users/dev/mid-reload-repo',
    });
  });

  // Self-limiting, same as the mid-reload and FILE-skip tests above: this
  // test's "not delivered" assertion also holds against the pre-Critical-1-fix
  // commit, but vacuously — nothing is ever attached there, so nothing is
  // ever sent regardless of whether `closed` -> `detach()` exists. Verified by
  // temporarily removing ONLY this `closed` handler from the real fix: exactly
  // this test fails and the other seven stay green (see the fix report).
  it('detaches on the window\'s "closed" event, not just isDestroyed() timing — a request arriving in the same tick as close is buffered rather than sent into a dying webContents', async () => {
    await import('../../main');

    await vi.waitFor(() => {
      expect(latestWindow().once).toHaveBeenCalledWith('closed', expect.any(Function));
    });

    // Between `win.close()` starting and the webContents actually being
    // destroyed, `isDestroyed()` can still report `false` for a beat — the
    // review's flagged race. Firing every `closed` listener (real Electron
    // fires them all) exercises detach() at the SAME instant as the window's
    // other teardown, rather than relying on isDestroyed() ever flipping.
    fireHandlersRegisteredSoFar(latestWindow().once, 'closed');

    const openFileHandler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    openFileHandler({ preventDefault: vi.fn() }, '/Users/dev/closed-window-repo');

    // Not delivered into the closed window — it buffers instead of being
    // spliced out and sent into a dying webContents.
    expect(latestWindow().webContents.send).not.toHaveBeenCalledWith(
      OPEN_PATH_CHANNEL,
      expect.anything()
    );
  });

  it('a request arriving after app.on(activate) recreates a destroyed window is still delivered — the primary macOS Dock-drop path', async () => {
    await import('../../main');

    await vi.waitFor(() => {
      expect(mockWindowInstances).toHaveLength(1);
    });
    // Simulate the user closing the only window: it is destroyed, and
    // `BrowserWindow.getAllWindows()` (mocked to `[]`) reports none open —
    // matching `app.on('activate')`'s own `hasVisibleWindow` check.
    mockWindowInstances[0]?.webContents.isDestroyed.mockReturnValue(true);

    // Anchor `findLastHandler`'s "last registration wins" assumption to a
    // durable count rather than trusting registration order silently: exactly
    // TWO `'activate'` listeners should exist by now — `create-window.ts`'s
    // per-window crash-recovery handler (registered first) and `main.ts`'s
    // own window-recreation handler (registered second, the one this test
    // needs). If a THIRD listener is ever added anywhere, this assertion
    // fails here, at the actual cause, instead of surfacing as a baffling
    // "window was never recreated" failure further down.
    const activateRegistrations = mockApp.on.mock.calls.filter((args) => args[0] === 'activate');
    expect(activateRegistrations).toHaveLength(2);

    const activateHandler = findLastHandler<() => Promise<void>>(mockApp.on, 'activate');
    await activateHandler();

    expect(mockWindowInstances).toHaveLength(2);

    const openFileHandler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    openFileHandler({ preventDefault: vi.fn() }, '/Users/dev/dock-drop-repo');

    await vi.waitFor(() => {
      expect(latestWindow().webContents.send).toHaveBeenCalledWith(OPEN_PATH_CHANNEL, {
        origin: 'open-file',
        path: '/Users/dev/dock-drop-repo',
      });
    });
    // Delivery went to the NEW window, never the destroyed one — proves the
    // queue re-attached rather than merely never having been detached.
    expect(mockWindowInstances[0]?.webContents.send).not.toHaveBeenCalled();
  });
});
