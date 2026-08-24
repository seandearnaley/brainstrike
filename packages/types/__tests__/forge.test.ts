import { describe, expect, it } from 'vitest';
import {
  type ForgeCheck,
  parseForgeRemote,
  readForgeChecks,
  resolveForgeRemoteName,
  rollupForgeChecks,
} from '../src/forge.js';

describe('parseForgeRemote', () => {
  it('parses the scp-like ssh form', () => {
    expect(parseForgeRemote('git@github.com:seandearnaley/brainstrike.git')).toEqual({
      ok: true,
      value: {
        forge: 'github',
        host: 'github.com',
        owner: 'seandearnaley',
        repo: 'brainstrike',
      },
    });
  });

  it('parses https with a .git suffix and a userinfo prefix', () => {
    expect(parseForgeRemote('https://octo@github.com/acme/widgets.git')).toEqual({
      ok: true,
      value: { forge: 'github', host: 'github.com', owner: 'acme', repo: 'widgets' },
    });
  });

  it('parses an ssh:// URL with a port and drops the port from the host', () => {
    expect(parseForgeRemote('ssh://git@github.enterprise.example:2222/acme/widgets.git')).toEqual({
      ok: true,
      value: {
        forge: 'github',
        host: 'github.enterprise.example',
        owner: 'acme',
        repo: 'widgets',
      },
    });
  });

  it('keeps a GitLab subgroup namespace in the owner', () => {
    expect(parseForgeRemote('https://gitlab.com/group/subgroup/widgets.git')).toEqual({
      ok: true,
      value: { forge: 'gitlab', host: 'gitlab.com', owner: 'group/subgroup', repo: 'widgets' },
    });
  });

  it('classifies an unlabelled enterprise host as unknown rather than guessing', () => {
    const result = parseForgeRemote('git@git.acme.internal:acme/widgets.git');
    expect(result).toEqual({
      ok: true,
      value: { forge: 'unknown', host: 'git.acme.internal', owner: 'acme', repo: 'widgets' },
    });
  });

  it('lowercases the host', () => {
    const result = parseForgeRemote('https://GitHub.COM/Acme/Widgets');
    expect(result.ok && result.value.host).toBe('github.com');
    expect(result.ok && result.value.owner).toBe('Acme');
  });

  it('fails with a reason on an empty remote', () => {
    expect(parseForgeRemote('   ')).toEqual({
      ok: false,
      reason: 'The remote URL is empty.',
    });
  });

  it('fails with a reason when the path has no owner segment', () => {
    const result = parseForgeRemote('https://github.com/widgets.git');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('owner/repo');
  });

  it('fails with a reason on a local filesystem remote', () => {
    const result = parseForgeRemote('/Users/sean/mirrors/brainstrike.git');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('not a forge URL');
  });

  it('fails with a reason on an unsupported protocol', () => {
    const result = parseForgeRemote('ftp://github.com/acme/widgets.git');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('ftp:');
  });

  it('fails with a reason instead of throwing on a malformed percent-escape', () => {
    const result = parseForgeRemote('https://github.com/acme/100%-coverage.git');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason.length > 0).toBe(true);
  });
});

describe('resolveForgeRemoteName', () => {
  it('prefers the branch-configured remote', () => {
    expect(
      resolveForgeRemoteName({ configuredRemote: 'upstream', remotes: ['origin', 'upstream'] })
    ).toEqual({ ok: true, value: 'upstream' });
  });

  it('fails when the configured remote no longer exists', () => {
    const result = resolveForgeRemoteName({ configuredRemote: 'gone', remotes: ['origin'] });
    expect(result).toEqual({
      ok: false,
      reason: 'The current branch tracks remote "gone", which no longer exists.',
    });
  });

  it('falls back to origin when the branch has no upstream', () => {
    expect(resolveForgeRemoteName({ configuredRemote: null, remotes: ['fork', 'origin'] })).toEqual(
      { ok: true, value: 'origin' }
    );
  });

  it('uses the sole remote when there is exactly one and it is not origin', () => {
    expect(resolveForgeRemoteName({ configuredRemote: null, remotes: ['fork'] })).toEqual({
      ok: true,
      value: 'fork',
    });
  });

  it('fails with a reason when there are no remotes', () => {
    expect(resolveForgeRemoteName({ configuredRemote: null, remotes: [] })).toEqual({
      ok: false,
      reason: 'The repository has no git remotes.',
    });
  });

  it('fails with a reason when several remotes exist and none is origin', () => {
    const result = resolveForgeRemoteName({ configuredRemote: null, remotes: ['a', 'b'] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('2 remotes');
  });
});

describe('readForgeChecks', () => {
  it('normalizes CheckRun and StatusContext nodes', () => {
    expect(
      readForgeChecks([
        {
          __typename: 'CheckRun',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://example.test/1',
          name: 'unit',
          status: 'COMPLETED',
        },
        {
          __typename: 'StatusContext',
          context: 'ci/legacy',
          state: 'FAILURE',
          targetUrl: 'https://example.test/2',
        },
      ])
    ).toEqual({
      ok: true,
      value: [
        { conclusion: 'success', name: 'unit', url: 'https://example.test/1' },
        { conclusion: 'failure', name: 'ci/legacy', url: 'https://example.test/2' },
      ],
    });
  });

  it('reports an in-progress CheckRun as pending regardless of conclusion', () => {
    expect(
      readForgeChecks([
        { __typename: 'CheckRun', conclusion: null, name: 'e2e', status: 'IN_PROGRESS' },
      ])
    ).toEqual({ ok: true, value: [{ conclusion: 'pending', name: 'e2e', url: null }] });
  });

  it('accepts an empty rollup', () => {
    expect(readForgeChecks([])).toEqual({ ok: true, value: [] });
  });

  it('fails the whole parse on a nameless node rather than dropping it', () => {
    const result = readForgeChecks([{ __typename: 'CheckRun', status: 'COMPLETED' }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('name');
  });

  it('fails when the rollup is not an array', () => {
    const result = readForgeChecks({ nodes: [] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('array');
  });
});

describe('rollupForgeChecks', () => {
  const check = (conclusion: ForgeCheck['conclusion'], name: string): ForgeCheck => ({
    conclusion,
    name,
    url: null,
  });

  it('is none for an empty list', () => {
    expect(rollupForgeChecks([])).toBe('none');
  });

  it('is failing when any check failed, even alongside pending ones', () => {
    expect(rollupForgeChecks([check('pending', 'a'), check('failure', 'b')])).toBe('failing');
  });

  it('treats cancelled, timed_out and action_required as failing', () => {
    expect(rollupForgeChecks([check('cancelled', 'a')])).toBe('failing');
    expect(rollupForgeChecks([check('timed_out', 'a')])).toBe('failing');
    expect(rollupForgeChecks([check('action_required', 'a')])).toBe('failing');
  });

  it('is pending when nothing failed and something is still running', () => {
    expect(rollupForgeChecks([check('success', 'a'), check('pending', 'b')])).toBe('pending');
  });

  it('is passing when skipped and neutral accompany successes', () => {
    expect(
      rollupForgeChecks([check('success', 'a'), check('skipped', 'b'), check('neutral', 'c')])
    ).toBe('passing');
  });
});
