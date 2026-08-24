/**
 * Main-process forge (pull-request) awareness — D5 as settled: `gh`-first,
 * EVENT-TRIGGERED refreshes, a small `brainstrike_forge_prs` cache, and no
 * auto-fix / auto-merge anywhere.
 *
 * THERE IS NO TIMER IN THIS FILE, and there must never be one (pinned by a
 * source assertion in `forge-service.test.ts`). Polling is alien to main:
 * every other main-side service is watcher + debounce + TTL. Refreshes are
 * driven by three events, each with its own floor:
 *
 * - `invalidation` (0 ms) — the git-metadata watcher saw refs move on this
 *   repository, i.e. a push/fetch actually happened. Never throttled: the one
 *   moment the remote state is known to have changed is the moment to look.
 * - `user` (0 ms) — the PrChip popover's explicit Refresh.
 * - `window` (60 s) — the chip mounted, or the window regained focus.
 *
 * Nothing fires while the window is hidden, which is what "0 when hidden"
 * means in the design: the renderer simply does not ask.
 *
 * Identity promotion: an unlabelled enterprise host (`git.acme.internal`)
 * parses as `forge: 'unknown'`, and this service PROMOTES it to GitHub when —
 * and only when — `gh auth status --hostname <host>` succeeds. gh itself is
 * the authority on which hosts it can serve, so nothing here guesses from the
 * hostname.
 */
import type {
  ForgePrStatus,
  ForgePrTransition,
  ForgePrUpdatedEvent,
  ForgePullRequest,
  ForgeRemoteIdentity,
  ForgeResult,
  ForgeUnavailable,
  GitForgeRepositoryContext,
} from '@brainstrike/types';
import { parseForgeRemote } from '@brainstrike/types';
import {
  detectGhCli,
  type ForgeCommandRunner,
  fetchForgePullRequest,
  probeGhAuth,
} from './forge-gh-client';
import {
  deleteForgePrCacheEntry,
  type ForgeCacheDatabase,
  readForgePrCacheEntry,
  writeForgePrCacheEntry,
} from './forge-pr-cache';
import { desktopAssistantServerLogger as logger } from './logger';

export type ForgeRefreshReason = 'invalidation' | 'user' | 'window';

/** Minimum time since the last gh fetch for a `(repo, branch)` key, per reason. */
export const FORGE_REFRESH_MIN_INTERVAL_MS: Readonly<Record<ForgeRefreshReason, number>> = {
  invalidation: 0,
  user: 0,
  window: 60_000,
};

export interface ForgeIdentityState {
  readonly failure: ForgeUnavailable | null;
  readonly identity: ForgeRemoteIdentity | null;
  readonly repoCommonDir: string;
}

export type ForgeRepositoryResolver = (
  rootId: string
) => Promise<ForgeResult<{ readonly context: GitForgeRepositoryContext; readonly cwd: string }>>;

export interface ForgeServiceOptions {
  readonly getDatabase: () => Promise<ForgeCacheDatabase>;
  readonly now?: () => number;
  readonly onPrUpdated: (event: Omit<ForgePrUpdatedEvent, 'generation'>) => void;
  readonly resolveRepository: ForgeRepositoryResolver;
  readonly run: ForgeCommandRunner;
}

export interface ForgeService {
  readonly identity: (rootId: string) => Promise<ForgeResult<ForgeIdentityState>>;
  readonly onRepositoryInvalidated: (gitCommonDir: string) => void;
  readonly prStatus: (rootId: string) => Promise<ForgeResult<ForgePrStatus>>;
  readonly refresh: (
    rootId: string,
    reason: ForgeRefreshReason
  ) => Promise<ForgeResult<ForgePrStatus>>;
}

interface ResolvedTarget {
  readonly branch: string;
  readonly cwd: string;
  readonly host: string;
  readonly identity: ForgeRemoteIdentity;
  readonly repoCommonDir: string;
}

interface Observation {
  readonly checksRollup: ForgePullRequest['checksRollup'];
  readonly headSha: string;
  readonly state: ForgePullRequest['state'];
}

const cacheKey = (repoCommonDir: string, branch: string): string => `${repoCommonDir}\0${branch}`;

function unavailable(failure: ForgeUnavailable): ForgePrStatus {
  return { failure, kind: 'unavailable' };
}

/**
 * Which transitions this observation represents, given the previous one.
 * `opened` fires once per pull request (no previous observation, or a new
 * number); `merged` when the state becomes merged; `checks` when the rollup
 * moved to a settled verdict, OR the head sha itself moved (a force-push or a
 * new commit) — `ForgePrTransition` has no dedicated "new commits" variant,
 * and the notification layer's `observationKey` already embeds `headSha`
 * (`<repoCommonDir>\0<branch>\0<headSha>`), so reusing `checks` here still
 * coalesces correctly: a repeat of the SAME head never re-notifies, while a
 * new head — settled rollup or not — always produces a fresh coalescing key.
 * An unchanged observation yields none.
 */
