import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_IPC_CHANNELS } from '../../platform/desktop-ipc-channels';
import type {
  DesktopIpcChannelRegistration,
  DesktopIpcRegistry,
} from '../../platform/desktop-ipc-registry';
import type { Contract } from '../../platform/ipc-contract';
import { MANUAL_PRODUCTION_REGISTRATIONS } from '../helpers/manual-ipc-inventory';

/**
 * BST-1648 step 5 — the GLOBAL IPC manifest test. `createDesktopIpcRegistry`
 * guards duplicate channels per INSTANCE only; production composes ~38
 * per-domain instances (no global singleton, by ruling), so two domains
 * registering the same channel would only collide at `ipcMain.handle` time
 * in a live app. This harness boots the real `main.ts` — module-scope
 * registrations AND the `app.whenReady()` block through window creation
 * (mcp → main-platform → browser is the last registration) — under the
 * `workspace-open-lifecycle.test.ts` mock shape, wraps the registry factory
 * so every instance is captured, and asserts over `union(getSnapshot())`,
 * the snapshot's first production-shaped consumer:
 *   1. no channel is registered by two instances (the restored global guard);
 *   2. every invoke spec of every `ipc-domains/*.contract.ts` (discovered by
 *      glob, so a migrated domain is covered without editing this file) is
 *      registered, and no push spec ever is;
 *   3. every registered channel is a `DESKTOP_IPC_CHANNELS` manifest literal.
 * RED-proven against a duplicate second-instance registration, a contract
 * domain main.ts never registers, and a non-manifest channel literal.
 */
const registryCapture = vi.hoisted(() => ({
  instances: [] as { getSnapshot: () => readonly DesktopIpcChannelRegistration[] }[],
}));
const profileStartup = vi.hoisted(() => ({
  acquire: vi.fn<() => Promise<never>>(),
  events: [] as string[],
}));

vi.mock('../../native-index-activation', async () => {
  const actual = await vi.importActual<typeof import('../../native-index-activation')>(
    '../../native-index-activation'
  );
  return {
    ...actual,
    createNativeIndexActivation: (
      ...args: Parameters<typeof actual.createNativeIndexActivation>
    ) => ({
      ...actual.createNativeIndexActivation(...args),
      acquireProfile: profileStartup.acquire,
    }),
  };
});

vi.mock('../../platform/desktop-ipc-registry', async () => {
  const actual = await vi.importActual<typeof import('../../platform/desktop-ipc-registry')>(
    '../../platform/desktop-ipc-registry'
  );
  return {
    ...actual,
    createDesktopIpcRegistry: (
      options: Parameters<typeof actual.createDesktopIpcRegistry>[0]
    ): DesktopIpcRegistry => {
      const registry = actual.createDesktopIpcRegistry(options);
      registryCapture.instances.push(registry);
      return registry;
    },
  };
});

// ---- electron + module mocks: the workspace-open-lifecycle harness shape ----
const mockSession = {
  defaultSession: {
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: { onHeadersReceived: vi.fn() },
  },
  fromPartition: vi.fn(() => ({
    clearStorageData: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
  })),
};

type MockOnFn = ReturnType<typeof vi.fn>;

function fireHandlersRegisteredSoFar(onMock: MockOnFn, eventName: string): void {
  const handlers = onMock.mock.calls
    .filter((call) => call[0] === eventName)
    .map((call) => call[1] as () => void);
  for (const handler of handlers) {
    handler();
  }
}

let nextMockWebContentsId = 1;
let mockWindowCount = 0;

// Use function syntax for Vitest 4 constructor mocks
const mockBrowserWindow = vi.fn();
mockBrowserWindow.mockImplementation(function (this: Record<string, unknown>) {
  profileStartup.events.push('window');
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
  const simulateLoad = () => {
    fireHandlersRegisteredSoFar(webContents.on, 'did-finish-load');
    fireHandlersRegisteredSoFar(webContents.on, 'did-stop-loading');
    return Promise.resolve();
  };
  Object.assign(this, {
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
  });
  mockWindowCount += 1;
});
Object.assign(mockBrowserWindow, {
  getAllWindows: vi.fn(() => []),
  getFocusedWindow: vi.fn(() => null),
});

