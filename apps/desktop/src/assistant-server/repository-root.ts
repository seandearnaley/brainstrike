import fsPromises from 'node:fs/promises';
import path from 'node:path';

/**
 * Locate the enclosing repository root by walking up for a `.git` entry (a
 * directory for a normal clone, a FILE for a worktree or submodule). Undefined
 * when the path is not inside a repository at all.
 *
 * Shared by the walk and the agent-ignore guard so both agree on where the
 * inherited-ignore chain starts. When they disagreed, the boundary depended on
 * which tool the model happened to reach for (BST-1435).
 */
export async function findRepositoryRoot(startAbsolutePath: string): Promise<string | undefined> {
  let current = startAbsolutePath;
  for (;;) {
    try {
      await fsPromises.stat(path.join(current, '.git'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return;
      }
      current = parent;
    }
  }
}

/** Directories from the repository root down to (not including) `target`, outermost first. */
export function ancestorDirectoriesBetween(repositoryRoot: string, target: string): string[] {
  if (repositoryRoot === target) {
    return [];
  }
  const relative = path.relative(repositoryRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return [];
  }
  const directories: string[] = [repositoryRoot];
  let current = repositoryRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (current !== target) {
      directories.push(current);
    }
  }
  return directories;
}

/** POSIX path of `target` relative to `base`, or '' when they are the same. */
export function relativePosixPrefix(base: string, target: string): string {
  const relative = path.relative(base, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return '';
  }
  return relative.split(path.sep).join('/');
}
