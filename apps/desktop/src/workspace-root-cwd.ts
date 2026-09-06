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
import type { ScopedLogger } from '@brainstrike/logging';

/** Resolves the active path-backed workspace roots for cwd validation. */
export interface WorkspaceRootResolver {
  /** Returns the known roots as `{ rootId, path, displayName }`. */
  listRoots: () => Promise<readonly { displayName: string; path: string; rootId: string }[]>;
}

/** Structural result so callers can return it verbatim across IPC. */
export type RootCwdResult = { ok: true; value: string } | { ok: false; error: string };

/**
 * Path-free, categorized message for a non-`ENOENT` filesystem failure.
 * Node's own `error.message` embeds the offending absolute path (e.g.
 * `EACCES: permission denied, realpath '/Users/me/repo/...'`), which is
 * exactly what this module's docblock forbids returning over IPC. Only the
 * `code` (`EACCES`, `ELOOP`, `ENOTDIR`, …) is safe to surface.
 */
function describeFsFailure(subject: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return code ? `${subject} could not be resolved (${code}).` : `${subject} could not be resolved.`;
}

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
    return { error: describeFsFailure('The selected folder', error), ok: false };
  }
}

/**
 * Narrow an already-resolved root cwd to a REQUESTED subdirectory.
 *
 * `resolveRootCwd` answers "which open folder", this answers "where inside it".
 * The two are separate because the root answer is the authorization (an unknown
 * rootId is a hard refusal) while this is a containment narrowing: `requested`
 * must be absolute, must exist, must be a directory, and — after `realpath` on
 * BOTH sides — must be the root itself or lie beneath it.
 *
 * The containment test is SEPARATOR-ANCHORED (`${rootCwd}${path.sep}`), never a
 * bare `startsWith`: `/work/repo-evil` starts with `/work/repo` as a string and
 * is not inside it. Both sides are canonical before comparison, so a symlink
 * pointing out of the root cannot smuggle a path past the check. When
 * `rootCwd` is itself a filesystem root (`/`, `C:\`) it is already
 * sep-terminated, so the separator is NOT appended a second time — otherwise
 * every real descendant would fail to match a `//` / `C:\\` prefix.
 *
 * Error strings never embed a filesystem path (`platform-contracts.md`: cwd is
 * not something this layer hands back or logs at warn+).
 */
export async function resolveContainedCwd(
  rootCwd: string,
  requested: string | undefined,
  domain: string
): Promise<RootCwdResult> {
  if (requested === undefined) {
    return { ok: true, value: rootCwd };
  }
  // `typeof requested !== 'string'` is unreachable per the declared
  // `cwd?: string` type, but this is a renderer-supplied IPC boundary where
  // TypeScript's compile-time guarantee does not hold at runtime — defensive
  // depth, not dead code. Do not simplify this away.
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    return { error: `${domain} requires a non-empty cwd string when one is supplied.`, ok: false };
  }
  if (!path.isAbsolute(requested)) {
    return { error: `${domain} requires an absolute cwd path.`, ok: false };
  }
  let canonical: string;
  try {
    canonical = await fsPromises.realpath(requested);
    const stats = await fsPromises.stat(canonical);
    if (!stats.isDirectory()) {
      return { error: 'The requested working directory is not a directory.', ok: false };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { error: 'The requested working directory no longer exists on disk.', ok: false };
    }
    return { error: describeFsFailure('The requested working directory', error), ok: false };
  }
  // `rootCwd` can already be sep-terminated (a filesystem root: `/`, `C:\`).
  // Appending another separator would turn the prefix into `//` / `C:\\`,
  // which no real descendant can ever start with — skip the append instead.
  const rootPrefix = rootCwd.endsWith(path.sep) ? rootCwd : `${rootCwd}${path.sep}`;
  if (canonical !== rootCwd && !canonical.startsWith(rootPrefix)) {
    return { error: 'The requested working directory is outside the open folder.', ok: false };
  }
  return { ok: true, value: canonical };
}
