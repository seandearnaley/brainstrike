import path from 'node:path';
import { dialog, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';

type RegisteredHandler = (...args: unknown[]) => unknown | Promise<unknown>;

const { getWindowRoleByWebContentsIdMock } = vi.hoisted(() => ({
  getWindowRoleByWebContentsIdMock: vi.fn(),
}));

vi.mock('../../window-role', () => ({
  getWindowRoleByWebContentsId: getWindowRoleByWebContentsIdMock,
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

function event(senderId = 1) {
  return { sender: { id: senderId }, senderFrame: createAllowlistedSenderFrame() };
}

/** Main's MCP host control: the picker hand-off, the factory reset and shutdown. */
function createMainRuntime() {
  return {
    close: vi.fn(),
    pickConfigPath: vi.fn(async (picked: string) => ({ path: picked, success: true as const })),
    resetSettings: vi.fn(async () => undefined),
    resumeSettings: vi.fn(async () => undefined),
  };
}

describe('Main MCP IPC (BST-1930 c5a-c5d)', () => {
  let handlers: Map<string, RegisteredHandler>;
  let runtime: ReturnType<typeof createMainRuntime>;
  let unregister: (() => void) | undefined;

  function handler(channel: string): RegisteredHandler {
    const registered = handlers.get(channel);
    if (!registered) {
      throw new Error(`No handler for ${channel}`);
    }
    return registered;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getWindowRoleByWebContentsIdMock.mockReturnValue('visible-ui');
    handlers = new Map();
    vi.mocked(ipcMain.handle).mockImplementation(((channel: string, next: RegisteredHandler) => {
      handlers.set(channel, next);
    }) as typeof ipcMain.handle);
    runtime = createMainRuntime();
    unregister = mcpIpc.registerMcpIpcHandlers({ runtime });
  });

  afterEach(async () => {
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime);
    unregister?.();
    unregister = undefined;
  });

  it('serves the picker, and no MCP settings, status, control or content', () => {
    expect([...handlers.keys()]).toEqual(expect.arrayContaining(['mcp:config:selectPath']));
    for (const channel of handlers.keys()) {
      expect(channel).not.toMatch(
        /^mcp:(tools|extensions|lifecycle|status|content):|^mcp:config:(?!selectPath$)/u
      );
    }
  });

  it('hands the natively picked file to the host and answers its selected path', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/me/mcp/../config/mcp.json'],
    });

    await expect(handler('mcp:config:selectPath')(event())).resolves.toBe(
      path.resolve('/Users/me/config/mcp.json')
    );
    expect(runtime.pickConfigPath).toHaveBeenCalledWith(path.resolve('/Users/me/config/mcp.json'));
  });

  it.each([
    ['cancelled', { canceled: true, filePaths: ['/ignored.json'] }],
    ['empty', { canceled: false, filePaths: [] }],
  ])('selects nothing when the picker is %s', async (_label, result) => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue(result);

    await expect(handler('mcp:config:selectPath')(event())).resolves.toBeNull();
    expect(runtime.pickConfigPath).not.toHaveBeenCalled();
  });

  it('coalesces a window picking twice and refuses a second window meanwhile', async () => {
    const pending = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>();
    vi.mocked(dialog.showOpenDialog).mockReturnValue(pending.promise);

    const first = handler('mcp:config:selectPath')(event(1));
    const again = handler('mcp:config:selectPath')(event(1));
    await expect(handler('mcp:config:selectPath')(event(2))).rejects.toThrow(
      'MCP config path selection is already active for another window'
    );
    pending.resolve({ canceled: false, filePaths: ['/picked/mcp.json'] });

    await expect(first).resolves.toBe('/picked/mcp.json');
    await expect(again).resolves.toBe('/picked/mcp.json');
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(runtime.pickConfigPath).toHaveBeenCalledTimes(1);
  });

  it('closes the picker across a factory reset and reopens it after the host resumes', async () => {
    await mcpIpc.resetMcpRuntimeForFactoryReset(runtime);

    expect(runtime.resetSettings).toHaveBeenCalledTimes(1);
    await expect(handler('mcp:config:selectPath')(event())).rejects.toThrow(
      'MCP settings are closed for a factory reset'
    );

    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime, 'failed');

    expect(runtime.resumeSettings).toHaveBeenCalledWith('failed');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(handler('mcp:config:selectPath')(event())).resolves.toBeNull();
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime);
    expect(runtime.resumeSettings).toHaveBeenCalledTimes(1);
  });

  it('suspends content-clear surfaces without erasing MCP preferences', async () => {
    await mcpIpc.suspendMcpSurfacesForContentClear();
    expect(runtime.resetSettings).not.toHaveBeenCalled();
    await expect(handler('mcp:config:selectPath')(event())).rejects.toThrow(
      'MCP settings are closed for a factory reset'
    );
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime, 'succeeded');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(handler('mcp:config:selectPath')(event())).resolves.toBeNull();
  });

  it('stays closed when the host cannot resume its settings', async () => {
    await mcpIpc.resetMcpRuntimeForFactoryReset(runtime);
    runtime.resumeSettings.mockRejectedValueOnce(new Error('host gone'));

    await expect(mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime)).rejects.toThrow('host gone');

    await expect(handler('mcp:config:selectPath')(event())).rejects.toThrow(
      'MCP settings are closed for a factory reset'
    );
  });

  it('closes the picker and its host control at shutdown', async () => {
    await mcpIpc.cleanupMcpRuntimeForShutdown(runtime);

    expect(runtime.close).toHaveBeenCalledTimes(1);
    await expect(handler('mcp:config:selectPath')(event())).rejects.toThrow(
      'MCP settings are closed for a factory reset'
    );
  });
});
