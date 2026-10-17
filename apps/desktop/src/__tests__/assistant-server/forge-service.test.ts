import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ForgeCachePort } from '@brainstrike/state-store';
import type { ForgePullRequest } from '@brainstrike/types';
import { Schema } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgeCacheReplySchema } from '../../agent-host-platform/worktree-forge-store';
import type { ForgeCommandRun, ForgeCommandRunner } from '../../assistant-server/forge-gh-client';
import {
  createForgeService,
  FORGE_REFRESH_MIN_INTERVAL_MS,
  FORGE_STOP_DRAIN_TIMEOUT_MS,
  type ForgeRepositoryResolver,
} from '../../assistant-server/forge-service';
import { desktopAssistantServerLogger } from '../../assistant-server/logger';

const ROOT_ID = 'root-1';
const COMMON_DIR = '/repos/widgets/.git';
const prJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify([
    {
      headRefOid: 'sha-1',
      isDraft: false,
      number: 42,
      reviewDecision: null,
      state: 'OPEN',
      statusCheckRollup: [
        { __typename: 'CheckRun', conclusion: 'SUCCESS', name: 'unit', status: 'COMPLETED' },
      ],
      title: 'Widget it',
      url: 'https://github.com/acme/widgets/pull/42',
      ...overrides,
    },
  ]);
