// Shared path utilities for platform-specific path resolution

export function finalPath(
  platform: 'electron' | 'web',
  entryPath: string,
  relativePath: string
): string {
  return platform === 'electron' ? entryPath : relativePath;
}

/** Extracts non-empty path segments without allocating intermediate arrays. */
export function extractPathSegments(path: string): string[] {
  const segments: string[] = [];
  const len = path.length;
  if (len === 0) {
    return segments;
  }

  let startIdx = 0;
  let idx = path.indexOf('/');

  while (idx !== -1) {
    if (idx > startIdx) {
      segments.push(path.slice(startIdx, idx));
    }
    startIdx = idx + 1;
    idx = path.indexOf('/', startIdx);
  }

  if (startIdx < len) {
    segments.push(path.slice(startIdx));
  }

  return segments;
}

/** Calculates path depth without allocating arrays. */
export function calculatePathDepth(path: string): number {
  let depth = 0;
  let idx = path.indexOf('/');
  while (idx !== -1) {
    depth++;
    idx = path.indexOf('/', idx + 1);
  }
  return depth;
}
