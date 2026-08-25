import path from 'node:path';
import type { StorageAdapter } from '@brainstrike/storage';
import type { WorktreeSettings } from '@brainstrike/types';

const WORKTREE_SETTINGS_STORAGE_KEY = 'worktree-settings';

interface PersistedWorktreeSettings {
  readonly managedDirectory: string | null;
  readonly setupCommand: readonly string[] | null;
}

function defaultManagedDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, '.brainstrike', 'worktrees');
}

function toSettings(persisted: PersistedWorktreeSettings, homeDirectory: string): WorktreeSettings {
  const defaultDir = defaultManagedDirectory(homeDirectory);
  const managedDirectory = persisted.managedDirectory ?? defaultDir;
  return {
    isDefaultDirectory: managedDirectory === defaultDir,
    managedDirectory,
    setupCommand: persisted.setupCommand ?? null,
  };
}

/** Read the persisted managed-worktree settings, defaulting when absent. */
export async function readWorktreeSettings(
  storage: StorageAdapter,
  homeDirectory: string
): Promise<WorktreeSettings> {
  const raw = await storage.getItem(WORKTREE_SETTINGS_STORAGE_KEY);
  if (raw === null) {
    return toSettings({ managedDirectory: null, setupCommand: null }, homeDirectory);
  }
  const parsed = JSON.parse(raw) as PersistedWorktreeSettings;
  return toSettings(parsed, homeDirectory);
}

/**
 * Persist managed-worktree settings. `managedDirectory: null` resets to the
 * built-in default. Only the raw fields are persisted — `isDefaultDirectory`
 * is always recomputed on read so it can never drift from the default path.
 */
export async function writeWorktreeSettings(
  storage: StorageAdapter,
  homeDirectory: string,
  next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
  }
): Promise<WorktreeSettings> {
  const persisted: PersistedWorktreeSettings = {
    managedDirectory: next.managedDirectory,
    setupCommand: next.setupCommand,
  };
  await storage.setItem(WORKTREE_SETTINGS_STORAGE_KEY, JSON.stringify(persisted));
  return toSettings(persisted, homeDirectory);
}
