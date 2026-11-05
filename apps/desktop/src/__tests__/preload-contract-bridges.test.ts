import Module from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clipboardContract } from '../ipc-domains/clipboard.contract';
import { databasePathContract } from '../ipc-domains/database.contract';
import { mcpAppsContract, mcpPathSelectionContract } from '../ipc-domains/mcp.contract';
import { threadGroupsContract } from '../ipc-domains/thread-groups.contract';
import { viewFilterPresetsContract } from '../ipc-domains/view-filter-presets.contract';
import { windowFocusContract } from '../ipc-domains/window-focus.contract';
import {
  DESKTOP_IPC_CHANNELS,
  DESKTOP_IPC_INVOKE_CHANNEL,
  DESKTOP_IPC_PUSH_CHANNEL,
  type DesktopIpcPush,
} from '../platform/desktop-ipc-channels';

/**
 * BST-1648: for every contract-derived bridge the preload exposes, the key
 * set is `Object.keys(contract)` BY CONSTRUCTION — this suite loads the real
 * preload under a mocked `electron` and reads the exposed objects back,
 * replacing the per-domain source-regex pins. The same load proves each
 * method rides the one invoke channel under its manifest method name and
 * applies the ONE `BoundaryResult` unwrap.
 */
type PushListener = (event: { ports: readonly unknown[] }, push: DesktopIpcPush) => void;
const mockExposeInMainWorld = vi.fn<(key: string, api: unknown) => void>();
const mockInvoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>();
const mockOn = vi.fn<(channel: string, listener: PushListener) => void>();
const mockElectron = {
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: { invoke: mockInvoke, on: mockOn },
  webUtils: { getPathForFile: vi.fn(() => '') },
};

type ModuleLoader = (this: typeof Module, id: string, ...rest: unknown[]) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleWithLoader._load;

const CONTRACT_BRIDGES = {
  clipboard: clipboardContract,
  threadGroups: threadGroupsContract,
  viewFilterPresets: viewFilterPresetsContract,
  windowFocus: windowFocusContract,
} as const;

function exposedApi(name: string): Record<string, (...args: unknown[]) => unknown> {
  const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === name);
  if (!call) {
    throw new Error(`Preload did not expose '${name}'.`);
  }
  return call[1] as Record<string, (...args: unknown[]) => unknown>;
}

/** Delivers one push from Main on the preload's push channel. */
function pushFromMain(method: string, payload: unknown): void {
  const listener = mockOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC_PUSH_CHANNEL)?.[1];
  if (!listener) {
    throw new Error('Preload did not listen on the push channel.');
  }
  listener({ ports: [] }, { method, payload });
}

