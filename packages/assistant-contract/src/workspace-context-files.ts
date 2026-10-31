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
