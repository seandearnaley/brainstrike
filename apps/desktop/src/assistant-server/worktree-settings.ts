/**
 * Main-owned worktree settings (spec §6.1 [D3], §6.3). Stored under ONE
 * `ElectronStorageAdapter` key, parsed the way `workspace-recent-roots.ts`
 * parses its ledger: a corrupt or invalid value THROWS rather than coercing to
 * the default, because silently relocating the managed directory would strand
 * every existing worktree the ledger points at.
 */
import path from 'node:path';
import type { StorageAdapter } from '@brainstrike/storage';
import type { WorktreeSettings } from '@brainstrike/types';
import { assertWorktreeTargetOutsideRoots } from './worktree-paths';

export const WORKTREE_SETTINGS_STORAGE_KEY = 'worktreeSettings' as const;

interface StoredWorktreeSettings {
  readonly managedDirectory: string | null;
  readonly setupCommand: readonly string[] | null;
}

/** `~/.brainstrike/worktrees` — outside every granted root by construction [D3]. */
export function defaultManagedWorktreeDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, '.brainstrike', 'worktrees');
}

function parseStored(raw: string | null): StoredWorktreeSettings {
  if (raw === null) {
    return { managedDirectory: null, setupCommand: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('worktreeSettings is not valid JSON.', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('worktreeSettings is not an object.');
  }
  const record = parsed as Record<string, unknown>;
  const managedDirectory = record['managedDirectory'];
  if (
    managedDirectory !== undefined &&
    managedDirectory !== null &&
    (typeof managedDirectory !== 'string' || !path.isAbsolute(managedDirectory))
  ) {
    throw new Error('worktreeSettings managedDirectory must be an absolute path.');
  }
  const setupCommand = record['setupCommand'];
  if (
    setupCommand !== undefined &&
    setupCommand !== null &&
    (!Array.isArray(setupCommand) ||
      setupCommand.length === 0 ||
      !setupCommand.every((part) => typeof part === 'string' && part.length > 0))
  ) {
    throw new Error('worktreeSettings setupCommand must be a non-empty string array.');
  }
  return {
    managedDirectory: (managedDirectory as string | null | undefined) ?? null,
    setupCommand: (setupCommand as readonly string[] | null | undefined) ?? null,
  };
}

function project(stored: StoredWorktreeSettings, homeDirectory: string): WorktreeSettings {
  const fallback = defaultManagedWorktreeDirectory(homeDirectory);
  return {
    isDefaultDirectory: stored.managedDirectory === null,
    managedDirectory: stored.managedDirectory ?? fallback,
    setupCommand: stored.setupCommand,
  };
}

export async function readWorktreeSettings(
  storage: StorageAdapter,
  homeDirectory: string
): Promise<WorktreeSettings> {
  return project(parseStored(await storage.getItem(WORKTREE_SETTINGS_STORAGE_KEY)), homeDirectory);
}

/**
 * Validate and persist. The containment refusal is the SAME rule
 * `WorktreeService.create` applies, applied earlier so the user learns at save
 * time rather than at create time (BST-1342).
 */
export async function writeWorktreeSettings(
  storage: StorageAdapter,
  homeDirectory: string,
  next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
  },
  listMountedRootPaths: () => Promise<readonly string[]>
): Promise<WorktreeSettings> {
  if (next.managedDirectory !== null) {
    if (!path.isAbsolute(next.managedDirectory)) {
      throw new Error('worktreeSettings managedDirectory must be an absolute path.');
    }
    assertWorktreeTargetOutsideRoots(next.managedDirectory, await listMountedRootPaths());
  }
  const stored: StoredWorktreeSettings = {
    managedDirectory: next.managedDirectory,
    setupCommand: next.setupCommand,
  };
  await storage.setItem(WORKTREE_SETTINGS_STORAGE_KEY, JSON.stringify(stored));
  return project(stored, homeDirectory);
}
