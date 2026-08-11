# Changeset Discovery Spike (BST-1110) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the discovery + structured-diff + watcher-invalidation engine for the Changeset Diff Viewer is feasible and fast on the real worktree-heavy corpus, and answer the five open questions in spec §10.

**Architecture:** An isolated npm spike project at `spikes/changeset-discovery/` (same pattern as `spikes/quickjs-sandbox`: outside the pnpm workspace, Node native type-stripping, vitest for logic-heavy parsers). Throwaway code — the deliverables are measured numbers and written answers in `RECOMMENDATION.md`, a competitive-teardown doc, and a findings addendum to the design spec.

**Tech Stack:** Node ≥ 22.18 (`node src/*.ts` type-stripping), `execFile` git invocation (no git library — matches production `git-service.ts`), `@parcel/watcher` (matches production watcher), vitest.

**Context for the implementer:**
- Design spec: `docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md` (read §3, §4, §10 before starting).
- Production reference code (read, do not modify): `apps/desktop/src/assistant-server/git-service.ts` (execution + output bounding), `apps/desktop/src/assistant-server/git-repository-parsers.ts` (`parseWorktreeSummaries` — the porcelain parser you are re-proving at scale), `docs/agents/explorer-search-tapestry.md` §"Explorer tree live refresh" (the one-pipeline ruling Q2 is about), `docs/agents/assistant-persistence.md` (Q4).
- Measurement corpus: this repo itself — the main checkout plus ~34 linked worktrees under `.claude/worktrees/`.
- Spike code is throwaway: no `any` still applies, but do NOT add production-grade error taxonomies; a thrown Error with a clear message is fine (visible failure, never silent).

## Global Constraints

