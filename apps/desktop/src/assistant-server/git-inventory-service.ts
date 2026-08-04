/**
 * Snapshot assembly for the cross-workspace git worktree inventory (BST-1112).
 *
 * Combines the fs-only discovery primitives in `git-inventory-discovery.ts`
 * (walk + `.git`/`commondir` resolution) with hook-free `git worktree list`
 * enumeration — reusing `git-service.ts`'s exported `invokeGitHookFree`,
 * never a bare spawn in a discovered, untrusted repository — to build a
 * {@link GitInventorySnapshot}: every repository + worktree reachable from
 * the active workspace roots, PLUS every linked worktree a repository's own
 * `.git/worktrees/*` administrative area CLAIMS to have, even ones outside
 * every root or fabricated by an untrusted repo-local write. This module is
 * the ONLY place in the discovery pair that spawns `git`.
 */
import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';
import type { GitInventory, GitInventoryRepository, WorktreeDescriptor } from '@brainstrike/types';
import {
  createNodeInventoryFs,
  DEFAULT_WALK_IGNORE_NAMES,
  DEFAULT_WALK_MAX_DEPTH,
  type DiscoveredGitEntry,
  type InventoryFs,
  resolveCommonDir,
  resolveGitEntryAtWorktree,
  walkForGitEntries,
} from './git-inventory-discovery';
import { parseWorktreeSummaries } from './git-repository-parsers';
import {
  describeFailure,
  GIT_DEFAULT_TIMEOUT_MS,
  type GitCommandRun,
  type GitCommandRunner,
  invokeGitHookFree,
  toErrorMessage,
} from './git-service';

export interface GitInventoryServiceDeps {
  /**
   * Overrides the production {@link createNodeInventoryFs}. Tests inject a
   * fake (hermetic unit coverage) or a real-fs call-recording wrapper
   * (integration coverage proving the "no content access beyond a
   * worktree's own `.git`" invariant for real). Defaults to
   * `createNodeInventoryFs()` when omitted.
   */
  readonly fs?: InventoryFs;
  /** Wraps `loadWorkspaceRootsFromDatabase` — this module never touches the DB directly. */
  readonly loadRoots: () => Promise<readonly { id: string; path: string }[]>;
  /** Hook-free callers only — see `invokeGitHookFree` usage below. Used hook-free. */
  readonly run: GitCommandRunner;
}

export interface GitInventorySnapshot extends GitInventory {
  readonly capturedAt: number;
}

interface ResolvedRoot {
  readonly id: string;
  readonly realPath: string;
}

/** Realpath every root; a root that cannot be resolved is skipped, VISIBLY (an `errors` entry), never silently dropped. */
async function resolveRoots(
  roots: readonly { id: string; path: string }[],
  errors: string[]
): Promise<readonly ResolvedRoot[]> {
  const resolved: ResolvedRoot[] = [];
  for (const root of roots) {
    try {
      const realPath = await fsRealpath(root.path);
      resolved.push({ id: root.id, realPath });
    } catch (error) {
      errors.push(
        `git inventory: root "${root.id}" (${root.path}) could not be resolved: ${toErrorMessage(error)}`
      );
    }
  }
  return resolved;
}

function dedupeGitEntries(entries: readonly DiscoveredGitEntry[]): readonly DiscoveredGitEntry[] {
  const seen = new Map<string, DiscoveredGitEntry>();
  for (const entry of entries) {
    if (!seen.has(entry.path)) {
      seen.set(entry.path, entry);
    }
  }
  return [...seen.values()];
}

interface RepoGroup {
  readonly commonDir: string;
  readonly cwd: string;
}

/**
 * Pick the `git worktree list` invocation cwd for a unique common dir. A
 * directly-walked `.git` DIRECTORY's parent is the actual main worktree root
 * (only the main worktree has a directory `.git` — every linked worktree uses
 * a gitfile), so it is preferred; otherwise (the repo's main worktree lies
 * outside every root, or was never walked) a `.git` FILE's parent works
 * identically — `git worktree list` reports the same full inventory
 * regardless of which of the repo's own worktrees it is invoked from.
 */
function chooseGroupCwd(entries: readonly DiscoveredGitEntry[]): string | null {
  const dirEntry = entries.find((entry) => entry.kind === 'dir');
  const chosen = dirEntry ?? entries[0];
  return chosen ? path.dirname(chosen.path) : null;
}

