import { describe, expect, it, vi } from 'vitest';
import {
  createPinnedGhEnvironment,
  detectGhCli,
  execFileGhRunner,
  type ForgeCommandRun,
  type ForgeCommandRunner,
  fetchForgePullRequest,
  probeGhAuth,
} from '../../assistant-server/forge-gh-client';

const ok = (stdout: string): ForgeCommandRun => ({ exitCode: 0, stderr: '', stdout });
const failed = (stderr: string): ForgeCommandRun => ({ exitCode: 1, stderr, stdout: '' });

describe('execFileGhRunner', () => {
  it('reports an explicitly aborted command separately from a timeout', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      execFileGhRunner({
        args: ['--version'],
        cwd: '/tmp',
        host: 'github.com',
        signal: controller.signal,
        timeoutMs: 20_000,
      })
    ).resolves.toMatchObject({ exitCode: null, failureReason: 'abort' });
  });
});

function runnerReturning(...runs: readonly ForgeCommandRun[]): ForgeCommandRunner {
  const queue = [...runs];
  return vi.fn(async () => queue.shift() ?? failed('unexpected extra gh invocation'));
}

describe('createPinnedGhEnvironment', () => {
  it('pins the host and disables prompts, pagers and colour', () => {
    const env = createPinnedGhEnvironment({ PATH: '/usr/bin' }, 'github.acme.test');
    expect(env['GH_HOST']).toBe('github.acme.test');
    expect(env['GH_PROMPT_DISABLED']).toBe('1');
    expect(env['GH_NO_UPDATE_NOTIFIER']).toBe('1');
    expect(env['GH_PAGER']).toBe('cat');
    expect(env['NO_COLOR']).toBe('1');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['LC_ALL']).toBe('C');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('drops inherited GH_* redirection but keeps GH_CONFIG_DIR and github.com tokens', () => {
    const env = createPinnedGhEnvironment(
      {
        GH_CONFIG_DIR: '/cfg',
        GH_ENTERPRISE_TOKEN: 'ent',
        GH_HOST: 'evil.test',
        GH_REPO: 'evil/repo',
        GH_TOKEN: 'tok',
        GITHUB_ENTERPRISE_TOKEN: 'gh-ent',
        GITHUB_TOKEN: 'gh-tok',
      },
      'github.com'
    );
    expect(env['GH_HOST']).toBe('github.com');
    expect(env['GH_REPO']).toBeUndefined();
    expect(env['GH_TOKEN']).toBe('tok');
    expect(env['GITHUB_TOKEN']).toBe('gh-tok');
    expect(env['GH_CONFIG_DIR']).toBe('/cfg');
    // Never forwarded, on any host — see the dedicated enterprise-host test below.
    expect(env['GH_ENTERPRISE_TOKEN']).toBeUndefined();
    expect(env['GITHUB_ENTERPRISE_TOKEN']).toBeUndefined();
  });

  it('SECURITY: never forwards any of the four token vars to a non-github.com host, even when all are set', () => {
    const env = createPinnedGhEnvironment(
      {
        GH_ENTERPRISE_TOKEN: 'ent',
        GH_TOKEN: 'tok',
        GITHUB_ENTERPRISE_TOKEN: 'gh-ent',
        GITHUB_TOKEN: 'gh-tok',
      },
      'ghes.example.com'
    );
    // GH_HOST is derived from the opened repository's own remote, not user
    // input — an attacker-controlled `origin` pointing at a GHES host must
    // never be handed a token go-gh would resolve for github.com or for the
    // user's real enterprise host.
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['GH_ENTERPRISE_TOKEN']).toBeUndefined();
    expect(env['GITHUB_ENTERPRISE_TOKEN']).toBeUndefined();
  });
});

describe('detectGhCli', () => {
  it('returns null when gh answers --version', async () => {
    await expect(
      detectGhCli(runnerReturning(ok('gh version 2.60.0')), '/repo')
    ).resolves.toBeNull();
  });

  it('reports gh-missing with an install hint when the binary is absent', async () => {
    const run: ForgeCommandRunner = async () => ({
      exitCode: null,
      failureReason: 'notFound',
      stderr: '',
      stdout: '',
    });
    await expect(detectGhCli(run, '/repo')).resolves.toEqual({
      detail: 'GitHub CLI (gh) was not found on PATH. Install it to see pull request status.',
      reason: 'gh-missing',
    });
  });

  it('reports gh-missing carrying stderr when gh exits non-zero', async () => {
    const failure = await detectGhCli(runnerReturning(failed('dyld: bad image')), '/repo');
    expect(failure?.reason).toBe('gh-missing');
    expect(failure?.detail).toContain('dyld: bad image');
  });
});

describe('probeGhAuth', () => {
  it('returns null when gh is authenticated for the host', async () => {
    await expect(probeGhAuth(runnerReturning(ok('')), '/repo', 'github.com')).resolves.toBeNull();
  });

  it('reports gh-unauthenticated naming the host and the fix', async () => {
    const failure = await probeGhAuth(
      runnerReturning(failed('You are not logged into any GitHub hosts.')),
      '/repo',
      'github.acme.test'
    );
    expect(failure?.reason).toBe('gh-unauthenticated');
    expect(failure?.detail).toContain('github.acme.test');
    expect(failure?.detail).toContain('gh auth login');
  });

  it('passes --hostname so the probe is host-scoped', async () => {
    const run = runnerReturning(ok(''));
    await probeGhAuth(run, '/repo', 'github.acme.test');
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['auth', 'status', '--hostname', 'github.acme.test'],
        cwd: '/repo',
        host: 'github.acme.test',
      })
    );
  });
});

