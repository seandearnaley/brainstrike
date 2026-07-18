/**
 * Root scoping for workspace-global path sets.
 *
 * Expansion state (and its persisted twin) is a single workspace-global set of
 * directory paths spanning every active root. These helpers apply the settled
 * root-scoping semantics (see docs/agents/ui-conventions.md, "Persisted
 * expansion restoration is scoped to the active root path"):
 *
 * - An absolute root keeps only itself and its descendants; Windows
 *   comparisons normalize separators and casing WITHOUT changing the path
 *   identity that is stored or handed to workers.
 * - A relative root (web File System Access exposes only a folder name) keeps
 *   every relative path and excludes stale absolute paths. Two web roots can
 *   therefore still see each other's relative paths — the accepted phase-4
 *   limitation; desktop (absolute) roots scope exactly.
 */
import { isAbsolutePath } from '@brainstrike/context-actions';
import { isDescendantPath } from '@brainstrike/utils/tree-operations';

export function normalizePathForRootScope(path: string): string {
  return path.replace(/\\/g, '/');
}

function isWindowsAbsolutePath(path: string): boolean {
  const normalizedPath = normalizePathForRootScope(path);
  return /^[A-Za-z]:\//u.test(normalizedPath) || normalizedPath.startsWith('//');
}

export function isPathWithinRoot(
  path: string,
  currentRootPath: string | null | undefined
): boolean {
  if (!currentRootPath) {
    return true;
  }
  if (!isAbsolutePath(currentRootPath)) {
    return !isAbsolutePath(path);
  }
  const normalizedPath = normalizePathForRootScope(path);
  const normalizedRootPath = normalizePathForRootScope(currentRootPath);
  const scopedPath = isWindowsAbsolutePath(currentRootPath)
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const scopedRootPath = isWindowsAbsolutePath(currentRootPath)
    ? normalizedRootPath.toLowerCase()
    : normalizedRootPath;
  if (/^\/+$/u.test(scopedRootPath)) {
    return scopedPath.startsWith(scopedRootPath);
  }
  const descendantRootPath = scopedRootPath.endsWith('/')
    ? scopedRootPath.slice(0, -1)
    : scopedRootPath;
  const isWindowsDriveRoot = /^[a-z]:\/$/u.test(scopedRootPath);
  return (
    scopedPath === scopedRootPath ||
    (!isWindowsDriveRoot && scopedPath === descendantRootPath) ||
    isDescendantPath(scopedPath, descendantRootPath)
  );
}

/**
 * Restrict a workspace-global expanded-path set to one root's scope. Returns
 * the INPUT set unchanged (same identity) when no root path is known or when
 * every member is already in scope, so content-equality selectors get the
 * cheap identity fast-path in the common single-root case.
 */
export function scopeExpandedPathsToRoot(
  expandedPaths: Set<string>,
  rootPath: string | null | undefined
): Set<string> {
  if (!rootPath) {
    return expandedPaths;
  }
  const scoped = new Set<string>();
  for (const path of expandedPaths) {
    if (isPathWithinRoot(path, rootPath)) {
      scoped.add(path);
    }
  }
  return scoped.size === expandedPaths.size ? expandedPaths : scoped;
}
