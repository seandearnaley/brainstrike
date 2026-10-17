import type { ForgeCachePort } from '@brainstrike/state-store';
import { Schema } from 'effect';
/**
 * `requireGh` behavior: gh install/auth detection, session memoization, the
 * R2 probe-rate bound, and R3's never-reject settlement. Split out of
 * `forge-service.test.ts` (which covers fetch/cache/transition behavior) to
 * keep both files under the repo's file-size guidance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgeCacheReplySchema } from '../../agent-host-platform/worktree-forge-store';
import type { ForgeCommandRun, ForgeCommandRunner } from '../../assistant-server/forge-gh-client';
import {
  createForgeService,
  FORGE_AUTH_FAILURE_TTL_MS,
  FORGE_REFRESH_MIN_INTERVAL_MS,
  type ForgeRepositoryResolver,
} from '../../assistant-server/forge-service';

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
describe('createForgeService — gh detection/auth probing (requireGh)', () => {
  let clock = 1_000_000;
  beforeEach(() => {
    clock = 1_000_000;
  });
  const now = () => clock;
  it('promotes an unlabelled enterprise host once gh authenticates for it', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver({ remoteUrl: 'git@git.acme.internal:acme/widgets.git' }),
      run,
    });
    const status = await service.refresh(ROOT_ID, 'user');
    expect(status.ok && status.value.kind).toBe('pr');
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['auth', 'status', '--hostname', 'git.acme.internal'] })
    );
  });
  it('is unavailable with an install hint when gh is missing, and probes only once across repeated refreshes', async () => {
    const run: ForgeCommandRunner = vi.fn(async () => ({
      exitCode: null,
      failureReason: 'notFound' as const,
      stderr: '',
      stdout: '',
    }));
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    const first = await service.refresh(ROOT_ID, 'invalidation');
    await service.refresh(ROOT_ID, 'invalidation');
    expect(first.ok && first.value.kind === 'unavailable' && first.value.failure.reason).toBe(
      'gh-missing'
    );
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('never spawns gh on a pure prStatus read, even when gh is missing (R2a)', async () => {
    const run: ForgeCommandRunner = vi.fn(async () => ({
      exitCode: null,
      failureReason: 'notFound' as const,
      stderr: '',
      stdout: '',
    }));
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    const status = await service.prStatus(ROOT_ID);
    expect(status.ok && status.value.kind).toBe('unknown');
    expect(run).not.toHaveBeenCalled();
  });
  it('never spawns gh on a pure prStatus read while unauthenticated (R2a)', async () => {
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'auth'
        ? { exitCode: 1, stderr: 'You are not logged into any GitHub hosts.', stdout: '' }
        : (HEALTHY_GH['--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.prStatus(ROOT_ID);
    expect(run).not.toHaveBeenCalled();
  });
  it('serves a failed auth probe from cache for 30s instead of re-spawning gh, across two window refreshes (R2b)', async () => {
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'auth'
        ? { exitCode: 1, stderr: 'You are not logged into any GitHub hosts.', stdout: '' }
        : (HEALTHY_GH['--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'window');
    clock += 1000; // well inside the 30s TTL
    await service.refresh(ROOT_ID, 'window');
    expect(countArgCalls(run, 'auth')).toBe(1);
  });
  it('re-probes auth once the failure TTL has elapsed (R2b)', async () => {
    const run: ForgeCommandRunner = vi.fn(async ({ args }) =>
      args[0] === 'auth'
        ? { exitCode: 1, stderr: 'You are not logged into any GitHub hosts.', stdout: '' }
        : (HEALTHY_GH['--version'] as ForgeCommandRun)
    );
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'invalidation');
    clock += FORGE_AUTH_FAILURE_TTL_MS + 1;
    await service.refresh(ROOT_ID, 'invalidation');
    expect(countArgCalls(run, 'auth')).toBe(2);
  });
  it('never rejects when the command runner itself throws, and recovers on the next healthy user refresh (R3)', async () => {
    let shouldReject = true;
    const run: ForgeCommandRunner = vi.fn(async ({ args }) => {
      if (shouldReject) {
        throw new Error('spawn EAGAIN');
      }
      if (args[0] === 'auth') {
        return HEALTHY_GH['auth'] as ForgeCommandRun;
      }
      if (args[0] === 'pr') {
        return HEALTHY_GH['pr'] as ForgeCommandRun;
      }
      return HEALTHY_GH['--version'] as ForgeCommandRun;
    });
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    const first = await service.refresh(ROOT_ID, 'user');
    expect(first.ok).toBe(true);
    expect(first.ok && first.value.kind).toBe('unavailable');
    shouldReject = false;
    const recovered = await service.refresh(ROOT_ID, 'user');
    expect(recovered.ok && recovered.value.kind).toBe('pr');
  });
  it('recovers from a cached gh-unauthenticated failure on an explicit user refresh', async () => {
    const authQueue: ForgeCommandRun[] = [
      { exitCode: 1, stderr: 'You are not logged into any GitHub hosts.', stdout: '' },
      { exitCode: 0, stderr: '', stdout: '' },
    ];
    const run: ForgeCommandRunner = vi.fn(async ({ args }) => {
      if (args[0] === 'auth') {
        return authQueue.shift() as ForgeCommandRun;
      }
      if (args[0] === 'pr') {
        return HEALTHY_GH['pr'] as ForgeCommandRun;
      }
      return HEALTHY_GH['--version'] as ForgeCommandRun;
    });
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    const first = await service.refresh(ROOT_ID, 'user');
    expect(first.ok && first.value.kind === 'unavailable' && first.value.failure.reason).toBe(
      'gh-unauthenticated'
    );
    const second = await service.refresh(ROOT_ID, 'user');
    expect(second.ok && second.value.kind).toBe('pr');
  });
  it('does not re-probe a cached successful auth on window/invalidation refreshes', async () => {
    const run = ghRunner(HEALTHY_GH);
    const service = createForgeService({
      getForgeCache: async () => fakeDatabase(),
      now,
      onPrUpdated: vi.fn(),
      resolveRepository: resolver(),
      run,
    });
    await service.refresh(ROOT_ID, 'user');
    expect(countArgCalls(run, 'auth')).toBe(1);
    await service.refresh(ROOT_ID, 'invalidation');
    clock += FORGE_REFRESH_MIN_INTERVAL_MS.window + 1;
    await service.refresh(ROOT_ID, 'window');
    expect(countArgCalls(run, 'auth')).toBe(1);
  });
});
