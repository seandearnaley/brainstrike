import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('terminates the DB host before deleting the profile directory from main', async () => {
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
    expect(fsMocks.rmSync).toHaveBeenCalledWith(expectedProfilePath, {
      force: true,
      recursive: true,
    });
    // Close-before-delete is what lets a reset (or a userData wipe that contains
    // the database root, as on packaged macOS) run against a quiesced directory.
    expect(dbHostManagerMocks.closeDbHostManager.mock.invocationCallOrder[0]).toBeLessThan(
      fsMocks.rmSync.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('keeps resetting the profile main resolved first, even if its inputs change afterwards', async () => {
    const { resetLocalDatabase, getDatabaseDiagnostics } = await import('../../db-main');
    const before = getDatabaseDiagnostics().databaseProfile;
    process.env['BRAINSTRIKE_DB_PROFILE'] = 'a-different-profile';

    await resetLocalDatabase();

    expect(before).toBe('test-profile');
    expect(fsMocks.rmSync).toHaveBeenCalledWith(
      path.join('/mock/documents', 'BrainStrike-dev', 'profiles', before ?? ''),
      { force: true, recursive: true }
    );
  });
});
