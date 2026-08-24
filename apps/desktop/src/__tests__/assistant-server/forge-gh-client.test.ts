import { describe, expect, it, vi } from 'vitest';
import {
  createPinnedGhEnvironment,
  detectGhCli,
  type ForgeCommandRun,
  type ForgeCommandRunner,
  fetchForgePullRequest,
  probeGhAuth,
} from '../../assistant-server/forge-gh-client';

const ok = (stdout: string): ForgeCommandRun => ({ exitCode: 0, stderr: '', stdout });
const failed = (stderr: string): ForgeCommandRun => ({ exitCode: 1, stderr, stdout: '' });

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

  it('drops inherited GH_* redirection but keeps the audited auth/config keys', () => {
    const env = createPinnedGhEnvironment(
      {
        GH_CONFIG_DIR: '/cfg',
        GH_ENTERPRISE_TOKEN: 'ent',
        GH_HOST: 'evil.test',
        GH_REPO: 'evil/repo',
        GH_TOKEN: 'tok',
      },
      'github.com'
    );
    expect(env['GH_HOST']).toBe('github.com');
    expect(env['GH_REPO']).toBeUndefined();
    expect(env['GH_TOKEN']).toBe('tok');
    expect(env['GH_ENTERPRISE_TOKEN']).toBe('ent');
    expect(env['GH_CONFIG_DIR']).toBe('/cfg');
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
    await fetchForgePullRequest(run, { branch: 'feature/bar', cwd: '/repo', host: 'github.com' });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          'pr',
          'list',
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

  it('returns a null pull request for an empty list — an observed absence', async () => {
    await expect(
      fetchForgePullRequest(runnerReturning(ok('[]')), {
        branch: 'feature/bar',
        cwd: '/repo',
        host: 'github.com',
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
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.failure.detail).toContain('name');
  });
});
