import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const profileLeaseMocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  clear: vi.fn(async () => undefined),
  release: vi.fn(),
}));
vi.mock('@brainstrike/host-lease', () => ({ acquireProfileResetLease: profileLeaseMocks.acquire }));

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

function installMainProcessRuntime(): void {
  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

function restoreParentPort(): void {
  if (originalParentPortDescriptor) {
    Object.defineProperty(process, 'parentPort', originalParentPortDescriptor);
    return;
  }

  Object.defineProperty(process, 'parentPort', {
    configurable: true,
    value: undefined,
    writable: true,
  });
}

const fsMocks = vi.hoisted(() => ({
  cpSync: vi.fn(),
  existsSync: vi.fn(() => true),
  lstatSync: vi.fn(() => ({
    isDirectory: () => false,
    isFile: () => false,
  })),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  readFileSync: vi.fn(() => ''),
  rmSync: vi.fn(),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const dbHostManagerMocks = vi.hoisted(() => ({
  closeDbHostManager: vi.fn(async () => undefined),
  reset: vi.fn(async () => undefined),
}));

vi.mock('node:fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:fs')>();
  return {
    ...mod,
    ...fsMocks,
    default: { ...mod, ...fsMocks },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'documents' ? '/mock/documents' : '/mock/userData')),
  },
}));

vi.mock('../../db-host-manager', () => ({
  closeDbHostManager: dbHostManagerMocks.closeDbHostManager,
  getDbHostManager: vi.fn(() => ({
    reset: dbHostManagerMocks.reset,
  })),
}));

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