/** Resolve every discovered `.git` entry to its common dir and group by it — the dedup, BEFORE any git spawn. */
async function groupByCommonDir(
  fs: InventoryFs,
  entries: readonly DiscoveredGitEntry[],
  errors: string[]
): Promise<readonly RepoGroup[]> {
  const groups = new Map<string, DiscoveredGitEntry[]>();
  for (const entry of entries) {
    const resolved = await resolveCommonDir({
      fs,
      gitEntryKind: entry.kind,
      gitEntryPath: entry.path,
    });
    if (!resolved.ok) {
      errors.push(
        `git inventory: could not resolve "${entry.path}" (${entry.kind}): ${resolved.error}`
      );
      continue;
    }
    const group = groups.get(resolved.value);
    if (group) {
      group.push(entry);
    } else {
      groups.set(resolved.value, [entry]);
    }
  }
  const result: RepoGroup[] = [];
  for (const [commonDir, groupEntries] of groups) {
    const cwd = chooseGroupCwd(groupEntries);
    if (!cwd) {
      errors.push(`git inventory: common dir "${commonDir}" had no resolvable worktree cwd`);
      continue;
    }
    result.push({ commonDir, cwd });
  }
  return result;
}

/** Path-segment-aware containment: `/a/broot` is NOT contained in `/a/b`. */
function isPathContained(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function computeContainment(
  worktreePath: string,
  resolvedRoots: readonly ResolvedRoot[]
): readonly string[] | 'outside-roots' {
  const containingIds = resolvedRoots
    .filter((root) => isPathContained(root.realPath, worktreePath))
    .map((root) => root.id);
  return containingIds.length > 0 ? containingIds : 'outside-roots';
}

interface WorktreeTrustResult {
  readonly trust: 'unvalidated' | 'validated';
  readonly trustReason: string | null;
}

/**
 * Bidirectional trust check for a worktree the repo CLAIMS but that lies
 * outside every root: read the target worktree path's own .git back and
 * confirm it resolves to the SAME common dir. A fabricated worktree admin
 * entry (the attack this guards against) points at a target whose own .git
 * either does not exist or resolves elsewhere — either way this returns
 * unvalidated, and the caller keeps the descriptor rather than dropping it.
 * The failure reason is carried alongside the verdict (never discarded) so
 * an operator debugging an unexpected `unvalidated` worktree has something
 * to act on.
 */
async function resolveWorktreeTrust(
  fs: InventoryFs,
  worktreePath: string,
  expectedCommonDir: string
): Promise<WorktreeTrustResult> {
  const resolved = await resolveGitEntryAtWorktree({ fs, worktreePath });
  if (!resolved.ok) {
    return { trust: 'unvalidated', trustReason: resolved.error };
  }
  if (resolved.value !== expectedCommonDir) {
    return {
      trust: 'unvalidated',
      trustReason: `worktree's own ".git" resolves to common dir "${resolved.value}", not the expected "${expectedCommonDir}"`,
    };
  }
  return { trust: 'validated', trustReason: null };
}

async function buildRepository(
  fs: InventoryFs,
  run: GitCommandRunner,
  group: RepoGroup,
  resolvedRoots: readonly ResolvedRoot[],
  errors: string[]
): Promise<GitInventoryRepository | null> {
  function invoke(
    args: readonly string[],
    timeoutMs = GIT_DEFAULT_TIMEOUT_MS
  ): Promise<GitCommandRun> {
    return run({ args, cwd: group.cwd, timeoutMs });
  }

  const worktreeRun = await invokeGitHookFree(invoke, ['worktree', 'list', '--porcelain', '-z']);
  if (worktreeRun.exitCode !== 0) {
    errors.push(
      `git inventory: "git worktree list" failed for common dir "${group.commonDir}" (cwd "${group.cwd}"): ${describeFailure(worktreeRun)}`
    );
    return null;
  }

  let summaries: ReturnType<typeof parseWorktreeSummaries>;
  try {
    summaries = parseWorktreeSummaries(worktreeRun.stdout, group.cwd);
  } catch (error) {
    errors.push(
      `git inventory: could not parse "git worktree list" output for common dir "${group.commonDir}": ${toErrorMessage(error)}`
    );
    return null;
  }

  const mainWorktree = summaries[0];
  if (!mainWorktree) {
    errors.push(
      `git inventory: "git worktree list" returned no worktrees for common dir "${group.commonDir}"`
    );
    return null;
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = await fsRealpath(mainWorktree.path);
  } catch (error) {
    errors.push(
      `git inventory: main worktree "${mainWorktree.path}" for common dir "${group.commonDir}" could not be resolved: ${toErrorMessage(error)}`
    );
    return null;
  }

  const worktrees: WorktreeDescriptor[] = [];
  for (const summary of summaries) {
    // `summary.path` is git's own report of the worktree location, sourced
    // from the attacker-writable `.git/worktrees/<name>/gitdir` file — git
    // NEVER canonicalizes it before printing. A committed symlink can make a
    // worktree LEXICALLY sit inside a trusted root while its REAL target
    // lies outside every root; comparing the raw path against the roots
    // would misclassify it as in-root and skip the bidirectional trust
    // check entirely (in-root ⇒ unconditionally `validated` below). Realpath
    // BEFORE computing containment/trust, and report that CANONICAL path in
    // the descriptor too — the raw, possibly-misleading report is never
    // something a caller should act on once we know the true location. A
    // realpath failure (deleted worktree, dangling symlink, permission
    // error) fails CLOSED and VISIBLY: outside-roots + unvalidated + a
    // `trustReason` explaining why.
    //
    // git already tells us when a worktree is merely prunable
    // (`summary.prunableReason`, e.g. "gitdir file points to non-existent
    // location") — the routine, extremely common case of a deleted worktree
    // directory that `git worktree prune` hasn't cleaned up yet. That is
    // housekeeping, not an inventory failure: it must NOT land in
    // `snapshot.errors`, which later workstreams treat as a health signal.
    // Only a realpath failure on a NON-prunable worktree — one git itself
    // does not already explain — is a genuine, visible `errors` entry.
    let canonicalPath: string;
    try {
      canonicalPath = await fsRealpath(summary.path);
    } catch (error) {
      const message = `git inventory: worktree "${summary.path}" for common dir "${group.commonDir}" could not be resolved: ${toErrorMessage(error)}`;
      if (summary.prunableReason === null) {
        errors.push(message);
      }
      worktrees.push({
        ...summary,
        containment: 'outside-roots',
        provenance: 'scanned',
        trust: 'unvalidated',
        trustReason: summary.prunableReason ?? message,
      });
      continue;
    }
    const containment = computeContainment(canonicalPath, resolvedRoots);
    const { trust, trustReason }: WorktreeTrustResult =
      containment === 'outside-roots'
        ? await resolveWorktreeTrust(fs, canonicalPath, group.commonDir)
        : { trust: 'validated', trustReason: null };
    // `path: canonicalPath` deliberately OVERWRITES `summary.path` (git-raw)
    // from the `...summary` spread below. This makes `WorktreeDescriptor.path`
    // diverge from `GitWorktreeSummary.path` everywhere else this shared type
    // is used in the app — downstream consumers must not assume the two agree
    // and must not compare a `WorktreeDescriptor.path` against a raw
    // `GitWorktreeSummary.path` without realpathing the latter first.
    worktrees.push({
      ...summary,
      containment,
      path: canonicalPath,
      provenance: 'scanned',
      trust,
      trustReason,
    });
  }

  return {
    identity: { gitCommonDir: group.commonDir, repositoryRoot },
    worktrees,
  };
}

/**
 * Assemble the full cross-workspace-root git inventory: realpath every root
 * (a failure is a visible `errors` entry, the root skipped), walk each for
 * every `.git` entry, dedupe by resolved common dir BEFORE any git spawn, then
 * enumerate each unique repository's worktrees hook-free and trust-validate
 * every one the repo claims that lies outside every root. Never throws —
 * every failure mode becomes a visible `errors` entry with the rest of the
 * snapshot intact.
 */
export async function buildInventorySnapshot(
  deps: GitInventoryServiceDeps
): Promise<GitInventorySnapshot> {
  const errors: string[] = [];
  const roots = await deps.loadRoots();
  const resolvedRoots = await resolveRoots(roots, errors);

  const fs = deps.fs ?? createNodeInventoryFs();
  const walkResults = await Promise.all(
    resolvedRoots.map((root) =>
      walkForGitEntries({
        fs,
        ignoreNames: DEFAULT_WALK_IGNORE_NAMES,
        maxDepth: DEFAULT_WALK_MAX_DEPTH,
        rootLabel: root.id,
        rootPath: root.realPath,
      })
    )
  );
  const allEntries: DiscoveredGitEntry[] = [];
  for (const result of walkResults) {
    allEntries.push(...result.gitEntries);
    errors.push(...result.errors);
  }
  const uniqueEntries = dedupeGitEntries(allEntries);
  const groups = await groupByCommonDir(fs, uniqueEntries, errors);

  const repositories: GitInventoryRepository[] = [];
  for (const group of groups) {
    const repository = await buildRepository(fs, deps.run, group, resolvedRoots, errors);
    if (repository) {
      repositories.push(repository);
    }
  }

  return { capturedAt: Date.now(), errors, repositories };
}
