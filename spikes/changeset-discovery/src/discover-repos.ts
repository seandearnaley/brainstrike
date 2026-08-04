// SPIKE (BST-1110) — throwaway reference. Known shortcuts + caveats recorded in ../RECOMMENDATION.md; do not port verbatim.
import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_IGNORE = new Set([
  'node_modules',
  '.turbo',
  'dist',
  'build',
  '.next',
  '.cache',
  '.nyc_output',
  'coverage',
  '.venv',
  'target',
]);

export interface DiscoveredGitEntry {
  containingRoot: string;
  gitPath: string;
  kind: 'repo' | 'gitfile';
}

export async function discoverRepos(
  rootPaths: string[],
  opts: { maxDepth: number; ignore: Set<string> }
): Promise<DiscoveredGitEntry[]> {
  const found: DiscoveredGitEntry[] = [];
  for (const root of rootPaths) {
    await walk(root, root, 0, opts, found);
  }
  return found;
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  opts: { maxDepth: number; ignore: Set<string> },
  found: DiscoveredGitEntry[]
): Promise<void> {
  if (depth > opts.maxDepth) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: intended visibility for unreadable directories during the walk
    console.warn(`unreadable: ${dir}: ${String(error)}`);
    return;
  }
  const git = entries.find((e) => e.name === '.git');
  if (git) {
    const gitPath = join(dir, '.git');
    const s = await stat(gitPath);
    found.push({ containingRoot: root, gitPath, kind: s.isDirectory() ? 'repo' : 'gitfile' });
    // A repo boundary: keep walking siblings via caller, but do not walk into .git,
    // and DO keep walking subdirectories — nested repos below a repo are real
    // (e.g. .claude/worktrees/* under the main checkout).
  }
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && e.name !== '.git' && !opts.ignore.has(e.name))
      .map((e) => walk(root, join(dir, e.name), depth + 1, opts, found))
  );
}
