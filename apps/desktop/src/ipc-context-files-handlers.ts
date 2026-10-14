/**
 * Pure handler logic for the workspace context-files scan IPC (dependency-
 * injected roots + reader for testability). The renderer's Workspace
 * Instructions settings panel calls this to display each mounted root's detected
 * `AGENTS.md`/`AGENT.md`/`CLAUDE.md` — its size, token estimate, and injection
 * status — so the user can opt an OVERSIZED file in.
 */

import { readWorkspaceTextFile } from '@brainstrike/host-capabilities/native-tools';
import type { WorkspaceRootPort } from '@brainstrike/state-store';
import type { WorkspaceFileReader } from './assistant-server/workspace-instructions-context';
import {
  scanWorkspaceContextFiles,
  type WorkspaceContextFileStatus,
} from './assistant-server/workspace-instructions-scan';
import { loadWorkspaceRootsFromCatalog } from './assistant-server/workspace-roots';

export interface ContextFilesScanDeps {
  /** Reads a guarded workspace text file. Defaults to `readWorkspaceTextFile`. */
  readonly readFile?: WorkspaceFileReader;
  /** Required authoritative workspace-root catalog. */
  readonly workspaceRoots: WorkspaceRootPort;
}

export async function scanWorkspaceContextFilesForReview(
  deps: ContextFilesScanDeps
): Promise<WorkspaceContextFileStatus[]> {
  const readFile = deps.readFile ?? readWorkspaceTextFile;
  const roots = await loadWorkspaceRootsFromCatalog(deps.workspaceRoots);
  return scanWorkspaceContextFiles(roots, readFile);
}