const mockApp = {
  commandLine: { appendSwitch: vi.fn() },
  getAppMetrics: vi.fn(() => []),
  getAppPath: vi.fn(() => path.resolve('/mock/app')),
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
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  powerMonitor: { on: vi.fn() },
  powerSaveBlocker: { isStarted: vi.fn(() => true), start: vi.fn(() => 1), stop: vi.fn() },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  screen: {
    getAllDisplays: vi.fn(() => [{ workArea: { height: 800, width: 1536, x: 0, y: 0 } }]),
  },
  session: mockSession,
  shell: { openPath: vi.fn().mockResolvedValue(''), showItemInFolder: vi.fn() },
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
  return { ...actual, createLogger: createLoggerMock };
});

vi.mock('../../window-state', async () => {
  const actual = await vi.importActual<typeof import('../../window-state')>('../../window-state');
  return {
    ...actual,
    readStoredWindowState: vi.fn(() => null),
    registerWindowStatePersistence: vi.fn(() => vi.fn()),
  };
});

vi.mock('electron-store', () => {
  const MockElectronStore = vi.fn();
  MockElectronStore.mockImplementation(function (this: Record<string, unknown>) {
    Object.assign(this, {});
  });
  return { default: MockElectronStore };
});

const { getDatabaseMock } = vi.hoisted(() => ({ getDatabaseMock: vi.fn() }));
vi.mock('../../db-main', async () => {
  const actual = await vi.importActual<typeof import('../../db-main')>('../../db-main');
  return { ...actual, getDatabase: getDatabaseMock };
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
  return { ...actual, probeDimensionIndexRuntimeCapabilities: probeMock };
});