function diffObservations(
  previous: Observation | undefined,
  next: ForgePullRequest,
  previousNumber: number | undefined
): readonly ForgePrTransition[] {
  if (previous === undefined || previousNumber !== next.number) {
    return ['opened'];
  }
  if (next.state === 'merged' && previous.state !== 'merged') {
    return ['merged'];
  }
  const checksSettled =
    next.checksRollup !== previous.checksRollup &&
    (next.checksRollup === 'failing' || next.checksRollup === 'passing');
  if (checksSettled || next.headSha !== previous.headSha) {
    return ['checks'];
  }
  return [];
}

export function createForgeService(options: ForgeServiceOptions): ForgeService {
  const { getDatabase, onPrUpdated, resolveRepository, run } = options;
  const now = options.now ?? (() => Date.now());
  /** Resolved once per app session — gh either exists or it does not. */
  let ghDetection: Promise<ForgeUnavailable | null> | undefined;
  // A bracketed IPv6 host is a safe key: Map compares exact strings, and
  // `parseForgeRemote` produces the same bracketed value for the same remote.
  const ghAuthByHost = new Map<string, Promise<ForgeUnavailable | null>>();
  const lastFetchAtByKey = new Map<string, number>();
  const lastFailureByKey = new Map<string, ForgeUnavailable>();
  const lastObservationByKey = new Map<string, Observation>();
  const lastNumberByKey = new Map<string, number>();
  /**
   * Keys whose observation maps have already been checked against the
   * durable cache row once this session — see `seedObservationFromCache`.
   */
  const seededObservationKeys = new Set<string>();
  /** In-flight `performFetchAndStore` calls, keyed like `lastFetchAtByKey`. */
  const inFlightFetchByKey = new Map<string, Promise<ForgePrStatus>>();
  /** repo common dir -> root ids the renderer has actually asked about. */
  const rootIdsByCommonDir = new Map<string, Set<string>>();

  async function resolveTarget(
    rootId: string
  ): Promise<
    ForgeResult<
      ResolvedTarget | { readonly failure: ForgeUnavailable; readonly repoCommonDir: string }
    >
  > {
    const resolved = await resolveRepository(rootId);
    if (!resolved.ok) {
      return resolved;
    }
    const { context, cwd } = resolved.value;
    const trackedRoots = rootIdsByCommonDir.get(context.commonDir) ?? new Set<string>();
    trackedRoots.add(rootId);
    rootIdsByCommonDir.set(context.commonDir, trackedRoots);
    if (context.branch === null) {
      return {
        ok: true,
        value: {
          failure: {
            detail: 'This checkout has a detached HEAD, so it drives no branch pull request.',
            reason: 'detached-head',
          },
          repoCommonDir: context.commonDir,
        },
      };
    }
    if (context.remoteUrl === null) {
      return {
        ok: true,
        value: {
          failure: {
            detail: context.remoteReason ?? 'The repository has no usable git remote.',
            reason: 'no-remote',
          },
          repoCommonDir: context.commonDir,
        },
      };
    }
    const parsed = parseForgeRemote(context.remoteUrl);
    if (!parsed.ok) {
      return {
        ok: true,
        value: {
          failure: { detail: parsed.reason, reason: 'unparsable-remote' },
          repoCommonDir: context.commonDir,
        },
      };
    }
    if (parsed.value.forge === 'gitlab') {
      return {
        ok: true,
        value: {
          failure: {
            detail: `${parsed.value.host} is a GitLab remote. Pull request status is GitHub-only in this release.`,
            reason: 'unsupported-forge',
          },
          repoCommonDir: context.commonDir,
        },
      };
    }
    return {
      ok: true,
      value: {
        branch: context.branch,
        cwd,
        host: parsed.value.host,
        identity: parsed.value,
        repoCommonDir: context.commonDir,
      },
    };
  }

  /**
   * `ghDetection` is session-scoped for BOTH outcomes: "gh either exists or
   * it does not" is treated as stable for the life of the process, so a
   * `gh-missing` failure stays memoized too — this bounds how often the CLI
   * itself gets probed across the window-focus and invalidation refreshes
   * that call `requireGh` (pinned by the "probes only once" test). It is
   * cleared only by an explicit `user`-reason refresh (the affordance
   * offered for "I just installed/fixed it").
   *
   * Auth is different: it is mutable runtime state the user is explicitly
   * told to change (`gh auth login --hostname <host>`), and `probeGhAuth`
   * performs a real network token-validation call — a single transient
   * DNS/proxy/503 blip must not poison the session. So an auth FAILURE is
   * never left memoized: it is deleted from `ghAuthByHost` as soon as it
   * resolves, and an explicit `user`-reason refresh proactively clears any
   * cached entry — success included — so it always re-probes rather than
   * trusting a positive that may since have been revoked.
   */
  async function requireGh(
    target: ResolvedTarget,
    reason: ForgeRefreshReason | null
  ): Promise<ForgeUnavailable | null> {
    if (reason === 'user') {
      ghAuthByHost.delete(target.host);
      if (ghDetection && (await ghDetection)) {
        ghDetection = undefined;
      }
    }
    ghDetection ??= detectGhCli(run, target.cwd);
    const detection = await ghDetection;
    if (detection) {
      return detection;
    }
    let auth = ghAuthByHost.get(target.host);
    if (!auth) {
      auth = probeGhAuth(run, target.cwd, target.host);
      ghAuthByHost.set(target.host, auth);
    }
    const failure = await auth;
    if (failure) {
      ghAuthByHost.delete(target.host);
    }
    return failure;
  }

  async function readCached(target: ResolvedTarget): Promise<ForgePrStatus> {
    const key = cacheKey(target.repoCommonDir, target.branch);
    const failure = lastFailureByKey.get(key);
    let cached: Awaited<ReturnType<typeof readForgePrCacheEntry>> = null;
    try {
      cached = await readForgePrCacheEntry(
        await getDatabase(),
        target.repoCommonDir,
        target.branch
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('Forge PR cache read failed', { detail, key });
      return unavailable({ detail, reason: 'fetch-failed' });
    }
    if (!cached) {
      // No cached row AND no recorded failure means nothing has ever
      // answered for this key — not an observed absence. Fabricating
      // `{ kind: 'none', observedAt: now }` here would lie to any "Last
      // checked …" affordance built on that timestamp.
      return failure ? unavailable(failure) : { kind: 'unknown' };
    }
    return failure
      ? { failure, kind: 'stale', observedAt: cached.observedAt, pullRequest: cached.pullRequest }
      : { kind: 'pr', observedAt: cached.observedAt, pullRequest: cached.pullRequest };
  }

  /**
   * Seed `lastObservationByKey`/`lastNumberByKey` from the durable cache row
   * the FIRST time this process-local service touches a key. Without this, a
   * fresh service instance (an app restart) diffs every first refresh
   * against an empty map and reports `opened` for a pull request that was
   * already known — `brainstrike_forge_prs` exists precisely so restarts
   * don't lose this. Only ever narrows the map from "no idea" to "this is
   * what we last stored"; it never overwrites an observation this session
   * has already recorded from a live `gh` answer.
   */
  async function seedObservationFromCache(target: ResolvedTarget, key: string): Promise<void> {
    if (seededObservationKeys.has(key)) {
      return;
    }
    seededObservationKeys.add(key);
    if (lastObservationByKey.has(key)) {
      return;
    }
    let cached: Awaited<ReturnType<typeof readForgePrCacheEntry>>;
    try {
      cached = await readForgePrCacheEntry(
        await getDatabase(),
        target.repoCommonDir,
        target.branch
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('Forge PR cache seed read failed; diffing against no prior observation', {
        detail,
        key,
      });
      return;
    }
    if (!cached) {
      return;
    }
    lastObservationByKey.set(key, {
      checksRollup: cached.pullRequest.checksRollup,
      headSha: cached.pullRequest.headSha,
      state: cached.pullRequest.state,
    });
    lastNumberByKey.set(key, cached.pullRequest.number);
  }

  /** Fetch, diff, persist and push. Wrapped by `fetchAndStore` for in-flight dedup. */
  async function performFetchAndStore(target: ResolvedTarget, key: string): Promise<ForgePrStatus> {
    // Stamped unconditionally, before gh even runs: this is what throttles a
    // `window` refresh, and it stays stamped even if the cache WRITE below
    // fails — the PR was still successfully fetched and delivered, so a
    // failed persist must not make a `window` refresh retry sooner than its
    // floor allows. (`invalidation`/`user` have a 0 ms floor regardless.)
    lastFetchAtByKey.set(key, now());
    await seedObservationFromCache(target, key);
    const fetched = await fetchForgePullRequest(run, {
      branch: target.branch,
      cwd: target.cwd,
      host: target.host,
    });
    if (!fetched.ok) {
      lastFailureByKey.set(key, fetched.failure);
      logger.warn('Forge PR refresh failed', { detail: fetched.failure.detail, key });
      return await readCached(target);
    }
    lastFailureByKey.delete(key);
    const observedAt = new Date(now()).toISOString();
    if (fetched.value === null) {
      try {
        const database = await getDatabase();
        await deleteForgePrCacheEntry(database, target.repoCommonDir, target.branch);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error('Forge PR cache delete failed; a stale cached row may remain', {
          detail,
          key,
        });
      }
      lastObservationByKey.delete(key);
      lastNumberByKey.delete(key);
      onPrUpdated({
        branch: target.branch,
        pullRequest: null,
        repoCommonDir: target.repoCommonDir,
        transitions: [],
      });
      return { kind: 'none', observedAt };
    }
    const pullRequest = fetched.value;
    const transitions = diffObservations(
      lastObservationByKey.get(key),
      pullRequest,
      lastNumberByKey.get(key)
    );
    // The cache is an optimization over a successfully fetched PR: a write
    // failure degrades to delivering it uncached rather than rejecting a
    // call that gh already answered. Logged at error (not swallowed) so the
    // failure is still visible.
    try {
      const database = await getDatabase();
      await writeForgePrCacheEntry(database, {
        branch: target.branch,
        observedAt,
        pullRequest,
        repoCommonDir: target.repoCommonDir,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('Forge PR cache write failed; delivering the fetched pull request uncached', {
        detail,
        key,
      });
    }
    lastObservationByKey.set(key, {
      checksRollup: pullRequest.checksRollup,
      headSha: pullRequest.headSha,
      state: pullRequest.state,
    });
    lastNumberByKey.set(key, pullRequest.number);
    onPrUpdated({
      branch: target.branch,
      pullRequest,
      repoCommonDir: target.repoCommonDir,
      transitions,
    });
    return { kind: 'pr', observedAt, pullRequest };
  }

  /**
   * Dedup concurrent refreshes of the same `(repo, branch)` key into one
   * `performFetchAndStore` call. `invalidation` has a deliberate 0 ms floor,
   * so a burst of ref-move events (or the same repo tracked under two root
   * ids) would otherwise spawn one 20 s-timeout `gh` call per event; this
   * collapses them onto the single in-flight promise instead. The
   * check-and-set below is synchronous — no `await` in between — so it
   * cannot race with itself.
   */
  function fetchAndStore(target: ResolvedTarget): Promise<ForgePrStatus> {
    const key = cacheKey(target.repoCommonDir, target.branch);
    const existing = inFlightFetchByKey.get(key);
    if (existing) {
      return existing;
    }
    const promise = performFetchAndStore(target, key).finally(() => {
      inFlightFetchByKey.delete(key);
    });
    inFlightFetchByKey.set(key, promise);
    return promise;
  }

  async function statusFor(
    rootId: string,
    reason: ForgeRefreshReason | null
  ): Promise<ForgeResult<ForgePrStatus>> {
    const resolved = await resolveTarget(rootId);
    if (!resolved.ok) {
      return resolved;
    }
    if ('failure' in resolved.value) {
      return { ok: true, value: unavailable(resolved.value.failure) };
    }
    const target = resolved.value;
    const ghFailure = await requireGh(target, reason);
    if (ghFailure) {
      return { ok: true, value: unavailable(ghFailure) };
    }
    if (reason === null) {
      return { ok: true, value: await readCached(target) };
    }
    const key = cacheKey(target.repoCommonDir, target.branch);
    const lastFetchAt = lastFetchAtByKey.get(key);
    const floor = FORGE_REFRESH_MIN_INTERVAL_MS[reason];
    if (lastFetchAt !== undefined && now() - lastFetchAt < floor) {
      return { ok: true, value: await readCached(target) };
    }
    return { ok: true, value: await fetchAndStore(target) };
  }

  return {
    identity: async (rootId) => {
      const resolved = await resolveTarget(rootId);
      if (!resolved.ok) {
        return resolved;
      }
      if ('failure' in resolved.value) {
        return {
          ok: true,
          value: {
            failure: resolved.value.failure,
            identity: null,
            repoCommonDir: resolved.value.repoCommonDir,
          },
        };
      }
      return {
        ok: true,
        value: {
          failure: null,
          identity: resolved.value.identity,
          repoCommonDir: resolved.value.repoCommonDir,
        },
      };
    },
    onRepositoryInvalidated: (gitCommonDir) => {
      const rootIds = rootIdsByCommonDir.get(gitCommonDir);
      if (!rootIds) {
        return;
      }
      for (const rootId of rootIds) {
        statusFor(rootId, 'invalidation').catch((error: unknown) => {
          logger.error('Forge invalidation refresh threw', { error, gitCommonDir, rootId });
        });
      }
    },
    prStatus: (rootId) => statusFor(rootId, null),
    refresh: (rootId, reason) => statusFor(rootId, reason),
  };
}
