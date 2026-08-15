import type { BreadcrumbSegment } from '@brainstrike/ui';

/**
 * Derive breadcrumb segments for a file tab (BST-1269). Labels are the path
 * segments RELATIVE to the workspace root; each segment's `path` is the
 * cumulative tree-node path (root-absolute), so a breadcrumb click can feed
 * OptimizedFileTree's `revealPath` without translation.
 */
export function buildFileBreadcrumbSegments(
  path: string,
  rootPath: string | null
): BreadcrumbSegment[] {
  const root =
    rootPath !== null && (path === rootPath || path.startsWith(`${rootPath}/`)) ? rootPath : null;
  const relative = root ? path.slice(root.length + 1) : path;
  const parts = relative.split('/').filter(Boolean);
  const isAbsolute = path.startsWith('/');

  let cursor = root ?? '';
  return parts.map((part) => {
    if (cursor) {
      cursor = `${cursor}/${part}`;
    } else {
      cursor = isAbsolute ? `/${part}` : part;
    }
    return { label: part, path: cursor };
  });
}