describe('fetchForgePullRequest', () => {
  const prJson = JSON.stringify([
    {
      headRefOid: 'abc123',
      isDraft: false,
      number: 2574,
      reviewDecision: 'APPROVED',
      state: 'OPEN',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://example.test/1',
          name: 'unit',
          status: 'COMPLETED',
        },
      ],
      title: 'Add the workspace bar',
      url: 'https://github.com/acme/widgets/pull/2574',
    },
  ]);

  it('maps one gh row into a ForgePullRequest with a derived rollup', async () => {
    const result = await fetchForgePullRequest(runnerReturning(ok(prJson)), {
      branch: 'feature/bar',
      cwd: '/repo',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    });
    expect(result).toEqual({
      ok: true,
      value: {
        checks: [{ conclusion: 'success', name: 'unit', url: 'https://example.test/1' }],
        checksRollup: 'passing',
        headSha: 'abc123',
        isDraft: false,
        number: 2574,
        reviewDecision: 'APPROVED',
        state: 'open',
        title: 'Add the workspace bar',
        url: 'https://github.com/acme/widgets/pull/2574',
      },
    });
  });

  it('asks gh for every branch state so a merged PR is still observed', async () => {
    const run = runnerReturning(ok('[]'));
    await fetchForgePullRequest(run, {
      branch: 'feature/bar',
      cwd: '/repo',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          'pr',
          'list',
          '--repo',
          'github.com/acme/widgets',
          '--head',
          'feature/bar',
          '--state',
          'all',
          '--limit',
          '1',
          '--json',
          'number,url,title,state,isDraft,reviewDecision,statusCheckRollup,headRefOid',
        ],
      })
    );
  });

  it('pins the lookup to the RESOLVED repository, not gh cwd/default-repo routing (R5)', async () => {
    const run = runnerReturning(ok('[]'));
    await fetchForgePullRequest(run, {
      branch: 'feature/bar',
      cwd: '/repo',
      host: 'github.acme.test',
      owner: 'acme-corp',
      repo: 'internal-tool',
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(['--repo', 'github.acme.test/acme-corp/internal-tool']),
      })
    );
  });

  it('returns a null pull request for an empty list — an observed absence', async () => {
    await expect(
      fetchForgePullRequest(runnerReturning(ok('[]')), {
        branch: 'feature/bar',
        cwd: '/repo',
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
      })
    ).resolves.toEqual({ ok: true, value: null });
  });

  it('surfaces gh stderr as a fetch-failed failure, never as "no PR"', async () => {
    const result = await fetchForgePullRequest(
      runnerReturning(failed('HTTP 401: Bad credentials')),
      {
        branch: 'feature/bar',
        cwd: '/repo',
        host: 'github.com',
        owner: 'acme',
        repo: 'widgets',
      }
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.reason).toBe('fetch-failed');
    expect(result.ok === false && result.failure.detail).toContain('HTTP 401');
  });

  it('surfaces malformed JSON as fetch-failed', async () => {
    const result = await fetchForgePullRequest(runnerReturning(ok('not json')), {
      branch: 'feature/bar',
      cwd: '/repo',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.detail).toContain('could not be parsed');
  });

  it('surfaces an unreadable checks rollup instead of an empty checks list', async () => {
    const broken = JSON.stringify([
      {
        headRefOid: 'abc',
        isDraft: false,
        number: 1,
        reviewDecision: null,
        state: 'OPEN',
        statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED' }],
        title: 't',
        url: 'https://example.test/pull/1',
      },
    ]);
    const result = await fetchForgePullRequest(runnerReturning(ok(broken)), {
      branch: 'b',
      cwd: '/repo',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.detail).toContain('name');
  });

  it('surfaces an unrecognized non-empty review decision as fetch-failed naming the value, instead of silently coercing to null (R8)', async () => {
    const broken = JSON.stringify([
      {
        headRefOid: 'abc',
        isDraft: false,
        number: 7,
        reviewDecision: 'BOGUS_DECISION',
        state: 'OPEN',
        statusCheckRollup: [],
        title: 't',
        url: 'https://example.test/pull/7',
      },
    ]);
    const result = await fetchForgePullRequest(runnerReturning(ok(broken)), {
      branch: 'b',
      cwd: '/repo',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.reason).toBe('fetch-failed');
    expect(result.ok === false && result.failure.detail).toContain('BOGUS_DECISION');
  });

  it('reads an empty-string review decision as null (no review yet), not a failure (R8)', async () => {
    const withEmptyReview = JSON.stringify([
      {
        headRefOid: 'abc',
        isDraft: false,
        number: 8,
        reviewDecision: '',
        state: 'OPEN',
        statusCheckRollup: [],
        title: 't',
        url: 'https://example.test/pull/8',
      },
    ]);
    const result = await fetchForgePullRequest(runnerReturning(ok(withEmptyReview)), {
      branch: 'b',
      cwd: '/repo',
      host: 'github.com',
      owner: 'acme',
      repo: 'widgets',
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value?.reviewDecision).toBeNull();
  });
});
