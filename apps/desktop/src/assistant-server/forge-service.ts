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
 * moved to a settled verdict. An unchanged observation yields none.
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
  if (
    next.checksRollup !== previous.checksRollup &&
    (next.checksRollup === 'failing' || next.checksRollup === 'passing')
  ) {
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

  async function requireGh(target: ResolvedTarget): Promise<ForgeUnavailable | null> {
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
    return await auth;
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
      return failure
        ? unavailable(failure)
        : { kind: 'none', observedAt: new Date(now()).toISOString() };
    }
    return failure
      ? { failure, kind: 'stale', observedAt: cached.observedAt, pullRequest: cached.pullRequest }
      : { kind: 'pr', observedAt: cached.observedAt, pullRequest: cached.pullRequest };
  }

  async function fetchAndStore(target: ResolvedTarget): Promise<ForgePrStatus> {
    const key = cacheKey(target.repoCommonDir, target.branch);
    lastFetchAtByKey.set(key, now());
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
    const database = await getDatabase();
    if (fetched.value === null) {
      await deleteForgePrCacheEntry(database, target.repoCommonDir, target.branch);
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
    await writeForgePrCacheEntry(database, {
      branch: target.branch,
      observedAt,
      pullRequest,
      repoCommonDir: target.repoCommonDir,
    });
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
    const ghFailure = await requireGh(target);
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
