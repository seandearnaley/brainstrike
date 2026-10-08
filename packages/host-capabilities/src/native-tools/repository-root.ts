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
    } catch (error) {
      // ONLY absence continues the search. EACCES/EIO here means we cannot tell
      // whether a repository — and therefore an inherited `.llmignore` — sits
      // above this point, and answering "no repository" would silently drop the
      // whole parent chain. That is the same fail-open the agent layers exist to
      // rule out, one level further back (BST-1436 review).
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(
          `Cannot determine the repository root while resolving inherited ignore rules (${code ?? 'unknown error'}). Refusing to continue, because a parent .llmignore may apply.`,
          { cause: error }
        );
      }
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
