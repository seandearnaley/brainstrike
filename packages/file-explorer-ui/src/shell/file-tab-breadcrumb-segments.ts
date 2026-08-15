import type { BreadcrumbSegment } from '@brainstrike/ui';

/**
 * Derive breadcrumb segments for a file tab (BST-1269). Labels are the path
 * segments RELATIVE to the workspace root; each segment's `path` is the
 * cumulative tree-node path — sliced from the ORIGINAL string, so separator
 * style ('/' or Windows '\\') is preserved and clicks feed
 * OptimizedFileTree's `revealPath` without translation.
 */
export function buildFileBreadcrumbSegments(
  path: string,
  rootPath: string | null
): BreadcrumbSegment[] {
  const isUnderRoot =
    rootPath !== null &&
    (path === rootPath || path.startsWith(`${rootPath}/`) || path.startsWith(`${rootPath}\\`));
  const startIndex = isUnderRoot && rootPath !== null ? rootPath.length + 1 : 0;

  const segments: BreadcrumbSegment[] = [];
  let segmentStart = startIndex;
  for (let index = startIndex; index <= path.length; index += 1) {
    const isBoundary = index === path.length || path[index] === '/' || path[index] === '\\';
    if (!isBoundary) {
      continue;
    }
    if (index > segmentStart) {
      segments.push({ label: path.slice(segmentStart, index), path: path.slice(0, index) });
    }
    segmentStart = index + 1;
  }
  return segments;
}