describe('db-main resetLocalDatabase in main process', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    profileLeaseMocks.acquire.mockImplementation(async (root: string) => {
      let released = false;
      return {
        clearRootContents: profileLeaseMocks.clear,
        get isReleased() {
          return released;
        },
        release() {
          released = true;
          profileLeaseMocks.release();
        },
        root,
      };
    });
    profileLeaseMocks.clear.mockResolvedValue(undefined);

    installMainProcessRuntime();
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue([]);
    process.env['NODE_ENV'] = 'development';
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'test-profile';
  });

  afterEach(() => {
    vi.resetModules();
    restoreParentPort();
  });

  it('joins the DB host before acquiring, clearing and releasing the profile lease', async () => {
    const { resetLocalDatabase } = await import('../../db-main');

    await resetLocalDatabase();

    const expectedProfilePath = path.join(
      '/mock/documents',
      'BrainStrike-dev',
      'profiles',
      'test-profile'
    );
    expect(dbHostManagerMocks.closeDbHostManager).toHaveBeenCalledTimes(1);
    expect(dbHostManagerMocks.reset).not.toHaveBeenCalled();
    expect(profileLeaseMocks.acquire).toHaveBeenCalledWith(expectedProfilePath);
    expect(profileLeaseMocks.clear).toHaveBeenCalledOnce();
    expect(profileLeaseMocks.release).toHaveBeenCalledOnce();
    expect(fsMocks.rmSync).not.toHaveBeenCalledWith(expectedProfilePath, expect.anything());
    expect(dbHostManagerMocks.closeDbHostManager.mock.invocationCallOrder[0]).toBeLessThan(
      profileLeaseMocks.acquire.mock.invocationCallOrder[0] ?? 0
    );
    expect(profileLeaseMocks.acquire.mock.invocationCallOrder[0]).toBeLessThan(
      profileLeaseMocks.clear.mock.invocationCallOrder[0] ?? 0
    );
    expect(profileLeaseMocks.clear.mock.invocationCallOrder[0]).toBeLessThan(
      profileLeaseMocks.release.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('rejects new main-process opens while the legacy host close is still preparing the lease', async () => {
    const gate = Promise.withResolvers<void>();
    dbHostManagerMocks.closeDbHostManager.mockImplementationOnce(async () => {
      await gate.promise;
    });
    const { resetLocalDatabase, getDatabase } = await import('../../db-main');
    const resetting = resetLocalDatabase();
    await expect(getDatabase()).rejects.toThrow('profile reset lease');
    expect(profileLeaseMocks.acquire).not.toHaveBeenCalled();
    expect(profileLeaseMocks.clear).not.toHaveBeenCalled();
    gate.resolve();
    await expect(resetting).resolves.toBeUndefined();
    expect(profileLeaseMocks.release).toHaveBeenCalledOnce();
  });

  it('joins legacy PG before retiring its native owner, and retains retirement failure/admission for retry', async () => {
    const failure = new Error('native host close failed');
    const retireProfileOwner = vi.fn(async () => undefined).mockRejectedValueOnce(failure);
    const { prepareDatabaseProfileReset, resetLocalDatabase, getDatabase } = await import(
      '../../db-main'
    );
    await expect(prepareDatabaseProfileReset({ retireProfileOwner })).rejects.toBe(failure);
    expect(dbHostManagerMocks.closeDbHostManager.mock.invocationCallOrder[0]).toBeLessThan(
      retireProfileOwner.mock.invocationCallOrder[0] ?? 0
    );
    expect(profileLeaseMocks.acquire).not.toHaveBeenCalled();
    expect(profileLeaseMocks.clear).not.toHaveBeenCalled();
    await expect(getDatabase()).rejects.toMatchObject({ cause: failure });
    const guard = await prepareDatabaseProfileReset();
    expect(retireProfileOwner).toHaveBeenCalledTimes(2);
    expect(retireProfileOwner.mock.invocationCallOrder[1]).toBeLessThan(
      profileLeaseMocks.acquire.mock.invocationCallOrder[0] ?? 0
    );
    await resetLocalDatabase(guard);
    guard.release();
  });

  it('retains a failed developer reset lease and retries with the same owner', async () => {
    const failure = new Error('profile clear failed');
    profileLeaseMocks.clear.mockRejectedValueOnce(failure);
    const { resetLocalDatabase, prepareDatabaseProfileReset, getDatabase } = await import(
      '../../db-main'
    );
    await expect(resetLocalDatabase()).rejects.toBe(failure);
    const guard = await prepareDatabaseProfileReset();
    expect(guard.isReleased).toBe(false);
    expect(profileLeaseMocks.release).not.toHaveBeenCalled();
    await expect(getDatabase()).rejects.toThrow('profile reset lease');
    await expect(resetLocalDatabase()).resolves.toBeUndefined();
    expect(profileLeaseMocks.acquire).toHaveBeenCalledOnce();
    expect(profileLeaseMocks.clear).toHaveBeenCalledTimes(2);
    expect(guard.isReleased).toBe(true);
  });

  it('borrows an explicit guard and rejects an unrelated or released owner', async () => {
    const { resetLocalDatabase, prepareDatabaseProfileReset } = await import('../../db-main');
    const guard = await prepareDatabaseProfileReset();
    await resetLocalDatabase(guard);
    expect(guard.isReleased).toBe(false);
    expect(profileLeaseMocks.release).not.toHaveBeenCalled();
    await expect(resetLocalDatabase({ ...guard })).rejects.toThrow('active owned');
    guard.release();
    await expect(resetLocalDatabase(guard)).rejects.toThrow('active owned');
    expect(profileLeaseMocks.clear).toHaveBeenCalledOnce();
  });

  it('keeps resetting the profile main resolved first, even if its inputs change afterwards', async () => {
    const { resetLocalDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    const before = getDatabaseDiagnostics().databaseProfile;
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'a-different-profile';

    await resetLocalDatabase();

    expect(before).toBe('test-profile');
    expect(profileLeaseMocks.acquire).toHaveBeenCalledWith(
      path.join('/mock/documents', 'BrainStrike-dev', 'profiles', before ?? '')
    );
    expect(profileLeaseMocks.clear).toHaveBeenCalledOnce();
  });

  it('rejects, and deletes and backs up nothing, when the DB host cannot be closed', async () => {
    dbHostManagerMocks.closeDbHostManager.mockRejectedValueOnce(new Error('DB host close failed'));
    const { resetLocalDatabase } = await import('../../db-main');

    await expect(resetLocalDatabase()).rejects.toThrow('DB host close failed');

    expect(profileLeaseMocks.acquire).not.toHaveBeenCalled();
    expect(profileLeaseMocks.clear).not.toHaveBeenCalled();
    expect(fsMocks.cpSync).not.toHaveBeenCalled();
    expect(fsMocks.rmSync).not.toHaveBeenCalled();
  });
});