describe('preload contract-derived bridges', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    moduleWithLoader._load = function (this: typeof Module, id: string, ...rest: unknown[]) {
      if (id === 'electron') {
        return mockElectron;
      }
      return originalLoad.call(this, id, ...rest);
    };
    await import('../preload');
  });

  afterAll(() => {
    moduleWithLoader._load = originalLoad;
  });

  it('opens one connection: a single push listener, and every call on the invoke channel', async () => {
    expect(mockOn.mock.calls.map(([channel]) => channel)).toEqual([DESKTOP_IPC_PUSH_CHANNEL]);
    mockInvoke.mockResolvedValueOnce({ ok: true, value: undefined });
    await exposedApi('clipboard')['writeText']?.('copied');
    mockInvoke.mockResolvedValueOnce([]);
    await exposedApi('threadGroups')['readRoots']?.();
    expect(mockInvoke.mock.calls.map(([channel]) => channel)).toEqual([
      DESKTOP_IPC_INVOKE_CHANNEL,
      DESKTOP_IPC_INVOKE_CHANNEL,
    ]);
  });

  it.each(Object.entries(CONTRACT_BRIDGES))(
    "exposes '%s' with exactly the contract's key set",
    (name, contract) => {
      expect(Object.keys(exposedApi(name)).sort()).toEqual(Object.keys(contract).sort());
    }
  );

  it('exposes the composed MCP bridge with contract-derived root and Apps keys', () => {
    const mcp = exposedApi('mcp');
    // Server status, lifecycle control, Tasks cards, global server input and
    // content are agent-host methods (BST-1930 c5b-c5d).
    const expectedRootKeys = new Set([...Object.keys(mcpPathSelectionContract), 'apps']);
    expect(new Set(Object.keys(mcp))).toEqual(expectedRootKeys);
    // An App's document is read from the agent host (BST-1930 c5d).
    expect(Object.keys(mcp['apps'] as object).sort()).toEqual(Object.keys(mcpAppsContract).sort());
  });

  it('routes MCP contract methods through their manifest channels', async () => {
    const mcp = exposedApi('mcp');
    const apps = mcp['apps'] as unknown as Record<string, (...args: unknown[]) => unknown>;
    mockInvoke.mockResolvedValueOnce(undefined);
    await apps['releaseShell']?.({ token: 'shell-1' });
    expect(mockInvoke).toHaveBeenCalledWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      DESKTOP_IPC_CHANNELS.mcp.appsReleaseShell,
      { token: 'shell-1' }
    );
  });

  it('omits retired SQL bridges and routes reset and profile path to their current owners', async () => {
    const electronApi = exposedApi('electronAPI') as unknown as {
      factoryReset: { resetLocal: () => Promise<unknown>; unavailableReason?: string };
      getUserDataPath: () => Promise<unknown>;
    };
    expect(electronApi).not.toHaveProperty('db');
    expect(electronApi).not.toHaveProperty('dbLive');
    mockInvoke.mockResolvedValueOnce({ success: true });
    await expect(electronApi.factoryReset.resetLocal()).resolves.toEqual({ success: true });
    expect(mockInvoke).toHaveBeenLastCalledWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      DESKTOP_IPC_CHANNELS.db.resetLocal
    );
    mockInvoke.mockResolvedValueOnce('/tmp/profile');
    await expect(electronApi.getUserDataPath()).resolves.toBe('/tmp/profile');
    expect(mockInvoke).toHaveBeenLastCalledWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      databasePathContract.getUserDataPath.channel
    );
  });

  it('routes clipboard.writeText to the manifest channel and transports the result envelope', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: undefined });
    await expect(exposedApi('clipboard')['writeText']?.('copied')).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      DESKTOP_IPC_CHANNELS.clipboard.writeText,
      'copied'
    );

    mockInvoke.mockResolvedValueOnce({
      error: { category: 'clipboard', code: 'write_failed', message: 'clipboard locked' },
      ok: false,
    });
    await expect(exposedApi('clipboard')['writeText']?.('copied')).resolves.toEqual({
      error: { category: 'clipboard', code: 'write_failed', message: 'clipboard locked' },
      ok: false,
    });
  });

  it('routes windowFocus.isFocused to the manifest channel and transports the result envelope', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: true });
    await expect(exposedApi('windowFocus')['isFocused']?.()).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(mockInvoke).toHaveBeenLastCalledWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      DESKTOP_IPC_CHANNELS.windowFocus.isFocused
    );

    mockInvoke.mockResolvedValueOnce({
      error: {
        category: 'window-focus',
        code: 'window_unavailable',
        message: 'The requesting renderer has no live BrowserWindow.',
      },
      ok: false,
    });
    await expect(exposedApi('windowFocus')['isFocused']?.()).resolves.toMatchObject({
      error: { code: 'window_unavailable' },
      ok: false,
    });
  });

  it('delivers windowFocus.changed pushes to onChange until it unsubscribes', () => {
    const callback = vi.fn();
    const unsubscribe = exposedApi('windowFocus')['onChange']?.(callback) as () => void;

    pushFromMain(DESKTOP_IPC_CHANNELS.windowFocus.changed, false);
    pushFromMain(DESKTOP_IPC_CHANNELS.commandPalette.open, true);
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);

    unsubscribe();
    pushFromMain(DESKTOP_IPC_CHANNELS.windowFocus.changed, true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('delivers the app menu Settings… push to onOpenSettings until it unsubscribes', () => {
    const callback = vi.fn();
    const unsubscribe = exposedApi('appMenu')['onOpenSettings']?.(callback) as () => void;

    pushFromMain(DESKTOP_IPC_CHANNELS.appMenu.openSettings, undefined);
    pushFromMain(DESKTOP_IPC_CHANNELS.commandPalette.open, undefined);
    expect(callback).toHaveBeenCalledOnce();

    unsubscribe();
    pushFromMain(DESKTOP_IPC_CHANNELS.appMenu.openSettings, undefined);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('omits the retired PostgreSQL integrity owner from the visible preload', () => {
    expect(mockExposeInMainWorld.mock.calls.some(([name]) => name === 'databaseIntegrity')).toBe(
      false
    );
  });

  it.each([
    ['threadGroups', 'readRoots', DESKTOP_IPC_CHANNELS.threadGroups.readRoots, []],
  ] as const)(
    '%s.%s routes to its manifest channel and preserves its raw result',
    async (name, method, channel, args) => {
      const result = { error: `${name} failed`, ok: false } as const;
      mockInvoke.mockResolvedValueOnce(result);

      await expect(exposedApi(name)[method]?.(...args)).resolves.toBe(result);
      expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_INVOKE_CHANNEL, channel, ...args);
    }
  );

  it.each([['windowFocus', 'onChange', DESKTOP_IPC_CHANNELS.windowFocus.changed]] as const)(
    '%s.%s keeps each subscription until its own unsubscribe',
    (name, method, channel) => {
      const first = vi.fn();
      const second = vi.fn();
      const unsubscribeFirst = exposedApi(name)[method]?.(first) as () => void;
      const unsubscribeSecond = exposedApi(name)[method]?.(second) as () => void;

      pushFromMain(channel, { marker: name });
      unsubscribeFirst();
      pushFromMain(channel, { marker: 'after' });
      unsubscribeSecond();
      pushFromMain(channel, { marker: 'gone' });

      expect(first.mock.calls).toEqual([[{ marker: name }]]);
      expect(second.mock.calls).toEqual([[{ marker: name }], [{ marker: 'after' }]]);
    }
  );

  it('forwards retained diagnostic read filters without exposing SQL', async () => {
    const bridge = exposedApi('desktopDiagnostics');
    mockInvoke.mockResolvedValueOnce([]);
    await expect(bridge['queryEvents']?.({ runId: 'run-1' })).resolves.toEqual([]);
    expect(mockInvoke).toHaveBeenLastCalledWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      DESKTOP_IPC_CHANNELS.diagnostics.queryEvents,
      { runId: 'run-1' }
    );
    mockInvoke.mockResolvedValueOnce({ count: 2, firstSeenMs: 1, lastSeenMs: 2 });
    await bridge['countByFingerprint']?.('fp-provider', 1);
    expect(mockInvoke).toHaveBeenLastCalledWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      DESKTOP_IPC_CHANNELS.diagnostics.countByFingerprint,
      { fingerprint: 'fp-provider', sinceMs: 1 }
    );
    expect(bridge).not.toHaveProperty('query');
  });
  it('forwards the unseen diagnostic watermark to the retained-count owner', async () => {
    mockInvoke.mockResolvedValueOnce({ errorCount: 205, warningCount: 1 });
    await expect(exposedApi('desktopDiagnostics')['getUnseenCounts']?.(1000)).resolves.toEqual({
      errorCount: 205,
      warningCount: 1,
    });
    expect(mockInvoke).toHaveBeenLastCalledWith(
      DESKTOP_IPC_INVOKE_CHANNEL,
      DESKTOP_IPC_CHANNELS.diagnostics.getUnseenCounts,
      1000
    );
  });
});
