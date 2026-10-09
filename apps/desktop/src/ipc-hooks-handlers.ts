/**
 * Pure handler logic for the hooks review IPC (dependency-injected fs + DB-root
 * resolution for testability). The renderer's Hooks settings panel calls this to
 * display a project root's `.brainstrike/hooks.json` for review before approval;
 * the server remains the trust authority (it re-hashes disk on every request).
 *
 * Two security properties live here:
 * - CONTAINMENT: the reviewed path MUST resolve (realpath'd) to a currently
 *   mounted DB `roots` row. An arbitrary absolute path — or a project hooks file
 *   that symlinks OUT of its root — is refused, so the renderer can never coax
 *   main into reading and returning file content outside the workspace (mirrors
 *   the asset-protocol containment precedent).
 * - DB-ID CORRELATION: the review returns the DB `roots.id` for the resolved
 *   root. The renderer keys trust by THAT id (stable across a remove→re-add),
 *   the same id the server matches on — so approve/revoke can never target a
 *   dead adapter-id entry while the server keeps trusting a live grant.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import {
  getProjectHooksPath,
  readProjectHookConfig,
  sha256OfBuffer,
} from '@brainstrike/host-capabilities/hooks';

const HOOKS_READ_ERROR = 'hooks.json could not be read';

export interface DbRootLite {
  readonly id: string;
  readonly path: string;
}

export interface ProjectHooksReview {
  /** The hash the host trusts this root's hooks at, when it trusts them at this path. */
  readonly approvedSha256?: string;
  readonly content?: string;
  readonly dbRootId?: string;
  readonly error?: string;
  readonly exists: boolean;
  readonly parseError?: string;
  readonly path: string;
  readonly rootId: string;
  readonly sha256?: string;
}

export interface HooksReviewDeps {
  /**
   * Reads the RAW file bytes. The review hash MUST be computed from these bytes
   * (via `sha256OfBuffer`), byte-identically to the server's load-time trust
   * hash — a utf8-decoded-string hash would diverge for BOM/non-utf8 bytes and
   * an approval would silently never take.
   */
  readonly readFile?: (path: string) => ReturnType<typeof readProjectHookConfig>;
  /**
   * Resolves an absolute path to its realpath. Used to detect a hooks file that
   * symlinks out of its workspace root. Injectable for tests.
   */
  readonly realpath?: (path: string) => string;
  /**
   * Resolves an absolute path to the mounted DB root that CONTAINS it, or null.
   * Built in the IPC layer from the DB `roots` table; the security containment
   * gate. No default — the caller MUST supply it (fail closed).
   */
  readonly resolveDbRoot: (absPath: string) => DbRootLite | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRealpath(path: string, realpath: (p: string) => string): string | null {
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

/** `child` is `parent` itself or nested beneath it (both already realpath'd). */
function isContained(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * Resolve an absolute path to the mounted DB root that contains it (realpath'd
 * containment; the longest/most-specific root wins for nested roots). Returns
 * null when no mounted root contains the path — the caller then fails closed.
 */
export function resolveDbRootForPath(
  absPath: string,
  dbRoots: readonly DbRootLite[],
  realpath: (p: string) => string
): DbRootLite | null {
  const targetReal = safeRealpath(absPath, realpath) ?? resolve(absPath);
  let best: DbRootLite | null = null;
  let bestLen = -1;
  for (const root of dbRoots) {
    const rootReal = safeRealpath(root.path, realpath) ?? resolve(root.path);
    if (isContained(targetReal, rootReal) && rootReal.length > bestLen) {
      best = root;
      bestLen = rootReal.length;
    }
  }
  return best;
}

export function getProjectHooksForReview(
  rootId: unknown,
  absPath: unknown,
  deps: HooksReviewDeps
): ProjectHooksReview {
  const read = deps.readFile ?? readProjectHookConfig;
  const realpath = deps.realpath ?? realpathSync;
  if (typeof rootId !== 'string' || rootId.length === 0) {
    return { error: 'rootId must be a non-empty string', exists: false, path: '', rootId: '' };
  }
  if (typeof absPath !== 'string' || absPath.trim().length === 0 || !isAbsolute(absPath.trim())) {
    return {
      error: 'root path must be a non-empty absolute path',
      exists: false,
      path: '',
      rootId,
    };
  }

  // CONTAINMENT: refuse any path that is not a currently-mounted workspace root.
  const dbRoot = deps.resolveDbRoot(absPath.trim());
  if (!dbRoot) {
    return {
      error: 'root path is not within a mounted workspace root',
      exists: false,
      path: '',
      rootId,
    };
  }

  const path = getProjectHooksPath(dbRoot.path);

  // Refuse a hooks file that symlinks OUT of its root BEFORE any read
  // (info-disclosure guard, mirrors the asset-protocol containment precedent): a
  // symlink target could be an arbitrary/large file, so main must never load its
  // bytes and only afterward decide to refuse them. A missing file (or broken
  // symlink) realpaths to null → treated as "does not exist".
  const realRoot = safeRealpath(dbRoot.path, realpath) ?? resolve(dbRoot.path);
  const realHooks = safeRealpath(path, realpath);
  if (realHooks === null) {
    return { dbRootId: dbRoot.id, exists: false, path, rootId };
  }
  if (!isContained(realHooks, realRoot)) {
    return {
      dbRootId: dbRoot.id,
      error: 'hooks file resolves outside the workspace root',
      exists: false,
      path,
      rootId,
    };
  }

  // Read the VALIDATED realpath, never the requested path (matches the
  // asset-protocol precedent, which fetches the resolved path): reading `path`
  // after validating `realHooks` would leave a swap-to-symlink race where the
  // read follows a link created between the check and the read. A read failure
  // here (permissions, TOCTOU unlink) is "does not exist".
  let bytes: Buffer;
  try {
    const result = read(realHooks);
    if (!Buffer.isBuffer(result)) {
      const error = result ?? HOOKS_READ_ERROR;
      return { dbRootId: dbRoot.id, error, exists: true, path, rootId };
    }
    bytes = result;
  } catch {
    return { dbRootId: dbRoot.id, error: HOOKS_READ_ERROR, exists: true, path, rootId };
  }

  // Hash the RAW bytes (byte-identical to the server trust hash), then decode
  // for display + parse. A single read backs both the hash and the content.
  const sha256 = sha256OfBuffer(bytes);
  const content = bytes.toString('utf8');
  let parseError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) {
      parseError = 'root of hooks.json must be a JSON object';
    }
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  return {
    content,
    dbRootId: dbRoot.id,
    exists: true,
    path,
    rootId,
    sha256,
    ...(parseError ? { parseError } : {}),
  };
}
