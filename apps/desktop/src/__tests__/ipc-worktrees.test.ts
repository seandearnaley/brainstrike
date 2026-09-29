import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerWorktreesIpcHandlers } from '../ipc-worktrees';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import type { WorktreesIpcHandlers } from '../worktrees-ipc-handlers';
import { createAllowlistedSenderFrame } from './helpers/desktop-ipc-sender-frame-test-allowlist';

const getWindowRoleByWebContentsIdMock = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock('../window-role', () => ({
  getWindowRoleByWebContentsId: getWindowRoleByWebContentsIdMock,
}));

const ALL_WORKTREE_CHANNELS = [
  DESKTOP_IPC_CHANNELS.worktrees.adopt,
  DESKTOP_IPC_CHANNELS.worktrees.archive,
  DESKTOP_IPC_CHANNELS.worktrees.checkoutStatus,
  DESKTOP_IPC_CHANNELS.worktrees.create,
  DESKTOP_IPC_CHANNELS.worktrees.createBranchHere,
  DESKTOP_IPC_CHANNELS.worktrees.createContext,
  DESKTOP_IPC_CHANNELS.worktrees.getSettings,
  DESKTOP_IPC_CHANNELS.worktrees.inspectArchive,
  DESKTOP_IPC_CHANNELS.worktrees.list,
  DESKTOP_IPC_CHANNELS.worktrees.managedPaths,
  DESKTOP_IPC_CHANNELS.worktrees.restore,
  DESKTOP_IPC_CHANNELS.worktrees.setSettings,
] as const;

function stubHandlers(): WorktreesIpcHandlers {
  return {
    adopt: vi.fn(async () => ({ ok: true, value: {} }) as never),
    archive: vi.fn(async () => ({ ok: true, value: {} }) as never),
    checkoutStatus: vi.fn(async () => ({ ok: true, value: {} }) as never),
    create: vi.fn(async () => ({ ok: true, value: {} }) as never),
    createBranchHere: vi.fn(async () => ({ ok: true, value: {} }) as never),
    createContext: vi.fn(async () => ({ ok: true, value: {} }) as never),
    getSettings: vi.fn(async () => ({ ok: true, value: {} }) as never),
    inspectArchive: vi.fn(async () => ({ ok: true, value: {} }) as never),
    list: vi.fn(async () => ({ ok: true, value: {} }) as never),
    listManagedPaths: vi.fn(async () => ({ ok: true, value: {} }) as never),
    restore: vi.fn(async () => ({ ok: true, value: {} }) as never),
    setSettings: vi.fn(async () => ({ ok: true, value: {} }) as never),
  };
}