vi.mock('../../database-maintenance-scheduler', () => ({
  createDesktopDatabaseMaintenanceScheduler: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));
vi.mock('../../dimension-index-maintenance-scheduler', () => ({
  createDesktopDimensionIndexMaintenanceScheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

// ---- contract + manifest discovery ----

const CONTRACT_MODULES = import.meta.glob<Record<string, unknown>>(
  '../../ipc-domains/*.contract.ts',
  { eager: true }
);

interface DiscoveredContract {
  readonly contract: Contract;
  readonly exportName: string;
  readonly file: string;
}

function isContract(value: unknown): value is Contract {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const specs = Object.values(value);
  return (
    specs.length > 0 &&
    specs.every(
      (spec) =>
        typeof spec === 'object' &&
        spec !== null &&
        typeof (spec as { channel?: unknown }).channel === 'string' &&
        ((spec as { kind?: unknown }).kind === 'invoke' ||
          (spec as { kind?: unknown }).kind === 'push')
    )
  );
}

function discoverContracts(): DiscoveredContract[] {
  const discovered: DiscoveredContract[] = [];
  for (const [file, module] of Object.entries(CONTRACT_MODULES)) {
    for (const [exportName, value] of Object.entries(module)) {
      if (isContract(value)) {
        // Database query/live/integrity protocols are retired on desktop; the
        // profile-path contract remains public. Assert their absence separately.
        if (
          path.basename(file) === 'database.contract.ts' &&
          exportName !== 'databasePathContract'
        ) {
          continue;
        }
        discovered.push({ contract: value, exportName, file: path.basename(file) });
      }
    }
  }
  return discovered.sort((left, right) => left.file.localeCompare(right.file));
}

function flattenManifest(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    out.add(value);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) {
      flattenManifest(nested, out);
    }
  }
  return out;
}

const REAL_PROCESS_ARGV = process.argv;

describe('global desktop IPC manifest (BST-1648 step 5)', () => {
  let union: DesktopIpcChannelRegistration[] = [];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    registryCapture.instances = [];
    profileStartup.events = [];
    profileStartup.acquire.mockImplementation(() => {
      profileStartup.events.push('profile');
      return new Promise<never>(() => undefined);
    });
    mockWindowCount = 0;
    getDatabaseMock.mockResolvedValue({});
    process.env['CI'] = 'false';
    process.argv = ['/node_modules/electron/dist/electron', '/mock/app'];

    await import('../../main');
    // The ready block registers mcp → main-platform → (createMainWindow)
    // browser last; the window's construction is the "boot finished" signal.
    await vi.waitFor(() => {
      expect(mockWindowCount).toBe(1);
      expect(
        registryCapture.instances.flatMap((registry) => registry.getSnapshot())
      ).toContainEqual(expect.objectContaining({ channel: DESKTOP_IPC_CHANNELS.browser.listTabs }));
    });
    union = registryCapture.instances.flatMap((registry) => [...registry.getSnapshot()]);
  });

  afterEach(() => {
    process.argv = REAL_PROCESS_ARGV;
  });

  it('boots the full per-domain registry set (module scope + app.whenReady())', () => {
    expect(registryCapture.instances.length).toBeGreaterThanOrEqual(30);
    expect(union.map((entry) => entry.channel)).toEqual(
      expect.arrayContaining([
        DESKTOP_IPC_CHANNELS.clipboard.writeText,
        DESKTOP_IPC_CHANNELS.mcp.configSelectPath,
        DESKTOP_IPC_CHANNELS.browser.listTabs,
      ])
    );
  });

  it('starts the shared host profile before the renderer without waiting for host readiness', () => {
    // M3 startup waited for the renderer's first thread request to launch its
    // host, putting utility startup after the visible shell's own startup.
    expect(profileStartup.acquire).toHaveBeenCalledTimes(3);
    expect(profileStartup.acquire.mock.calls).toEqual([[], [], []]);
    // Startup, root catalog and host log readers borrow the same owner.
    expect(profileStartup.events).toEqual(['profile', 'profile', 'profile', 'window']);
  });

  it('registers every channel on exactly one registry instance (the global duplicate guard)', () => {
    const counts = new Map<string, number>();
    for (const registration of union) {
      counts.set(registration.channel, (counts.get(registration.channel) ?? 0) + 1);
    }
    const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
    expect(duplicates).toEqual([]);
  });

  it('does not register retired SQL, queue or integrity invokes', () => {
    const retired = new Set<string>([
      DESKTOP_IPC_CHANNELS.db.query,
      DESKTOP_IPC_CHANNELS.db.exec,
      DESKTOP_IPC_CHANNELS.db.liveQueryStart,
      DESKTOP_IPC_CHANNELS.db.liveQueryStop,
      DESKTOP_IPC_CHANNELS.db.integrityState,
      // The retired embedding backfill bridge (BST-2023): neither side may return.
      'embedding-host:enqueue-backfill',
      'embedding-host:cancel-backfill',
      'embedding-host:cancel-all-backfills',
      'embedding-host:get-backfills-in-flight',
    ]);
    expect(union.filter((entry) => retired.has(entry.channel))).toEqual([]);
  });

  it('exposes no preload channel that main does not handle (BST-2023)', async () => {
    // A bridge method over an unregistered channel rejects "No handler registered" only
    // when a renderer calls it; this keeps every preload invoke and send backed by Main.
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const groups = DESKTOP_IPC_CHANNELS as unknown as Record<string, Record<string, unknown>>;
    const expected = ['preload.ts', 'hidden-preload.ts'].flatMap((file) =>
      [
        ...readFileSync(path.resolve(import.meta.dirname, '../..', file), 'utf8').matchAll(
          /ipcRenderer\.(invoke|send)\(\s*DESKTOP_IPC_CHANNELS\.(\w+)\.(\w+)/g
        ),
      ].map(([, method, group = '', name = '']) => ({
        channel: String(groups[group]?.[name] ?? `${group}.${name}`),
        file,
        kind: method === 'invoke' ? 'invoke' : 'event',
      }))
    );
    expect(expected.length).toBeGreaterThan(50);
    // Preload and Main both gate these on E2E test mode, which this boot is not.
    const e2eOnly = new Set<string>([
      DESKTOP_IPC_CHANNELS.storage.clearAllForE2e,
      DESKTOP_IPC_CHANNELS.storage.seedMainOwnedForE2e,
    ]);
    const registered = new Set([
      ...union.map(({ channel, kind }) => `${kind} ${channel}`),
      ...[...e2eOnly].map((channel) => `invoke ${channel}`),
    ]);
    expect(expected.filter(({ channel, kind }) => !registered.has(`${kind} ${channel}`))).toEqual(
      []
    );
  });

  it('registers every contract invoke channel exactly once, as an invoke, and never a push event', () => {
    const contracts = discoverContracts();
    expect([...new Set(contracts.map(({ file }) => file))]).toEqual([
      'changes.contract.ts',
      'clipboard.contract.ts',
      'collection-catalog.contract.ts',
      'command-sessions.contract.ts',
      'content-clear.contract.ts',
      'context-files.contract.ts',
      'database.contract.ts',
      'factory-reset.contract.ts',
      'file-system.contract.ts',
      'forge.contract.ts',
      'git.contract.ts',
      'index-search.contract.ts',
      'mcp.contract.ts',
      'model-catalog.contract.ts',
      'notes-vault.contract.ts',
      'prompt-library.contract.ts',
      'skills.contract.ts',
      'source-files.contract.ts',
      'storage-preferences.contract.ts',
      'terminal.contract.ts',
      'thread-groups.contract.ts',
      'user-commands.contract.ts',
      'user-personas.contract.ts',
      'view-filter-presets.contract.ts',
      'window-focus.contract.ts',
      'worktrees.contract.ts',
    ]);
    expect(contracts.filter(({ file }) => file === 'database.contract.ts')).toHaveLength(1);
    expect(contracts.filter(({ file }) => file === 'file-system.contract.ts')).toHaveLength(2);
    expect(contracts.filter(({ file }) => file === 'mcp.contract.ts')).toHaveLength(2);
    expect(contracts.filter(({ file }) => file === 'storage-preferences.contract.ts')).toHaveLength(
      4
    );
    const registeredInvokes = new Map(
      union.filter((entry) => entry.kind === 'invoke').map((entry) => [entry.channel, entry])
    );
    for (const { contract, exportName } of contracts) {
      for (const [key, spec] of Object.entries(contract)) {
        if (spec.kind === 'push') {
          expect(
            union.map((entry) => entry.channel),
            `${exportName}.${key}`
          ).not.toContain(spec.channel);
          continue;
        }
        expect(registeredInvokes.get(spec.channel), `${exportName}.${key}`).toBeDefined();
      }
    }
  });

  it('matches the contract registry plus the explicit manual production inventory exactly', () => {
    const contractRegistrations = [
      ...new Map(
        discoverContracts()
          .flatMap(({ contract }) => Object.values(contract))
          .filter((spec) => spec.kind === 'invoke')
          .map((spec) => [spec.channel, { channel: spec.channel, kind: 'invoke' as const }])
      ).values(),
    ];
    const expected = [...contractRegistrations, ...MANUAL_PRODUCTION_REGISTRATIONS]
      .map(({ channel, kind }) => ({ channel, kind }))
      .sort((left, right) => left.channel.localeCompare(right.channel));
    const actual = union
      .map(({ channel, kind }) => ({ channel, kind }))
      .sort((left, right) => left.channel.localeCompare(right.channel));

    expect(new Set(expected.map(({ channel }) => channel)).size).toBe(expected.length);
    expect(actual).toEqual(expected);
  });

  it("publishes the main window's native focus and blur to its renderer on the window-focus push channel (BST-1864)", () => {
    const [mainWindow] = mockBrowserWindow.mock.instances as unknown as Array<{
      on: MockOnFn;
      webContents: { send: MockOnFn };
    }>;
    expect(mainWindow).toBeDefined();
    if (!mainWindow) {
      return;
    }
    const send = mainWindow.webContents.send;
    send.mockClear();

    fireHandlersRegisteredSoFar(mainWindow.on, 'blur');
    expect(send).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.windowFocus.changed, false);
    fireHandlersRegisteredSoFar(mainWindow.on, 'focus');
    expect(send).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.windowFocus.changed, true);
  });

  it('registers only DESKTOP_IPC_CHANNELS manifest literals', () => {
    const manifest = flattenManifest(DESKTOP_IPC_CHANNELS);
    const offManifest = union
      .map((entry) => entry.channel)
      .filter((channelName) => !manifest.has(channelName));
    expect(offManifest).toEqual([]);
  });
});
