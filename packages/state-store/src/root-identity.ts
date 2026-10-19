import { realpathSync } from 'node:fs';

/**
 * A data root's identity (BST-2234): the operating system's canonical path, from realpath(3) on POSIX and
 * GetFinalPathNameByHandleW on Windows (`fs.realpathSync.native`). The root lock records it, and every check that a
 * lock, profile or reset target is this root derives it here, so a root has exactly one spelling.
 *
 * Node's JavaScript `fs.realpathSync` replaces only symbolic links. It keeps a component's case on a case-insensitive
 * file system and a Windows 8.3 short name such as `RUNNER~1`, so two derivations of one root disagreed. A path that
 * cannot be canonicalized throws.
 */
export function canonicalRoot(path: string): string {
  return realpathSync.native(path);
}