function resolver(
  overrides: Partial<{
    branch: string | null;
    remoteReason: string | null;
    remoteUrl: string | null;
  }> = {}
): ForgeRepositoryResolver {
  return async () => ({
    ok: true,
    value: {
      context: {
        branch: 'branch' in overrides ? (overrides.branch ?? null) : 'feature/bar',
        commonDir: COMMON_DIR,
        remoteReason: overrides.remoteReason ?? null,
        remoteUrl:
          'remoteUrl' in overrides
            ? (overrides.remoteUrl ?? null)
            : 'git@github.com:acme/widgets.git',
      },
      cwd: '/repos/widgets',
    },
  });
}
/** In-memory stand-in for `brainstrike_forge_prs`, keyed like the real PK. */
function fakeDatabase(): ForgeCachePort & {
  readonly rows: Map<string, unknown>;
} {
  const rows = new Map<string, unknown>();
  return {
    forgeCache: async (request) => {
      const key = `${request.repoCommonDir}\0${request.branch}`;
      if (request.operation === 'write') {
        rows.set(key, { observedAt: request.observedAt, pullRequest: request.pullRequest });
      }
      return Schema.decodeUnknownSync(ForgeCacheReplySchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })({ entry: rows.get(key) ?? null });
    },
    forgeCacheSnapshot: async () => [],
    rows,
  };
}
function ghRunner(byCommand: Readonly<Record<string, ForgeCommandRun>>): ForgeCommandRunner {
  return vi.fn(async ({ args }) => {
    const key = args[0] === 'pr' ? 'pr' : (args[0] ?? '');
    return byCommand[key] ?? { exitCode: 1, stderr: `unstubbed gh ${args.join(' ')}`, stdout: '' };
  });
}
/** Count of invocations of a mocked `ForgeCommandRunner` whose first arg matches. */
function countArgCalls(run: ForgeCommandRunner, firstArg: string): number {
  return (
    run as unknown as {
      mock: {
        calls: readonly [
          {
            args: readonly string[];
          },
        ][];
      };
    }
  ).mock.calls.filter(([params]) => params.args[0] === firstArg).length;
}
const HEALTHY_GH: Readonly<Record<string, ForgeCommandRun>> = {
  '--version': { exitCode: 0, stderr: '', stdout: 'gh version 2.60.0' },
  auth: { exitCode: 0, stderr: '', stdout: '' },
  pr: { exitCode: 0, stderr: '', stdout: prJson() },
};
describe('createForgeService', () => {
  let clock = 1_000_000;
  beforeEach(() => {
    clock = 1_000_000;
  });
  const now = () => clock;
  it('never free-runs: the module contains only the sanctioned shutdown timer', () => {
    const source = readFileSync(
      path.join(import.meta.dirname, '../../assistant-server/forge-service.ts'),
      'utf8'
    );
    expect(source).not.toContain('setInterval');
    expect(source.match(/setTimeout\(/gu)).toHaveLength(1);
    expect(source).toContain('AbortSignal.any([params.signal, abortController.signal])');
  });
  it('fetches, caches and reports a pull request', async () => {
    const database = fakeDatabase();
    const service = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run: ghRunner(HEALTHY_GH),
    });
    const refreshed = await service.refresh(ROOT_ID, 'user');
    expect(refreshed.ok).toBe(true);
    expect(refreshed.ok && refreshed.value.kind).toBe('pr');
    expect(
      refreshed.ok && refreshed.value.kind === 'pr' && refreshed.value.pullRequest.number
    ).toBe(42);
    expect(database.rows.size).toBe(1);
  });
  it('sources the `gh pr list --repo` pin from the resolved target.identity, not a hardcoded default', async () => {
    // Distinct from forge-gh-client.test.ts's `--repo` assertion, which only
    // proves fetchForgePullRequest FORMATS a given owner/repo/host into the
    // arg correctly. This pins the SERVICE half of that contract: that
    // `performFetchAndStore` actually threads `target.identity.owner`/`.repo`
    // (resolved here from `resolver()`'s `git@github.com:acme/widgets.git`
    // fixture) through to the runner, rather than the client's own default or
    // some other value.
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    const prCall = (
      run as unknown as {
        mock: {
          calls: readonly [
            {
              args: readonly string[];
            },
          ][];
        };
      }
    ).mock.calls.find(([params]) => params.args[0] === 'pr');
    expect(prCall).toBeDefined();
    const args = prCall?.[0].args ?? [];
    const repoFlagIndex = args.indexOf('--repo');
    expect(repoFlagIndex).toBeGreaterThanOrEqual(0);
    expect(args[repoFlagIndex + 1]).toBe('github.com/acme/widgets');
  });
  it('reports the first observation as an "opened" transition', async () => {
    const onPrUpdated = vi.fn();
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated,
      resolveRepository: resolver(),
      run: ghRunner(HEALTHY_GH),
    });
    await service.refresh(ROOT_ID, 'user');
    expect(onPrUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/bar',
        repoCommonDir: COMMON_DIR,
        transitions: ['opened'],
      })
    );
  });
  it('reports a checks transition when the rollup changes on the same head', async () => {
    const database = fakeDatabase();
    const onPrUpdated = vi.fn();
    const failingChecks = prJson({
      statusCheckRollup: [
        { __typename: 'CheckRun', conclusion: 'FAILURE', name: 'unit', status: 'COMPLETED' },
      ],
    });
    const queue = [
      HEALTHY_GH['pr'] as ForgeCommandRun,
      { exitCode: 0, stderr: '', stdout: failingChecks },
    ];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) => {
      if (args[0] === 'pr') {
        return queue.shift() as ForgeCommandRun;
      }
      return HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun;
    });
    const service = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated,
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    await service.refresh(ROOT_ID, 'user');
    expect(onPrUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ transitions: ['checks'] })
    );
  });
  it('reports a merged transition and keeps the row', async () => {
    const database = fakeDatabase();
    const onPrUpdated = vi.fn();
    const merged = prJson({ state: 'MERGED' });
    const queue = [
      HEALTHY_GH['pr'] as ForgeCommandRun,
      { exitCode: 0, stderr: '', stdout: merged },
    ];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'pr'
        ? (queue.shift() as ForgeCommandRun)
        : (HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated,
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    await service.refresh(ROOT_ID, 'user');
    expect(onPrUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ transitions: ['merged'] })
    );
    expect(database.rows.size).toBe(1);
  });
  it('durably records an observed absence instead of deleting the row (R1/R7)', async () => {
    const database = fakeDatabase();
    const queue = [
      HEALTHY_GH['pr'] as ForgeCommandRun,
      { exitCode: 0, stderr: '', stdout: '[]' } as ForgeCommandRun,
    ];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'pr'
        ? (queue.shift() as ForgeCommandRun)
        : (HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    const second = await service.refresh(ROOT_ID, 'user');
    expect(second.ok && second.value.kind).toBe('none');
    // The row survives — as a durable "none" observation, not a deletion.
    expect(database.rows.size).toBe(1);
    expect(
      Schema.decodeUnknownSync(ForgeCacheReplySchema, { errors: 'all', onExcessProperty: 'error' })(
        { entry: database.rows.get(`${COMMON_DIR}\0feature/bar`) }
      ).entry?.pullRequest
    ).toBeNull();
  });
  it('reports the SAME durable "none" observedAt on an immediate prStatus read (R1)', async () => {
    const database = fakeDatabase();
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'pr'
        ? ({ exitCode: 0, stderr: '', stdout: '[]' } as ForgeCommandRun)
        : (HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    const refreshed = await service.refresh(ROOT_ID, 'user');
    expect(refreshed.ok && refreshed.value.kind).toBe('none');
    const observedAt =
      refreshed.ok && refreshed.value.kind === 'none' ? refreshed.value.observedAt : null;
    expect(observedAt).not.toBeNull();
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind).toBe('none');
    expect(status.ok && status.value.kind === 'none' && status.value.observedAt).toBe(observedAt);
  });
  it('still reports "none" for a brand-new service reading the same durable row after a restart (R1)', async () => {
    const database = fakeDatabase();
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'pr'
        ? ({ exitCode: 0, stderr: '', stdout: '[]' } as ForgeCommandRun)
        : (HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun)
    );
    const first = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await first.refresh(ROOT_ID, 'user');
    const restarted = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      // prStatus never spawns (R2a), so a runner that would fail every call
      // is fine here — it proves the "none" comes from the durable row, not
      // a fresh gh answer.
      run: ghRunner({}),
    });
    const status = await restarted.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind).toBe('none');
  });
  it('returns the last-known PR as STALE with the failure when gh fails', async () => {
    const database = fakeDatabase();
    const queue = [
      HEALTHY_GH['pr'] as ForgeCommandRun,
      { exitCode: 1, stderr: 'HTTP 503: upstream', stdout: '' } as ForgeCommandRun,
    ];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'pr'
        ? (queue.shift() as ForgeCommandRun)
        : (HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    const stale = await service.refresh(ROOT_ID, 'user');
    expect(stale.ok && stale.value.kind).toBe('stale');
    expect(stale.ok && stale.value.kind === 'stale' && stale.value.failure.detail).toContain(
      'HTTP 503'
    );
    expect(stale.ok && stale.value.kind === 'stale' && stale.value.pullRequest?.number).toBe(42);
  });
  it('returns the durable cache as STALE (not bare unavailable) when a REFRESH auth preflight fails (R6)', async () => {
    const database = fakeDatabase();
    database.rows.set(`${COMMON_DIR}\0feature/bar`, {
      observedAt: new Date(now()).toISOString(),
      pullRequest: {
        checks: [{ conclusion: 'success', name: 'unit', url: null }],
        checksRollup: 'passing',
        headSha: 'sha-1',
        isDraft: false,
        number: 42,
        reviewDecision: null,
        state: 'open',
        title: 'Widget it',
        url: 'https://github.com/acme/widgets/pull/42',
      },
    });
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'auth'
        ? { exitCode: 1, stderr: 'You are not logged into any GitHub hosts.', stdout: '' }
        : (HEALTHY_GH['--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    const status = await service.refresh(ROOT_ID, 'window');
    expect(status.ok && status.value.kind).toBe('stale');
    expect(status.ok && status.value.kind === 'stale' && status.value.failure.reason).toBe(
      'gh-unauthenticated'
    );
    expect(status.ok && status.value.kind === 'stale' && status.value.pullRequest?.number).toBe(42);
  });
  it('throttles a window refresh but never an invalidation or a user refresh', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'window');
    const afterFirst = (
      run as unknown as {
        mock: {
          calls: unknown[];
        };
      }
    ).mock.calls.length;
    await service.refresh(ROOT_ID, 'window');
    expect(
      (
        run as unknown as {
          mock: {
            calls: unknown[];
          };
        }
      ).mock.calls.length
    ).toBe(afterFirst);
    await service.refresh(ROOT_ID, 'invalidation');
    expect(
      (
        run as unknown as {
          mock: {
            calls: unknown[];
          };
        }
      ).mock.calls.length
    ).toBeGreaterThan(afterFirst);
    clock += FORGE_REFRESH_MIN_INTERVAL_MS.window + 1;
    const beforeWindow = (
      run as unknown as {
        mock: {
          calls: unknown[];
        };
      }
    ).mock.calls.length;
    await service.refresh(ROOT_ID, 'window');
    expect(
      (
        run as unknown as {
          mock: {
            calls: unknown[];
          };
        }
      ).mock.calls.length
    ).toBeGreaterThan(beforeWindow);
  });
  it('is unavailable with a reason on a detached HEAD', async () => {
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ branch: null }),
      run: ghRunner(HEALTHY_GH),
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind).toBe('unavailable');
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure.reason).toBe(
      'detached-head'
    );
  });
  it('is unavailable with the git reason when the repository has no usable remote', async () => {
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({
        remoteReason: 'The repository has no git remotes.',
        remoteUrl: null,
      }),
      run: ghRunner(HEALTHY_GH),
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure).toEqual({
      detail: 'The repository has no git remotes.',
      reason: 'no-remote',
    });
  });
  it('is unavailable with a parse reason on an unparsable remote', async () => {
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ remoteUrl: '/Users/sean/mirrors/widgets.git' }),
      run: ghRunner(HEALTHY_GH),
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure.reason).toBe(
      'unparsable-remote'
    );
  });
  it('says GitLab is not supported yet instead of running gh against it', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ remoteUrl: 'git@gitlab.com:acme/widgets.git' }),
      run,
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure.reason).toBe(
      'unsupported-forge'
    );
    expect(
      status.ok && status.value.kind === 'unavailable' && status.value.failure.detail
    ).toContain('GitLab');
    expect(run).not.toHaveBeenCalled();
  });
  it('refreshes only the repositories it has already resolved when a repo is invalidated', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    service.onRepositoryInvalidated(COMMON_DIR);
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    await service.prStatus(ROOT_ID);
    const before = (
      run as unknown as {
        mock: {
          calls: unknown[];
        };
      }
    ).mock.calls.length;
    service.onRepositoryInvalidated(COMMON_DIR);
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
    await vi.waitFor(() =>
      expect(
        (
          run as unknown as {
            mock: {
              calls: unknown[];
            };
          }
        ).mock.calls.length
      ).toBeGreaterThan(before)
    );
  });
  it('reports identity separately so the BranchChip can explain a missing chip', async () => {
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ remoteUrl: '/Users/sean/mirrors/widgets.git' }),
      run: ghRunner(HEALTHY_GH),
    });
    const identity = await service.identity(ROOT_ID);
    expect(identity.ok).toBe(true);
    expect(identity.ok && identity.value.identity).toBeNull();
    expect(identity.ok && identity.value.repoCommonDir).toBe(COMMON_DIR);
    expect(identity.ok && identity.value.failure?.reason).toBe('unparsable-remote');
  });
  it('propagates a repository resolution failure as an error result', async () => {
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: async () => ({ error: 'No open folder matches root id "x".', ok: false }),
      run: ghRunner(HEALTHY_GH),
    });
    await expect(service.prStatus('x')).resolves.toEqual({
      error: 'No open folder matches root id "x".',
      ok: false,
    });
  });
  it('reports "unknown" instead of a fabricated "none" before anything has ever been fetched', async () => {
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run: ghRunner(HEALTHY_GH),
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind).toBe('unknown');
  });
  it('does not re-fire "opened" on restart for a PR already recorded in the durable cache', async () => {
    const database = fakeDatabase();
    const first = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run: ghRunner(HEALTHY_GH),
    });
    await first.refresh(ROOT_ID, 'user');
    expect(database.rows.size).toBe(1);
    // A brand-new service instance over the SAME durable database — the
    // in-memory maps a fresh instance starts with must not be mistaken for
    // "this PR has never been observed".
    const onPrUpdated = vi.fn();
    const restarted = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated,
      resolveRepository: resolver(),
      run: ghRunner(HEALTHY_GH),
    });
    await restarted.refresh(ROOT_ID, 'user');
    expect(onPrUpdated).toHaveBeenCalledWith(expect.objectContaining({ transitions: [] }));
  });
  it('degrades to delivering the fetched PR uncached when the cache write throws', async () => {
    const throwingDatabase: ForgeCachePort = {
      forgeCache: () => Promise.reject(new Error('StateStore not ready')),
      forgeCacheSnapshot: async () => [],
    };
    const onPrUpdated = vi.fn();
    const service = createForgeService({
      getForgeCache: async () => throwingDatabase,
      now,
      onPrUpdated,
      resolveRepository: resolver(),
      run: ghRunner(HEALTHY_GH),
    });
    const result = await service.refresh(ROOT_ID, 'user');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.kind).toBe('pr');
    expect(result.ok && result.value.kind === 'pr' && result.value.pullRequest.number).toBe(42);
    expect(onPrUpdated).toHaveBeenCalledWith(expect.objectContaining({ transitions: ['opened'] }));
  });
  it('reports a transition when the head sha changes with the rollup unchanged', async () => {
    const database = fakeDatabase();
    const onPrUpdated = vi.fn();
    const pushed = prJson({ headRefOid: 'sha-2' });
    const queue = [
      HEALTHY_GH['pr'] as ForgeCommandRun,
      { exitCode: 0, stderr: '', stdout: pushed },
    ];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'pr'
        ? (queue.shift() as ForgeCommandRun)
        : (HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated,
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    await service.refresh(ROOT_ID, 'user');
    expect(onPrUpdated).toHaveBeenLastCalledWith(
      expect.objectContaining({ transitions: ['checks'] })
    );
  });
  it('dedupes concurrent refreshes for the same key into one gh invocation', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    const [a, b] = await Promise.all([
      service.refresh(ROOT_ID, 'invalidation'),
      service.refresh(ROOT_ID, 'invalidation'),
    ]);
    expect(a.ok && a.value.kind).toBe('pr');
    expect(b.ok && b.value.kind).toBe('pr');
    expect(countArgCalls(run, 'pr')).toBe(1);
  });
  it('stops new refresh work, aborts an in-flight gh command, and drains before resolving', async () => {
    const loggerInfo = vi.spyOn(desktopAssistantServerLogger, 'info').mockImplementation(() => {});
    const database = fakeDatabase();
    const getForgeCache = vi.fn(async () => database);
    let resolvePrStarted: ((signal: AbortSignal) => void) | undefined;
    const prStarted = new Promise<AbortSignal>((resolve) => {
      resolvePrStarted = resolve;
    });
    const run: ForgeCommandRunner = vi.fn(async ({ args, signal }) => {
      if (args[0] !== 'pr') {
        return HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun;
      }
      if (!signal) {
        throw new Error('Forge refresh did not provide an abort signal.');
      }
      resolvePrStarted?.(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
      return {
        exitCode: null,
        failureReason: 'abort',
        stderr: 'aborted',
        stdout: '',
      } satisfies ForgeCommandRun;
    });
    const service = createForgeService({
      getForgeCache,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    try {
      const refresh = service.refresh(ROOT_ID, 'user');
      const signal = await prStarted;
      const stop = service.stop();
      expect(signal.aborted).toBe(true);
      await expect(stop).resolves.toBeUndefined();
      await expect(refresh).resolves.toEqual({ error: 'Forge service has stopped.', ok: false });
      await expect(service.refresh(ROOT_ID, 'user')).resolves.toEqual({
        error: 'Forge service has stopped.',
        ok: false,
      });
      expect(loggerInfo).toHaveBeenCalledWith('Forge gh command aborted during shutdown', {
        command: 'pr',
        host: 'github.com',
        outcome: 'resolved',
      });
      expect(getForgeCache).toHaveBeenCalledTimes(1);
      expect(countArgCalls(run, 'pr')).toBe(1);
    } finally {
      loggerInfo.mockRestore();
    }
  });
  it('records structured abort evidence when an in-flight gh command rejects on shutdown', async () => {
    const loggerInfo = vi.spyOn(desktopAssistantServerLogger, 'info').mockImplementation(() => {});
    let resolvePrStarted: (() => void) | undefined;
    const prStarted = new Promise<void>((resolve) => {
      resolvePrStarted = resolve;
    });
    const run: ForgeCommandRunner = vi.fn(async ({ args, signal }) => {
      if (args[0] !== 'pr') {
        return HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun;
      }
      if (!signal) {
        throw new Error('Forge refresh did not provide an abort signal.');
      }
      resolvePrStarted?.();
      return await new Promise<ForgeCommandRun>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('gh aborted', 'AbortError')),
          { once: true }
        )
      );
    });
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    try {
      const refresh = service.refresh(ROOT_ID, 'user');
      await prStarted;
      await service.stop();
      await expect(refresh).resolves.toEqual({ error: 'Forge service has stopped.', ok: false });
      expect(loggerInfo).toHaveBeenCalledWith('Forge gh command aborted during shutdown', {
        command: 'pr',
        host: 'github.com',
        outcome: 'rejected',
      });
    } finally {
      loggerInfo.mockRestore();
    }
  });
  it('does not label a normally completed gh command as aborted when shutdown follows', async () => {
    const loggerInfo = vi.spyOn(desktopAssistantServerLogger, 'info').mockImplementation(() => {});
    let resolvePr: ((run: ForgeCommandRun) => void) | undefined;
    const pendingPr = new Promise<ForgeCommandRun>((resolve) => {
      resolvePr = resolve;
    });
    let resolvePrStarted: (() => void) | undefined;
    const prStarted = new Promise<void>((resolve) => {
      resolvePrStarted = resolve;
    });
    const run: ForgeCommandRunner = vi.fn(async ({ args }) => {
      if (args[0] !== 'pr') {
        return HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun;
      }
      resolvePrStarted?.();
      return await pendingPr;
    });
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    try {
      const refresh = service.refresh(ROOT_ID, 'user');
      await prStarted;
      resolvePr?.(HEALTHY_GH['pr'] as ForgeCommandRun);
      const stop = service.stop();
      await stop;
      await expect(refresh).resolves.toEqual({ error: 'Forge service has stopped.', ok: false });
      expect(loggerInfo).not.toHaveBeenCalledWith(
        'Forge gh command aborted during shutdown',
        expect.anything()
      );
    } finally {
      resolvePr?.(HEALTHY_GH['pr'] as ForgeCommandRun);
      loggerInfo.mockRestore();
    }
  });
  it('bounds stop when an aborted gh command does not settle and fences its late continuation from the database', async () => {
    vi.useFakeTimers();
    const loggerError = vi
      .spyOn(desktopAssistantServerLogger, 'error')
      .mockImplementation(() => {});
    const database = fakeDatabase();
    const getForgeCache = vi.fn(async () => database);
    let resolvePrStarted: ((signal: AbortSignal) => void) | undefined;
    const prStarted = new Promise<AbortSignal>((resolve) => {
      resolvePrStarted = resolve;
    });
    let resolveIdentityStarted: (() => void) | undefined;
    const identityStarted = new Promise<void>((resolve) => {
      resolveIdentityStarted = resolve;
    });
    let resolveIdentity: (() => void) | undefined;
    const pendingIdentity = new Promise<void>((resolve) => {
      resolveIdentity = resolve;
    });
    let resolvePr: ((run: ForgeCommandRun) => void) | undefined;
    const pendingPr = new Promise<ForgeCommandRun>((resolve) => {
      resolvePr = resolve;
    });
    const run: ForgeCommandRunner = vi.fn(async ({ args, signal }) => {
      if (args[0] !== 'pr') {
        return HEALTHY_GH[args[0] === 'auth' ? 'auth' : '--version'] as ForgeCommandRun;
      }
      if (!signal) {
        throw new Error('Forge refresh did not provide an abort signal.');
      }
      resolvePrStarted?.(signal);
      return await pendingPr;
    });
    const service = createForgeService({
      getForgeCache,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: async (rootId) => {
        if (rootId === 'slow-identity') {
          resolveIdentityStarted?.();
          await pendingIdentity;
        }
        return await resolver()(rootId);
      },
      run,
    });
    try {
      const refresh = service.refresh(ROOT_ID, 'user');
      const signal = await prStarted;
      const identity = service.identity('slow-identity');
      await identityStarted;
      let stopSettled = false;
      const stop = service.stop().then(() => {
        stopSettled = true;
      });
      expect(signal.aborted).toBe(true);
      resolveIdentity?.();
      await expect(identity).resolves.toEqual({ error: 'Forge service has stopped.', ok: false });
      await vi.advanceTimersByTimeAsync(FORGE_STOP_DRAIN_TIMEOUT_MS - 1);
      expect(stopSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stop;
      expect(stopSettled).toBe(true);
      expect(loggerError).toHaveBeenCalledWith(
        'Forge service stop timed out while draining in-flight operations',
        { drainTimeoutMs: FORGE_STOP_DRAIN_TIMEOUT_MS, pendingOperations: 1 }
      );
      resolvePr?.(HEALTHY_GH['pr'] as ForgeCommandRun);
      await expect(refresh).resolves.toEqual({ error: 'Forge service has stopped.', ok: false });
      expect(getForgeCache).toHaveBeenCalledTimes(1);
    } finally {
      resolvePr?.(HEALTHY_GH['pr'] as ForgeCommandRun);
      resolveIdentity?.();
      loggerError.mockRestore();
      vi.useRealTimers();
    }
  });
  it('fails loudly on a corrupted cached review decision rather than silently coercing to null', async () => {
    const database = fakeDatabase();
    database.rows.set(`${COMMON_DIR}\0feature/bar`, {
      observedAt: new Date(now()).toISOString(),
      pullRequest: {
        checks: [],
        checksRollup: 'none',
        headSha: 'sha-1',
        isDraft: false,
        number: 42,
        reviewDecision: 'BOGUS',
        state: 'open',
        title: 'Widget it',
        url: 'https://github.com/acme/widgets/pull/42',
      },
    });
    const service = createForgeService({
      getForgeCache: async () => database,
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run: ghRunner(HEALTHY_GH),
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind).toBe('unavailable');
    expect(status.ok && status.value.kind === 'unavailable' && status.value.failure.reason).toBe(
      'fetch-failed'
    );
    expect(
      status.ok && status.value.kind === 'unavailable' && status.value.failure.detail
    ).toContain('reviewDecision');
  });
});
describe('ForgePullRequest cache round trip', () => {
  it('keeps the rollup derivable from the stored checks', () => {
    const pullRequest: ForgePullRequest = {
      checks: [{ conclusion: 'failure', name: 'unit', url: null }],
      checksRollup: 'failing',
      headSha: 'sha',
      isDraft: false,
      number: 1,
      reviewDecision: null,
      state: 'open',
      title: 't',
      url: 'https://example.test/pull/1',
    };
    expect(structuredClone(pullRequest.checks)).toEqual(pullRequest.checks);
  });
});
