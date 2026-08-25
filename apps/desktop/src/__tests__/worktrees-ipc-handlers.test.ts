import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktreesIpcHandlers } from '../worktrees-ipc-handlers';

const service = {
  archive: vi.fn(),
  create: vi.fn(),
  createBranchHere: vi.fn(),
  isManagedWorktreePath: vi.fn(),
  list: vi.fn(),
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

  it('never lets a thrown service error cross the IPC boundary', async () => {
    service.list.mockRejectedValue(new Error('boom'));
    expect(await handlers().list()).toEqual({ error: 'boom', ok: false });
  });
});
