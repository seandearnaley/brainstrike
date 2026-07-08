/**
 * Shared cwd resolution for desktop IPC domains that run inside a workspace root
 * (git, terminal). A renderer-supplied `rootId` is resolved + containment-checked
 * against the DB-backed workspace roots (the SAME source the read/search tools
 * use), then canonicalized with `realpath`. The canonical root is the pinned cwd:
 * commands/shells run AT the root, never an arbitrary path.
 *
 * Rejections (all `{ ok: false }`, never a throw):
 * - empty/non-string rootId,
 * - a rootId that matches no known root (no arbitrary cwd),
 * - a web (FSA) root with no absolute filesystem path,
 * - a root whose path no longer resolves on disk.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { ScopedLogger } from '@brainstrike/utils/logger';

/** Resolves the active path-backed workspace roots for cwd validation. */
export interface WorkspaceRootResolver {
  /** Returns the known roots as `{ rootId, path, displayName }`. */
  listRoots: () => Promise<readonly { displayName: string; path: string; rootId: string }[]>;
}

/** Structural result so callers can return it verbatim across IPC. */
export type RootCwdResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Resolve a renderer-supplied `rootId` to a canonical, containment-checked
 * absolute path. `domain` names the caller (for error text); `logger` records a
 * roots-load failure.
 */
export async function resolveRootCwd(
  resolver: WorkspaceRootResolver,
  rootId: unknown,
  domain: string,
  logger: Pick<ScopedLogger, 'error'>
): Promise<RootCwdResult> {
  if (typeof rootId !== 'string' || rootId.trim().length === 0) {
    return { error: `${domain} requires a non-empty rootId string`, ok: false };
  }
  const trimmed = rootId.trim();
  let roots: readonly { displayName: string; path: string; rootId: string }[];
  try {
    roots = await resolver.listRoots();
  } catch (error) {
    logger.error(`Failed to load workspace roots for ${domain} domain`, { error });
    return { error: 'Workspace roots are unavailable.', ok: false };
  }
  const match = roots.find((root) => root.rootId === trimmed);
  if (!match) {
    return { error: `No open folder matches root id "${trimmed}".`, ok: false };
  }
  if (!path.isAbsolute(match.path)) {
    // Web / FSA roots have no real filesystem path → not addressable.
    return { error: 'The selected folder has no local filesystem path.', ok: false };
  }
  try {
    const canonicalRoot = await fsPromises.realpath(match.path);
    return { ok: true, value: canonicalRoot };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { error: 'The selected folder no longer exists on disk.', ok: false };
    }
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  }
}
