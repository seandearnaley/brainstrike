import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';

/**
 * BST-1393 Layer 3: argv / macOS `open-file` / `second-instance` all funnel
 * into the SAME `workspace-open-queue`, which holds requests until a
 * renderer is listening and then delivers them over `workspace:open-path`.
 * This harness mirrors `boot-order.test.ts`'s mock shape (read at HEAD) —
 * see that file's own header comment for the "Vitest 4 constructor mock"
 * pattern this reuses — with one deliberate departure documented at
 * `simulateLoad` below: `loadFile`/`loadURL` must fire the load events to the
 * listeners registered AT THE MOMENT they are called, not to whichever
 * listener the test manually invokes after the fact. The first version of
 * this file did the latter and passed against code that never attached the
 * queue in production (L3 review 2026-08-27) — a mock that resolves the load
 * promise without ever emitting the event it is named for hides exactly the
 * ordering bug the review found.
 *
 * Attach now requires TWO independent conditions (PR #2682 review):
 * `did-stop-loading` (NOT `did-finish-load`, which is main-frame-only and
 * would miss a subframe-only load) AND an explicit renderer-ready ping over
 * `ipcMain`. Every test that expects a delivery must therefore both let the
 * window finish loading AND call `sendReadyPing` — see that helper below.
 */

