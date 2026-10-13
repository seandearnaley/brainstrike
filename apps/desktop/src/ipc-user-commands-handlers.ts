/** Desktop command discovery uses the required authoritative root catalog.
 * Catalog failures reject discovery; a successful empty inventory still scans
 * global commands. No database owner is acquired by this consumer.
 */

import { homedir } from 'node:os';
import type { UserSlashCommandsListResult } from '@brainstrike/assistant-contract';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import { createNodeFsScanDeps } from './assistant-server/node-fs-scan-deps';
import {
  scanUserSlashCommands,
  type UserSlashCommandScanDeps,
  type UserSlashCommandScanRoot,
} from './assistant-server/user-slash-commands-loader';
import { loadWorkspaceRootsFromCatalog } from './assistant-server/workspace-roots';

export interface UserCommandsListDeps {
  /** Injected fs surface (real disk in production, in-memory in tests). */
  readonly fs: UserSlashCommandScanDeps;
  /** The user's home directory (for `~/.brainstrike` / `~/.claude`). */
  readonly homedir: () => string;
  /** Required authoritative workspace-root catalog. */
  readonly workspaceRoots: WorkspaceRootPort;
}

export async function resolveScanRoots(
  workspaceRoots: WorkspaceRootPort
): Promise<UserSlashCommandScanRoot[]> {
  const roots = await loadWorkspaceRootsFromCatalog(workspaceRoots);
  return roots.map((root) => ({
    absPath: root.path,
    displayName: root.displayName,
    id: root.rootId,
  }));
}

export async function listUserSlashCommands(
  deps: UserCommandsListDeps
): Promise<UserSlashCommandsListResult> {
  const roots = await resolveScanRoots(deps.workspaceRoots);
  const commands = scanUserSlashCommands({ homeDir: deps.homedir(), roots }, deps.fs);
  return {
    commands,
    roots: roots.map((root) => ({ displayName: root.displayName, id: root.id })),
  };
}

/** Production borrows the catalog and owns only its per-scan filesystem handle. */
export function createUserCommandsListHandler(
  workspaceRoots: WorkspaceRootPort
): () => Promise<UserSlashCommandsListResult> {
  return async () => {
    const filesystem = createNodeFsScanDeps();
    try {
      return await listUserSlashCommands({
        fs: filesystem,
        homedir,
        workspaceRoots,
      });
    } finally {
      filesystem.dispose();
    }
  };
}
