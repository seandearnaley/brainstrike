/**
 * Pure handler logic for the workspace context-files scan IPC (dependency-
 * injected roots + reader for testability). The renderer's Workspace
 * Instructions settings panel calls this to display each mounted root's detected
 * `AGENTS.md`/`AGENT.md`/`CLAUDE.md` — its size, token estimate, and injection
 * status — so the user can opt an OVERSIZED file in.
 */

import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { readWorkspaceTextFile } from './assistant-server/assistant-tools';
import type { WorkspaceFileReader } from './assistant-server/workspace-instructions-context';
import {
  scanWorkspaceContextFiles,
  type WorkspaceContextFileStatus,
} from './assistant-server/workspace-instructions-scan';
import { loadWorkspaceRootsFromDatabase } from './assistant-server/workspace-roots';
import { getDatabase } from './db-main';

export interface ContextFilesScanDeps {
  /** Loads the active, path-backed workspace roots. Defaults to the DB `roots` table. */
  readonly loadRoots?: () => Promise<readonly RuntimeWorkspaceRoot[]>;
  /** Reads a guarded workspace text file. Defaults to `readWorkspaceTextFile`. */
  readonly readFile?: WorkspaceFileReader;
}

export async function scanWorkspaceContextFilesForReview(
  deps: ContextFilesScanDeps = {}
): Promise<WorkspaceContextFileStatus[]> {
  const readFile = deps.readFile ?? readWorkspaceTextFile;
  const loadRoots =
    deps.loadRoots ??
    (async () => {
      const db = await getDatabase();
      return loadWorkspaceRootsFromDatabase(db);
    });
  const roots = await loadRoots();
  return scanWorkspaceContextFiles(roots, readFile);
}
