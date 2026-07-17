import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/utils/logger';
import {
  findRootContextFile,
  MAX_CONTEXT_FILE_CHARS,
  type WorkspaceFileReader,
} from './workspace-instructions-context';

const logger = createLogger('AssistantWorkspaceInstructionsScan');

/**
 * The Settings UI's per-root view of a detected workspace instructions file.
 * `status`:
 * - `none`     — no `AGENTS.md`/`AGENT.md`/`CLAUDE.md` at the root's top level.
 * - `fits`     — a file at/under the per-file char budget (auto-injected).
 * - `oversized`— a file over the budget (injected ONLY if the root is opted in;
 *                otherwise detected-but-not-injected).
 * - `error`    — the file could not be read (surfaced, never silently hidden).
 */
export interface WorkspaceContextFileStatus {
  approxTokens: number | null;
  displayName: string;
  error?: string;
  fileName: string | null;
  oversized: boolean;
  path: string | null;
  rootId: string;
  sizeBytes: number | null;
  status: 'none' | 'fits' | 'oversized' | 'error';
}

/**
 * Approximate token count using the same chars/4 heuristic as
 * `countTokensHeuristic`, so the Settings estimate matches the context-budget
 * machinery the assistant uses elsewhere.
 */
function approxTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Scan each mounted root for its first-match workspace instructions file and
 * report its size + token estimate + injection status for the Settings UI. The
 * reader is injected (the real `readWorkspaceTextFile` in the live wiring) so
 * this is unit-testable without disk. `oversized`/`status` are computed from the
 * file's CHARACTER length against {@link MAX_CONTEXT_FILE_CHARS}, byte-identical
 * to the injection path's threshold decision.
 */
export async function scanWorkspaceContextFiles(
  roots: readonly RuntimeWorkspaceRoot[],
  readFile: WorkspaceFileReader
): Promise<WorkspaceContextFileStatus[]> {
  const results = await Promise.all(
    roots.map(async (root): Promise<WorkspaceContextFileStatus> => {
      const base = { displayName: root.displayName, rootId: root.rootId } as const;
      const result = await findRootContextFile(root, readFile);

      if (result.kind === 'error') {
        // A present-but-unreadable file (binary, over the 2 MB cap, EACCES, …).
        // Surfaced as `error` so the Settings UI shows "Unavailable" — never
        // fabricated into "No file".
        logger.warn('Failed to scan workspace instructions file', {
          error: result.detail,
          fileName: result.fileName,
          rootId: root.rootId,
        });
        return {
          ...base,
          approxTokens: null,
          error: result.detail,
          fileName: null,
          oversized: false,
          path: null,
          sizeBytes: null,
          status: 'error',
        };
      }

      if (result.kind === 'none') {
        return {
          ...base,
          approxTokens: null,
          fileName: null,
          oversized: false,
          path: null,
          sizeBytes: null,
          status: 'none',
        };
      }

      const found = result.file;
      const oversized = found.content.length > MAX_CONTEXT_FILE_CHARS;
      return {
        ...base,
        approxTokens: approxTokensFromChars(found.content.length),
        fileName: found.path,
        oversized,
        path: found.path,
        sizeBytes: found.size,
        status: oversized ? 'oversized' : 'fits',
      };
    })
  );
  return results;
}
