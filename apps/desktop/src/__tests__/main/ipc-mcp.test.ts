import path from 'node:path';
import { dialog, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcpIpc from '../../ipc-mcp';
import { createAllowlistedSenderFrame } from '../helpers/desktop-ipc-sender-frame-test-allowlist';
import { invokeDesktopIpcFrom } from '../helpers/desktop-ipc-sender-test-helpers';

const { isAppWindowSenderMock } = vi.hoisted(() => ({
  isAppWindowSenderMock: vi.fn(),
}));

vi.mock('../../app-windows', () => ({
  isAppWindowSender: isAppWindowSenderMock,
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
}));

function event(senderId = 1) {
  return { sender: { id: senderId }, senderFrame: createAllowlistedSenderFrame() };
}

function selectPath(from: ReturnType<typeof event>): Promise<unknown> {
  return invokeDesktopIpcFrom(ipcMain, from, 'mcp:config:selectPath');
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
  let runtime: ReturnType<typeof createMainRuntime>;
  let unregister: (() => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    isAppWindowSenderMock.mockReturnValue(true);
    runtime = createMainRuntime();
    unregister = mcpIpc.registerMcpIpcHandlers({ runtime });
  });

  afterEach(async () => {
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime);
    unregister?.();
    unregister = undefined;
  });

  it('hands the natively picked file to the host and answers its selected path', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/me/mcp/../config/mcp.json'],
    });

    await expect(selectPath(event())).resolves.toBe(path.resolve('/Users/me/config/mcp.json'));
    expect(runtime.pickConfigPath).toHaveBeenCalledWith(path.resolve('/Users/me/config/mcp.json'));
  });

  it.each([
    ['cancelled', { canceled: true, filePaths: ['/ignored.json'] }],
    ['empty', { canceled: false, filePaths: [] }],
  ])('selects nothing when the picker is %s', async (_label, result) => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue(result);

    await expect(selectPath(event())).resolves.toBeNull();
    expect(runtime.pickConfigPath).not.toHaveBeenCalled();
  });

  it('coalesces a window picking twice and refuses a second window meanwhile', async () => {
    const pending = Promise.withResolvers<{ canceled: boolean; filePaths: string[] }>();
    vi.mocked(dialog.showOpenDialog).mockReturnValue(pending.promise);

    const first = selectPath(event(1));
    const again = selectPath(event(1));
    await expect(selectPath(event(2))).rejects.toThrow(
      'MCP config path selection is already active for another window'
    );
    const picked = path.resolve('/picked/mcp.json');
    pending.resolve({ canceled: false, filePaths: [picked] });

    await expect(first).resolves.toBe(picked);
    await expect(again).resolves.toBe(picked);
    expect(dialog.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(runtime.pickConfigPath).toHaveBeenCalledTimes(1);
  });

  it('closes the picker across a factory reset and reopens it after the host resumes', async () => {
    await mcpIpc.resetMcpRuntimeForFactoryReset(runtime);

    expect(runtime.resetSettings).toHaveBeenCalledTimes(1);
    await expect(selectPath(event())).rejects.toThrow(
      'MCP settings are closed for a factory reset'
    );

    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime, 'failed');

    expect(runtime.resumeSettings).toHaveBeenCalledWith('failed');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(selectPath(event())).resolves.toBeNull();
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime);
    expect(runtime.resumeSettings).toHaveBeenCalledTimes(1);
  });

  it('suspends content-clear surfaces without erasing MCP preferences', async () => {
    await mcpIpc.suspendMcpSurfacesForContentClear();
    expect(runtime.resetSettings).not.toHaveBeenCalled();
    await expect(selectPath(event())).rejects.toThrow(
      'MCP settings are closed for a factory reset'
    );
    await mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime, 'succeeded');
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    await expect(selectPath(event())).resolves.toBeNull();
  });

  it('stays closed when the host cannot resume its settings', async () => {
    await mcpIpc.resetMcpRuntimeForFactoryReset(runtime);
    runtime.resumeSettings.mockRejectedValueOnce(new Error('host gone'));

    await expect(mcpIpc.resumeMcpRuntimeAfterFactoryReset(runtime)).rejects.toThrow('host gone');

    await expect(selectPath(event())).rejects.toThrow(
      'MCP settings are closed for a factory reset'
    );
  });

  it('closes the picker and its host control at shutdown', async () => {
    await mcpIpc.cleanupMcpRuntimeForShutdown(runtime);

    expect(runtime.close).toHaveBeenCalledTimes(1);
    await expect(selectPath(event())).rejects.toThrow(
      'MCP settings are closed for a factory reset'
    );
  });
});
