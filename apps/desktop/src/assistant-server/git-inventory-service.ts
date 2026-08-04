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
import { createLogger } from '@brainstrike/logging';
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
import {
  createGitInventoryWatchers,
  type GitInventoryWatchers,
  type WatchGitCommonDir,
} from './git-inventory-watcher';
import { parseWorktreeSummaries } from './git-repository-parsers';
import {
  describeFailure,
  GIT_DEFAULT_TIMEOUT_MS,
  type GitCommandRun,
  type GitCommandRunner,
  invokeGitHookFree,
  toErrorMessage,
} from './git-service';

const logger = createLogger('GitInventoryService');

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

/** TTL default (Task 4, plan-pinned): a `getSnapshot()` call within this many ms
 * of the last successful build's `capturedAt` serves the cached snapshot. Past
 * it — or immediately, regardless of age, once a watcher invalidation has
 * marked the cache dirty (see {@link createGitInventoryService}) — the next
 * call rebuilds. */
export const GIT_INVENTORY_SNAPSHOT_TTL_MS = 5000;

export interface GitInventoryService {
  /**
   * Serve the cached snapshot when it is fresh (within `maxAgeMs`, default
   * {@link GIT_INVENTORY_SNAPSHOT_TTL_MS}) AND not dirty; otherwise rebuild.
   * Concurrent calls during a rebuild share the SAME in-flight build (no
   * thundering herd). Dead-watcher errors (`watchers.getHealthErrors()`) are
   * folded into `.errors` fresh on EVERY call, cache hit or not, so a watcher
   * that dies between rebuilds still shows up on the very next call rather
   * than waiting for the next rebuild to notice it.
   *
   * THROWS on a malformed `maxAgeMs` (non-finite or negative). A bad TTL is a
   * caller bug, and silently coercing it would either pin the cache forever
   * (`Infinity`) or force a rebuild on every call (`NaN`) with no signal —
   * exactly the silent degradation this codebase forbids. `maxAgeMs: 0` is
   * valid and means "force a fresh build".
   */
  readonly getSnapshot: (opts?: { readonly maxAgeMs?: number }) => Promise<GitInventorySnapshot>;
  /**
   * Kick off the initial build and watcher sync. Synchronous: the build runs
   * in the background and its outcome — including a failure that would
   * otherwise be an unhandled rejection — surfaces through the next
   * `getSnapshot()`'s `.errors`, never thrown here.
   *
   * Calling `start()` while already started throws (a caller bug: starting
   * twice would orphan the first watcher set without ever disposing it).
   * Calling `start()` again after `stop()` is supported and creates a fresh
   * watcher set — see the restart note below.
   */
  readonly start: () => void;
  /**
   * Dispose every live watcher and drop the cached snapshot (so a `getSnapshot()`
   * call after `stop()`, if the caller makes one, rebuilds from scratch rather
   * than serving stale pre-stop data). Idempotent.
   */
  readonly stop: () => Promise<void>;
}

function toBuildFailureSnapshot(error: unknown): GitInventorySnapshot {
  return {
    capturedAt: Date.now(),
    errors: [`git inventory: snapshot build failed: ${toErrorMessage(error)}`],
    repositories: [],
  };
}

/**
 * Stateful wrapper around {@link buildInventorySnapshot}: a TTL + dirty-flag
 * cache with in-flight build coalescing, and per-repo watcher lifecycle
 * management (Task 4, BST-1112). `git-inventory-watcher.ts`'s `disposeAll()`
 * is TERMINAL — once a `GitInventoryWatchers` instance is disposed it never
 * subscribes again — so `stop()` drops the instance entirely rather than
 * trying to resurrect it, and `start()` always builds a FRESH
 * `createGitInventoryWatchers()` instance. Restart-after-stop is therefore
 * supported deliberately (this matches the watcher module's own doc comment,
 * which frames "call `createGitInventoryWatchers` again" as the intended
 * restart path); what is NOT supported is calling `start()` twice without an
 * intervening `stop()` — that would silently orphan the first watcher set,
 * so it throws instead.
 *
 * No factory-reset runtime entry is registered for this service: like the
 * `fs:watch-telemetry` in-memory counters documented in
 * `docs/agents/platform-contracts.md`, every piece of state here — the
 * cached snapshot, the dirty flag, the live watcher subscriptions — is
 * process-lifetime-only and rebuilt from disk plus the DB `roots` table on
 * the next `getSnapshot()`/`start()`. There is nothing here that survives a
 * reset to go stale, and nothing a reset needs to clear.
 */
