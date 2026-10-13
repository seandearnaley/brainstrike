import Module from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { changesContract } from '../ipc-domains/changes.contract';
import { clipboardContract } from '../ipc-domains/clipboard.contract';
import { commandSessionsContract } from '../ipc-domains/command-sessions.contract';
import { contextFilesContract } from '../ipc-domains/context-files.contract';
import { databasePathContract } from '../ipc-domains/database.contract';
import { forgeContract } from '../ipc-domains/forge.contract';
import { gitContract } from '../ipc-domains/git.contract';
import { indexSearchContract } from '../ipc-domains/index-search.contract';
import { mcpAppsContract, mcpPathSelectionContract } from '../ipc-domains/mcp.contract';
import { notesVaultContract } from '../ipc-domains/notes-vault.contract';
import { promptLibraryContract } from '../ipc-domains/prompt-library.contract';
import { skillsContract } from '../ipc-domains/skills.contract';
import {
  layoutContract,
  settingsContract,
  storageContract,
} from '../ipc-domains/storage-preferences.contract';
import { terminalContract } from '../ipc-domains/terminal.contract';
import { threadGroupsContract } from '../ipc-domains/thread-groups.contract';
import { userCommandsContract } from '../ipc-domains/user-commands.contract';
import { userPersonasContract } from '../ipc-domains/user-personas.contract';
import { viewFilterPresetsContract } from '../ipc-domains/view-filter-presets.contract';
import { windowFocusContract } from '../ipc-domains/window-focus.contract';
import { worktreesContract } from '../ipc-domains/worktrees.contract';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';

/**
 * BST-1648: for every contract-derived bridge the preload exposes, the key
 * set is `Object.keys(contract)` BY CONSTRUCTION — this suite loads the real
 * preload under a mocked `electron` and reads the exposed objects back,
 * replacing the per-domain source-regex pins. The same load proves each
 * method routes to its manifest channel and applies the ONE `IpcResult`
 * unwrap.
 */
const mockExposeInMainWorld = vi.fn<(key: string, api: unknown) => void>();
const mockInvoke = vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>();
const mockElectron = {
  contextBridge: { exposeInMainWorld: mockExposeInMainWorld },
  ipcRenderer: { invoke: mockInvoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
  webUtils: { getPathForFile: vi.fn(() => '') },
};

type ModuleLoader = (this: typeof Module, id: string, ...rest: unknown[]) => unknown;
const moduleWithLoader = Module as unknown as { _load: ModuleLoader };
const originalLoad = moduleWithLoader._load;

const CONTRACT_BRIDGES = {
  assistantPersonas: userPersonasContract,
  changes: changesContract,
  clipboard: clipboardContract,
  commandSessions: commandSessionsContract,
  contextFiles: contextFilesContract,
  forge: forgeContract,
  git: gitContract,
  indexSearch: indexSearchContract,
  notesVault: notesVaultContract,
  promptLibrary: promptLibraryContract,
  settings: settingsContract,
  skills: skillsContract,
  terminal: terminalContract,
  threadGroups: threadGroupsContract,
  userCommands: userCommandsContract,
  viewFilterPresets: viewFilterPresetsContract,
  windowFocus: windowFocusContract,
  worktrees: worktreesContract,
} as const;

function exposedApi(name: string): Record<string, (...args: unknown[]) => unknown> {
  const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === name);
  if (!call) {
    throw new Error(`Preload did not expose '${name}'.`);
  }
  return call[1] as Record<string, (...args: unknown[]) => unknown>;
}