- Branch: work on `spike/changeset-discovery` cut from `spec/changeset-diff-viewer` (the spec must be present).
- `spikes/changeset-discovery` is NOT part of the pnpm workspace — use `npm` inside it, never add it to `pnpm-workspace.yaml`.
- git invocation: always `execFile('git', [...args])` with an explicit `cwd` — never a shell string; always `-z`/NUL-safe porcelain where git offers it (git ≥ 2.36 assumed, matching production's floor).
- All spike scripts accept target paths as CLI args — no hardcoded absolute paths in code (hardcoded paths in *commands you run* are fine).
- Every measurement goes into `spikes/changeset-discovery/RECOMMENDATION.md` with the exact command that produced it.

---

### Task 1: Spike scaffold

**Files:**
- Create: `spikes/changeset-discovery/package.json`
- Create: `spikes/changeset-discovery/tsconfig.json`
- Create: `spikes/changeset-discovery/README.md`
- Create: `spikes/changeset-discovery/src/git.ts`
- Test: `spikes/changeset-discovery/test/git.test.ts`

**Interfaces:**
- Produces: `runGit(cwd: string, args: string[]): Promise<string>` (stdout as UTF-8, throws on non-zero exit with stderr in the message) and `runGitBuffer(cwd: string, args: string[]): Promise<Buffer>` — used by every later task.

- [ ] **Step 1: Create the branch and scaffold**

```bash
git checkout spec/changeset-diff-viewer && git checkout -b spike/changeset-discovery
mkdir -p spikes/changeset-discovery/src spikes/changeset-discovery/test
```

`spikes/changeset-discovery/package.json`:

```json
{
  "name": "changeset-discovery-spike",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@parcel/watcher": "^2.5.1",
    "@types/node": "^24.0.0",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

`spikes/changeset-discovery/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`spikes/changeset-discovery/README.md`:

```markdown
# Changeset discovery spike (BST-1110)

Isolated npm project outside the pnpm workspace, same pattern as
`spikes/quickjs-sandbox`. Throwaway prototype for the Changeset Diff Viewer
engine: repo/worktree discovery across roots, structured multi-file diffs,
`.git` watcher invalidation. Findings live in `RECOMMENDATION.md`.

    cd spikes/changeset-discovery
    npm install
    npm run typecheck
    npm test
    node src/discover.ts <rootPath> [<rootPath>...]
    node src/scope-diff.ts <worktreePath> <uncommitted|staged|branch-vs-base>
    node src/watch-git.ts <repoGitDir>
```

`spikes/changeset-discovery/src/git.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
  });
  return stdout;
}

export async function runGitBuffer(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: MAX_BUFFER,
    encoding: 'buffer',
  });
  return stdout;
}
```

- [ ] **Step 2: Write a smoke test**

`spikes/changeset-discovery/test/git.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { runGit } from '../src/git.ts';

describe('runGit', () => {
  it('returns stdout for a successful command', async () => {
    const out = await runGit(process.cwd(), ['--version']);
    expect(out).toMatch(/^git version /);
  });

  it('throws with stderr detail on failure', async () => {
    await expect(
      runGit(process.cwd(), ['rev-parse', '--verify', 'no-such-ref-xyz']),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Install and verify**

```bash
cd spikes/changeset-discovery && npm install && npm run typecheck && npm test
```

Expected: typecheck clean, 2 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add spikes/changeset-discovery && git commit -m "spike(BST-1110): scaffold changeset-discovery spike project"
```

---

### Task 2: Repo discovery walk

**Files:**
- Create: `spikes/changeset-discovery/src/discover-repos.ts`
- Test: `spikes/changeset-discovery/test/discover-repos.test.ts`

**Interfaces:**
- Consumes: nothing (pure fs walk).
- Produces: `discoverRepos(rootPaths: string[], opts: { maxDepth: number; ignore: Set<string> }): Promise<DiscoveredGitEntry[]>` where `DiscoveredGitEntry = { gitPath: string; kind: 'repo' | 'gitfile'; containingRoot: string }` — `kind: 'repo'` is a `.git` directory, `kind: 'gitfile'` is a `.git` *file* (linked worktree or submodule). Used by Task 3.

- [ ] **Step 1: Write failing tests against a fixture tree**

`spikes/changeset-discovery/test/discover-repos.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discoverRepos, DEFAULT_IGNORE } from '../src/discover-repos.ts';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'spike-discover-'));
  await mkdir(join(root, 'repo-a', '.git'), { recursive: true });
  await mkdir(join(root, 'nested', 'repo-b', '.git'), { recursive: true });
  await mkdir(join(root, 'linked-wt'), { recursive: true });
  await writeFile(join(root, 'linked-wt', '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
  await mkdir(join(root, 'node_modules', 'trap', '.git'), { recursive: true });
  await mkdir(join(root, 'a/b/c/d/e/f/too-deep', '.git'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discoverRepos', () => {
  it('finds .git directories and .git files, classifies kind', async () => {
    const found = await discoverRepos([root], { maxDepth: 4, ignore: DEFAULT_IGNORE });
    const byPath = new Map(found.map((f) => [f.gitPath, f]));
    expect(byPath.get(join(root, 'repo-a', '.git'))?.kind).toBe('repo');
    expect(byPath.get(join(root, 'nested', 'repo-b', '.git'))?.kind).toBe('repo');
    expect(byPath.get(join(root, 'linked-wt', '.git'))?.kind).toBe('gitfile');
  });

  it('skips ignored directories and respects maxDepth', async () => {
    const found = await discoverRepos([root], { maxDepth: 4, ignore: DEFAULT_IGNORE });
    const paths = found.map((f) => f.gitPath);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.includes('too-deep'))).toBe(false);
  });

  it('does not descend INTO a found repo (no nested scan inside .git)', async () => {
    const found = await discoverRepos([root], { maxDepth: 4, ignore: DEFAULT_IGNORE });
    expect(found.filter((f) => f.gitPath.startsWith(join(root, 'repo-a', '.git', '')))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test` — Expected: FAIL (`discover-repos.ts` does not exist).

- [ ] **Step 3: Implement the walk**

`spikes/changeset-discovery/src/discover-repos.ts`:

```typescript
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_IGNORE = new Set([
  'node_modules', '.turbo', 'dist', 'build', '.next', '.cache',
  '.nyc_output', 'coverage', '.venv', 'target',
]);

export interface DiscoveredGitEntry {
  gitPath: string;
  kind: 'repo' | 'gitfile';
  containingRoot: string;
}

export async function discoverRepos(
  rootPaths: string[],
  opts: { maxDepth: number; ignore: Set<string> },
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
  found: DiscoveredGitEntry[],
): Promise<void> {
  if (depth > opts.maxDepth) {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    console.warn(`unreadable: ${dir}: ${String(error)}`);
    return;
  }
  const git = entries.find((e) => e.name === '.git');
  if (git) {
    const gitPath = join(dir, '.git');
    const s = await stat(gitPath);
    found.push({ gitPath, kind: s.isDirectory() ? 'repo' : 'gitfile', containingRoot: root });
    // A repo boundary: keep walking siblings via caller, but do not walk into .git,
    // and DO keep walking subdirectories — nested repos below a repo are real
    // (e.g. .claude/worktrees/* under the main checkout).
  }
  await Promise.all(
    entries
      .filter((e) => e.isDirectory() && e.name !== '.git' && !opts.ignore.has(e.name))
      .map((e) => walk(root, join(dir, e.name), depth + 1, opts, found)),
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add spikes/changeset-discovery && git commit -m "spike(BST-1110): bounded-depth repo discovery walk"
```

---

### Task 3: Inventory assembly — worktree enumeration, out-of-root following, containment

**Files:**
- Create: `spikes/changeset-discovery/src/inventory.ts`
- Create: `spikes/changeset-discovery/src/discover.ts` (CLI entry)
- Test: `spikes/changeset-discovery/test/inventory.test.ts`

**Interfaces:**
- Consumes: `discoverRepos`, `runGit`.
- Produces: `buildInventory(rootPaths: string[]): Promise<Inventory>` with:

```typescript
interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;   // null = detached or bare
  containment: string[] | 'outside-roots';  // containing root paths
  provenance: 'scanned';   // spike only proves the scanned half of hybrid
}
interface RepoEntry {
  repositoryRoot: string;  // main worktree path = stable identity
  gitCommonDir: string;
  worktrees: WorktreeEntry[];
}
interface Inventory {
  repos: RepoEntry[];      // deduped by repositoryRoot
  timingMs: { walk: number; enumerate: number; total: number };
  errors: string[];        // visible, never silently dropped
}
```

- [ ] **Step 1: Write failing test on a real fixture (two worktrees, one outside the scanned root)**

`spikes/changeset-discovery/test/inventory.test.ts`:

```typescript
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInventory } from '../src/inventory.ts';

const run = promisify(execFile);
let base: string;
let scanRoot: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'spike-inv-'));
  scanRoot = join(base, 'workspace');
  const repo = join(scanRoot, 'myrepo');
  await mkdir(repo, { recursive: true });
  await run('git', ['init', '-b', 'main'], { cwd: repo });
  await writeFile(join(repo, 'f.txt'), 'hello\n');
  await run('git', ['add', '.'], { cwd: repo });
  await run('git', ['-c', 'user.email=s@x', '-c', 'user.name=s', 'commit', '-m', 'init'], { cwd: repo });
  // one worktree inside the scanned root, one outside it
  await run('git', ['worktree', 'add', join(scanRoot, 'wt-inside'), '-b', 'inside'], { cwd: repo });
  await run('git', ['worktree', 'add', join(base, 'wt-outside'), '-b', 'outside'], { cwd: repo });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('buildInventory', () => {
  it('dedupes worktrees of one repo to a single RepoEntry keyed by main worktree', async () => {
    const inv = await buildInventory([scanRoot]);
    expect(inv.repos).toHaveLength(1);
    expect(inv.repos[0]?.repositoryRoot).toBe(join(scanRoot, 'myrepo'));
    expect(inv.repos[0]?.worktrees).toHaveLength(3); // main + inside + outside
  });

  it('classifies containment, including outside-roots', async () => {
    const inv = await buildInventory([scanRoot]);
    const byPath = new Map(inv.repos[0]?.worktrees.map((w) => [w.path, w]));
    expect(byPath.get(join(scanRoot, 'wt-inside'))?.containment).toEqual([scanRoot]);
    expect(byPath.get(join(base, 'wt-outside'))?.containment).toBe('outside-roots');
  });

  it('reports branch names and detachment honestly', async () => {
    const inv = await buildInventory([scanRoot]);
    const branches = inv.repos[0]?.worktrees.map((w) => w.branch).sort();
    expect(branches).toEqual(['inside', 'main', 'outside']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test` — Expected: FAIL (`inventory.ts` does not exist).

- [ ] **Step 3: Implement inventory assembly**

`spikes/changeset-discovery/src/inventory.ts`:

```typescript
import { performance } from 'node:perf_hooks';
import { resolve, sep } from 'node:path';
import { discoverRepos, DEFAULT_IGNORE } from './discover-repos.ts';
import { runGit } from './git.ts';

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  containment: string[] | 'outside-roots';
  provenance: 'scanned';
}

export interface RepoEntry {
  repositoryRoot: string;
  gitCommonDir: string;
  worktrees: WorktreeEntry[];
}

export interface Inventory {
  repos: RepoEntry[];
  timingMs: { walk: number; enumerate: number; total: number };
  errors: string[];
}

export function parseWorktreePorcelain(zOutput: string): Array<{ path: string; head: string; branch: string | null }> {
  const records = zOutput.split('\0\0').map((r) => r.trim()).filter(Boolean);
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
      path,
      head: fields.get('HEAD') ?? '',
      branch: ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref,
    };
  });
}

function classifyContainment(worktreePath: string, rootPaths: string[]): string[] | 'outside-roots' {
  const containing = rootPaths.filter(
    (root) => worktreePath === root || worktreePath.startsWith(resolve(root) + sep),
  );
  return containing.length > 0 ? containing : 'outside-roots';
}

export async function buildInventory(rootPaths: string[]): Promise<Inventory> {
  const t0 = performance.now();
  const errors: string[] = [];
  const entries = await discoverRepos(rootPaths.map((r) => resolve(r)), {
    maxDepth: 6,
    ignore: DEFAULT_IGNORE,
  });
  const t1 = performance.now();

  const repos = new Map<string, RepoEntry>();
  for (const entry of entries) {
    const workdir = entry.gitPath.slice(0, -('/.git'.length));
    try {
      const commonDir = (await runGit(workdir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
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
        repositoryRoot: main.path,
        gitCommonDir: commonDir,
        worktrees: parsed.map((w) => ({
          ...w,
          containment: classifyContainment(w.path, rootPaths.map((r) => resolve(r))),
          provenance: 'scanned',
        })),
      });
    } catch (error) {
      errors.push(`${workdir}: ${String(error)}`);
    }
  }
  const t2 = performance.now();
  return {
    repos: [...repos.values()],
    timingMs: { walk: t1 - t0, enumerate: t2 - t1, total: t2 - t0 },
    errors,
  };
}
```

`spikes/changeset-discovery/src/discover.ts`:

```typescript
import { buildInventory } from './inventory.ts';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node src/discover.ts <rootPath> [<rootPath>...]');
  process.exit(1);
}
const inv = await buildInventory(roots);
console.log(JSON.stringify(inv, null, 2));
console.error(
  `repos=${inv.repos.length} worktrees=${inv.repos.reduce((n, r) => n + r.worktrees.length, 0)} ` +
  `walk=${inv.timingMs.walk.toFixed(0)}ms enumerate=${inv.timingMs.enumerate.toFixed(0)}ms ` +
  `total=${inv.timingMs.total.toFixed(0)}ms errors=${inv.errors.length}`,
);
```

Note: the NUL-record split (`'\0\0'`) assumption is exactly what Q1's measurement validates against the production parser's behavior — if `git worktree list --porcelain -z` output on the real corpus splits differently, compare with `parseWorktreeSummaries` in `apps/desktop/src/assistant-server/git-repository-parsers.ts:86` and record the discrepancy in RECOMMENDATION.md.

- [ ] **Step 4: Run tests**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add spikes/changeset-discovery && git commit -m "spike(BST-1110): inventory assembly with out-of-root worktree following"
```

---

### Task 4: Per-scope structured diff prototype

**Files:**
- Create: `spikes/changeset-discovery/src/scope-diff.ts`
- Test: `spikes/changeset-discovery/test/scope-diff.test.ts`

**Interfaces:**
- Consumes: `runGit`, `runGitBuffer`.
- Produces: `computeScopeDiff(worktreePath: string, scope: 'uncommitted' | 'staged' | 'branch-vs-base'): Promise<ScopeDiff>`:

```typescript
interface FileDiffEntry {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';   // U = untracked (reported as added-in-working-tree)
  additions: number | null;               // null = binary
  deletions: number | null;
  oldContent: string | null;              // null = absent side or binary or over cap
  newContent: string | null;
  binary: boolean;
  overCap: boolean;
}
interface ScopeDiff {
  worktreePath: string;
  scope: string;
  base: string | null;                    // merge-base sha for branch-vs-base
  files: FileDiffEntry[];
  timingMs: { list: number; content: number; total: number };
}
```

- [ ] **Step 1: Write failing test on a generated fixture repo**

`spikes/changeset-discovery/test/scope-diff.test.ts`:

```typescript
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeScopeDiff } from '../src/scope-diff.ts';