describe('registerWorktreesIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWindowRoleByWebContentsIdMock.mockReturnValue('visible-ui');
  });

  it('registers all twelve channels and routes each to the correct handler', async () => {
    const { ipcMain } = await import('electron');
    const handlers = stubHandlers();

    registerWorktreesIpcHandlers(handlers);

    const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
    const registeredChannels = handleMock.mock.calls.map(([channel]) => channel);
    expect(registeredChannels).toEqual(expect.arrayContaining([...ALL_WORKTREE_CHANNELS]));
    expect(registeredChannels).toHaveLength(12);

    const handlerFor = (channel: string) =>
      handleMock.mock.calls.find(([registered]) => registered === channel)?.[1] as (
        event: unknown,
        ...args: unknown[]
      ) => unknown;
    const clearHandlerMocks = () => {
      vi.mocked(handlers.adopt).mockClear();
      vi.mocked(handlers.archive).mockClear();
      vi.mocked(handlers.checkoutStatus).mockClear();
      vi.mocked(handlers.create).mockClear();
      vi.mocked(handlers.createBranchHere).mockClear();
      vi.mocked(handlers.createContext).mockClear();
      vi.mocked(handlers.getSettings).mockClear();
      vi.mocked(handlers.inspectArchive).mockClear();
      vi.mocked(handlers.list).mockClear();
      vi.mocked(handlers.listManagedPaths).mockClear();
      vi.mocked(handlers.restore).mockClear();
      vi.mocked(handlers.setSettings).mockClear();
    };

    const visibleEvent = { sender: { id: 8101 }, senderFrame: createAllowlistedSenderFrame() };
    const adoptPayload = { createdBy: 'user', path: '/repo/wt' };
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.adopt)(visibleEvent, adoptPayload);
    expect(handlers.adopt).toHaveBeenCalledWith(adoptPayload);
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.createContext).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.listManagedPaths).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    const inspectArchivePayload = { worktreeId: 'w1' };
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.inspectArchive)(
      visibleEvent,
      inspectArchivePayload
    );
    expect(handlers.inspectArchive).toHaveBeenCalledWith(inspectArchivePayload);

    clearHandlerMocks();
    const payload = {
      baseRef: 'HEAD',
      branch: { name: 'feature' },
      createdBy: 'user',
      name: 'feature',
      rootId: 'root-1',
    } as const;
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.create)(visibleEvent, payload);
    expect(handlers.create).toHaveBeenCalledWith(payload);
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.createContext).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.listManagedPaths).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    const archivePayload = { worktreeId: 'w1' };
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.archive)(visibleEvent, archivePayload);
    expect(handlers.archive).toHaveBeenCalledWith(archivePayload);
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.createContext).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.listManagedPaths).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    const checkoutStatusPayload = { path: '/repo/wt' };
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.checkoutStatus)(
      visibleEvent,
      checkoutStatusPayload
    );
    expect(handlers.checkoutStatus).toHaveBeenCalledWith(checkoutStatusPayload);
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.createContext).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.listManagedPaths).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    const createBranchHerePayload = { branch: 'feature', worktreeId: 'w1' };
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.createBranchHere)(
      visibleEvent,
      createBranchHerePayload
    );
    expect(handlers.createBranchHere).toHaveBeenCalledWith(createBranchHerePayload);
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.createContext).not.toHaveBeenCalled();
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.listManagedPaths).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    const createContextPayload = { rootId: 'r-1' };
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.createContext)(
      visibleEvent,
      createContextPayload
    );
    expect(handlers.createContext).toHaveBeenCalledWith(createContextPayload);
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.listManagedPaths).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.getSettings)(visibleEvent);
    expect(handlers.getSettings).toHaveBeenCalledWith();
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.listManagedPaths).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.managedPaths)(visibleEvent);
    expect(handlers.listManagedPaths).toHaveBeenCalledWith();
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.list)(visibleEvent);
    expect(handlers.list).toHaveBeenCalledWith();
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    const restorePayload = { worktreeId: 'w1' };
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.restore)(visibleEvent, restorePayload);
    expect(handlers.restore).toHaveBeenCalledWith(restorePayload);
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.listManagedPaths).not.toHaveBeenCalled();
    expect(handlers.setSettings).not.toHaveBeenCalled();

    clearHandlerMocks();
    const setSettingsPayload = { managedDirectory: '/x', setupCommand: null };
    await handlerFor(DESKTOP_IPC_CHANNELS.worktrees.setSettings)(visibleEvent, setSettingsPayload);
    expect(handlers.setSettings).toHaveBeenCalledWith(setSettingsPayload);
    expect(handlers.adopt).not.toHaveBeenCalled();
    expect(handlers.archive).not.toHaveBeenCalled();
    expect(handlers.checkoutStatus).not.toHaveBeenCalled();
    expect(handlers.create).not.toHaveBeenCalled();
    expect(handlers.createBranchHere).not.toHaveBeenCalled();
    expect(handlers.getSettings).not.toHaveBeenCalled();
    expect(handlers.list).not.toHaveBeenCalled();
    expect(handlers.restore).not.toHaveBeenCalled();
  });

  it.each([
    ['a hidden sender', 'embedding-host'],
    ['an untracked sender', undefined],
  ] as const)('rejects %s on all twelve channels', async (_label, role) => {
    const { ipcMain } = await import('electron');
    const handlers = stubHandlers();
    getWindowRoleByWebContentsIdMock.mockReturnValue(role);
    registerWorktreesIpcHandlers(handlers);

    const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
    const event = { sender: { id: 8102 }, senderFrame: createAllowlistedSenderFrame() };
    for (const channel of ALL_WORKTREE_CHANNELS) {
      const registeredHandler = handleMock.mock.calls.find(
        ([registered]) => registered === channel
      )?.[1] as ((event: unknown, payload?: unknown) => unknown) | undefined;
      await expect(registeredHandler?.(event, { value: 'untrusted' })).rejects.toThrow(
        `Desktop IPC ${channel} requires sender role visible-ui.`
      );
    }

    for (const handler of Object.values(handlers)) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it('preserves raw GitResult failures for type-valid domain errors', async () => {
    const { ipcMain } = await import('electron');
    const branchFailure = { error: 'branch is required', ok: false } as const;
    const settingsFailure = { error: 'setup command cannot be empty', ok: false } as const;
    const handlers = {
      ...stubHandlers(),
      createBranchHere: vi.fn(async () => branchFailure),
      setSettings: vi.fn(async () => settingsFailure),
    } satisfies WorktreesIpcHandlers;
    registerWorktreesIpcHandlers(handlers);

    const handleMock = ipcMain.handle as unknown as ReturnType<typeof vi.fn>;
    const handlerFor = (channel: string) =>
      handleMock.mock.calls.find(([registered]) => registered === channel)?.[1] as (
        event: unknown,
        payload: unknown
      ) => unknown;
    const visibleEvent = { sender: { id: 8101 }, senderFrame: createAllowlistedSenderFrame() };

    await expect(
      handlerFor(DESKTOP_IPC_CHANNELS.worktrees.createBranchHere)(visibleEvent, {
        branch: '',
        worktreeId: 'worktree-1',
      })
    ).resolves.toBe(branchFailure);
    await expect(
      handlerFor(DESKTOP_IPC_CHANNELS.worktrees.setSettings)(visibleEvent, {
        managedDirectory: null,
        setupCommand: [],
      })
    ).resolves.toBe(settingsFailure);
  });

  it('disposer removes all twelve registered channels', async () => {
    const { ipcMain } = await import('electron');
    const dispose = registerWorktreesIpcHandlers(stubHandlers());

    dispose();

    const removeHandlerMock = ipcMain.removeHandler as unknown as ReturnType<typeof vi.fn>;
    const removedChannels = removeHandlerMock.mock.calls.map(([channel]) => channel);
    expect(removedChannels).toEqual(expect.arrayContaining([...ALL_WORKTREE_CHANNELS]));
    expect(removedChannels).toHaveLength(12);
  });
});
