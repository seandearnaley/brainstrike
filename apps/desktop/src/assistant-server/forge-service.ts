/**
 * Main-process forge (pull-request) awareness — D5 as settled: `gh`-first,
 * EVENT-TRIGGERED refreshes, a small `brainstrike_forge_prs` cache, and no
 * auto-fix / auto-merge anywhere.
 *
 * THERE IS NO TIMER IN THIS FILE, and there must never be one (pinned by a
 * source assertion in `forge-service.test.ts`). Polling is alien to main:
 * every other main-side service is watcher + debounce + TTL. Refreshes are
 * driven by four events, each with its own floor:
 *
 * - `invalidation` (0 ms) — the git-metadata watcher saw refs move on this
 *   repository, i.e. a push/fetch actually happened. Never throttled: the one
 *   moment the remote state is known to have changed is the moment to look.
 * - `shell` (0 ms) — the agent's own shell command created a pull request.
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
  ForgeIdentityState,
  ForgePrStatus,
  ForgePrTransition,
  ForgePrUpdatedEvent,
  ForgePullRequest,
  ForgeRefreshReason,
  ForgeRemoteIdentity,
  ForgeResult,
  ForgeUnavailable,
  GitForgeRepositoryContext,
} from '@brainstrike/types';
import { forgePrCacheKey, parseForgeRemote } from '@brainstrike/types';
import {
  detectGhCli,
  type ForgeCommandRunner,
  fetchForgePullRequest,
  probeGhAuth,
} from './forge-gh-client';
import {
  type ForgeCacheDatabase,
  readForgePrCacheEntry,
  writeForgePrCacheEntry,
} from './forge-pr-cache';
import { desktopAssistantServerLogger as logger } from './logger';

export type { ForgeIdentityState, ForgeRefreshReason } from '@brainstrike/types';

/** Minimum time since the last gh fetch for a `(repo, branch)` key, per reason. */
export const FORGE_REFRESH_MIN_INTERVAL_MS: Readonly<Record<ForgeRefreshReason, number>> = {
  invalidation: 0,
  // A `gh pr create` we just watched happen is the freshest possible trigger.
  shell: 0,
  user: 0,
  window: 60_000,
};

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
  readonly stop: () => Promise<void>;
}

/** Upper bound on waiting for a dependency that ignores the shutdown abort signal. */
export const FORGE_STOP_DRAIN_TIMEOUT_MS = 2000;

const FORGE_STOPPED_ERROR = 'Forge service has stopped.';

