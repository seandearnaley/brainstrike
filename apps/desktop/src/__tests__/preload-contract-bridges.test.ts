import Module from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { changesContract } from '../ipc-domains/changes.contract';
import { clipboardContract } from '../ipc-domains/clipboard.contract';
import { commandSessionsContract } from '../ipc-domains/command-sessions.contract';
import { contextFilesContract } from '../ipc-domains/context-files.contract';
import {
  databaseContract,
  databaseIntegrityContract,
  databaseLiveContract,
  databasePathContract,
} from '../ipc-domains/database.contract';
import { forgeContract } from '../ipc-domains/forge.contract';
import { gitContract } from '../ipc-domains/git.contract';
import { indexSearchContract } from '../ipc-domains/index-search.contract';
import { mcpAppsContract, mcpPathSelectionContract } from '../ipc-domains/mcp.contract';
import { notesVaultContract } from '../ipc-domains/notes-vault.contract';
import { skillsContract } from '../ipc-domains/skills.contract';
import {
  layoutContract,
  settingsContract,
  storageContract,
} from '../ipc-domains/storage-preferences.contract';
import { terminalContract } from '../ipc-domains/terminal.contract';
import { userCommandsContract } from '../ipc-domains/user-commands.contract';
import { userPersonasContract } from '../ipc-domains/user-personas.contract';
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
  databaseIntegrity: databaseIntegrityContract,
  forge: forgeContract,
  git: gitContract,
  indexSearch: indexSearchContract,
  notesVault: notesVaultContract,
  settings: settingsContract,
  skills: skillsContract,
  terminal: terminalContract,
  userCommands: userCommandsContract,
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
    // Server status, lifecycle control, Tasks cards and global server input
    // are agent-host methods (BST-1930 c5b-c5c).
    const expectedRootKeys = new Set([
      ...Object.keys(mcpPathSelectionContract),
      'apps',
      'complete',
      'getPrompt',
      'readResource',
    ]);
    expect(new Set(Object.keys(mcp))).toEqual(expectedRootKeys);
    expect(Object.keys(mcp['apps'] as object).sort()).toEqual(
      [...Object.keys(mcpAppsContract), 'readResource'].sort()
    );
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

  it("reads an MCP App resource against the server's live generation from Main's status", async () => {
    const apps = exposedApi('mcp')['apps'] as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    const uri = 'ui://fixture/app.html';
    mockInvoke.mockResolvedValueOnce({
      revision: 3,
      servers: [{ configuredServerId: 'fixture', generation: 7 }],
    });
    mockInvoke.mockResolvedValueOnce({
      ok: true,
      result: {
        result: { contents: [{ mimeType: 'text/html;profile=mcp-app', text: '<p>app</p>', uri }] },
        type: 'resources/read',
      },
    });

    await expect(
      apps['readResource']?.({
        mimeType: 'text/html;profile=mcp-app',
        resourceUri: uri,
        serverId: 'fixture',
        toolName: 'show',
      })
    ).resolves.toBe('<p>app</p>');
    expect(mockInvoke.mock.calls.slice(-2)).toEqual([
      [DESKTOP_IPC_CHANNELS.mcp.statusGet],
      [
        DESKTOP_IPC_CHANNELS.mcp.contentReadResource,
        { authority: { configuredServerId: 'fixture', generation: 7 }, uri },
      ],
    ]);
  });

  it('unwraps MCP content replies into the established public promise behavior', async () => {
    const mcp = exposedApi('mcp');
    const result = { completion: { values: ['done'] }, type: 'completion/complete' };
    mockInvoke.mockResolvedValueOnce({ ok: true, result });
    await expect(mcp['complete']?.({ argument: { name: 'n', value: 'v' } })).resolves.toBe(result);

    mockInvoke.mockResolvedValueOnce({
      error: { category: 'protocol', code: 'invalid-result', message: 'bad content' },
      ok: false,
    });
    await expect(mcp['complete']?.({})).rejects.toMatchObject({
      category: 'protocol',
      code: 'invalid-result',
      message: 'bad content (protocol · invalid-result)',
    });
  });

  it('derives the visible database invokes and path capability from their contracts', async () => {
    const electronApi = exposedApi('electronAPI') as unknown as {
      db: Record<string, (...args: unknown[]) => unknown>;
      dbLive: Record<string, (...args: unknown[]) => unknown>;
      getUserDataPath: () => Promise<unknown>;
    };

    expect(Object.keys(electronApi.db).sort()).toEqual(Object.keys(databaseContract).sort());
    expect(Object.keys(electronApi.dbLive).sort()).toEqual(
      Object.keys(databaseLiveContract).sort()
    );
    expect(electronApi.getUserDataPath).toBeTypeOf('function');
    expect(Object.keys(databasePathContract)).toEqual(['getUserDataPath']);

    mockInvoke.mockResolvedValueOnce({ rows: [{ value: 1 }] });
    await expect(electronApi.db['query']?.('SELECT 1')).resolves.toEqual({
      rows: [{ value: 1 }],
    });
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.db.query, 'SELECT 1');

    mockInvoke.mockResolvedValueOnce('/tmp/profile');
    await expect(electronApi.getUserDataPath()).resolves.toBe('/tmp/profile');
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.db.getUserDataPath);
  });

  it('routes clipboard.writeText to the manifest channel and unwraps the result envelope', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: undefined });
    await expect(exposedApi('clipboard')['writeText']?.('copied')).resolves.toBeUndefined();
    expect(mockInvoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.clipboard.writeText, 'copied');

    mockInvoke.mockResolvedValueOnce({
      error: { category: 'clipboard', code: 'write_failed', message: 'clipboard locked' },
      ok: false,
    });
    await expect(exposedApi('clipboard')['writeText']?.('copied')).rejects.toThrow(
      'clipboard locked (clipboard · write_failed)'
    );
  });

  it('routes windowFocus.isFocused to the manifest channel and unwraps the result envelope', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: true });
    await expect(exposedApi('windowFocus')['isFocused']?.()).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.windowFocus.isFocused);

    mockInvoke.mockResolvedValueOnce({
      error: {
        category: 'window-focus',
        code: 'window_unavailable',
        message: 'The requesting renderer has no live BrowserWindow.',
      },
      ok: false,
    });
    await expect(exposedApi('windowFocus')['isFocused']?.()).rejects.toThrow(
      'The requesting renderer has no live BrowserWindow. (window-focus · window_unavailable)'
    );
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

  it('routes databaseIntegrity.getState to the manifest channel and unwraps the result envelope', async () => {
    const snapshot = { revision: 0, state: { kind: 'healthy' } };
    mockInvoke.mockResolvedValueOnce({ ok: true, value: snapshot });
    await expect(exposedApi('databaseIntegrity')['getState']?.()).resolves.toEqual(snapshot);
    expect(mockInvoke).toHaveBeenLastCalledWith(DESKTOP_IPC_CHANNELS.db.integrityState);

    mockInvoke.mockResolvedValueOnce({
      error: { category: 'database', code: 'unavailable', message: 'integrity unavailable' },
      ok: false,
    });
    await expect(exposedApi('databaseIntegrity')['getState']?.()).rejects.toThrow(
      'integrity unavailable (database · unavailable)'
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

  it.each([
    ['assistantPersonas', 'list', DESKTOP_IPC_CHANNELS.userPersonas.list],
    ['contextFiles', 'scan', DESKTOP_IPC_CHANNELS.contextFiles.scan],
    ['skills', 'scan', DESKTOP_IPC_CHANNELS.skills.scan],
    ['userCommands', 'list', DESKTOP_IPC_CHANNELS.userCommands.list],
  ])('%s.%s invokes %s and unwraps the value', async (name, method, channelName) => {
    mockInvoke.mockResolvedValueOnce({ ok: true, value: { marker: name } });
    await expect(exposedApi(name)[method]?.()).resolves.toEqual({ marker: name });
    expect(mockInvoke).toHaveBeenLastCalledWith(channelName);
  });
});
