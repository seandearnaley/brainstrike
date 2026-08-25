import path from 'node:path';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import { describe, expect, it } from 'vitest';
import { readWorktreeSettings, writeWorktreeSettings } from '../worktree-settings';

const HOME_DIRECTORY = '/Users/tester';
const DEFAULT_MANAGED_DIRECTORY = path.join(HOME_DIRECTORY, '.brainstrike', 'worktrees');

describe('worktree settings', () => {
  it('defaults the managed directory when nothing is persisted', async () => {
    const storage = new MemoryStorageAdapter();

    await expect(readWorktreeSettings(storage, HOME_DIRECTORY)).resolves.toEqual({
      isDefaultDirectory: true,
      managedDirectory: DEFAULT_MANAGED_DIRECTORY,
      setupCommand: null,
    });
  });

  it('persists and reads a custom managed directory', async () => {
    const storage = new MemoryStorageAdapter();
    const customDirectory = '/Volumes/worktrees';

    await writeWorktreeSettings(storage, HOME_DIRECTORY, {
      managedDirectory: customDirectory,
      setupCommand: ['pnpm', 'install'],
    });

    await expect(readWorktreeSettings(storage, HOME_DIRECTORY)).resolves.toEqual({
      isDefaultDirectory: false,
      managedDirectory: customDirectory,
      setupCommand: ['pnpm', 'install'],
    });
  });

  it('resets a custom managed directory to the default', async () => {
    const storage = new MemoryStorageAdapter();
    await writeWorktreeSettings(storage, HOME_DIRECTORY, {
      managedDirectory: '/Volumes/worktrees',
      setupCommand: null,
    });

    await expect(
      writeWorktreeSettings(storage, HOME_DIRECTORY, {
        managedDirectory: null,
        setupCommand: null,
      })
    ).resolves.toEqual({
      isDefaultDirectory: true,
      managedDirectory: DEFAULT_MANAGED_DIRECTORY,
      setupCommand: null,
    });
  });
});
