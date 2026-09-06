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
  createWalkSemaphore,
  DEFAULT_WALK_IGNORE_NAMES,
  DEFAULT_WALK_MAX_CONCURRENCY,
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
  /**
   * Called after each watcher invalidation has marked the cache dirty
   * (BST-1161). main.ts wires this to the `changes:invalidated` renderer
   * broadcast; the service itself stays Electron-free. `repositoryRoot` is
   * resolved from the cached snapshot's identity mapping (identity never
   * changes on invalidation, so the pre-invalidation cache is a valid map);
   * `null` when the common dir cannot be mapped (e.g. no snapshot yet). A
   * throwing listener is logged and never loses the dirty-mark itself.
   */
  readonly onInvalidate?: (event: GitInventoryInvalidation) => void;
  /** Hook-free callers only — see `invokeGitHookFree` usage below. Used hook-free. */
  readonly run: GitCommandRunner;
}

/** What a watcher invalidation was about, for push-to-renderer consumers (BST-1161). */
export interface GitInventoryInvalidation {
  readonly gitCommonDir: string;
  readonly repositoryRoot: string | null;
}

export interface GitInventorySnapshot extends GitInventory {
  readonly capturedAt: number;
}

interface ResolvedRoot {
  readonly id: string;
  readonly realPath: string;
}

/**
 * Realpath every root; a root that cannot be resolved is skipped, VISIBLY (an
 * `errors` entry), never silently dropped. Resolved in parallel — each root's
 * `realpath` is an independent fs call (not a git spawn), and workspace root
 * counts are small and UI-bounded, so this carries none of the "bounded git
 * spawns" / shared-fs-concurrency-budget concerns that keep the walk
 * (`walkForGitEntries`'s hoisted semaphore) and the per-repo `git worktree
 * list` loop in `buildInventorySnapshot` deliberately sequential.
 */
