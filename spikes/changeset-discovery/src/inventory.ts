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

function classifyContainment(
  worktreePath: string,
  rootPaths: string[]
): string[] | 'outside-roots' {
  const containing = rootPaths.filter(
    (root) => worktreePath === root || worktreePath.startsWith(resolve(root) + sep)
  );
  return containing.length > 0 ? containing : 'outside-roots';
}

export async function buildInventory(rootPaths: string[]): Promise<Inventory> {
  const t0 = performance.now();
  const errors: string[] = [];
  const entries = await discoverRepos(
    rootPaths.map((r) => resolve(r)),
    {
      ignore: DEFAULT_IGNORE,
      maxDepth: 6,
    }
  );
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
          containment: classifyContainment(
            w.path,
            rootPaths.map((r) => resolve(r))
          ),
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
