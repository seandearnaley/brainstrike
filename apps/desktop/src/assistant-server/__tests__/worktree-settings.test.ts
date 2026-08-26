import path from 'node:path';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultManagedWorktreeDirectory,
  readWorktreeSettings,
  WORKTREE_SETTINGS_STORAGE_KEY,
  writeWorktreeSettings,
} from '../worktree-settings';

const HOME_DIRECTORY = '/Users/tester';
const DEFAULT_MANAGED_DIRECTORY = path.join(HOME_DIRECTORY, '.brainstrike', 'worktrees');
const NO_MOUNTED_ROOTS = () => Promise.resolve([]);
const ORIGINAL_ARGV = [...process.argv];

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('worktree settings', () => {
  it('defaults the managed directory when nothing is persisted', async () => {
    const storage = new MemoryStorageAdapter();

    await expect(readWorktreeSettings(storage, HOME_DIRECTORY)).resolves.toEqual({
      isDefaultDirectory: true,
      managedDirectory: DEFAULT_MANAGED_DIRECTORY,
      setupCommand: null,
    });
  });

  it('exports the stable storage key and default directory helper', () => {
    expect(WORKTREE_SETTINGS_STORAGE_KEY).toBe('worktreeSettings');
    expect(defaultManagedWorktreeDirectory(HOME_DIRECTORY)).toBe(DEFAULT_MANAGED_DIRECTORY);
  });

  it('uses an absolute managed-directory override in desktop E2E test mode', async () => {
    process.argv = ORIGINAL_ARGV.filter((argument) => argument !== '--test-mode');
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
    vi.stubEnv('BRAINSTRIKE_E2E_WORKTREE_DIR', '/tmp/brainstrike-e2e-worktrees');
    vi.resetModules();
    const { defaultManagedWorktreeDirectory: readDefaultDirectory } = await import(
      '../worktree-settings'
    );

    expect(readDefaultDirectory(HOME_DIRECTORY)).toBe('/tmp/brainstrike-e2e-worktrees');
  });

  it('throws for a relative managed-directory override in desktop E2E test mode', async () => {
    process.argv = ORIGINAL_ARGV.filter((argument) => argument !== '--test-mode');
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'true');
    vi.stubEnv('BRAINSTRIKE_E2E_WORKTREE_DIR', 'relative/worktrees');
    vi.resetModules();
    const { defaultManagedWorktreeDirectory: readDefaultDirectory } = await import(
      '../worktree-settings'
    );

    expect(() => readDefaultDirectory(HOME_DIRECTORY)).toThrow(
      'BRAINSTRIKE_E2E_WORKTREE_DIR must be an absolute path.'
    );
  });

  it('ignores the managed-directory override outside desktop E2E test mode', async () => {
    process.argv = ORIGINAL_ARGV.filter((argument) => argument !== '--test-mode');
    vi.stubEnv('ELECTRON_IS_E2E_TEST', 'false');
    vi.stubEnv('BRAINSTRIKE_E2E_WORKTREE_DIR', '/tmp/brainstrike-e2e-worktrees');
    vi.resetModules();
    const { defaultManagedWorktreeDirectory: readDefaultDirectory } = await import(
      '../worktree-settings'
    );

    expect(readDefaultDirectory(HOME_DIRECTORY)).toBe(DEFAULT_MANAGED_DIRECTORY);
  });

  it('persists and reads a custom managed directory', async () => {
    const storage = new MemoryStorageAdapter();
    const customDirectory = '/Volumes/worktrees';

    await writeWorktreeSettings(
      storage,
      HOME_DIRECTORY,
      {
        managedDirectory: customDirectory,
        setupCommand: ['pnpm', 'install'],
      },
      NO_MOUNTED_ROOTS
    );

    await expect(readWorktreeSettings(storage, HOME_DIRECTORY)).resolves.toEqual({
      isDefaultDirectory: false,
      managedDirectory: customDirectory,
      setupCommand: ['pnpm', 'install'],
    });
  });

  it('round-trips the explicit disabled setup state', async () => {
    const storage = new MemoryStorageAdapter();

    await writeWorktreeSettings(
      storage,
      HOME_DIRECTORY,
      {
        managedDirectory: null,
        setupCommand: 'disabled',
      },
      NO_MOUNTED_ROOTS
    );

    await expect(readWorktreeSettings(storage, HOME_DIRECTORY)).resolves.toEqual({
      isDefaultDirectory: true,
      managedDirectory: DEFAULT_MANAGED_DIRECTORY,
      setupCommand: 'disabled',
    });
  });

  it('resets a custom managed directory to the default', async () => {
    const storage = new MemoryStorageAdapter();
    await writeWorktreeSettings(
      storage,
      HOME_DIRECTORY,
      {
        managedDirectory: '/Volumes/worktrees',
        setupCommand: null,
      },
      NO_MOUNTED_ROOTS
    );

    await expect(
      writeWorktreeSettings(
        storage,
        HOME_DIRECTORY,
        {
          managedDirectory: null,
          setupCommand: null,
        },
        NO_MOUNTED_ROOTS
      )
    ).resolves.toEqual({
      isDefaultDirectory: true,
      managedDirectory: DEFAULT_MANAGED_DIRECTORY,
      setupCommand: null,
    });
  });

  it('treats an explicitly stored default path as a custom selection', async () => {
    const storage = new MemoryStorageAdapter();

    await expect(
      writeWorktreeSettings(
        storage,
        HOME_DIRECTORY,
        {
          managedDirectory: DEFAULT_MANAGED_DIRECTORY,
          setupCommand: null,
        },
        NO_MOUNTED_ROOTS
      )
    ).resolves.toMatchObject({ isDefaultDirectory: false });
  });

  it('throws when persisted settings are not valid JSON', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setItem(WORKTREE_SETTINGS_STORAGE_KEY, '{');

    await expect(readWorktreeSettings(storage, HOME_DIRECTORY)).rejects.toThrow(
      'worktreeSettings is not valid JSON.'
    );
  });

  it('throws when persisted settings are not an object', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setItem(WORKTREE_SETTINGS_STORAGE_KEY, '[]');

    await expect(readWorktreeSettings(storage, HOME_DIRECTORY)).rejects.toThrow(
      'worktreeSettings is not an object.'
    );
  });

  it('throws when the persisted managed directory is relative', async () => {
    const storage = new MemoryStorageAdapter();
    await storage.setItem(
      WORKTREE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ managedDirectory: 'relative/worktrees', setupCommand: null })
    );

    await expect(readWorktreeSettings(storage, HOME_DIRECTORY)).rejects.toThrow(
      'worktreeSettings managedDirectory must be an absolute path.'
    );
  });

  it.each([
    { setupCommand: [] },
    { setupCommand: [''] },
    { setupCommand: ['pnpm', 42] },
    { setupCommand: 'run-the-repository-script' },
  ])('throws when persisted setupCommand is invalid: $setupCommand', async (persisted) => {
    const storage = new MemoryStorageAdapter();
    await storage.setItem(WORKTREE_SETTINGS_STORAGE_KEY, JSON.stringify(persisted));

    await expect(readWorktreeSettings(storage, HOME_DIRECTORY)).rejects.toThrow(
      'worktreeSettings setupCommand must be a non-empty string array, "disabled", or null.'
    );
  });

  it('refuses to persist a relative managed directory', async () => {
    const storage = new MemoryStorageAdapter();

    await expect(
      writeWorktreeSettings(
        storage,
        HOME_DIRECTORY,
        { managedDirectory: 'relative/worktrees', setupCommand: null },
        NO_MOUNTED_ROOTS
      )
    ).rejects.toThrow('worktreeSettings managedDirectory must be an absolute path.');
  });

  it('never calls setItem when the write is refused (relative path)', async () => {
    const storage = new MemoryStorageAdapter();
    const setItemSpy = vi.spyOn(storage, 'setItem');

    await expect(
      writeWorktreeSettings(
        storage,
        HOME_DIRECTORY,
        { managedDirectory: 'relative/worktrees', setupCommand: null },
        NO_MOUNTED_ROOTS
      )
    ).rejects.toThrow('worktreeSettings managedDirectory must be an absolute path.');
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('refuses to persist a managed directory inside a mounted root', async () => {
    const storage = new MemoryStorageAdapter();

    await expect(
      writeWorktreeSettings(
        storage,
        HOME_DIRECTORY,
        { managedDirectory: '/work/project/worktrees', setupCommand: null },
        () => Promise.resolve(['/work/project'])
      )
    ).rejects.toThrow('Managed worktrees must not live inside the granted folder "/work/project"');
  });

  it('never calls setItem when the write is refused (containment)', async () => {
    const storage = new MemoryStorageAdapter();
    const setItemSpy = vi.spyOn(storage, 'setItem');

    await expect(
      writeWorktreeSettings(
        storage,
        HOME_DIRECTORY,
        { managedDirectory: '/work/project/worktrees', setupCommand: null },
        () => Promise.resolve(['/work/project'])
      )
    ).rejects.toThrow('Managed worktrees must not live inside the granted folder "/work/project"');
    expect(setItemSpy).not.toHaveBeenCalled();
  });
});