const mockSession = {
  defaultSession: {
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
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
function fireHandlersRegisteredSoFar(
  onMock: MockOnFn,
  eventName: string,
  args: readonly unknown[] = []
): void {
  const handlers = onMock.mock.calls
    .filter((call) => call[0] === eventName)
    .map((call) => call[1] as (...handlerArgs: unknown[]) => void);
  for (const handler of handlers) {
    handler(...args);
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
    readonly id: number;
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

// Real Electron `WebContents.id`s are unique per instance — main.ts's ready-
// ping handler routes on `event.sender.id`, so the mock must give each
// window a DISTINCT id too, or the activate-recreation test (and any other
// two-window scenario) would silently collide on the same map key.
let nextMockWebContentsId = 1;

function createMockWindowInstance(): MockWindowInstance {
  const webContents = {
    id: nextMockWebContentsId++,
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
  // `did-stop-loading` follows it (the WebContents-level "spinner stopped"
  // event, always fired — main.ts's attach trigger, per the PR #2682 review:
  // `did-finish-load` is main-frame-only and would miss a subframe load).
  const simulateLoad = () => {
    fireHandlersRegisteredSoFar(webContents.on, 'did-finish-load');
    fireHandlersRegisteredSoFar(webContents.on, 'did-stop-loading');
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
  Object.assign(this, instance);
  // Push the CONSTRUCTED window (`this`), not the template object: they share
  // every mock-function reference, so all existing assertions behave
  // identically — but only `this` is the object `main.ts` actually holds,
  // which lets the destroyed-webContents regression test below redefine
  // `webContents` as a throwing getter the production `closed` handlers see.
  mockWindowInstances.push(this as unknown as MockWindowInstance);
});
Object.assign(mockBrowserWindow, {
  getAllWindows: vi.fn(() => []),
  // Null on purpose: the app under a harness is never the OS-active
  // application, so the focused-window FALLBACK must not be what routes a
  // menu push — the explicit click-handler window is (see the
  // File-menu routing test below).
  getFocusedWindow: vi.fn(() => null),
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
  setPath: vi.fn(),
  whenReady: vi.fn(() => Promise.resolve()),
};

const mockIpcMain = {
  handle: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
};

vi.mock('electron', () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  clipboard: { writeText: vi.fn() },
  ipcMain: mockIpcMain,
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
    mkdirSync: vi.fn(),
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
const OPEN_PATH_READY_CHANNEL = DESKTOP_IPC_CHANNELS.workspace.openPathReady;

/**
 * Fires EVERY registered `openPathReady` handler with `{ sender: win.webContents }`
 * — modeling `ipcMain`'s real dispatch (every listener for the channel runs;
 * `main.ts`'s own `event.sender !== win.webContents` guard is what decides
 * relevance), rather than assuming which registration belongs to `win`. Every
 * `createMainWindow()` call (initial launch, each `activate` recreation)
 * registers its own handler and never removes it until `closed`, so more than
 * one can be live at once.
 */
function sendReadyPing(win: MockWindowInstance): void {
  const handlers = mockIpcMain.on.mock.calls
    .filter((args) => args[0] === OPEN_PATH_READY_CHANNEL)
    .map(
      (args) =>
        args[1] as (
          event: { sender: unknown; senderFrame: unknown },
          payload: { resetGeneration: null }
        ) => void
    );
  for (const handler of handlers) {
    handler({ sender: win.webContents, senderFrame: {} }, { resetGeneration: null });
  }
}

/**
 * Fires every registered `did-start-navigation` handler with Electron's modern
 * details-object signature. Supplying no deprecated positional args makes
 * this harness fail if `main.ts` still reads `isInPlace` / `isMainFrame` from
 * positions 3 and 4. This listener is the ONLY thing that resets
 * `rendererReady` (never `did-start-loading` alone; see the PR #2682 re-review
 * this whole file is built around).
 */
function fireDidStartNavigation(
  onMock: MockOnFn,
  isMainFrame: boolean,
  isSameDocument = false
): void {
  fireHandlersRegisteredSoFar(onMock, 'did-start-navigation', [{ isMainFrame, isSameDocument }]);
}

// Captured once at module load, before any test mutates it (see beforeEach).
const REAL_PROCESS_ARGV = process.argv;

describe('main workspace-open lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockWindowInstances = [];
    isDesktopShuttingDownMock.mockReturnValue(false);
    mockApp.isPackaged = false;
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ isDirectory: () => true });
    process.env['CI'] = 'false';
    // The RUNTIME dev-launch shape (`electron <app-dir>`), not the vitest
    // worker's own argv: the app-dir positional resolves to the mocked
    // `app.getAppPath()` and is dropped by IDENTITY (BST-1393 L5). The old
    // harness left the real worker argv in place and relied on the parser's
    // former positional `slice(2)` to hide `…/vitest/dist/workers/forks.js`
    // — a fixture accident, not a runtime shape.
    process.argv = ['/node_modules/electron/dist/electron', '/mock/app'];
  });

  afterEach(() => {
    // process.argv is process-global and this fork worker runs other test
    // files after this one — never leak the mocked launch shape to them.
    process.argv = REAL_PROCESS_ARGV;
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

    // The window's `loadFile`/`loadURL` mock fires the load events to
    // whichever listeners exist AT THAT MOMENT (see `simulateLoad`) — the
    // queue's attach listener is registered inside `createMainWindow`, AFTER
    // that call resolves, so `loadFinished` here can ONLY become true via the
    // `isLoading()` fallback. No test-driven event firing for THIS half: this
    // proves production wiring, not the harness poking the code from outside.
    await vi.waitFor(() => {
      expect(mockWindowInstances).toHaveLength(1);
    });
    // Not delivered yet: the window finished loading, but
    // `WorkspaceConnectHost` has not pinged ready.
    expect(latestWindow().webContents.send).not.toHaveBeenCalled();

    sendReadyPing(latestWindow());

    expect(latestWindow().webContents.send).toHaveBeenCalledExactlyOnceWith(OPEN_PATH_CHANNEL, {
      origin: 'open-file',
      path: '/Users/dev/repo',
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

    // The Chromium-REORDERED delivery shape captured live (BST-1393 L5):
    // switches — including ones Chromium injects itself — are regrouped
    // AHEAD of positionals, so the `electron .` app-path argument arrives at
    // an arbitrary index. Unpackaged (`app.isPackaged === false` in this
    // harness) drops it by IDENTITY against the mocked `app.getAppPath()`
    // ('/mock/app'), never by position — folder-argv.test.ts pins the parse;
    // this pins the delivery wiring.
    secondInstanceHandler(
      {},
      [
        '/node_modules/electron/dist/electron',
        '--no-sandbox',
        '--allow-file-access-from-files',
        '/mock/app',
        resolve('/work/second-instance-repo'),
      ],
      '/cwd'
    );

    await vi.waitFor(() => {
      expect(mockWindowInstances).toHaveLength(1);
    });
    sendReadyPing(latestWindow());

    expect(latestWindow().webContents.send).toHaveBeenCalledWith(OPEN_PATH_CHANNEL, {
      origin: 'second-instance',
      path: resolve('/work/second-instance-repo'),
    });
  });

  it('does not enqueue or show a second-instance request after renderer shutdown begins', async () => {
    await import('../../main');
    await vi.waitFor(() => expect(mockWindowInstances).toHaveLength(1));
    const window = latestWindow();
    sendReadyPing(window);
    window.show.mockClear();
    window.webContents.send.mockClear();
    isDesktopShuttingDownMock.mockReturnValue(true);
    const secondInstanceHandler = findHandler<
      (event: unknown, argv: string[], workingDirectory: string) => void
    >(mockApp.on, 'second-instance');
    secondInstanceHandler({}, ['/electron', '/mock/app', '/work/late-repo'], '/cwd');
    expect(window.webContents.send).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
  });

  it('does not recreate a window on activate after renderer shutdown begins', async () => {
    await import('../../main');
    await vi.waitFor(() => expect(mockWindowInstances).toHaveLength(1));
    latestWindow().webContents.isDestroyed.mockReturnValue(true);
    isDesktopShuttingDownMock.mockReturnValue(true);
    const activateRegistrations = mockApp.on.mock.calls.filter((args) => args[0] === 'activate');
    expect(activateRegistrations).toHaveLength(2);

    const activateHandler = findLastHandler<() => Promise<void>>(mockApp.on, 'activate');
    await activateHandler();

    expect(mockWindowInstances).toHaveLength(1);
  });

  it('does not deliver an open-file request after renderer shutdown begins', async () => {
    await import('../../main');
    await vi.waitFor(() => expect(mockWindowInstances).toHaveLength(1));
    const window = latestWindow();
    sendReadyPing(window);
    window.webContents.send.mockClear();
    isDesktopShuttingDownMock.mockReturnValue(true);
    const handler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    const preventDefault = vi.fn();
    handler({ preventDefault }, '/work/late-repo');
    expect(preventDefault).toHaveBeenCalledExactlyOnceWith();
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it('enqueues and delivers a launch-argv folder exactly once', async () => {
    process.argv = [...process.argv, resolve('/work/argv-repo')];

    await import('../../main');

    await vi.waitFor(() => {
      expect(mockWindowInstances).toHaveLength(1);
    });
    sendReadyPing(latestWindow());

    expect(latestWindow().webContents.send).toHaveBeenCalledExactlyOnceWith(OPEN_PATH_CHANNEL, {
      origin: 'argv',
      path: resolve('/work/argv-repo'),
    });

    // A later, unrelated MAIN-FRAME reload (did-start-loading +
    // did-start-navigation → did-stop-loading → a fresh ready ping) must not
    // redeliver the same already-consumed request — the queue's one-shot
    // consume, exercised through the real wiring rather than the queue's own
    // unit test.
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-start-loading');
    fireDidStartNavigation(latestWindow().webContents.on, true);
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-stop-loading');
    sendReadyPing(latestWindow());
    // Scoped to the open-path channel specifically: a real main-frame
    // navigation ALSO fires `browser-pane-host.ts`'s own `did-start-navigation`
    // listener, which disposes the pane and pushes an unrelated
    // `browser:tabsChanged` event through the same `webContents.send` mock —
    // asserting a bare call COUNT here would conflate that with a redelivery.
    const openPathSends = latestWindow().webContents.send.mock.calls.filter(
      (call) => call[0] === OPEN_PATH_CHANNEL
    );
    expect(openPathSends).toHaveLength(1);
  });

  // Self-limiting, like the mid-reload test below, though by a DIFFERENT
  // mechanism: this test never manually fires an event at all, so its
  // "nothing was sent" assertion holds pre-fix too, but only because the
  // still-broken initial attach (Critical 1) means nothing is EVER sent,
  // regardless of the path's shape — it cannot discriminate the filter's
  // removal from the attach bug. `workspace-open-queue.test.ts`'s
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

  // Self-limiting: this test manually fires the events the production wiring
  // depends on, so it cannot discriminate their EXISTENCE — the queue's own
  // unit tests do that in isolation (`workspace-open-queue.test.ts`'s
  // `detach()` cases). What it DOES pin, faithfully: the ORDER and the
  // ready-ping gate — a request enqueued between `did-start-loading` and the
  // reload's `did-stop-loading` stays buffered, and even once the reload's
  // document reports "stopped", delivery still waits on a FRESH ready ping
  // (the old one was reset, not carried over from before the reload).
  it('a request arriving mid-reload buffers via did-start-loading detach, then delivers only once a MAIN-FRAME reload BOTH stops loading AND re-pings ready', async () => {
    await import('../../main');

    await vi.waitFor(() => {
      expect(mockWindowInstances).toHaveLength(1);
    });
    sendReadyPing(latestWindow());

    // Simulate a REAL reload beginning: `did-start-loading` (WebContents-level,
    // fires for any frame) fires alongside `did-start-navigation` with
    // `isMainFrame: true, isSameDocument: false` — the top-level document is about
    // to be replaced, tearing down `WorkspaceConnectHost`'s subscription with
    // it. ONLY this combination should reset `rendererReady` (see the
    // subframe-cycle test below for the contrasting case that must NOT).
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-start-loading');
    fireDidStartNavigation(latestWindow().webContents.on, true);

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

    // The reload's document stops loading — NOT enough on its own, since the
    // reset ready flag has not been re-pinged yet.
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-stop-loading');
    expect(latestWindow().webContents.send).not.toHaveBeenCalledWith(
      OPEN_PATH_CHANNEL,
      expect.anything()
    );

    // The reloaded document's WorkspaceConnectHost re-subscribes and re-pings.
    sendReadyPing(latestWindow());

    expect(latestWindow().webContents.send).toHaveBeenCalledWith(OPEN_PATH_CHANNEL, {
      origin: 'open-file',
      path: '/Users/dev/mid-reload-repo',
    });
  });

  it('a subframe-only load cycle (did-start-loading + did-stop-loading, NO re-ping) still delivers on the ALREADY-VALID ready ping', async () => {
    // The regression this pins is the SECOND Critical the re-review found:
    // an earlier version of this fix reset `rendererReady` on EVERY
    // `did-start-loading`, which is WebContents-level and fires for ANY
    // frame — including the canvas surface's real `<iframe>`
    // (`canvas-frame.tsx`, whose `src` changes with the nonce every time an
    // artifact opens or re-keys). `WorkspaceConnectHost`'s ready-ping effect
    // depends only on `[connectPath]`, so it NEVER re-fires for a subframe
    // navigation — resetting `rendererReady` there was UNRECOVERABLE:
    // `did-stop-loading` would restore `loadFinished`, but with no second
    // ready ping ever coming, the queue stayed permanently detached. Same
    // end state as the ORIGINAL Critical 2, reached through the new flag.
    //
    // The falsifying shape, deliberately: ready is pinged ONCE, up front,
    // and NEVER again — if `rendererReady` survives the whole subframe cycle
    // below, delivery works using that one ping. If anything in the cycle
    // silently clears it, delivery is lost forever (this test times out /
    // fails, and nothing here would ever re-ping to rescue it).
    await import('../../main');

    await vi.waitFor(() => {
      expect(mockWindowInstances).toHaveLength(1);
    });
    sendReadyPing(latestWindow());

    // A subframe navigation: `did-start-loading` fires (WebContents-level,
    // any frame) and `did-start-navigation` fires too, but with
    // `isMainFrame: false` — main.ts's guard must leave `rendererReady`
    // untouched. The subframe's own completion would emit
    // `did-frame-finish-load` (an event nothing here listens for), NOT
    // `did-finish-load` — modeled by simply never firing it.
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-start-loading');
    fireDidStartNavigation(latestWindow().webContents.on, false);

    const openFileHandler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    openFileHandler({ preventDefault: vi.fn() }, '/Users/dev/subframe-repo');
    expect(latestWindow().webContents.send).not.toHaveBeenCalledWith(
      OPEN_PATH_CHANNEL,
      expect.anything()
    );

    // did-stop-loading DOES fire once Chromium's overall loading state
    // clears — the falsifier for a did-finish-load-only pairing (§1). NO
    // re-ping follows: delivery must land on the ready state from BEFORE
    // this whole cycle, which the guard was supposed to leave intact (§2).
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-stop-loading');

    expect(latestWindow().webContents.send).toHaveBeenCalledWith(OPEN_PATH_CHANNEL, {
      origin: 'open-file',
      path: '/Users/dev/subframe-repo',
    });
  });

  it('gates delivery on BOTH load-finished and the ready ping, independently: neither alone attaches', async () => {
    await import('../../main');

    await vi.waitFor(() => {
      expect(mockWindowInstances).toHaveLength(1);
    });

    const openFileHandler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    openFileHandler({ preventDefault: vi.fn() }, '/Users/dev/ready-gate-repo');

    // Load already finished (via `simulateLoad` inside window creation), but
    // no ready ping yet — must NOT deliver.
    expect(latestWindow().webContents.send).not.toHaveBeenCalledWith(
      OPEN_PATH_CHANNEL,
      expect.anything()
    );

    // The ready ping alone completes the gate (load-finished was already true).
    sendReadyPing(latestWindow());

    expect(latestWindow().webContents.send).toHaveBeenCalledWith(OPEN_PATH_CHANNEL, {
      origin: 'open-file',
      path: '/Users/dev/ready-gate-repo',
    });
  });

  it('gates delivery correctly when the ready ping arrives BEFORE did-stop-loading, the opposite ordering from the test above', async () => {
    await import('../../main');

    await vi.waitFor(() => {
      expect(mockWindowInstances).toHaveLength(1);
    });
    // Get back to a "loading" state via a main-frame reload, so the window
    // is not already both loaded AND ready by construction (as it is right
    // after initial boot).
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-start-loading');
    fireDidStartNavigation(latestWindow().webContents.on, true);

    // The ready ping arrives FIRST, while the reload is still in flight.
    sendReadyPing(latestWindow());

    const openFileHandler = findHandler<(event: { preventDefault: () => void }, p: string) => void>(
      mockApp.on,
      'open-file'
    );
    openFileHandler({ preventDefault: vi.fn() }, '/Users/dev/ready-before-stop-repo');

    // rendererReady is true, but loadFinished is not — must NOT deliver yet.
    expect(latestWindow().webContents.send).not.toHaveBeenCalledWith(
      OPEN_PATH_CHANNEL,
      expect.anything()
    );

    // did-stop-loading completes the gate from the OTHER side.
    fireHandlersRegisteredSoFar(latestWindow().webContents.on, 'did-stop-loading');

    expect(latestWindow().webContents.send).toHaveBeenCalledWith(OPEN_PATH_CHANNEL, {
      origin: 'open-file',
      path: '/Users/dev/ready-before-stop-repo',
    });
  });

  // Self-limiting like the FILE-skip test above (a DIFFERENT mechanism than
  // the mid-reload test, which manually fires the mis-ordered event to make
  // delivery land pre-fix): this test never needs a delivery to land, so its
  // "not delivered" assertion also holds against the pre-Critical-1-fix
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
    sendReadyPing(latestWindow());

    expect(latestWindow().webContents.send).toHaveBeenCalledWith(OPEN_PATH_CHANNEL, {
      origin: 'open-file',
      path: '/Users/dev/dock-drop-repo',
    });
    // Delivery went to the NEW window, never the destroyed one — proves the
    // queue re-attached rather than merely never having been detached.
    expect(mockWindowInstances[0]?.webContents.send).not.toHaveBeenCalled();
  });

  it('no "closed" handler dereferences win.webContents after destruction — the teardown "Object has been destroyed" exception (BST-1393 L5 e2e finding)', async () => {
    await import('../../main');

    await vi.waitFor(() => {
      expect(latestWindow().once).toHaveBeenCalledWith('closed', expect.any(Function));
    });

    const win = latestWindow();
    // Real Electron: once a window has emitted `closed`, its `webContents`
    // GETTER itself throws "Object has been destroyed". The live e2e run
    // surfaced exactly that as an uncaught main-process exception from the
    // ready-callback map's cleanup handler, which read `win.webContents.id`
    // inside `closed` instead of capturing the id at registration time.
    // Both halves of Electron's post-close contract must be simulated
    // together: `isDestroyed()` reports true AND the `webContents` getter
    // throws. Simulating only the throwing getter mislabels handlers that
    // are correctly guarded by `isDestroyed()` (browser-pane dispose) while
    // the actually-unguarded one hides behind them.
    win.isDestroyed.mockReturnValue(true);
    Object.defineProperty(win, 'webContents', {
      configurable: true,
      get() {
        throw new TypeError('Object has been destroyed');
      },
    });

    expect(() => fireHandlersRegisteredSoFar(win.once, 'closed')).not.toThrow();
  });

  it('routes a File-menu click to the EXPLICIT click-handler window while getFocusedWindow() is null — the wiring seam where the original silent no-op lived', async () => {
    await import('../../main');

    const { Menu } = await import('electron');
    const buildFromTemplate = vi.mocked(Menu.buildFromTemplate);
    // The application menu is (re)built inside app.whenReady — wait for a
    // template that carries the File submenu's open-folder item.
    const findOpenFolderItem = (): Electron.MenuItemConstructorOptions | null => {
      for (const [template] of buildFromTemplate.mock.calls) {
        for (const entry of template ?? []) {
          const submenu = Array.isArray(entry.submenu) ? entry.submenu : [];
          const item = submenu.find((row) => row.id === 'file-open-folder');
          if (item) {
            return item;
          }
        }
      }
      return null;
    };
    await vi.waitFor(() => {
      expect(findOpenFolderItem()).not.toBeNull();
      expect(mockWindowInstances).toHaveLength(1);
    });

    const win = latestWindow();
    // `application-file-menu.test.ts` proves the menu module FORWARDS the
    // click-handler window and the e2e proves the end-to-end effect; this
    // pins the layer in between — main.ts's pushToMenuTargetWindow actually
    // USES the forwarded window rather than the focused-window fallback,
    // which the mock keeps null (exactly the harness/programmatic-click
    // state where the original implementation was a silent no-op). The mock
    // constructor pushes `this`, so `win instanceof BrowserWindow` holds.
    findOpenFolderItem()?.click?.(
      {} as Electron.MenuItem,
      win as unknown as Electron.BaseWindow,
      {} as Electron.KeyboardEvent
    );

    expect(win.webContents.send).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.workspace.openFolderPicker,
      undefined
    );
  });
});
