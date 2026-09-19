import Module from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { changesContract } from '../ipc-domains/changes.contract';
import { clipboardContract } from '../ipc-domains/clipboard.contract';
import { commandSessionsContract } from '../ipc-domains/command-sessions.contract';
import { contextFilesContract } from '../ipc-domains/context-files.contract';
import { forgeContract } from '../ipc-domains/forge.contract';
import { gitContract } from '../ipc-domains/git.contract';
import {
  mcpAppsContract,
  mcpContract,
  mcpElicitationContract,
  mcpPathSelectionContract,
  mcpTasksContract,
} from '../ipc-domains/mcp.contract';
import { notesVaultContract } from '../ipc-domains/notes-vault.contract';
import { skillsContract } from '../ipc-domains/skills.contract';
import { terminalContract } from '../ipc-domains/terminal.contract';
import { userCommandsContract } from '../ipc-domains/user-commands.contract';
import { userPersonasContract } from '../ipc-domains/user-personas.contract';
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
  notesVault: notesVaultContract,
  skills: skillsContract,
  terminal: terminalContract,
  userCommands: userCommandsContract,
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

  it.each(Object.entries(CONTRACT_BRIDGES))(
    "exposes '%s' with exactly the contract's key set",
    (name, contract) => {
      expect(Object.keys(exposedApi(name)).sort()).toEqual(Object.keys(contract).sort());
    }
  );

  it('exposes the composed MCP bridge with contract-derived root, Apps and Tasks keys', () => {
    const mcp = exposedApi('mcp');
    const expectedRootKeys = new Set([
      ...Object.keys(mcpContract),
      ...Object.keys(mcpPathSelectionContract),
      ...Object.keys(mcpElicitationContract),
      'apps',
      'complete',
      'getPrompt',
      'readResource',
      'tasks',
    ]);
    expect(new Set(Object.keys(mcp))).toEqual(expectedRootKeys);
    expect(Object.keys(mcp['apps'] as object).sort()).toEqual(
      [...Object.keys(mcpAppsContract), 'readResource'].sort()
    );
    expect(Object.keys(mcp['tasks'] as object).sort()).toEqual(
      Object.keys(mcpTasksContract).sort()
    );
  });

  it('routes MCP contract methods and subscriptions through their manifest channels', async () => {
    const mcp = exposedApi('mcp');
    mockInvoke.mockResolvedValueOnce({ apps: true, tasks: true });
    await expect(mcp['getExtensionPreferences']?.()).resolves.toEqual({ apps: true, tasks: true });
    expect(mockInvoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.mcp.extensionsGet);

    const apps = mcp['apps'] as unknown as Record<string, (...args: unknown[]) => unknown>;
    mockInvoke.mockResolvedValueOnce({ preparationId: 'prep-1' });
    await apps['prepare']?.({ preparationId: 'prep-1' });
    expect(mockInvoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.mcp.appsPrepare, {
      preparationId: 'prep-1',
    });

    const tasks = mcp['tasks'] as unknown as Record<string, (...args: unknown[]) => unknown>;
    mockInvoke.mockResolvedValueOnce({ tasks: [] });
    await tasks['list']?.();
    expect(mockInvoke).toHaveBeenCalledWith(DESKTOP_IPC_CHANNELS.mcp.taskList);

    const listener = vi.fn();
    const unsubscribe = mcp['onServerStatusUpdated']?.(listener) as () => void;
    expect(mockElectron.ipcRenderer.on).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.mcp.statusUpdated,
      expect.any(Function)
    );
    unsubscribe();
    expect(mockElectron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      DESKTOP_IPC_CHANNELS.mcp.statusUpdated,
      expect.any(Function)
    );
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
