import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Directories a walk STARTED AT THE REPOSITORY ROOT must never descend into.
 *
 * These are build output, package caches and agent-tool scratch space. A root
 * walk that descends into one does not merely get slow: it reads files that
 * belong to another checkout and reports them as this repository's, so a guard
 * fails on a branch it was never pointed at. PR #3111 settled the shape of the
 * fix when `.stryker-tmp` hit this class — name the directory here. Never
 * teach a walk to swallow ENOENT/ENOTDIR instead: that hides the next one of
 * these rather than excluding it.
 *
 * This set alone is not enough, because it has to learn the name of every tool
 * that parks a checkout in the tree. `isForeignCheckout` carries the rule that
 * does not need the name.
 */
export const REPO_ROOT_IGNORED_DIRECTORIES = new Set([
  '.claude',
  '.git',
  '.muse',
  '.pnpm-store',
  '.stryker-tmp',
  '.turbo',
  'dist',
  'node_modules',
]);

/**
 * True when `directory` is the root of a different checkout: a git worktree,
 * clone or submodule carries its own `.git` entry, and nothing that is part of
 * THIS repository's tracked content does.
 *
 * This is the rule a name denylist cannot express. Agent tooling parks full
 * worktrees under `.claude/worktrees` and `.muse/worktrees` today; the next
 * tool will pick its own directory, and a guard that only knows the current
 * names silently starts reporting that checkout's files as this one's. Only
 * valid for a walk rooted at the repository root — it would skip the root
 * itself, which is why callers test children and never the starting point.
 *
 * Brainstrike has no submodules (no `.gitmodules`), so a nested `.git` always
 * means a foreign checkout here.
 */
export function isForeignCheckout(directory) {
  return existsSync(path.join(directory, '.git'));
}

/**
 * Every file under `root` whose name ends with one of `extensions`, keyed by
 * that extension and sorted within each key. One traversal serves all of them:
 * a walk per extension multiplies the cost of the whole tree by the number of
 * suffixes a caller happens to want.
 */
export function collectFilesByExtension(root, extensions) {
  const found = new Map(extensions.map((extension) => [extension, []]));
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!(REPO_ROOT_IGNORED_DIRECTORIES.has(entry.name) || isForeignCheckout(child))) {
          walk(child);
        }
        continue;
      }
      for (const extension of extensions) {
        if (entry.name.endsWith(extension)) {
          found.get(extension).push(child);
        }
      }
    }
  };
  walk(root);
  for (const files of found.values()) {
    files.sort();
  }
  return found;
}