export function createGitInventoryService(
  deps: GitInventoryServiceDeps & { readonly watchDirectory: WatchGitCommonDir }
): GitInventoryService {
  let started = false;
  let watchers: GitInventoryWatchers | null = null;
  let cachedSnapshot: GitInventorySnapshot | null = null;
  // Starts dirty so the very first getSnapshot()/start() always builds,
  // regardless of maxAgeMs, instead of serving a nonexistent cache.
  let dirty = true;
  let inFlightBuild: Promise<GitInventorySnapshot> | null = null;
  // Bumped by every stop(). A rebuild() closes over the generation it started
  // in and refuses to write `cachedSnapshot` (or rely on `watchers` for sync)
  // once the counter has moved past it — see stop()'s doc comment for the
  // race this guards.
  let generation = 0;

  function withLiveHealthErrors(snapshot: GitInventorySnapshot): GitInventorySnapshot {
    const healthErrors = watchers?.getHealthErrors() ?? [];
    if (healthErrors.length === 0) {
      return snapshot;
    }
    return { ...snapshot, errors: [...snapshot.errors, ...healthErrors] };
  }

  async function rebuild(): Promise<GitInventorySnapshot> {
    const myGeneration = generation;
    // Cleared BEFORE the build starts, not after: an invalidation that
    // arrives WHILE this build is in flight must re-dirty the cache for the
    // NEXT call. Clearing it after the build would let a late-arriving
    // invalidation be silently overwritten by this function's own
    // `dirty = false`, losing the very change it was reporting.
    dirty = false;
    let snapshot: GitInventorySnapshot;
    let buildFailed = false;
    try {
      snapshot = await buildInventorySnapshot(deps);
    } catch (error) {
      // `buildInventorySnapshot` documents itself as never-throwing for
      // every failure mode INSIDE its own walk/spawn pipeline, but
      // `deps.loadRoots()` — a caller-supplied function (main.ts wires it to
      // a DB read) — is invoked unguarded at its very first line and CAN
      // reject (e.g. the database is not ready yet). That must not become an
      // unhandled rejection here or in `start()`'s fire-and-forget caller; it
      // becomes a visible `errors` entry instead.
      snapshot = toBuildFailureSnapshot(error);
      buildFailed = true;
    }
    // A stop() that ran while the build above was in flight bumped
    // `generation` past the value captured at this function's start — this
    // build's result belongs to a superseded lifecycle. It must not sync a
    // NEWER lifecycle's watcher set (checked here even though `watchers`
    // itself is read live below and may already be a FRESH, non-null
    // instance from a subsequent start() — generation is the authority on
    // "does this result still belong", not mere null-ness) and must not
    // repopulate the cache (nor should a failed build "heal" a lifecycle
    // that has already moved on).
    if (generation !== myGeneration) {
      return snapshot;
    }
    // `watchers` is read live (not captured at the top of this function): if
    // stop() ran while the build above was in flight, it has already set
    // `watchers = null`, so a late-completing build skips sync() on a
    // disposed instance rather than reviving it.
    if (watchers) {
      const commonDirs = snapshot.repositories.map((repo) => repo.identity.gitCommonDir);
      try {
        await watchers.sync(commonDirs);
      } catch (error) {
        snapshot = {
          ...snapshot,
          errors: [
            ...snapshot.errors,
            `git inventory: watcher sync failed: ${toErrorMessage(error)}`,
          ],
        };
      }
      // Re-check: stop() could have run WHILE the sync() above was pending.
      if (generation !== myGeneration) {
        return snapshot;
      }
    }
    cachedSnapshot = snapshot;
    if (buildFailed) {
      // A failed build must not be cached as if it were a fresh, authoritative
      // "no repositories" result: leave the cache dirty so the very next
      // getSnapshot() retries `loadRoots()` instead of serving an empty
      // inventory for the rest of the TTL window.
      dirty = true;
    }
    return snapshot;
  }

  async function getSnapshot(opts?: { readonly maxAgeMs?: number }): Promise<GitInventorySnapshot> {
    const maxAgeMs = opts?.maxAgeMs ?? GIT_INVENTORY_SNAPSHOT_TTL_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new Error(
        `GitInventoryService.getSnapshot(): invalid maxAgeMs ${maxAgeMs} — must be a finite number >= 0.`
      );
    }
    if (inFlightBuild) {
      return withLiveHealthErrors(await inFlightBuild);
    }
    if (!dirty && cachedSnapshot && Date.now() - cachedSnapshot.capturedAt < maxAgeMs) {
      return withLiveHealthErrors(cachedSnapshot);
    }
    const buildPromise = rebuild();
    inFlightBuild = buildPromise;
    try {
      return withLiveHealthErrors(await buildPromise);
    } finally {
      if (inFlightBuild === buildPromise) {
        inFlightBuild = null;
      }
    }
  }

  function start(): void {
    if (started) {
      throw new Error(
        'GitInventoryService.start(): already started. Call stop() before starting again — ' +
          'starting twice would orphan the first watcher set without disposing it.'
      );
    }
    started = true;
    watchers = createGitInventoryWatchers({
      onInvalidate: () => {
        dirty = true;
      },
      watchDirectory: deps.watchDirectory,
    });
    // NOT dead: a fresh `watchers` instance has zero subscriptions until the
    // next rebuild's `watchers.sync(...)` call, and the eager `getSnapshot()`
    // below is the only thing that triggers one. Without forcing `dirty`
    // here, a caller that calls `getSnapshot()` while stopped (documented as
    // supported on `stop()`) can leave a fresh, non-dirty cache in place;
    // `start()` would then hit getSnapshot()'s cache-hit path and return
    // without ever calling rebuild() — subscribing this new `watchers`
    // instance to nothing.
    dirty = true;
    // Fire-and-forget by design (`start()` is synchronous per the interface
    // contract). This no-arg `getSnapshot()` never rejects — `rebuild()`
    // catches both the build and the watcher-sync failure paths above, and
    // the only other rejection path is `maxAgeMs` validation, which a no-arg
    // call cannot reach — so this `.catch` is
    // defense in depth, not the primary error-visibility path: it exists so
    // that an unforeseen rejection can never surface as an unhandled promise
    // rejection.
    getSnapshot().catch((error: unknown) => {
      logger.error('git inventory service: unexpected initial build rejection', {
        error: toErrorMessage(error),
      });
    });
  }

  /**
   * Disposes every live watcher and drops the cache, so a `getSnapshot()`
   * call after `stop()` rebuilds from scratch rather than serving stale
   * pre-stop data. Idempotent (a second call sees `inFlightBuild === null`
   * and `watchers === null`, so both `await`s below are skipped).
   *
   * Awaits any in-flight build (rather than abandoning it) so the caller's
   * "torn down while the DB is still available" ordering — `main.ts` runs
   * this step BEFORE the `database` shutdown step precisely because
   * `loadRoots` reads the DB — actually holds: a build's `deps.loadRoots()`
   * DB read is guaranteed to have settled (resolved or rejected) before
   * `stop()` resolves and the caller proceeds to close the database.
   *
   * `generation` is bumped BEFORE that await, and `rebuild()` re-checks it
   * after every `await` point: a build already in flight when `stop()` runs
   * will neither write `cachedSnapshot` (it would otherwise resurrect a
   * stopped service's cache, silently undoing `cachedSnapshot = null` /
   * `dirty = true` below) nor sync the new lifecycle's watcher set (the
   * `watchers = null` swap below already prevents it from syncing the OLD,
   * disposed instance).
   *
   * Note for future refactors: BECAUSE of that drain, `cachedSnapshot = null`
   * below and `rebuild()`'s post-sync generation re-check are both currently
   * unobservable (removing either in isolation breaks no test) — they are
   * duals, and BOTH become load-bearing the moment the drain is removed.
   * Dropping the drain would silently un-cover them; keep them.
   */
  async function stop(): Promise<void> {
    started = false;
    generation += 1;
    const pendingBuild = inFlightBuild;
    inFlightBuild = null;
    const toDispose = watchers;
    watchers = null;
    if (pendingBuild) {
      await pendingBuild.catch(() => undefined);
    }
    cachedSnapshot = null;
    dirty = true;
    if (toDispose) {
      await toDispose.disposeAll();
    }
  }

  return { getSnapshot, start, stop };
}
