/**
 * Resolve `relative` against the directory of `baseFilePath` using pure string
 * math (no node:path — this runs in renderers). Returns a normalized path with
 * `/` separators, or null when the relative path climbs above the root of the
 * base path (an escape a caller must treat as out-of-workspace).
 */
export function resolveRelativePath(baseFilePath: string, relative: string): string | null {
  const isAbsolute = baseFilePath.startsWith('/');
  const baseSegments = baseFilePath.split(/[\\/]+/).filter((s) => s.length > 0);
  // Drop the file name; what remains is the directory.
  baseSegments.pop();
  const stack = [...baseSegments];
  for (const part of relative.split(/[\\/]+/)) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      if (stack.length === 0) {
        return null;
      }
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (stack.length === 0) {
    return null;
  }
  return (isAbsolute ? '/' : '') + stack.join('/');
}
