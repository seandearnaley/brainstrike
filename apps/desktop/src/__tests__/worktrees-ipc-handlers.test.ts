import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktreesIpcHandlers } from '../worktrees-ipc-handlers';

const service = {
  adopt: vi.fn(),
  archive: vi.fn(),
  checkoutStatus: vi.fn(),
  create: vi.fn(),
  createBranchHere: vi.fn(),
  createContext: vi.fn(),
  inspectArchive: vi.fn(),
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

  it('rejects a malformed adopt payload at the boundary', async () => {
    expect(await handlers().adopt({ createdBy: 'user', path: 'relative/wt' })).toEqual({
      error: 'worktrees:adopt requires { path: <absolute path>, createdBy: "agent" | "user" }.',
      ok: false,
    });
    expect(service.adopt).not.toHaveBeenCalled();
  });

  // validateAdopt's refusal condition is `!(structurally valid) || (createdBy invalid)` — the
  // `||`'s short-circuit means `payload['createdBy']` is read ONLY once the structural checks
  // (isRecord, non-empty path, absolute path) already passed. A payload that fails the
  // structural checks — including one that isn't a record at all, like `null` or an array —
  // must never reach that createdBy read, or `payload['createdBy']` would throw for `null`
  // instead of returning the stated refusal.
  it.each([
    ['null', null],
    ['an array', ['not', 'a', 'record']],
    ['a string', 'not-a-record'],
  ] as const)(
    'rejects a non-record adopt payload (%s) without evaluating createdBy',
    async (_label, payload) => {
      await expect(handlers().adopt(payload)).resolves.toEqual({
        error: 'worktrees:adopt requires { path: <absolute path>, createdBy: "agent" | "user" }.',
        ok: false,
      });
      expect(service.adopt).not.toHaveBeenCalled();
    }
  );

  it('rejects a structurally valid adopt payload with an invalid createdBy', async () => {
    expect(await handlers().adopt({ createdBy: 'robot', path: '/repo/wt' })).toEqual({
      error: 'worktrees:adopt requires { path: <absolute path>, createdBy: "agent" | "user" }.',
      ok: false,
    });
    expect(service.adopt).not.toHaveBeenCalled();

    expect(await handlers().adopt({ path: '/repo/wt' })).toEqual({
      error: 'worktrees:adopt requires { path: <absolute path>, createdBy: "agent" | "user" }.',
      ok: false,
    });
    expect(service.adopt).not.toHaveBeenCalled();
  });

  it('forwards a validated adopt to the service, with runId and threadId when supplied', async () => {
    service.adopt.mockResolvedValue({ ok: true, value: {} });
    const params = { createdBy: 'user', path: '/repo/wt', runId: 'run-1', threadId: 'thread-1' };

    await handlers().adopt(params);

    expect(service.adopt).toHaveBeenCalledWith(params);
  });

  // Task 12's run attribution depends on runId reaching the service only when the renderer
  // actually supplied one — an `undefined`-valued key would satisfy a loose `toEqual`, but the
  // ledger write shape and any downstream `Object.hasOwn`/spread check needs the key GENUINELY
  // absent, not present-with-undefined.
  it('omits runId and threadId from the forwarded params when the renderer did not supply them', async () => {
    service.adopt.mockResolvedValue({ ok: true, value: {} });

    await handlers().adopt({ createdBy: 'user', path: '/repo/wt' });

    expect(service.adopt).toHaveBeenCalledTimes(1);
    const forwarded = service.adopt.mock.calls[0]?.[0];
    expect(forwarded).toStrictEqual({ createdBy: 'user', path: '/repo/wt' });
    expect(forwarded).not.toHaveProperty('runId');
    expect(forwarded).not.toHaveProperty('threadId');
  });

  // Contract: absent runId/threadId is fine (prior test); present+valid
  // passes through (prior test); present+MALFORMED must be REJECTED loudly,
  // never silently dropped to absent — an unknown-typed IPC boundary must
  // not coerce a caller's malformed input into a different, unstated
  // request (adopting with no run attribution when one was actually asked
  // for).
  it.each([
    ['a number', { createdBy: 'user', path: '/repo/wt', runId: 42 }],
    ['an empty string', { createdBy: 'user', path: '/repo/wt', runId: '' }],
  ] as const)('rejects a present but malformed runId (%s)', async (_label, payload) => {
    expect(await handlers().adopt(payload)).toEqual({
      error: 'worktrees:adopt runId must be a non-empty string when present.',
      ok: false,
    });
    expect(service.adopt).not.toHaveBeenCalled();
  });

  it.each([
    ['a number', { createdBy: 'user', path: '/repo/wt', threadId: 42 }],
    ['an empty string', { createdBy: 'user', path: '/repo/wt', threadId: '' }],
  ] as const)('rejects a present but malformed threadId (%s)', async (_label, payload) => {
    expect(await handlers().adopt(payload)).toEqual({
      error: 'worktrees:adopt threadId must be a non-empty string when present.',
      ok: false,
    });
    expect(service.adopt).not.toHaveBeenCalled();
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

  it('forwards a validated repository setup decision to the service', async () => {
    service.create.mockResolvedValue({ ok: true, value: { setup: null, worktree: null } });
    const params = {
      baseRef: 'main',
      branch: { name: 'bs/x' },
      createdBy: 'user',
      name: 'x',
      repositorySetupDecision: {
        decision: 'denied',
        repositoryId: '/work/app/.git',
        scriptSha256: 'hash-1',
      },
      rootId: 'r',
    };

    await handlers().create(params);

    expect(service.create).toHaveBeenCalledWith(params);
  });

  it('rejects a malformed repository setup decision at the boundary', async () => {
    const result = await handlers().create({
      baseRef: 'main',
      branch: { name: 'bs/x' },
      createdBy: 'user',
      name: 'x',
      repositorySetupDecision: {
        decision: 'sometimes',
        repositoryId: '/work/app/.git',
        scriptSha256: 'hash-1',
      },
      rootId: 'r',
    });

    expect(result).toEqual({
      error:
        'worktrees:create repositorySetupDecision must identify a repository, be approved or denied, and carry the script hash it is pinned to.',
      ok: false,
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('rejects a repository setup decision missing its script hash at the boundary', async () => {
    const result = await handlers().create({
      baseRef: 'main',
      branch: { name: 'bs/x' },
      createdBy: 'user',
      name: 'x',
      repositorySetupDecision: {
        decision: 'approved',
        repositoryId: '/work/app/.git',
      },
      rootId: 'r',
    });

    expect(result).toEqual({
      error:
        'worktrees:create repositorySetupDecision must identify a repository, be approved or denied, and carry the script hash it is pinned to.',
      ok: false,
    });
    expect(service.create).not.toHaveBeenCalled();
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
    const params = {
      confirmIgnoredEntries: 'confirmation-token',
      force: true,
      runId: 'run-1',
      worktreeId: 'wt-1',
    };
    await handlers().archive(params);
    expect(service.archive).toHaveBeenCalledWith(params);
  });

  it('rejects malformed archive confirmation and inspection payloads', async () => {
    await expect(
      handlers().archive({ confirmIgnoredEntries: true, worktreeId: 'wt-1' })
    ).resolves.toEqual({
      error: 'worktrees:archive confirmIgnoredEntries must be a non-empty string when present.',
      ok: false,
    });
    await expect(handlers().inspectArchive({ worktreeId: 42 })).resolves.toEqual({
      error: 'worktrees:inspectArchive requires { worktreeId }.',
      ok: false,
    });
    expect(service.archive).not.toHaveBeenCalled();
    expect(service.inspectArchive).not.toHaveBeenCalled();
  });

  it('forwards a validated archive inspection to the service', async () => {
    service.inspectArchive.mockResolvedValue({
      ok: true,
      value: {
        confirmationToken: 'confirmation-token',
        ignoredEntryCount: 1,
        ignoredTopLevelEntries: ['.env'],
        ignoredTopLevelEntriesTruncated: false,
        ignoredTopLevelEntryCount: 1,
      },
    });
    await handlers().inspectArchive({ worktreeId: 'wt-1' });
    expect(service.inspectArchive).toHaveBeenCalledWith({ worktreeId: 'wt-1' });
  });

  it('rejects a malformed checkout-status payload at the boundary', async () => {
    expect(await handlers().checkoutStatus({ path: 'relative/worktree' })).toEqual({
      error: 'worktrees:checkoutStatus requires { path: <absolute path> }.',
      ok: false,
    });
    expect(service.checkoutStatus).not.toHaveBeenCalled();
  });

  it('forwards a validated checkout-status read to the service', async () => {
    service.checkoutStatus.mockResolvedValue({
      ok: true,
      value: { ahead: 0, behind: 0, clean: true, path: '/repo/wt', upstream: 'origin/feature' },
    });
    const params = { path: '/repo/wt' };
    await handlers().checkoutStatus(params);
    expect(service.checkoutStatus).toHaveBeenCalledWith(params);
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
      value: {
        managedParentPath: '/managed/app-slug',
        repositorySetup: null,
        suggestedName: 'bright-fox',
      },
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
