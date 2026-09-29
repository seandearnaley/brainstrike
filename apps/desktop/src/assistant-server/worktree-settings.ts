/**
 * Main-owned worktree settings (spec §6.1 [D3], §6.3). Stored under ONE
 * `ElectronStorageAdapter` key, parsed the way `workspace-recent-roots.ts`
 * parses its ledger: a corrupt or invalid value THROWS rather than coercing to
 * the default, because silently relocating the managed directory would strand
 * every existing worktree the ledger points at.
 */
import path from 'node:path';
import type { StorageAdapter } from '@brainstrike/storage';
import type { WorktreeSettings, WorktreeSetupCommand } from '@brainstrike/types';
import { isElectronE2ETestMode } from '../electron-e2e-test-mode';
import { assertWorktreeTargetOutsideRoots } from './worktree-paths';

export const WORKTREE_SETTINGS_STORAGE_KEY = 'worktreeSettings' as const;

interface StoredWorktreeSettings {
  readonly managedDirectory: string | null;
  readonly setupCommand: WorktreeSetupCommand;
}

const DESKTOP_TEST_MODE = isElectronE2ETestMode();

/**
 * `~/.brainstrike/worktrees` [D3]. In desktop E2E the location is redirected
 * through `BRAINSTRIKE_E2E_WORKTREE_DIR` so a test can never create worktrees
 * in the developer's real home directory. Gated on the same test-mode check
 * every other E2E hook in this app uses — it is inert in a shipped build.
 */
export function defaultManagedWorktreeDirectory(homeDirectory: string): string {
  const override = DESKTOP_TEST_MODE ? process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'] : undefined;
  if (override === undefined) {
    return path.join(homeDirectory, '.brainstrike', 'worktrees');
  }
  if (!path.isAbsolute(override)) {
    throw new Error('BRAINSTRIKE_E2E_WORKTREE_DIR must be an absolute path.');
  }
  return override;
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
    setupCommand !== 'disabled' &&
    (!Array.isArray(setupCommand) ||
      setupCommand.length === 0 ||
      !setupCommand.every((part) => typeof part === 'string' && part.length > 0))
  ) {
    throw new Error(
      'worktreeSettings setupCommand must be a non-empty string array, "disabled", or null.'
    );
  }
  return {
    managedDirectory: (managedDirectory as string | null | undefined) ?? null,
    setupCommand: (setupCommand as WorktreeSetupCommand | undefined) ?? null,
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
    readonly setupCommand: WorktreeSetupCommand;
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
