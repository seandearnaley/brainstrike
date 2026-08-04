// SPIKE (BST-1110) — throwaway reference. Known shortcuts + caveats recorded in ../RECOMMENDATION.md; do not port verbatim.
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DEFAULT_IGNORE, discoverRepos } from './discover-repos.ts';
import { runGit } from './git.ts';

export interface WorktreeEntry {
  branch: string | null;
  containment: string[] | 'outside-roots';
  head: string;
  path: string;
  provenance: 'scanned';
}

export interface RepoEntry {
  gitCommonDir: string;
  repositoryRoot: string;
  worktrees: WorktreeEntry[];
}

export interface Inventory {
  errors: string[];
  repos: RepoEntry[];
  timingMs: { walk: number; enumerate: number; total: number };
}

export function parseWorktreePorcelain(
  zOutput: string
): Array<{ path: string; head: string; branch: string | null }> {
  const records = zOutput
    .split('\0\0')
    .map((r) => r.trim())
    .filter(Boolean);
  return records.map((record) => {
    const fields = new Map<string, string>();
    for (const line of record.split('\0').filter(Boolean)) {
      const space = line.indexOf(' ');
      if (space === -1) {
        fields.set(line, '');
      } else {
        fields.set(line.slice(0, space), line.slice(space + 1));
      }
    }
    const path = fields.get('worktree');
    if (!path) {
      throw new Error(`worktree porcelain record missing path: ${record}`);
    }
    const ref = fields.get('branch') ?? null;
    return {
      branch: ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref,
      head: fields.get('HEAD') ?? '',
      path,
    };
  });
}

// rootPaths must already be canonicalized (resolved + realpath'd) — git's own
// absolute-path output is always canonical (symlink-resolved), so comparing
// against non-canonical roots silently misclassifies containment on any
// platform where a temp/home/mount directory is itself a symlink (e.g.
// macOS /tmp -> /private/tmp, /var -> /private/var).
function classifyContainment(
  worktreePath: string,
  canonicalRootPaths: string[]
): string[] | 'outside-roots' {
  const containing = canonicalRootPaths.filter(
    (root) => worktreePath === root || worktreePath.startsWith(root + sep)
  );
  return containing.length > 0 ? containing : 'outside-roots';
}

// Resolves each root to an absolute, symlink-free path once per buildInventory
// call. A root that can't be canonicalized (doesn't exist, permission denied,
// etc.) is never silently dropped from view: it's recorded in errors and
// excluded from the scan, rather than passed through unresolved (which would
// silently degrade containment classification for every worktree under it).
async function canonicalizeRoots(rootPaths: string[], errors: string[]): Promise<string[]> {
  const canonical: string[] = [];
  for (const root of rootPaths) {
    try {
      canonical.push(await realpath(resolve(root)));
    } catch (error) {
      errors.push(`root ${root}: ${String(error)}`);
    }
  }
  return canonical;
}

export async function buildInventory(rootPaths: string[]): Promise<Inventory> {
  const t0 = performance.now();
  const errors: string[] = [];
  const canonicalRoots = await canonicalizeRoots(rootPaths, errors);
  const entries = await discoverRepos(canonicalRoots, {
    ignore: DEFAULT_IGNORE,
    maxDepth: 6,
  });
  const t1 = performance.now();

  const repos = new Map<string, RepoEntry>();
  for (const entry of entries) {
    const workdir = entry.gitPath.slice(0, -'/.git'.length);
    try {
      const commonDir = (
        await runGit(workdir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
      ).trim();
      if (repos.has(commonDir)) {
        continue; // another worktree of an already-inventoried repo
      }
      const porcelain = await runGit(workdir, ['worktree', 'list', '--porcelain', '-z']);
      const parsed = parseWorktreePorcelain(porcelain);
      const main = parsed[0];
      if (!main) {
        throw new Error(`no worktrees parsed for ${workdir}`);
      }
      repos.set(commonDir, {
        gitCommonDir: commonDir,
        repositoryRoot: main.path,
        worktrees: parsed.map((w) => ({
          ...w,
          containment: classifyContainment(w.path, canonicalRoots),
          provenance: 'scanned',
        })),
      });
    } catch (error) {
      errors.push(`${workdir}: ${String(error)}`);
    }
  }
  const t2 = performance.now();
  return {
    errors,
    repos: [...repos.values()],
    timingMs: { enumerate: t2 - t1, total: t2 - t0, walk: t1 - t0 },
  };
}
