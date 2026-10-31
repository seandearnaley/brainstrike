/**
 * Worktree settings (spec §6.1 [D3], §6.3), kept under ONE setting of the
 * agent host's state store beside the worktree ledger they locate (ADR-0029).
 * Parsed the way `workspace-recent-roots.ts` parses its ledger: a corrupt or
 * invalid value THROWS rather than coercing to the default, because silently
 * relocating the managed directory would strand every existing worktree the
 * ledger points at.
 */
import path from 'node:path';
import {
  type BoundaryFailureError,
  refusalError,
} from '@brainstrike/assistant-contract/boundary-failure';
import type { StateStore } from '@brainstrike/state-store';
import type { WorktreeSettings, WorktreeSetupCommand } from '@brainstrike/types';
import { assertWorktreeTargetOutsideRoots } from './worktree-paths.ts';

export const WORKTREE_SETTINGS_KEY = 'worktreeSettings' as const;

/** The state store's settings, which hold the worktree settings. */
export type WorktreeSettingsStore = Pick<StateStore, 'getSetting' | 'setSetting'>;

interface StoredWorktreeSettings {
  readonly managedDirectory: string | null;
  readonly setupCommand: WorktreeSetupCommand;
}

/**
 * `~/.brainstrike/worktrees` [D3]: the managed directory when the user saved
 * none. The composing host passes it (desktop E2E redirects it), so every
 * read and write projects the same default.
 */
export function defaultManagedWorktreeDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, '.brainstrike', 'worktrees');
}

/** A stored or submitted value the settings refuse, in words the user can act on. */
function settingsInvalid(message: string): BoundaryFailureError {
  return refusalError('input', 'worktree.settings-invalid', message);
}

function parseStored(raw: string | undefined): StoredWorktreeSettings {
  if (raw === undefined) {
    return { managedDirectory: null, setupCommand: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw settingsInvalid('worktreeSettings is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw settingsInvalid('worktreeSettings is not an object.');
  }
  const record = parsed as Record<string, unknown>;
  const managedDirectory = record['managedDirectory'];
  if (
    managedDirectory !== undefined &&
    managedDirectory !== null &&
    (typeof managedDirectory !== 'string' || !path.isAbsolute(managedDirectory))
  ) {
    throw settingsInvalid('worktreeSettings managedDirectory must be an absolute path.');
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
    throw settingsInvalid(
      'worktreeSettings setupCommand must be a non-empty string array, "disabled", or null.'
    );
  }
  return {
    managedDirectory: (managedDirectory as string | null | undefined) ?? null,
    setupCommand: (setupCommand as WorktreeSetupCommand | undefined) ?? null,
  };
}

function project(stored: StoredWorktreeSettings, defaultDirectory: string): WorktreeSettings {
  return {
    isDefaultDirectory: stored.managedDirectory === null,
    managedDirectory: stored.managedDirectory ?? defaultDirectory,
    setupCommand: stored.setupCommand,
  };
}

export async function readWorktreeSettings(
  store: WorktreeSettingsStore,
  defaultDirectory: string
): Promise<WorktreeSettings> {
  return project(parseStored(await store.getSetting(WORKTREE_SETTINGS_KEY)), defaultDirectory);
}

/**
 * Validate and persist. The containment refusal is the SAME rule
 * `WorktreeService.create` applies, applied earlier so the user learns at save
 * time rather than at create time (BST-1342).
 */
export async function writeWorktreeSettings(
  store: WorktreeSettingsStore,
  defaultDirectory: string,
  next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: WorktreeSetupCommand;
  },
  listMountedRootPaths: () => Promise<readonly string[]>
): Promise<WorktreeSettings> {
  if (next.managedDirectory !== null) {
    if (!path.isAbsolute(next.managedDirectory)) {
      throw settingsInvalid('worktreeSettings managedDirectory must be an absolute path.');
    }
    assertWorktreeTargetOutsideRoots(next.managedDirectory, await listMountedRootPaths());
  }
  const stored: StoredWorktreeSettings = {
    managedDirectory: next.managedDirectory,
    setupCommand: next.setupCommand,
  };
  await store.setSetting(WORKTREE_SETTINGS_KEY, JSON.stringify(stored));
  return project(stored, defaultDirectory);
}