const run = promisify(execFile);
let repo: string;

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'spike-diff-'));
  const g = (args: string[]) =>
    run('git', ['-c', 'user.email=s@x', '-c', 'user.name=s', ...args], { cwd: repo });
  await g(['init', '-b', 'main']);
  await writeFile(join(repo, 'kept.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'doomed.txt'), 'bye\n');
  await g(['add', '.']);
  await g(['commit', '-m', 'init']);
  await writeFile(join(repo, 'kept.txt'), 'one\nTWO\nthree\n'); // modified, unstaged
  await rm(join(repo, 'doomed.txt'));                            // deleted, unstaged
  await writeFile(join(repo, 'fresh.txt'), 'new\n');             // untracked
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('computeScopeDiff uncommitted', () => {
  it('reports modified, deleted, and untracked with both-sides content', async () => {
    const diff = await computeScopeDiff(repo, 'uncommitted');
    const byPath = new Map(diff.files.map((f) => [f.path, f]));
    const kept = byPath.get('kept.txt');
    expect(kept?.status).toBe('M');
    expect(kept?.oldContent).toBe('one\ntwo\n');
    expect(kept?.newContent).toBe('one\nTWO\nthree\n');
    expect(kept?.additions).toBe(2);
    expect(kept?.deletions).toBe(1);
    expect(byPath.get('doomed.txt')?.status).toBe('D');
    expect(byPath.get('doomed.txt')?.newContent).toBeNull();
    expect(byPath.get('fresh.txt')?.status).toBe('U');
    expect(byPath.get('fresh.txt')?.oldContent).toBeNull();
    expect(byPath.get('fresh.txt')?.newContent).toBe('new\n');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test` — Expected: FAIL (`scope-diff.ts` does not exist).

- [ ] **Step 3: Implement**

`spikes/changeset-discovery/src/scope-diff.ts`:

```typescript
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from './git.ts';

const CONTENT_CAP_BYTES = 2 * 1024 * 1024; // provisional; Q3 tunes this

export type DiffScope = 'uncommitted' | 'staged' | 'branch-vs-base';

export interface FileDiffEntry {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
  additions: number | null;
  deletions: number | null;
  oldContent: string | null;
  newContent: string | null;
  binary: boolean;
  overCap: boolean;
}

export interface ScopeDiff {
  worktreePath: string;
  scope: string;
  base: string | null;
  files: FileDiffEntry[];
  timingMs: { list: number; content: number; total: number };
}

function parseNumstat(zOutput: string): Map<string, { additions: number | null; deletions: number | null }> {
  const out = new Map<string, { additions: number | null; deletions: number | null }>();
  const fields = zOutput.split('\0').filter(Boolean);
  // numstat -z: "adds\tdels\tpath" per record; renames emit "adds\tdels\t" then oldPath then newPath
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i]!;
    const [adds, dels, inlinePath] = record.split('\t');
    let path = inlinePath;
    if (inlinePath === '') {
      i += 2; // skip oldPath, take newPath
      path = fields[i];
    }
    if (path === undefined || adds === undefined || dels === undefined) {
      throw new Error(`unparseable numstat record: ${record}`);
    }
    out.set(path, {
      additions: adds === '-' ? null : Number(adds),
      deletions: dels === '-' ? null : Number(dels),
    });
  }
  return out;
}

async function readSide(
  worktreePath: string,
  ref: string | 'worktree',
  path: string,
): Promise<{ content: string | null; binary: boolean; overCap: boolean }> {
  try {
    const buffer =
      ref === 'worktree'
        ? await readFile(join(worktreePath, path))
        : Buffer.from(await runGit(worktreePath, ['cat-file', 'blob', `${ref}:${path}`]), 'utf8');
    if (buffer.length > CONTENT_CAP_BYTES) {
      return { content: null, binary: false, overCap: true };
    }
    if (buffer.includes(0)) {
      return { content: null, binary: true, overCap: false };
    }
    return { content: buffer.toString('utf8'), binary: false, overCap: false };
  } catch {
    return { content: null, binary: false, overCap: false }; // absent side (added/deleted)
  }
}

export async function computeScopeDiff(worktreePath: string, scope: DiffScope): Promise<ScopeDiff> {
  const t0 = performance.now();
  let base: string | null = null;
  let listArgs: string[];
  let oldRef: string;
  let newRef: string | 'worktree';

  if (scope === 'uncommitted') {
    listArgs = ['diff', 'HEAD', '--numstat', '-z', '--find-renames'];
    oldRef = 'HEAD';
    newRef = 'worktree';
  } else if (scope === 'staged') {
    listArgs = ['diff', '--cached', '--numstat', '-z', '--find-renames'];
    oldRef = 'HEAD';
    newRef = ''; // index — read via cat-file with :0:path
  } else {
    const upstream = (await runGit(worktreePath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    base = (await runGit(worktreePath, ['merge-base', 'HEAD', upstream])).trim();
    listArgs = ['diff', `${base}...HEAD`, '--numstat', '-z', '--find-renames'];
    oldRef = base;
    newRef = 'HEAD';
  }

  const numstat = parseNumstat(await runGit(worktreePath, listArgs));
  const statusZ = await runGit(worktreePath, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  const untracked = statusZ
    .split('\0')
    .filter((l) => l.startsWith('? '))
    .map((l) => l.slice(2));
  const t1 = performance.now();

  const files: FileDiffEntry[] = [];
  for (const [path, counts] of numstat) {
    const old = await readSide(worktreePath, oldRef, path);
    const now =
      scope === 'staged'
        ? await readSide(worktreePath, ':0', path)
        : await readSide(worktreePath, newRef, path);
    const status: FileDiffEntry['status'] =
      old.content === null && !old.binary && !old.overCap ? 'A'
      : now.content === null && !now.binary && !now.overCap ? 'D'
      : 'M';
    files.push({
      path,
      status,
      additions: counts.additions,
      deletions: counts.deletions,
      oldContent: old.content,
      newContent: now.content,
      binary: old.binary || now.binary,
      overCap: old.overCap || now.overCap,
    });
  }
  if (scope === 'uncommitted') {
    for (const path of untracked) {
      const now = await readSide(worktreePath, 'worktree', path);
      files.push({
        path,
        status: 'U',
        additions: now.content?.split('\n').length ?? null,
        deletions: 0,
        oldContent: null,
        newContent: now.content,
        binary: now.binary,
        overCap: now.overCap,
      });
    }
  }
  const t2 = performance.now();
  return {
    worktreePath,
    scope,
    base,
    files,
    timingMs: { list: t1 - t0, content: t2 - t1, total: t2 - t0 },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [worktreePath, scope] = process.argv.slice(2);
  if (!worktreePath || !['uncommitted', 'staged', 'branch-vs-base'].includes(scope ?? '')) {
    console.error('usage: node src/scope-diff.ts <worktreePath> <uncommitted|staged|branch-vs-base>');
    process.exit(1);
  }
  const diff = await computeScopeDiff(worktreePath, scope as DiffScope);
  console.log(JSON.stringify({ ...diff, files: diff.files.map((f) => ({ ...f, oldContent: f.oldContent ? `${f.oldContent.length}B` : null, newContent: f.newContent ? `${f.newContent.length}B` : null })) }, null, 2));
  console.error(`files=${diff.files.length} list=${diff.timingMs.list.toFixed(0)}ms content=${diff.timingMs.content.toFixed(0)}ms`);
}
```

Known spike shortcuts (record in RECOMMENDATION.md, do not fix): rename pairs are collapsed to the new path with status M; `cat-file` via utf8 `runGit` mangles binary old-sides (binary detection then keys off the new side); sequential per-file content reads (the measurement tells us whether production needs batching via `cat-file --batch`).

- [ ] **Step 4: Run tests**

Run: `npm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add spikes/changeset-discovery && git commit -m "spike(BST-1110): per-scope structured diff prototype"
```

---

### Task 5: Watcher invalidation prototype

**Files:**
- Create: `spikes/changeset-discovery/src/watch-git.ts`

**Interfaces:**
- Consumes: `@parcel/watcher` (same library as production desktop watching).
- Produces: a runnable observation harness only — findings, not an API.

- [ ] **Step 1: Implement the harness**

`spikes/changeset-discovery/src/watch-git.ts`:

```typescript
import watcher from '@parcel/watcher';

const gitDir = process.argv[2];
if (!gitDir) {
  console.error('usage: node src/watch-git.ts <path-to-.git-dir>');
  process.exit(1);
}

const INTERESTING = /(^|\/)(HEAD|index|ORIG_HEAD|refs\/|worktrees\/[^/]+\/(HEAD|index))/;
let pending: string[] = [];
let timer: NodeJS.Timeout | null = null;

const subscription = await watcher.subscribe(gitDir, (err, events) => {
  if (err) {
    console.error(`watch error: ${String(err)}`);
    return;
  }
  for (const event of events) {
    const rel = event.path.slice(gitDir.length + 1);
    const interesting = INTERESTING.test(rel);
    console.log(`${new Date().toISOString()} ${event.type} ${rel} ${interesting ? '<== INVALIDATE' : '(noise)'}`);
    if (interesting) {
      pending.push(rel);
    }
  }
  if (pending.length > 0 && !timer) {
    timer = setTimeout(() => {
      console.log(`>>> debounced invalidation: ${pending.length} interesting events`);
      pending = [];
      timer = null;
    }, 300);
  }
});

console.log(`watching ${gitDir} — run git operations in another terminal; Ctrl-C to stop`);
process.on('SIGINT', async () => {
  await subscription.unsubscribe();
  process.exit(0);
});
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 3: Observe real git operations (manual, record output)**

In terminal A: `node src/watch-git.ts /Users/seandearnaley/Documents/GitHub/brainstrike/.git`
In terminal B, inside the brainstrike checkout:

```bash
git status
touch /tmp/spike-touch-probe && git add -N . 2>/dev/null; git reset --quiet
git commit --allow-empty -m "watch probe" --quiet && git reset --hard HEAD~1 --quiet
```

Record in RECOMMENDATION.md: (a) noise ratio — how many events per commit are `(noise)` vs `INVALIDATE` (index churn from `git status` itself is the classic trap); (b) whether events for `worktrees/<name>/HEAD` fire inside the main `.git` when a linked worktree commits (they should — linked worktree metadata lives in the common dir, meaning ONE watch per repo covers all worktrees); verify by committing inside one of the `.claude/worktrees/*` checkouts.

- [ ] **Step 4: Commit**

```bash
git add spikes/changeset-discovery && git commit -m "spike(BST-1110): .git watcher invalidation harness"
```

---

### Task 6: Measurement runs on the real corpus

**Files:**
- Create: `spikes/changeset-discovery/RECOMMENDATION.md` (measurements section; later tasks append)

**Interfaces:**
- Consumes: `discover.ts`, `scope-diff.ts` CLIs from Tasks 3–4.

- [ ] **Step 1: Discovery on the worktree-heavy corpus**

```bash
cd spikes/changeset-discovery
node src/discover.ts /Users/seandearnaley/Documents/GitHub/brainstrike > /tmp/spike-inv-single.json
node src/discover.ts /Users/seandearnaley/Documents/GitHub/brainstrike ~/Documents/GitHub > /tmp/spike-inv-multi.json
```

Expected shape (verify, then record real numbers): single-root run finds ≥ 35 repos (main + ~34 `.claude/worktrees/*` gitfile entries) that dedupe to a small number of `RepoEntry`s with large `worktrees` arrays. Record: walk ms, enumerate ms, total ms, repo count, worktree count, error count — for both runs. If enumerate time is dominated by per-gitfile `rev-parse` process spawns, note process count (it is one `rev-parse` + one `worktree list` per *discovered entry* pre-dedup — the Q1 answer likely wants gitfile-pointer parsing to dedupe BEFORE spawning; record the idea, don't build it).

- [ ] **Step 2: Scope diffs at realistic sizes**

```bash
node src/scope-diff.ts /Users/seandearnaley/Documents/GitHub/brainstrike uncommitted
node src/scope-diff.ts /Users/seandearnaley/Documents/GitHub/brainstrike branch-vs-base
WT=$(ls -d /Users/seandearnaley/Documents/GitHub/brainstrike/.claude/worktrees/agent-* | head -1) && node src/scope-diff.ts "$WT" uncommitted
```

Record per run: file count, list ms, content ms. Then synthesize a large changeset and measure the cap behavior:

```bash
cd /tmp && rm -rf spike-big && mkdir spike-big && cd spike-big && git init -q -b main
for i in $(seq 1 200); do seq 1 500 > "file$i.txt"; done
git add . && git -c user.email=s@x -c user.name=s commit -qm init
for i in $(seq 1 200); do seq 1 600 > "file$i.txt"; done
node /Users/seandearnaley/Documents/GitHub/brainstrike/spikes/changeset-discovery/src/scope-diff.ts /tmp/spike-big uncommitted
```

Record: 200-file changeset content-read time; extrapolate whether eager-list + lazy-per-file-content (the spec §4 plan) is justified or whether even eager content is cheap.

- [ ] **Step 3: Write the measurements section**

Create `spikes/changeset-discovery/RECOMMENDATION.md` with sections: `## Measurements` (tables: discovery runs, scope-diff runs, watcher observations from Task 5), `## Spike shortcuts taken` (the recorded caveats from Tasks 3–4). Leave `## Answers to spec §10` as the next task's section.

- [ ] **Step 4: Commit**

```bash
git add spikes/changeset-discovery/RECOMMENDATION.md && git commit -m "spike(BST-1110): corpus measurements recorded"
```

---

### Task 7: Competitive teardown

**Files:**
- Create: `docs/superpowers/research/2026-08-03-diff-review-competitive-teardown.md`

**Interfaces:** none (research document).

- [ ] **Step 1: Build the matrix**

Research Cursor (current release), OpenAI Codex (app + CLI), and Claude Code (CLI + desktop) diff/review UX — use product docs, changelogs, and hands-on where installed. Rows (fixed, one per capability; add rows if research surfaces more):

1. Diff scopes offered (turn / uncommitted / staged / branch / commit)
2. Multi-file diff navigation (stacked scroll vs file-by-file, sticky headers)
3. Changed-files presentation (flat list vs tree; selection semantics)
4. Multi-root / multi-repo awareness
5. Worktree visibility & management
6. Agent-change attribution (which turn/run touched a file)
7. Conversation revert (files-only vs coupled message+file; redo support)
8. Commit/push from the review surface
9. Partial application (per-hunk/per-file accept-reject)
10. Live refresh behavior while an agent is working

Columns: Cursor / Codex / Claude Code / **BrainStrike planned** (cite spec section per cell). Close with two lists: **Parity gaps** (they have it, spec doesn't — flag any candidate scope additions, esp. row 9 given the settled no-per-hunk-staging decision: note it as a known concession, not a gap to fix) and **Differentiators** (spec has it, none of them do — expected: cross-repo changesets, out-of-root worktree provenance, journal-backed git-independent review).

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/research/2026-08-03-diff-review-competitive-teardown.md
git commit -m "spike(BST-1110): competitive teardown matrix"
```

---

### Task 8: Answer the five §10 questions + spec addendum

**Files:**
- Modify: `spikes/changeset-discovery/RECOMMENDATION.md` (append `## Answers to spec §10`)
- Modify: `docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md` (append `## 11. Spike findings (BST-1110)`)

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: the unblock signal for W1–W3 (BST-1111/1112/1113).

- [ ] **Step 1: Q1 — walk cost / ignore strategy / indexer reuse**

Evidence: Task 6 timings. Additionally read the workspace-index traversal section (`docs/agents/explorer-search-tapestry.md` §"Workspace Index Traversal") and answer: does the inventory walk reuse the indexer's traversal or stay independent? Decision criteria to address explicitly: coupling (indexer is renderer-driven; inventory is main-process), ignore-list divergence risk, and whether measured walk cost even justifies sharing. Write the answer with the measured numbers inline.

- [ ] **Step 2: Q2 — `.git` watching vs the one-pipeline ruling**

Evidence: Task 5 observations. Read `docs/agents/explorer-search-tapestry.md` §"Explorer tree live refresh" and locate the main-process `@parcel/watcher` wiring it describes. Answer: separate main-process subscription per repo common-dir (recommended if Task 5 confirmed one watch covers all linked worktrees) vs new signal type on the existing channel — and state explicitly why the choice does not violate the "no second event channel for the explorer tree" ruling (the ruling governs the explorer refresh pipeline; a `changes`-domain invalidation stream is a different consumer with its own contract — confirm or refute against the doc's actual wording).

- [ ] **Step 3: Q3 — size caps + lazy-hunk strategy**

Evidence: Task 6 large-changeset run + the 2 MB provisional cap behavior. Cross-check production precedents: `GIT_MAX_OUTPUT_BYTES` in `git-service.ts` and the checkpoint journal's 2 MB capture cap. Recommend: eager `ChangesetView` + lazy per-file `StructuredFileDiff` (confirm/refute with numbers), a concrete per-file content cap, and the over-cap UX (spec §7: visible truncation marker; specify whether over-cap files fall back to hunk-only rendering without full-file context).

- [ ] **Step 4: Q4 — Mastra tombstone seam**

Read `docs/agents/assistant-persistence.md` (message persistence & reload hydration) and the storage code it points into. Answer: where does a `tombstonedAt`-style marker live such that (a) hydration filters tombstoned messages without forking Mastra internals, (b) one-level redo can un-tombstone, (c) the next user message finalizes deletion. Name exact tables/columns/metadata fields and the seam (e.g., filter at the hydration read vs a Mastra thread-metadata flag). If the doc reveals this needs Mastra-boundary review (`docs/agents/mastra-boundary.md`), say so and note it as a W5 precondition rather than resolving it here.

- [ ] **Step 5: Q5 — cross-thread conflict awareness in v1**

Evidence: journal semantics in `docs/agents/workspace-context.md:489-590` (hash-compare conflict detection). Reason through the two-thread case: thread B edits a file after thread A's run; A's range-revert then hash-mismatches → per-file conflict (already surfaced honestly). Answer whether that existing conflict surfacing suffices for v1 (expected: yes — explicit conflict, no silent loss) or whether v1 needs proactive cross-thread detection; record the ruling.

- [ ] **Step 6: Write the spec addendum**

Append to `docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md`:

```markdown
## 11. Spike findings (BST-1110)

Measured on 2026-MM-DD, corpus: main checkout + N linked worktrees.
Full data: `spikes/changeset-discovery/RECOMMENDATION.md`; teardown:
`docs/superpowers/research/2026-08-03-diff-review-competitive-teardown.md`.

| §10 question | Ruling |
| --- | --- |
| Q1 walk cost / indexer reuse | <one-line ruling + headline number> |
| Q2 .git watching | <one-line ruling> |
| Q3 size caps / laziness | <one-line ruling + cap value> |
| Q4 tombstone seam | <one-line ruling + exact seam> |
| Q5 cross-thread conflicts | <one-line ruling> |

Scope adjustments from the teardown: <none | list>.
```

(Fill every cell from the RECOMMENDATION.md answers — the table is the executive summary, the file is the evidence.)

- [ ] **Step 7: Run the full spike verification battery**

```bash
cd spikes/changeset-discovery && npm run typecheck && npm test
```

Expected: clean + all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add spikes/changeset-discovery/RECOMMENDATION.md docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md
git commit -m "spike(BST-1110): §10 answers + spec addendum — W1-W3 unblocked"
```

---

### Task 9: Close out

**Files:** none (process step).

- [ ] **Step 1: Report**

Summarize for the project lead: headline measurements, the five rulings, any teardown-driven scope adjustments proposed for W1–W4, and explicit confirmation (or denial) that BST-1111/1112/1113 are unblocked. Post the summary as a comment on BST-1110 and move it toward done (the main session holds Linear access; executors report back instead of writing to Linear directly).

- [ ] **Step 2: PR**

Open a PR for `spike/changeset-discovery` → `main` (stacked on `spec/changeset-diff-viewer` until that merges) titled `spike(BST-1110): changeset discovery prototype + findings`. The spike code merges as reference material under `spikes/` per repo precedent (`spikes/quickjs-sandbox` is merged); production workstreams must not import from it.