describe('preload contract-derived bridges', () => {
  beforeEach(async () => {
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

  it('passes document pins, unchanged texts and a plain cancellation token', async () => {
    mockInvoke.mockClear();
    const inferencePlan = {
      device: 'wasm',
      dimensions: 384,
      dtype: 'q8',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    };
    const payload = {
      dimensions: 384,
      inferencePlan,
      modelId: inferencePlan.modelId,
      modelKey: 'native:documents',
      texts: ['  document\n', 'second'],
    };
    await exposedApi('embeddingHost')['documentEmbeddings']?.(payload, {
      requestId: 'renderer-token',
    });
    expect(mockInvoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.embeddingHost.documentEmbeddings, {
      payload,
      requestId: 'renderer-token',
    });
    await exposedApi('embeddingHost')['cancelDocumentEmbeddings']?.('renderer-token');
    expect(mockInvoke).toHaveBeenLastCalledWith(
      DESKTOP_IPC_CHANNELS.embeddingHost.cancelDocumentEmbeddings,
      'renderer-token'
    );
    mockInvoke.mockClear();
    expect(() =>
      exposedApi('embeddingHost')['documentEmbeddings']?.(
        { ...payload, inferencePlan: undefined },
        { requestId: 'renderer-token' }
      )
    ).toThrow();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('preserves complete native inference pins across the actual preload transport', async () => {
    mockInvoke.mockClear();
    const inferencePlan = {
      device: 'wasm',
      dimensions: 384,
      dtype: 'q8',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    };
    const payload = {
      dimensions: 384,
      inferencePlan,
      modelId: inferencePlan.modelId,
      modelKey: 'native:minilm',
      query: 'callers',
    };
    await exposedApi('embeddingHost')['queryEmbedding']?.(payload);
    expect(mockInvoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, {
      payload,
      requestId: expect.any(String),
    });
    await exposedApi('embeddingHost')['queryEmbedding']?.(payload, { requestId: 'search-token' });
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.embeddingHost.queryEmbedding, {
      payload,
      requestId: 'search-token',
    });
    await exposedApi('embeddingHost')['cancelQueryEmbedding']?.('search-token');
    expect(mockInvoke).toHaveBeenLastCalledWith(
      DESKTOP_IPC_CHANNELS.embeddingHost.cancelQueryEmbedding,
      'search-token'
    );
  });
  it.each([
    { dimensions: 384, dtype: 'q8', modelId: 'Xenova/bge-small-en-v1.5' },
    { dimensions: 768, dtype: 'fp32', modelId: 'Xenova/bge-base-en-v1.5' },
    { dimensions: 768, dtype: 'q4', modelId: 'jinaai/jina-embeddings-v2-base-code' },
  ])(
    'preserves original catalog $modelId without invented revision across query and document preload',
    async (selected) => {
      const inferencePlan = { ...selected, device: 'wasm' };
      for (const kind of ['queryEmbedding', 'documentEmbeddings'] as const) {
        mockInvoke.mockClear();
        const payload = {
          dimensions: selected.dimensions,
          inferencePlan,
          modelId: selected.modelId,
          modelKey: `local::${selected.modelId}`,
          ...(kind === 'queryEmbedding' ? { query: 'callers' } : { texts: ['document'] }),
        };
        await exposedApi('embeddingHost')[kind]?.(payload, { requestId: 'catalog-token' });
        expect(mockInvoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.embeddingHost[kind], {
          payload,
          requestId: 'catalog-token',
        });
      }
    }
  );
  it.each([
    { device: undefined },
    { dtype: undefined },
    { dtype: 'unknown' },
    { revision: 'main' },
    { dimensions: 0 },
    { dimensions: Number.NaN },
  ])('rejects invalid explicit local plan before IPC: %j', (invalid) => {
    mockInvoke.mockClear();
    expect(() =>
      exposedApi('embeddingHost')['queryEmbedding']?.({
        dimensions: 768,
        inferencePlan: {
          device: 'wasm',
          dimensions: 768,
          dtype: 'q8',
          modelId: 'Xenova/bge-base-en-v1.5',
          ...invalid,
        },
        modelId: 'Xenova/bge-base-en-v1.5',
        modelKey: 'local::Xenova/bge-base-en-v1.5',
        query: 'callers',
      })
    ).toThrow();
    expect(mockInvoke).not.toHaveBeenCalled();
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
    expect(mockInvoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.mcp.appsReleaseShell, {
      token: 'shell-1',
    });
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
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.db.resetLocal);
    mockInvoke.mockResolvedValueOnce('/tmp/profile');
    await expect(electronApi.getUserDataPath()).resolves.toBe('/tmp/profile');
    expect(mockInvoke).toHaveBeenLastCalledWith(databasePathContract.getUserDataPath.channel);
  });

  it('routes clipboard.writeText to the manifest channel and transports the result envelope', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: undefined });
    await expect(exposedApi('clipboard')['writeText']?.('copied')).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    expect(mockInvoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.clipboard.writeText, 'copied');

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
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.windowFocus.isFocused);

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

  it('subscribes windowFocus.onChange to the push channel and returns its unsubscribe', () => {
    const callback = vi.fn();
    const unsubscribe = exposedApi('windowFocus')['onChange']?.(callback) as () => void;
    expect(mockElectron.ipcRenderer.on).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.windowFocus.changed,
      expect.any(Function)
    );

    const listener = vi
      .mocked(mockElectron.ipcRenderer.on)
      .mock.calls.find(
        ([channel]) => channel === DESKTOP_IPC_CHANNELS.windowFocus.changed
      )?.[1] as (event: unknown, focused: boolean) => void;
    listener({}, false);
    expect(callback).toHaveBeenCalledWith(false);

    unsubscribe();
    expect(mockElectron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.windowFocus.changed,
      listener
    );
  });

  it('omits the retired PostgreSQL integrity owner from the visible preload', () => {
    expect(mockExposeInMainWorld.mock.calls.some(([name]) => name === 'databaseIntegrity')).toBe(
      false
    );
  });

  it('derives the nested production storage and layout bridges', async () => {
    const electronApi = exposedApi('electronAPI') as unknown as {
      loadLayout: () => Promise<unknown>;
      saveLayout: (state: unknown) => Promise<unknown>;
      storage: Record<string, (...args: unknown[]) => Promise<unknown>>;
    };
    expect(Object.keys(electronApi.storage).sort()).toEqual(Object.keys(storageContract).sort());
    expect(['loadLayout', 'saveLayout'].every((key) => key in electronApi)).toBe(true);

    mockInvoke.mockResolvedValueOnce(['alpha']);
    await expect(electronApi.storage['getAllKeys']?.()).resolves.toEqual(['alpha']);
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.storage.getAllKeys);

    const state = {
      showConsole: true,
      showLeftPanel: true,
      showRightPanel: false,
      sizes: [50, 50],
    };
    mockInvoke.mockResolvedValueOnce({ success: true });
    await expect(electronApi.saveLayout(state)).resolves.toEqual({ success: true });
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.preferences.layoutSave, state);
    expect(Object.keys(layoutContract).sort()).toEqual(['loadLayout', 'saveLayout']);
  });

  it('routes git.status to its manifest channel and preserves the raw GitResult envelope', async () => {
    const result = { error: 'not a repository', ok: false } as const;
    mockInvoke.mockResolvedValueOnce(result);

    await expect(exposedApi('git')['status']?.('root-1')).resolves.toBe(result);
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.git.status, 'root-1');
  });

  it.each([
    ['changes', 'inventory', DESKTOP_IPC_CHANNELS.changes.inventory, []],
    ['commandSessions', 'list', DESKTOP_IPC_CHANNELS.commandSessions.list, [{ rootId: 'root-1' }]],
    ['forge', 'refresh', DESKTOP_IPC_CHANNELS.forge.refresh, ['root-1', { reason: 'user' }]],
    ['notesVault', 'readFile', DESKTOP_IPC_CHANNELS.notesVault.readFile, ['/vault/note.md']],
    ['terminal', 'create', DESKTOP_IPC_CHANNELS.terminal.create, [{ rootId: 'root-1' }]],
    ['worktrees', 'listManagedPaths', DESKTOP_IPC_CHANNELS.worktrees.managedPaths, []],
  ] as const)(
    '%s.%s routes to its manifest channel and preserves its raw result',
    async (name, method, channel, args) => {
      const result = { error: `${name} failed`, ok: false } as const;
      mockInvoke.mockResolvedValueOnce(result);

      await expect(exposedApi(name)[method]?.(...args)).resolves.toBe(result);
      expect(mockInvoke).toHaveBeenLastCalledWith(channel, ...args);
    }
  );

  it.each([
    ['changes', 'onInvalidated', DESKTOP_IPC_CHANNELS.changes.invalidated],
    ['forge', 'onPrUpdated', DESKTOP_IPC_CHANNELS.forge.prUpdated],
    ['notesVault', 'onChanged', DESKTOP_IPC_CHANNELS.notesVault.changed],
    ['terminal', 'onData', DESKTOP_IPC_CHANNELS.terminal.data],
    ['terminal', 'onExit', DESKTOP_IPC_CHANNELS.terminal.exit],
  ] as const)('%s.%s subscribes and removes the same push listener', (name, method, channel) => {
    const callback = vi.fn();
    const unsubscribe = exposedApi(name)[method]?.(callback) as () => void;
    const listener = vi
      .mocked(mockElectron.ipcRenderer.on)
      .mock.calls.find(([registered]) => registered === channel)?.[1] as (
      event: unknown,
      payload: unknown
    ) => void;

    listener({}, { marker: name });
    expect(callback).toHaveBeenCalledWith({ marker: name });
    unsubscribe();
    expect(mockElectron.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener);
  });

  it('passes prompt commands unchanged through the actual sandbox bridge envelope', async () => {
    const request = { filter: { favoritesOnly: true }, operation: 'list' };
    const receipt = { accepted: true, items: [], revisions: [] };
    mockInvoke.mockResolvedValueOnce({ ok: true, value: receipt });
    await expect(exposedApi('promptLibrary')['request']?.(request)).resolves.toEqual({
      ok: true,
      value: receipt,
    });
    expect(mockInvoke).toHaveBeenLastCalledWith(
      DESKTOP_IPC_CHANNELS.promptLibrary.request,
      request
    );
    mockInvoke.mockResolvedValueOnce({
      error: {
        category: 'promptLibrary',
        code: 'prompt_library_failed',
        message: 'Prompt owner closed',
      },
      ok: false,
    });
    await expect(exposedApi('promptLibrary')['request']?.(request)).resolves.toMatchObject({
      error: { code: 'prompt_library_failed' },
      ok: false,
    });
  });

  it.each([
    ['assistantPersonas', 'list', DESKTOP_IPC_CHANNELS.userPersonas.list],
    ['contextFiles', 'scan', DESKTOP_IPC_CHANNELS.contextFiles.scan],
    ['skills', 'scan', DESKTOP_IPC_CHANNELS.skills.scan],
    ['userCommands', 'list', DESKTOP_IPC_CHANNELS.userCommands.list],
  ])('%s.%s invokes %s and transports the envelope', async (name, method, channelName) => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: { marker: name } });
    await expect(exposedApi(name)[method]?.()).resolves.toEqual({
      ok: true,
      value: { marker: name },
    });
    expect(mockInvoke).toHaveBeenLastCalledWith(channelName);
  });
  it('forwards retained diagnostic read filters without exposing SQL', async () => {
    const bridge = exposedApi('desktopDiagnostics');
    mockInvoke.mockResolvedValueOnce([]);
    await expect(bridge['queryEvents']?.({ runId: 'run-1' })).resolves.toEqual([]);
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.diagnostics.queryEvents, {
      runId: 'run-1',
    });
    mockInvoke.mockResolvedValueOnce({ count: 2, firstSeenMs: 1, lastSeenMs: 2 });
    await bridge['countByFingerprint']?.('fp-provider', 1);
    expect(mockInvoke).toHaveBeenLastCalledWith(
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
      DESKTOP_IPC_CHANNELS.diagnostics.getUnseenCounts,
      1000
    );
  });
});
