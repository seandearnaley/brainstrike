import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWorktreesIpcHandlers } from '../ipc-worktrees';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import type { WorktreesIpcHandlers } from '../worktrees-ipc-handlers';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

function stubHandlers(): WorktreesIpcHandlers {
  return {
    archive: vi.fn(async () => ({ ok: true, value: {} }) as never),
    create: vi.fn(async () => ({ ok: true, value: {} }) as never),
    createBranchHere: vi.fn(async () => ({ ok: true, value: {} }) as never),
    getSettings: vi.fn(async () => ({ ok: true, value: {} }) as never),
    list: vi.fn(async () => ({ ok: true, value: {} }) as never),
    restore: vi.fn(async () => ({ ok: true, value: {} }) as never),
    setSettings: vi.fn(async () => ({ ok: true, value: {} }) as never),
  };
}

describe('registerWorktreesIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all seven channels and routes create to the correct handler', async () => {
    const { ipcMain } = await import('electron');
    const handlers = stubHandlers();

    registerWorktreesIpcHandlers(handlers);

    const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
    const registeredChannels = handleMock.mock.calls.map(([channel]) => channel);
    expect(registeredChannels).toEqual(
      expect.arrayContaining([
        DESKTOP_IPC_CHANNELS.worktrees.archive,
        DESKTOP_IPC_CHANNELS.worktrees.create,
        DESKTOP_IPC_CHANNELS.worktrees.createBranchHere,
        DESKTOP_IPC_CHANNELS.worktrees.getSettings,
        DESKTOP_IPC_CHANNELS.worktrees.list,
        DESKTOP_IPC_CHANNELS.worktrees.restore,
        DESKTOP_IPC_CHANNELS.worktrees.setSettings,
      ])
    );
    expect(registeredChannels).toHaveLength(7);

    const createHandler = handleMock.mock.calls.find(
      ([channel]) => channel === DESKTOP_IPC_CHANNELS.worktrees.create
    )?.[1] as (event: unknown, payload: unknown) => unknown;
    const payload = { name: 'feature' };
    await createHandler({}, payload);
    expect(handlers.create).toHaveBeenCalledWith(payload);
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
  });

  it('disposer removes all seven registered channels', async () => {
    const { ipcMain } = await import('electron');
    const dispose = registerWorktreesIpcHandlers(stubHandlers());

    dispose();

    const removeHandlerMock = ipcMain.removeHandler as unknown as ReturnType<typeof vi.fn>;
    const removedChannels = removeHandlerMock.mock.calls.map(([channel]) => channel);
    expect(removedChannels).toEqual(
      expect.arrayContaining([
        DESKTOP_IPC_CHANNELS.worktrees.archive,
        DESKTOP_IPC_CHANNELS.worktrees.create,
        DESKTOP_IPC_CHANNELS.worktrees.createBranchHere,
        DESKTOP_IPC_CHANNELS.worktrees.getSettings,
        DESKTOP_IPC_CHANNELS.worktrees.list,
        DESKTOP_IPC_CHANNELS.worktrees.restore,
        DESKTOP_IPC_CHANNELS.worktrees.setSettings,
      ])
    );
    expect(removedChannels).toHaveLength(7);
  });
});
