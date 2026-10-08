import path from 'node:path';

/**
 * Platform path-identity primitives, shared by the read authority, the mount
 * table, and the persisted stores. Kept in one leaf module so the two halves
 * of the same case-folding concern (`pathsEqual` for identity, `pathKey` for
 * Set/Map keys) cannot drift apart, and so the storage helpers need not
 * depend on the read-authority module just to compare two strings.
 *
 * Lexical only: none of these authorize a read. Realpath preflight and
 * containment-after-canonicalization stay in workspace-root-read.
 */

export function isContained(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === '' ||
    !(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
  );
}

export function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

/** The `pathsEqual` equivalence relation, reduced to a Set/Map key. */
export function pathKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
