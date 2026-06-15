import path from 'node:path';

const DOT_CHAR_CODE = 46;
const SLASH_CHAR_CODE = 47;

/**
 * Pure, OS-portable helpers for the assistant's *virtual* workspace paths.
 *
 * The assistant addresses files with POSIX-style, workspace-relative paths
 * (always "/"-separated, conceptually rooted at the selected workspace folder).
 * These helpers never touch the filesystem — they only normalise and reason
 * about the virtual path string. Real filesystem access is resolved and
 * containment-checked separately (see `resolveWorkspaceAbsolutePath` in
 * `assistant-tools.ts`, which also follows symlinks via `realpath`).
 *
 * Keeping this logic pure and centralised means it can be unit-tested without a
 * temp-dir harness and behaves identically on macOS, Linux, and Windows.
 */

/**
 * Normalise a virtual workspace path.
 *
 * - Accepts Windows separators and mixed separators (converted to "/").
 * - Collapses ".", duplicate slashes, and trailing slashes.
 * - Clamps ".." at the root so a virtual path can never escape the workspace by
 *   construction (the realpath containment check remains as defence-in-depth for
 *   symlinks).
 * - Preserves the caller's rooting convention: a rooted input ("/src") stays
 *   rooted, a relative input ("src") stays relative. This keeps selection-match
 *   keys stable across the directory listing, file read, and selection tools.
 *
 * A bare ".", "", "./", or whitespace resolves to the root "/".
 */
export function normalizeWorkspacePath(value: string): string {
  const forward = value.trim().replace(/\\/g, '/');
  if (forward.length === 0) {
    return '/';
  }
  const isRooted = forward.startsWith('/');
  // Root before normalising so POSIX semantics clamp ".." at "/" — escapes are
  // impossible by construction. This also collapses "." and duplicate slashes.
  const normalizedRooted = path.posix.normalize(`/${forward.replace(/^\/+/, '')}`);
  const withoutTrailing =
    normalizedRooted.length > 1 ? normalizedRooted.replace(/\/+$/, '') : normalizedRooted;
  if (withoutTrailing === '/') {
    return '/';
  }
  return isRooted ? withoutTrailing : withoutTrailing.slice(1);
}

/**
 * Normalise a list of virtual workspace paths, dropping blanks and
 * de-duplicating equivalent paths.
 */
export function normalizeWorkspacePaths(paths: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const filePath of paths) {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      continue;
    }
    unique.add(normalizeWorkspacePath(filePath));
  }
  return Array.from(unique);
}

/** Split a virtual path into its non-empty segments (leading "/" dropped). */
export function toPathSegments(workspacePath: string): string[] {
  return workspacePath
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
}

/** Join base + child segments into a single rooted virtual path. */
export function joinSegments(
  baseSegments: readonly string[],
  childSegments: readonly string[]
): string {
  const merged = [...baseSegments, ...childSegments].filter((segment) => segment.length > 0);
  return `/${merged.join('/')}`;
}

/** True when any segment of the virtual path is dot-prefixed (e.g. ".git"). */
export function isHiddenPath(entryPath: string): boolean {
  // Directory listings call this for every child. Scan in place so ordinary
  // visible paths do not allocate a full segment array just to answer a boolean.
  for (let index = 0; index < entryPath.length; index += 1) {
    const code = entryPath.charCodeAt(index);
    if (code === SLASH_CHAR_CODE) {
      continue;
    }
    if (code === DOT_CHAR_CODE) {
      return true;
    }
    const nextSlash = entryPath.indexOf('/', index);
    if (nextSlash === -1) {
      return false;
    }
    index = nextSlash;
  }
  return false;
}

/**
 * Pure containment check: is `canonicalTargetPath` the root itself or a
 * descendant of `canonicalRootPath`? Both arguments must be canonical absolute
 * paths (e.g. from `fs.realpath`). Uses `path.relative`/`path.isAbsolute`, so it
 * respects the host's separator and is correct on every OS (including a Windows
 * path that resolves onto a different drive).
 */
export function isWithinRoot(canonicalRootPath: string, canonicalTargetPath: string): boolean {
  if (canonicalTargetPath === canonicalRootPath) {
    return true;
  }
  const relativeFromRoot = path.relative(canonicalRootPath, canonicalTargetPath);
  return (
    relativeFromRoot.length > 0 &&
    !relativeFromRoot.startsWith('..') &&
    !path.isAbsolute(relativeFromRoot)
  );
}
