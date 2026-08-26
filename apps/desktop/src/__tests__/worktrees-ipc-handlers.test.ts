import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktreesIpcHandlers } from '../worktrees-ipc-handlers';

const service = {
  archive: vi.fn(),
  create: vi.fn(),
  createBranchHere: vi.fn(),
  createContext: vi.fn(),
  isManagedWorktreePath: vi.fn(),
  list: vi.fn(),
  listManagedPaths: vi.fn(),
  restore: vi.fn(),
};

function handlers() {
  return createWorktreesIpcHandlers({
    readSettings: () =>
      Promise.resolve({ isDefaultDirectory: true, managedDirectory: '/m', setupCommand: null }),
    resolveService: () => service as never,
    writeSettings: (next: unknown) => Promise.resolve(next as never),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('worktrees IPC handlers', () => {
  it('reports an absent service as a typed failure, never an empty list', async () => {
    const withoutService = createWorktreesIpcHandlers({
      readSettings: () =>
        Promise.resolve({ isDefaultDirectory: true, managedDirectory: '/m', setupCommand: null }),
      resolveService: () => null,
      writeSettings: (next: unknown) => Promise.resolve(next as never),
    });
    expect(await withoutService.list()).toEqual({
      error: 'The worktree service is not available in this session.',
      ok: false,
    });
  });

  it('routes the ledger-only managed-path listing through the service boundary', async () => {
    service.listManagedPaths.mockResolvedValue({
      ok: true,
      value: [{ id: 'worktree-1', path: '/managed/worktree-1' }],
    });

    await expect(handlers().listManagedPaths()).resolves.toEqual({
      ok: true,
      value: [{ id: 'worktree-1', path: '/managed/worktree-1' }],
    });
    expect(service.listManagedPaths).toHaveBeenCalledWith();
  });

  it('rejects a malformed create payload at the boundary', async () => {
    expect(await handlers().create({ name: 42 })).toEqual({
      error: 'worktrees:create requires { rootId, baseRef, name, branch, createdBy }.',
      ok: false,
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('rejects a create whose branch request is neither detached nor named', async () => {
    expect(
      await handlers().create({
        baseRef: 'main',
        branch: {},
        createdBy: 'user',
        name: 'a',
        rootId: 'r',
      })
    ).toEqual({
      error: 'worktrees:create branch must be { detached: true } or { name: string }.',
      ok: false,
    });
  });

  it('forwards a validated create to the service', async () => {
    service.create.mockResolvedValue({ ok: true, value: { setup: null, worktree: null } });
    const params = {
      baseRef: 'main',
      branch: { name: 'bs/x' },
      createdBy: 'user',
      name: 'x',
      rootId: 'r',
    };
    await handlers().create(params);
    expect(service.create).toHaveBeenCalledWith(params);
  });

  it('rejects a malformed archive payload at the boundary', async () => {
    expect(await handlers().archive({ worktreeId: 42 })).toEqual({
      error: 'worktrees:archive requires { worktreeId }.',
      ok: false,
    });
    expect(service.archive).not.toHaveBeenCalled();
  });

  it('forwards a validated archive to the service', async () => {
    service.archive.mockResolvedValue({ ok: true, value: { snapshotRef: 'ref', worktree: null } });
    const params = { force: true, runId: 'run-1', worktreeId: 'wt-1' };
    await handlers().archive(params);
    expect(service.archive).toHaveBeenCalledWith(params);
  });

  it('rejects a malformed createBranchHere payload at the boundary', async () => {
    expect(await handlers().createBranchHere({ branch: 42, worktreeId: 'wt-1' })).toEqual({
      error: 'worktrees:createBranchHere requires { branch, worktreeId }.',
      ok: false,
    });
    expect(service.createBranchHere).not.toHaveBeenCalled();
  });

  it('forwards a validated createBranchHere to the service', async () => {
    service.createBranchHere.mockResolvedValue({ ok: true, value: null });
    const params = { branch: 'bs/attached', worktreeId: 'wt-1' };
    await handlers().createBranchHere(params);
    expect(service.createBranchHere).toHaveBeenCalledWith(params);
  });

  it('rejects a malformed createContext payload at the boundary', async () => {
    expect(await handlers().createContext({ rootId: '' })).toEqual({
      error: 'worktrees:createContext requires { rootId }.',
      ok: false,
    });
    expect(service.createContext).not.toHaveBeenCalled();
  });

  it('forwards a validated createContext to the service', async () => {
    service.createContext.mockResolvedValue({
      ok: true,
      value: { managedParentPath: '/managed/app-slug', suggestedName: 'bright-fox' },
    });
    const params = { rootId: 'r-1' };
    await handlers().createContext(params);
    expect(service.createContext).toHaveBeenCalledWith(params);
  });

  it('rejects a malformed restore payload at the boundary', async () => {
    expect(await handlers().restore({ worktreeId: 42 })).toEqual({
      error: 'worktrees:restore requires { worktreeId }.',
      ok: false,
    });
    expect(service.restore).not.toHaveBeenCalled();
  });

  it('forwards a validated restore to the service', async () => {
    service.restore.mockResolvedValue({ ok: true, value: { setup: null, worktree: null } });
    const params = { worktreeId: 'wt-1' };
    await handlers().restore(params);
    expect(service.restore).toHaveBeenCalledWith(params);
  });

  it('never lets a thrown service error cross the IPC boundary', async () => {
    service.list.mockRejectedValue(new Error('boom'));
    expect(await handlers().list()).toEqual({ error: 'boom', ok: false });
  });

  it('returns settings from the read boundary', async () => {
    const settings = {
      isDefaultDirectory: false,
      managedDirectory: '/worktrees',
      setupCommand: null,
    };
    const readSettings = vi.fn(() => Promise.resolve(settings));
    const ipcHandlers = createWorktreesIpcHandlers({
      readSettings,
      resolveService: () => service as never,
      writeSettings: (next: unknown) => Promise.resolve(next as never),
    });

    await expect(ipcHandlers.getSettings()).resolves.toEqual({ ok: true, value: settings });
  });

  it('returns a typed failure when reading settings throws', async () => {
    const ipcHandlers = createWorktreesIpcHandlers({
      readSettings: () => Promise.reject(new Error('settings read failed')),
      resolveService: () => service as never,
      writeSettings: (next: unknown) => Promise.resolve(next as never),
    });

    await expect(ipcHandlers.getSettings()).resolves.toEqual({
      error: 'settings read failed',
      ok: false,
    });
  });

  it('rejects a non-object settings payload', async () => {
    const writeSettings = vi.fn((next: unknown) => Promise.resolve(next as never));
    const ipcHandlers = createWorktreesIpcHandlers({
      readSettings: () => Promise.resolve({} as never),
      resolveService: () => service as never,
      writeSettings,
    });

    await expect(ipcHandlers.setSettings(null)).resolves.toEqual({
      error: 'worktrees:setSettings requires an object payload.',
      ok: false,
    });
    expect(writeSettings).not.toHaveBeenCalled();
  });

  it('rejects a relative managed directory', async () => {
    const writeSettings = vi.fn((next: unknown) => Promise.resolve(next as never));
    const ipcHandlers = createWorktreesIpcHandlers({
      readSettings: () => Promise.resolve({} as never),
      resolveService: () => service as never,
      writeSettings,
    });

    const result = await ipcHandlers.setSettings({
      managedDirectory: 'relative/dir',
      setupCommand: null,
    });
    expect(result).toEqual({
      error: 'worktrees:setSettings managedDirectory must be an absolute path or null.',
      ok: false,
    });
    expect(writeSettings).not.toHaveBeenCalled();
  });

  it('rejects an empty setup command', async () => {
    const writeSettings = vi.fn((next: unknown) => Promise.resolve(next as never));
    const ipcHandlers = createWorktreesIpcHandlers({
      readSettings: () => Promise.resolve({} as never),
      resolveService: () => service as never,
      writeSettings,
    });

    const result = await ipcHandlers.setSettings({ managedDirectory: null, setupCommand: [] });
    expect(result).toEqual({
      error:
        'worktrees:setSettings setupCommand must be a non-empty string array, "disabled", or null.',
      ok: false,
    });
    expect(writeSettings).not.toHaveBeenCalled();
  });

  it('rejects a string setup state other than disabled', async () => {
    const writeSettings = vi.fn((next: unknown) => Promise.resolve(next as never));
    const ipcHandlers = createWorktreesIpcHandlers({
      readSettings: () => Promise.resolve({} as never),
      resolveService: () => service as never,
      writeSettings,
    });

    await expect(
      ipcHandlers.setSettings({ managedDirectory: null, setupCommand: 'enabled' })
    ).resolves.toEqual({
      error:
        'worktrees:setSettings setupCommand must be a non-empty string array, "disabled", or null.',
      ok: false,
    });
    expect(writeSettings).not.toHaveBeenCalled();
  });

  it('round-trips the disabled setup state through the write boundary', async () => {
    const next = { managedDirectory: null, setupCommand: 'disabled' as const };
    const settings = {
      isDefaultDirectory: true,
      managedDirectory: '/home/test/.brainstrike/worktrees',
      setupCommand: 'disabled' as const,
    };
    const writeSettings = vi.fn(() => Promise.resolve(settings));
    const ipcHandlers = createWorktreesIpcHandlers({
      readSettings: () => Promise.resolve(settings),
      resolveService: () => service as never,
      writeSettings,
    });

    await expect(ipcHandlers.setSettings(next)).resolves.toEqual({ ok: true, value: settings });
    expect(writeSettings).toHaveBeenCalledWith(next);
  });

  it('round-trips valid settings through the write boundary', async () => {
    const next = { managedDirectory: '/Volumes/worktrees', setupCommand: ['pnpm', 'install'] };
    const settings = { ...next, isDefaultDirectory: false };
    const writeSettings = vi.fn(() => Promise.resolve(settings));
    const ipcHandlers = createWorktreesIpcHandlers({
      readSettings: () => Promise.resolve(settings),
      resolveService: () => service as never,
      writeSettings,
    });

    await expect(ipcHandlers.setSettings(next)).resolves.toEqual({ ok: true, value: settings });
    expect(writeSettings).toHaveBeenCalledWith(next);
  });

  it('returns a typed failure when writing settings throws', async () => {
    const ipcHandlers = createWorktreesIpcHandlers({
      readSettings: () => Promise.resolve({} as never),
      resolveService: () => service as never,
      writeSettings: () => Promise.reject(new Error('managed directory refused')),
    });

    await expect(
      ipcHandlers.setSettings({ managedDirectory: '/work/project/worktrees', setupCommand: null })
    ).resolves.toEqual({ error: 'managed directory refused', ok: false });
  });
});