async function resolveRoots(
  roots: readonly { id: string; path: string }[],
  errors: string[]
): Promise<readonly ResolvedRoot[]> {
  const results = await Promise.all(
    roots.map(async (root) => {
      try {
        return {
          ok: true as const,
          resolved: { id: root.id, realPath: await fsRealpath(root.path) },
        };
      } catch (error) {
        return {
          error: `git inventory: root "${root.id}" (${root.path}) could not be resolved: ${toErrorMessage(error)}`,
          ok: false as const,
        };
      }
    })
  );
  const resolved: ResolvedRoot[] = [];
  for (const result of results) {
    if (result.ok) {
      resolved.push(result.resolved);
    } else {
      errors.push(result.error);
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
  const containingIds = resolvedRoots.reduce<string[]>((ids, root) => {
    if (isPathContained(root.realPath, worktreePath)) {
      ids.push(root.id);
    }
    return ids;
  }, []);
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
  errors: string[],
  signal: AbortSignal | undefined
): Promise<GitInventoryRepository | null> {
  function invoke(
    args: readonly string[],
    timeoutMs = GIT_DEFAULT_TIMEOUT_MS
  ): Promise<GitCommandRun> {
    return run({ args, cwd: group.cwd, signal, timeoutMs });
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

  // Canonicalized ONCE, reused for every summary's `current` comparison below
  // (BST-1112 review 3712381425) — comparing a RAW `summary.path` against a
  // raw `group.cwd` (the previous behavior, inherited from
  // `finishWorktreeRecord`) can disagree with the CANONICAL comparison this
  // block otherwise insists on for `path`/`containment`/`trust` whenever
  // either side is reached through a symlink. A failure here is treated the
  // same way `mainWorktree.path`'s realpath failure above is: visible and
  // repository-build-aborting, never a raw-path fallback that would silently
  // reintroduce the exact divergence this fix closes.
  let canonicalCwd: string;
  try {
    canonicalCwd = await fsRealpath(group.cwd);
  } catch (error) {
    errors.push(
      `git inventory: worktree-list cwd "${group.cwd}" for common dir "${group.commonDir}" could not be resolved: ${toErrorMessage(error)}`
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
    //
    // `name` and `current` are recomputed from `canonicalPath` too (BST-1112
    // review 3712381425), for the same reason `path` is overwritten:
    // `summary.name`/`summary.current` were derived by `finishWorktreeRecord`
    // from the RAW git-reported path, so leaving them in the `...summary`
    // spread would let them silently disagree with the now-canonical `path`
    // — e.g. a committed symlink (`inside-link -> /outside/dir`) would report
    // `path: '/outside/dir'` next to the attacker-chosen `name: 'inside-link'`,
    // and `current` would read `false` for every worktree of a repo reached
    // through a symlinked path even when one of them genuinely is the
    // worktree `group.cwd` was invoked from.
    worktrees.push({
      ...summary,
      containment,
      current: canonicalPath === canonicalCwd,
      name: path.basename(canonicalPath),
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
 *
 * `signal` (BST-1112 review, codex P1 3712467640) is optional and threaded
 * through to every `walkForGitEntries` call (a cheap per-recursion check that
 * stops queueing new `readdir`s once aborted) and every `git` invocation in
 * `buildRepository` (killing an in-flight process immediately via
 * `execFileGitRunner`'s `signal` passthrough). `createGitInventoryService`'s
 * `stop()` is the caller that wires this up, so a slow build does not hold a
 * graceful shutdown open past its own drain timeout.
 */
export async function buildInventorySnapshot(
  deps: GitInventoryServiceDeps,
  signal?: AbortSignal
): Promise<GitInventorySnapshot> {
  const errors: string[] = [];
  const roots = await deps.loadRoots();
  const resolvedRoots = await resolveRoots(roots, errors);

  const fs = deps.fs ?? createNodeInventoryFs();
  // ONE semaphore shared across every root's walk (BST-1112 review
  // 3712386046) — the bound is on TOTAL concurrent `readdir`s for this
  // snapshot build, not `32 × rootCount`.
  const walkSemaphore = createWalkSemaphore(DEFAULT_WALK_MAX_CONCURRENCY);
  const walkResults = await Promise.all(
    resolvedRoots.map((root) =>
      walkForGitEntries({
        fs,
        ignoreNames: DEFAULT_WALK_IGNORE_NAMES,
        maxDepth: DEFAULT_WALK_MAX_DEPTH,
        rootLabel: root.id,
        rootPath: root.realPath,
        semaphore: walkSemaphore,
        signal,
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

  // Sequential BY DESIGN, not an oversight (BST-1112 review, react-doctor
  // async-await-in-loop): each iteration spawns hook-free `git worktree list`
  // (plus an internal `git config` probe) against a DIFFERENT, independently
  // discovered — and therefore untrusted — repository. Fanning these out with
  // `Promise.all` would trade a bounded, one-at-a-time spawn rate for an
  // unbounded burst of concurrent `git` child processes sized by however many
  // repositories the walk found, with no semaphore of its own guarding it
  // (unlike the walk's `readdir`s, hoisted above).
  const repositories: GitInventoryRepository[] = [];
  for (const group of groups) {
    const repository = await buildRepository(fs, deps.run, group, resolvedRoots, errors, signal);
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

/**
 * Upper bound on how long `stop()` will await an in-flight build before
 * abandoning it (BST-1112 review, codex P1 3712467640). `stop()` aborts the
 * build's `AbortSignal` first — this is the fallback for a build that does
 * not honor it (an `InventoryFs`/`GitCommandRunner` that ignores `signal`,
 * or work already past its last abort check) — so `main.ts`'s
 * `SIGNAL_SHUTDOWN_TIMEOUT_MS` (5s) forced-exit never fires because THIS
 * drain alone ran that long.
 */
export const GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS = 2000;

/**
 * Thrown by `getSnapshot()` for any call made after `stop()` and before the
 * next `start()` (BST-1112 review Blocker 1, 3712384894). `stop()`'s drain
 * exists so callers like `main.ts` can close the database right after it
 * resolves; a `getSnapshot()` that instead started a NEW build in that
 * window — the previous behavior, since nothing gated `rebuild()` on
 * lifecycle state — could issue a `loadRoots()` DB read racing that close.
 * Typed and visible (never an empty snapshot) so a caller polling after
 * shutdown gets an actionable rejection instead of silently degraded data.
 */
export class GitInventoryStoppedError extends Error {
  readonly code = 'inventory-stopped' as const;
  constructor() {
    super(
      'GitInventoryService.getSnapshot(): the service has been stopped. Call start() again before requesting a snapshot.'
    );
    this.name = 'GitInventoryStoppedError';
  }
}

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
   * exactly the silent degradation this codebase forbids.
   *
   * `maxAgeMs: 0` is valid and FORCED: it guarantees a build that STARTED
   * AFTER the call, so a caller that just wrote a `roots` row can rely on the
   * result having seen it. That means it opts out of the coalescing above —
   * an in-flight build's `loadRoots()` already ran, so it is awaited and then
   * ONE more build runs. At most one extra build per forced call, and forced
   * calls arriving before that follow-up starts all share it (BST-1397).
   *
   * THROWS a typed {@link GitInventoryStoppedError} (`code: 'inventory-stopped'`)
   * for any call made after `stop()` and before the next `start()` — this
   * service does not build or serve a snapshot while intentionally torn
   * down; see `stop()`'s doc comment for the DB-read race this closes.
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
   * watcher set — see the restart note below. It also clears the
   * `stopped` flag `stop()` set, so `getSnapshot()` calls succeed again.
   */
  readonly start: () => void;
  /**
   * Dispose every live watcher and drop the cached snapshot, and reject any
   * `getSnapshot()` call made before the next `start()` with
   * {@link GitInventoryStoppedError} rather than rebuilding against a
   * possibly-closed DB. Idempotent.
   *
   * Bounds its wait for an in-flight build to
   * {@link GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS} — see the function doc comment
   * for the abort-then-bounded-wait mechanics and why an unbounded await was
   * itself a shutdown-deadline hazard (BST-1112 review, codex P1 3712467640).
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
  // Set by stop(), cleared by start() (BST-1112 review Blocker 1, 3712384894).
  // Checked at the very top of getSnapshot()'s synchronous prologue — before
  // it ever reads `inFlightBuild` or calls `rebuild()` — so no `await` point
  // separates the check from the decision not to start a new build; a call
  // that lands during stop()'s own drain window rejects immediately instead
  // of racing it.
  let stopped = false;
  let watchers: GitInventoryWatchers | null = null;
  let cachedSnapshot: GitInventorySnapshot | null = null;
  // Starts dirty so the very first getSnapshot()/start() always builds,
  // regardless of maxAgeMs, instead of serving a nonexistent cache.
  let dirty = true;
  let inFlightBuild: Promise<GitInventorySnapshot> | null = null;
  // The follow-up build a forced (`maxAgeMs: 0`) call scheduled behind the
  // build that was already in flight when it arrived, or `null` when none is
  // scheduled (BST-1397). Every forced call that lands before that follow-up
  // STARTS shares it — one extra build for the whole batch, not one per
  // caller. See `awaitForcedFollowUp()`.
  //
  // This is ONLY the coalescing slot — "which promise should a NEW forced
  // caller share?" — and `startTrackedBuild()` clears it the moment a build
  // actually starts, whether or not that promise has settled yet: a caller
  // arriving after that point needs a build starting AFTER it, not this one.
  // `pendingForcedRejects` below tracks the OTHER concern — "which forced
  // promises can `stop()` still settle?" — and does not share this slot's
  // lifetime (PR #2685 review, item 10 fold-in #2: clearing this slot used
  // to ALSO drop `stop()`'s only handle on the promise, exactly at the
  // moment the follow-up PROMOTES into being the tracked build itself — see
  // that set's doc comment for the full scenario).
  let forcedFollowUpWaiter: {
    readonly promise: Promise<GitInventorySnapshot>;
    readonly reject: (error: unknown) => void;
  } | null = null;
  // Every forced-follow-up `reject` handle whose promise has NOT settled
  // yet — independent of `forcedFollowUpWaiter` above, and outliving it: a
  // follow-up that starts its own build (`startTrackedBuild()`, inside
  // `awaitForcedFollowUp`'s chain) clears the coalescing slot immediately,
  // but its promise is still unsettled at that point, chained to the build
  // it just started. If `stop()` then ABANDONS that build (does not settle
  // within `GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS`), the promise's only other
  // settle path is gone — `forcedFollowUpWaiter` was already null, so the
  // single-slot version of this fix (BST-1400 item 10) had nothing left to
  // reject, and the caller hung forever even though `stop()` itself already
  // resolved. Entries are added when `awaitForcedFollowUp` creates a promise
  // and removed the moment that SAME promise settles (by either path) —
  // `stop()` rejects whatever is still in the set at abandonment time.
  const pendingForcedRejects = new Set<(error: unknown) => void>();
  // The AbortController for whichever build `inFlightBuild` currently points
  // at, if any (BST-1112 review, codex P1 3712467640). stop() aborts it so a
  // build blocked on a slow walk/git spawn unblocks (or at least stops doing
  // further work) instead of holding stop()'s drain open for the full 30s
  // git timeout. Cleared by rebuild() itself once its own build settles, so
  // stop() never aborts a LATER build it has no relationship to.
  let buildAbortController: AbortController | null = null;
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
    // A fresh controller per build (BST-1112 review, codex P1 3712467640):
    // stop() reads `buildAbortController` live, so it only ever aborts THIS
    // build, never a later one a subsequent start() kicked off.
    const abortController = new AbortController();
    buildAbortController = abortController;
    let snapshot: GitInventorySnapshot;
    let buildFailed = false;
    try {
      snapshot = await buildInventorySnapshot(deps, abortController.signal);
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
    } finally {
      if (buildAbortController === abortController) {
        buildAbortController = null;
      }
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

  /** Starts a build NOW and publishes it as the one every concurrent
   * `getSnapshot()` coalesces onto. */
  async function startTrackedBuild(): Promise<GitInventorySnapshot> {
    // Whatever forced follow-up was queued is no later than this build, so it
    // is no longer a valid thing to coalesce a NEW forced call onto: that
    // caller needs a build starting after IT. Released here — at the one
    // place a build begins — rather than from inside the follow-up's own
    // continuation, which would have to compare promise identities to know
    // whether the slot still belonged to it.
    forcedFollowUpWaiter = null;
    const buildPromise = rebuild();
    inFlightBuild = buildPromise;
    try {
      return await buildPromise;
    } finally {
      if (inFlightBuild === buildPromise) {
        inFlightBuild = null;
      }
    }
  }

  /**
   * Guarantees the caller a build that STARTED AFTER its call (BST-1397).
   *
   * The plain coalescing branch is wrong for a forced call: the in-flight
   * build's `deps.loadRoots()` already ran, so its result cannot contain the
   * `roots` row the caller just wrote — which is the entire reason it forced
   * a refresh. Awaiting that build and then running ONE more is the only way
   * to serve a snapshot that saw the change, short of cancelling and
   * restarting the in-flight build (which would penalise its own callers).
   *
   * Waits for the in-flight build to SETTLE — success or failure — because
   * the two builds share `deps` and running them concurrently would double
   * the git spawn rate `buildInventorySnapshot` deliberately bounds.
   *
   * The returned promise is externally settleable (BST-1400 item 10), not a
   * bare `.then()` chain off `current`: if `stop()` ABANDONS the build this
   * promise is currently depending on (it did not settle within
   * `GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS`), a chain with no other settle
   * path would wait on a build that may never resolve — hanging every
   * forced caller forever even though `stop()` itself already returned.
   * `stop()` holds the `reject` for exactly that case, via
   * `pendingForcedRejects` — NOT via `forcedFollowUpWaiter`, which stops
   * pointing at this promise the moment `startTrackedBuild()` runs below
   * (review fold-in #2: the promise depends on a DIFFERENT build — its OWN
   * — from that point on, but is still unsettled, so it must stay
   * reject-able under its own handle regardless of what the coalescing slot
   * currently holds). Once settled (by either path), later calls to it are
   * no-ops — Promises settle once — so no coordination is needed between the
   * two settle sites beyond both having a handle to the same promise.
   */
  function awaitForcedFollowUp(
    current: Promise<GitInventorySnapshot>
  ): Promise<GitInventorySnapshot> {
    if (forcedFollowUpWaiter) {
      return forcedFollowUpWaiter.promise;
    }
    const myGeneration = generation;
    let reject!: (error: unknown) => void;
    const promise = new Promise<GitInventorySnapshot>((resolve, rejectFn) => {
      reject = rejectFn;
      void current
        .then(
          () => undefined,
          () => undefined
        )
        .then(() => {
          // stop() may have run while the build above was draining — either
          // still torn down (`stopped`), or already restarted into a lifecycle
          // this caller never asked about (`generation` moved). Same rule as
          // getSnapshot()'s prologue: report the teardown, do not build.
          if (stopped || generation !== myGeneration) {
            throw new GitInventoryStoppedError();
          }
          // The build we just waited on cleared `dirty` when it started, so a
          // change that landed after it began would otherwise leave the cache
          // looking clean. Re-dirty so this build is unconditional.
          dirty = true;
          return startTrackedBuild();
        })
        .then(resolve, reject);
    });
    forcedFollowUpWaiter = { promise, reject };
    pendingForcedRejects.add(reject);
    // Removed the instant THIS promise settles, by either path — not tied to
    // `forcedFollowUpWaiter`'s own lifetime, which (per the doc above) can
    // clear well before this promise actually settles.
    void promise.then(
      () => {
        pendingForcedRejects.delete(reject);
      },
      () => {
        pendingForcedRejects.delete(reject);
      }
    );
    return promise;
  }

  async function getSnapshot(opts?: { readonly maxAgeMs?: number }): Promise<GitInventorySnapshot> {
    const maxAgeMs = opts?.maxAgeMs ?? GIT_INVENTORY_SNAPSHOT_TTL_MS;
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
      throw new Error(
        `GitInventoryService.getSnapshot(): invalid maxAgeMs ${maxAgeMs} — must be a finite number >= 0.`
      );
    }
    // No `await` between this check and every path below that could start a
    // NEW build (the `inFlightBuild`-coalescing branch just awaits an
    // EXISTING one) — so a call landing at any point after stop() sets
    // `stopped = true`, including WHILE stop() is still draining the build it
    // caught in flight, rejects here rather than racing it. See
    // GitInventoryStoppedError's doc comment for why this is a rejection,
    // not an empty/degraded snapshot.
    if (stopped) {
      throw new GitInventoryStoppedError();
    }
    if (inFlightBuild) {
      // `maxAgeMs: 0` is the documented "force a fresh build" value, and a
      // caller that just wrote a `roots` row means it literally: see
      // awaitForcedFollowUp().
      return withLiveHealthErrors(
        await (maxAgeMs === 0 ? awaitForcedFollowUp(inFlightBuild) : inFlightBuild)
      );
    }
    // `maxAgeMs: 0` can never satisfy this — `Date.now() - capturedAt` is
    // never negative — so a forced call with no build in flight falls through
    // to a build of its own below.
    if (!dirty && cachedSnapshot && Date.now() - cachedSnapshot.capturedAt < maxAgeMs) {
      return withLiveHealthErrors(cachedSnapshot);
    }
    return withLiveHealthErrors(await startTrackedBuild());
  }

  function start(): void {
    if (started) {
      throw new Error(
        'GitInventoryService.start(): already started. Call stop() before starting again — ' +
          'starting twice would orphan the first watcher set without disposing it.'
      );
    }
    started = true;
    // Clears the block getSnapshot() checks (BST-1112 review Blocker 1) —
    // every getSnapshot() call while stopped rejected without touching
    // `dirty`/`cachedSnapshot`, so nothing could have mutated either since
    // stop() last set them; this restart is not racing a stale cache left
    // behind by a call made while stopped the way it would have before that
    // fix (see the retired comment this replaced, in git history).
    stopped = false;
    watchers = createGitInventoryWatchers({
      onInvalidate: (gitCommonDir) => {
        // Dirty-mark FIRST: a throwing consumer below must never lose the
        // invalidation the watcher just reported.
        dirty = true;
        if (!deps.onInvalidate) {
          return;
        }
        const repositoryRoot =
          cachedSnapshot?.repositories.find((repo) => repo.identity.gitCommonDir === gitCommonDir)
            ?.identity.repositoryRoot ?? null;
        try {
          deps.onInvalidate({ gitCommonDir, repositoryRoot });
        } catch (error) {
          logger.error('git inventory service: onInvalidate consumer threw', {
            error: toErrorMessage(error),
            gitCommonDir,
          });
        }
      },
      watchDirectory: deps.watchDirectory,
    });
    // NOT dead: a fresh `watchers` instance has zero subscriptions until the
    // next rebuild's `watchers.sync(...)` call, and the eager `getSnapshot()`
    // below is the only thing that triggers one. `dirty` is ALREADY `true`
    // here — stop() sets it and nothing since could have cleared it, per the
    // note above — but forcing it again is cheap, explicit, and does not
    // depend on that invariant continuing to hold as this function evolves.
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
   * Disposes every live watcher and drops the cache, and — from the moment
   * this function starts running — rejects every `getSnapshot()` call with
   * {@link GitInventoryStoppedError} instead of building or serving anything,
   * until the next `start()`. Idempotent (a second call sees
   * `inFlightBuild === null` and `watchers === null`, so both drain/dispose
   * steps below are skipped).
   *
   * Bounds its wait for an in-flight build to
   * {@link GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS} (BST-1112 review, codex P1
   * 3712467640) rather than awaiting it unconditionally: the caller's "torn
   * down while the DB is still available" ordering — `main.ts` runs this step
   * BEFORE the `database` shutdown step precisely because `loadRoots` reads
   * the DB — wants that DB read settled before `stop()` resolves, but an
   * unconditional await made `stop()` itself the shutdown-deadline hazard
   * instead: a build can hold up to `GIT_DEFAULT_TIMEOUT_MS` (30s) PER git
   * spawn, far past `main.ts`'s `SIGNAL_SHUTDOWN_TIMEOUT_MS` (5s) forced-exit,
   * which would then skip the database/error-log shutdown steps entirely.
   * `buildAbortController.abort()` is tried FIRST — it kills an in-flight
   * `git` child process immediately (`execFileGitRunner`'s `signal`
   * passthrough) and stops the walk from queueing further `readdir`s — so the
   * bounded wait below is normally a formality, not the common path. If the
   * build still has not settled once the bound elapses (an `InventoryFs` or
   * `GitCommandRunner` that ignores `signal`, or work already past its last
   * abort check), the build is ABANDONED, visibly logged, and `stop()`
   * resolves anyway: the `stopped` flag (checked in `getSnapshot()`, set
   * below before this wait even starts) guarantees no caller can observe or
   * trigger a NEW build off the abandoned one's eventual — possibly very
   * late — settlement, so there is nothing left for that stale promise to
   * corrupt; it is simply left to resolve into the void.
   *
   * `generation` is bumped BEFORE the wait, and `rebuild()` re-checks it
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
    // Set before the drain wait below (not after) — see getSnapshot()'s own
    // comment on why no `await` may separate this from that check.
    stopped = true;
    generation += 1;
    const pendingBuild = inFlightBuild;
    inFlightBuild = null;
    // A follow-up queued behind `pendingBuild` belongs to the lifecycle being
    // torn down: leaving it in the slot would let a forced call made after
    // the next start() coalesce onto a build scheduled before that call ever
    // happened. `pendingForcedRejects` (below) is what still lets abandonment
    // settle any of those promises that are not done yet — this slot itself
    // carries no reject handle of its own to preserve any more (review
    // fold-in #2: it used to, and clearing it here was exactly what dropped
    // that handle at the wrong moment — see the slot's own doc comment).
    forcedFollowUpWaiter = null;
    const toDispose = watchers;
    watchers = null;
    if (pendingBuild) {
      buildAbortController?.abort();
      const settledInTime = await Promise.race([
        pendingBuild.then(
          () => true,
          () => true
        ),
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(false), GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS);
        }),
      ]);
      if (!settledInTime) {
        logger.error(
          'git inventory service: stop() abandoned an in-flight build that did not settle within the drain timeout',
          { drainTimeoutMs: GIT_INVENTORY_STOP_DRAIN_TIMEOUT_MS }
        );
        // Without this, every forced getSnapshot() caller still waiting on a
        // promise from `awaitForcedFollowUp` would hang forever: each one's
        // only other settle path is chained off the very build just
        // abandoned above (directly, or via a promotion that made this build
        // its own), which may never resolve. Every entry still in the set at
        // this point depends on `pendingBuild` — there is only ever one
        // in-flight build at a time, so nothing here can belong to some
        // OTHER build that is still healthy.
        for (const rejectPendingForcedWaiter of pendingForcedRejects) {
          rejectPendingForcedWaiter(new GitInventoryStoppedError());
        }
        pendingForcedRejects.clear();
      }
    }
    cachedSnapshot = null;
    dirty = true;
    if (toDispose) {
      await toDispose.disposeAll();
    }
  }

  return { getSnapshot, start, stop };
}
