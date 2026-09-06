import Module from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { clipboardContract } from '../ipc-domains/clipboard.contract';
import { contextFilesContract } from '../ipc-domains/context-files.contract';
import { skillsContract } from '../ipc-domains/skills.contract';
import { userCommandsContract } from '../ipc-domains/user-commands.contract';
import { userPersonasContract } from '../ipc-domains/user-personas.contract';
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
  clipboard: clipboardContract,
  contextFiles: contextFilesContract,
  skills: skillsContract,
  userCommands: userCommandsContract,
} as const;

function exposedApi(name: string): Record<string, (...args: unknown[]) => unknown> {
  const call = mockExposeInMainWorld.mock.calls.find(([key]) => key === name);
  if (!call) {
    throw new Error(`Preload did not expose '${name}'.`);
  }
  return call[1] as Record<string, (...args: unknown[]) => unknown>;
}

describe('preload contract-derived bridges', () => {
  beforeAll(async () => {
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