class ForgeServiceStoppedError extends Error {
  constructor() {
    super(FORGE_STOPPED_ERROR);
    this.name = 'ForgeServiceStoppedError';
  }
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

/** How long a FAILED auth probe is served from cache before re-probing (R2b). */
export const FORGE_AUTH_FAILURE_TTL_MS = 30_000;

interface AuthProbeState {
  readonly failure: ForgeUnavailable | null;
  readonly probedAt: number;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

export function createForgeService(options: ForgeServiceOptions): ForgeService {
  const { getDatabase, onPrUpdated, resolveRepository, run } = options;
  const now = options.now ?? (() => Date.now());
  const abortController = new AbortController();
  const inFlightOperations = new Set<Promise<unknown>>();
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  const logShutdownCommandAbort = (
    params: Parameters<ForgeCommandRunner>[0],
    outcome: 'rejected' | 'resolved'
  ): void => {
    logger.info('Forge gh command aborted during shutdown', {
      command: params.args[0] ?? '',
      host: params.host,
      outcome,
    });
  };
  const runUntilStopped: ForgeCommandRunner = async (params) => {
    const signal = params.signal
      ? AbortSignal.any([params.signal, abortController.signal])
      : abortController.signal;
    try {
      const result = await run({ ...params, signal });
      if (abortController.signal.aborted && result.failureReason === 'abort') {
        logShutdownCommandAbort(params, 'resolved');
      }
      return result;
    } catch (error) {
      if (abortController.signal.aborted && isAbortError(error)) {
        logShutdownCommandAbort(params, 'rejected');
      }
      throw error;
    }
  };
  /** Resolved once per app session — gh either exists or it does not. */
  let ghDetection: Promise<ForgeUnavailable | null> | undefined;
  // A bracketed IPv6 host is a safe key: Map compares exact strings, and
  // `parseForgeRemote` produces the same bracketed value for the same remote.
  const authStateByHost = new Map<string, AuthProbeState>();
  /** In-flight `probeGhAuth` calls, keyed like `authStateByHost`. */
  const inFlightAuthByHost = new Map<string, Promise<ForgeUnavailable | null>>();
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

  function assertRunning(): void {
    if (stopped) {
      throw new ForgeServiceStoppedError();
    }
  }

  function rethrowStopped(error: unknown): void {
    if (error instanceof ForgeServiceStoppedError) {
      throw error;
    }
  }

  function stoppedResult<T>(): ForgeResult<T> {
    return { error: FORGE_STOPPED_ERROR, ok: false };
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    inFlightOperations.add(operation);
    operation.then(
      () => inFlightOperations.delete(operation),
      () => inFlightOperations.delete(operation)
    );
    return operation;
  }

  function toStoppedResult<T>(operation: Promise<ForgeResult<T>>): Promise<ForgeResult<T>> {
    return operation.catch((error: unknown) => {
      if (error instanceof ForgeServiceStoppedError) {
        return stoppedResult<T>();
      }
      throw error;
    });
  }

  async function resolveTarget(
    rootId: string
  ): Promise<
    ForgeResult<
      ResolvedTarget | { readonly failure: ForgeUnavailable; readonly repoCommonDir: string }
    >
  > {
    const resolved = await resolveRepository(rootId);
    assertRunning();
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

  /** Turns a `run` rejection into a structured failure instead of a thrown error (R3). */
  function settledFailure(error: unknown, context: string): ForgeUnavailable {
    const detail = error instanceof Error ? error.message : String(error);
    return { detail: `${context}: ${detail}`, reason: 'fetch-failed' };
  }

  /**
   * Wraps `detectGhCli` so the promise assigned to `ghDetection` can NEVER
   * settle rejected (R3): if `run` itself throws/rejects, this clears
   * `ghDetection` (so the NEXT call gets a fresh attempt instead of replaying
   * the same rejection forever) and resolves to a structured failure instead.
   */
  function detectGhCliSettled(cwd: string): Promise<ForgeUnavailable | null> {
    return detectGhCli(runUntilStopped, cwd).catch((error: unknown) => {
      ghDetection = undefined;
      return settledFailure(error, 'gh --version could not be run');
    });
  }

  /** Same discipline as `detectGhCliSettled`, for the in-flight auth probe (R3). */
  function probeGhAuthSettled(cwd: string, host: string): Promise<ForgeUnavailable | null> {
    return probeGhAuth(runUntilStopped, cwd, host).catch((error: unknown) => {
      inFlightAuthByHost.delete(host);
      return settledFailure(error, 'gh auth status could not be run');
    });
  }

  /**
   * `ghDetection` is session-scoped for BOTH outcomes: "gh either exists or
   * it does not" is treated as stable for the life of the process, so a
   * `gh-missing` failure stays memoized too — this bounds how often the CLI
   * itself gets probed across the window-focus and invalidation refreshes
   * that call `requireGh` (pinned by the "probes only once" test). It is
   * cleared only by an explicit `user`-reason refresh (the affordance
   * offered for "I just installed/fixed it") or by a settled rejection (R3,
   * `detectGhCliSettled`).
   *
   * Auth is different: it is mutable runtime state the user is explicitly
   * told to change (`gh auth login --hostname <host>`), and `probeGhAuth`
   * performs a real network token-validation call — a single transient
   * DNS/proxy/503 blip must not poison the session forever. A SUCCESSFUL
   * probe stays memoized indefinitely, exactly like `ghDetection`. A FAILED
   * probe is served from `authStateByHost` for `FORGE_AUTH_FAILURE_TTL_MS`
   * (30s) WITHOUT re-spawning `gh` (R2b) — this is what bounds the probe rate
   * for a repository whose window/invalidation refreshes keep firing while
   * the user is simply not logged in — and past that TTL the next refresh
   * re-probes automatically. An explicit `user`-reason refresh always clears
   * BOTH the cached state and any in-flight probe FIRST, before any `await`
   * that could throw (R3), so "I just fixed it" always lands a fresh probe.
   *
   * Never called for the pure cache-read path (`reason === null`, R2a) — see
   * `statusFor`.
   */
  async function requireGh(
    target: ResolvedTarget,
    reason: ForgeRefreshReason
  ): Promise<ForgeUnavailable | null> {
    if (reason === 'user') {
      authStateByHost.delete(target.host);
      inFlightAuthByHost.delete(target.host);
      ghDetection = undefined;
    }
    ghDetection ??= detectGhCliSettled(target.cwd);
    const detection = await ghDetection;
    if (detection) {
      return detection;
    }
    const cachedAuth = authStateByHost.get(target.host);
    if (
      cachedAuth &&
      (cachedAuth.failure === null || now() - cachedAuth.probedAt < FORGE_AUTH_FAILURE_TTL_MS)
    ) {
      return cachedAuth.failure;
    }
    let inFlight = inFlightAuthByHost.get(target.host);
    if (!inFlight) {
      inFlight = probeGhAuthSettled(target.cwd, target.host);
      inFlightAuthByHost.set(target.host, inFlight);
    }
    const failure = await inFlight;
    inFlightAuthByHost.delete(target.host);
    authStateByHost.set(target.host, { failure, probedAt: now() });
    return failure;
  }

  /**
   * Folds a durable cache read (which may itself be an observed `none`, R1)
   * together with a failure into the `ForgePrStatus` the caller sees.
   */
  function toStatus(
    cached: Awaited<ReturnType<typeof readForgePrCacheEntry>>,
    failure: ForgeUnavailable | null
  ): ForgePrStatus {
    if (!cached) {
      // No cached row AND no recorded failure means nothing has ever
      // answered for this key — not an observed absence. Fabricating
      // `{ kind: 'none', observedAt: now }` here would lie to any "Last
      // checked …" affordance built on that timestamp.
      return failure ? unavailable(failure) : { kind: 'unknown' };
    }
    if (failure) {
      // R6: a REFRESH whose gh-detection/auth preflight or fetch failed still
      // has a durable observation to fall back on — never hide it behind a
      // bare `unavailable`. `pullRequest` is `null` when the last observation
      // was itself a `none` (R1) — still an honest "last known state, refresh
      // currently failing".
      return {
        failure,
        kind: 'stale',
        observedAt: cached.observedAt,
        pullRequest: cached.pullRequest,
      };
    }
    return cached.pullRequest
      ? { kind: 'pr', observedAt: cached.observedAt, pullRequest: cached.pullRequest }
      : { kind: 'none', observedAt: cached.observedAt };
  }

  /**
   * Reads the durable cache row (if any) and folds in a failure — by default
   * `lastFailureByKey`'s last recorded FETCH failure, or an `overrideFailure`
   * supplied by a caller whose gh-detection/auth PREFLIGHT failed before ever
   * attempting a fetch (R6).
   *
   * NEVER invokes `requireGh` and NEVER spawns a `gh` subprocess (R2a) — this
   * is the pure cache-read path `statusFor` uses for `reason === null`:
   * rendering already-cached content must not probe gh's install/auth state.
   */
  async function readCached(
    target: ResolvedTarget,
    overrideFailure?: ForgeUnavailable
  ): Promise<ForgePrStatus> {
    const key = forgePrCacheKey(target.repoCommonDir, target.branch);
    const failure = overrideFailure ?? lastFailureByKey.get(key) ?? null;
    let cached: Awaited<ReturnType<typeof readForgePrCacheEntry>> = null;
    try {
      assertRunning();
      const database = await getDatabase();
      assertRunning();
      cached = await readForgePrCacheEntry(database, target.repoCommonDir, target.branch);
      assertRunning();
    } catch (error) {
      rethrowStopped(error);
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('Forge PR cache read failed', { detail, key });
      return unavailable({ detail, reason: 'fetch-failed' });
    }
    return toStatus(cached, failure);
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
      assertRunning();
      const database = await getDatabase();
      assertRunning();
      cached = await readForgePrCacheEntry(database, target.repoCommonDir, target.branch);
      assertRunning();
    } catch (error) {
      rethrowStopped(error);
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('Forge PR cache seed read failed; diffing against no prior observation', {
        detail,
        key,
      });
      return;
    }
    if (!cached || cached.pullRequest === null) {
      // No row, or a durable `none` observation (R1): either way there is no
      // prior PR to diff against, so leave the maps empty — a subsequently
      // observed PR still correctly reports `opened`.
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
    // R3: `fetchForgePullRequest` itself never rejects (every failure path is
    // a resolved `{ ok: false }`), but the injected `run` it awaits internally
    // could — this seam guarantees `statusFor`/`refresh` never reject either.
    const fetched = await fetchForgePullRequest(runUntilStopped, {
      branch: target.branch,
      cwd: target.cwd,
      host: target.host,
      owner: target.identity.owner,
      repo: target.identity.repo,
    }).catch((error: unknown) => ({
      failure: settledFailure(error, 'gh pr list could not be run'),
      ok: false as const,
    }));
    assertRunning();
    if (!fetched.ok) {
      lastFailureByKey.set(key, fetched.failure);
      logger.warn('Forge PR refresh failed', { detail: fetched.failure.detail, key });
      return await readCached(target);
    }
    lastFailureByKey.delete(key);
    const observedAt = new Date(now()).toISOString();
    if (fetched.value === null) {
      // R1/R7: an observed absence is a durable cache row, not a delete — the
      // whole point of this table is instant boot rendering, and "gh answered
      // no PR" deserves the same durability as "gh answered a PR". A write
      // failure degrades to delivering the observed `none` to the caller
      // (same discipline as the PR write below) rather than silently leaving
      // a stale PR row the list-wide projection would still show.
      try {
        assertRunning();
        const database = await getDatabase();
        assertRunning();
        await writeForgePrCacheEntry(database, {
          branch: target.branch,
          observedAt,
          pullRequest: null,
          repoCommonDir: target.repoCommonDir,
        });
        assertRunning();
      } catch (error) {
        rethrowStopped(error);
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(
          'Forge PR cache write failed (observed absence); a stale cached PR row may remain',
          { detail, key }
        );
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
      assertRunning();
      const database = await getDatabase();
      assertRunning();
      await writeForgePrCacheEntry(database, {
        branch: target.branch,
        observedAt,
        pullRequest,
        repoCommonDir: target.repoCommonDir,
      });
      assertRunning();
    } catch (error) {
      rethrowStopped(error);
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
    const key = forgePrCacheKey(target.repoCommonDir, target.branch);
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
    assertRunning();
    const resolved = await resolveTarget(rootId);
    if (!resolved.ok) {
      return resolved;
    }
    if ('failure' in resolved.value) {
      return { ok: true, value: unavailable(resolved.value.failure) };
    }
    const target = resolved.value;
    if (reason === null) {
      // R2a: the pure cache-read path NEVER calls `requireGh` and NEVER
      // spawns a `gh` subprocess — it serves the durable cache (or
      // `unknown`). Only an explicit refresh reason probes gh's install/auth
      // state.
      return { ok: true, value: await readCached(target) };
    }
    const ghFailure = await requireGh(target, reason);
    assertRunning();
    if (ghFailure) {
      // R6: fall back to the durable cache (as `stale`) instead of a bare
      // `unavailable` that would hide a durable observation behind a
      // transient probe failure.
      return { ok: true, value: await readCached(target, ghFailure) };
    }
    const key = forgePrCacheKey(target.repoCommonDir, target.branch);
    const lastFetchAt = lastFetchAtByKey.get(key);
    const floor = FORGE_REFRESH_MIN_INTERVAL_MS[reason];
    if (lastFetchAt !== undefined && now() - lastFetchAt < floor) {
      return { ok: true, value: await readCached(target) };
    }
    return { ok: true, value: await fetchAndStore(target) };
  }

  function trackedStatusFor(
    rootId: string,
    reason: ForgeRefreshReason | null
  ): Promise<ForgeResult<ForgePrStatus>> {
    if (stopped) {
      return Promise.resolve(stoppedResult());
    }
    return track(toStoppedResult(statusFor(rootId, reason)));
  }

  function stop(): Promise<void> {
    if (stopPromise) {
      return stopPromise;
    }
    stopped = true;
    abortController.abort();
    const pending = [...inFlightOperations];
    stopPromise = (async () => {
      if (pending.length === 0) {
        return;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const settledInTime = await Promise.race([
          Promise.allSettled(pending).then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), FORGE_STOP_DRAIN_TIMEOUT_MS);
          }),
        ]);
        if (!settledInTime) {
          logger.error('Forge service stop timed out while draining in-flight operations', {
            drainTimeoutMs: FORGE_STOP_DRAIN_TIMEOUT_MS,
            pendingOperations: inFlightOperations.size,
          });
        }
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    })();
    return stopPromise;
  }

  return {
    identity: (rootId) => {
      if (stopped) {
        return Promise.resolve(stoppedResult());
      }
      const operation: Promise<ForgeResult<ForgeIdentityState>> = (async () => {
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
      })();
      return track(toStoppedResult(operation));
    },
    onRepositoryInvalidated: (gitCommonDir) => {
      const rootIds = rootIdsByCommonDir.get(gitCommonDir);
      if (!rootIds) {
        return;
      }
      for (const rootId of rootIds) {
        trackedStatusFor(rootId, 'invalidation').catch((error: unknown) => {
          logger.error('Forge invalidation refresh threw', { error, gitCommonDir, rootId });
        });
      }
    },
    prStatus: (rootId) => trackedStatusFor(rootId, null),
    refresh: (rootId, reason) => trackedStatusFor(rootId, reason),
    stop,
  };
}
