import { describe, expect, it } from 'vitest';
import {
  FORGE_CHECK_CONCLUSIONS,
  type ForgeCheck,
  forgePrCacheKey,
  parseForgeRemote,
  readChecks,
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

  it('classifies a host that merely contains "github" as a substring as unknown', () => {
    const result = parseForgeRemote('https://mygithub.com/acme/widgets.git');
    expect(result.ok && result.value.forge).toBe('unknown');
  });

  it('classifies a host with "github" as a middle label as unknown, not github', () => {
    const result = parseForgeRemote('https://foo.github.attacker.example/acme/widgets.git');
    expect(result.ok && result.value.forge).toBe('unknown');
  });

  it('classifies a github enterprise host (first label "github") as github', () => {
    const result = parseForgeRemote('https://github.acme.com/acme/widgets.git');
    expect(result.ok && result.value.forge).toBe('github');
  });

  it('classifies a gitlab enterprise host (first label "gitlab") as gitlab', () => {
    const result = parseForgeRemote('https://gitlab.acme.com/acme/widgets.git');
    expect(result.ok && result.value.forge).toBe('gitlab');
  });

  it('fails with a reason instead of fabricating an owner when a github URL has extra path segments', () => {
    const result = parseForgeRemote('https://github.com/acme/widgets/tree/main');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('github.com/acme/widgets/tree/main');
  });

  it('keeps GitLab subgroup namespaces even with more than two segments', () => {
    const result = parseForgeRemote('https://gitlab.com/group/subgroup/nested/widgets.git');
    expect(result).toEqual({
      ok: true,
      value: {
        forge: 'gitlab',
        host: 'gitlab.com',
        owner: 'group/subgroup/nested',
        repo: 'widgets',
      },
    });
  });

  it('falls through Windows drive-letter paths using backslashes to the local/unrecognized failure', () => {
    const result = parseForgeRemote('C:\\repos\\x');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('not a forge URL');
  });

  it('falls through Windows drive-letter paths using forward slashes to the local/unrecognized failure', () => {
    const result = parseForgeRemote('C:/repos/x');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('not a forge URL');
  });

  it('parses a git+ssh:// remote (a SUPPORTED_PROTOCOLS entry)', () => {
    const result = parseForgeRemote('git+ssh://git@github.com/acme/widgets.git');
    expect(result).toEqual({
      ok: true,
      value: { forge: 'github', host: 'github.com', owner: 'acme', repo: 'widgets' },
    });
  });

  it('parses a git:// remote (a SUPPORTED_PROTOCOLS entry)', () => {
    const result = parseForgeRemote('git://github.com/acme/widgets.git');
    expect(result).toEqual({
      ok: true,
      value: { forge: 'github', host: 'github.com', owner: 'acme', repo: 'widgets' },
    });
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

  it('fails when the rollup is null instead of silently treating it as no checks', () => {
    const result = readForgeChecks(null);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('array');
  });

  it('fails when the rollup is missing (undefined) instead of silently treating it as no checks', () => {
    const result = readForgeChecks(undefined);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('array');
  });

  it('pins the STALE conclusion alias to neutral', () => {
    expect(
      readForgeChecks([
        { __typename: 'CheckRun', conclusion: 'STALE', name: 'stale-check', status: 'COMPLETED' },
      ])
    ).toEqual({ ok: true, value: [{ conclusion: 'neutral', name: 'stale-check', url: null }] });
  });

  it('pins the STARTUP_FAILURE conclusion alias to failure', () => {
    expect(
      readForgeChecks([
        {
          __typename: 'CheckRun',
          conclusion: 'STARTUP_FAILURE',
          name: 'boot-check',
          status: 'COMPLETED',
        },
      ])
    ).toEqual({ ok: true, value: [{ conclusion: 'failure', name: 'boot-check', url: null }] });
  });

  it('does not resolve inherited Object.prototype keys as a recognized conclusion', () => {
    const constructorResult = readForgeChecks([
      { __typename: 'CheckRun', conclusion: 'constructor', name: 'x', status: 'COMPLETED' },
    ]);
    expect(constructorResult.ok).toBe(false);
    expect(constructorResult.ok === false && constructorResult.reason).toContain('constructor');

    const protoResult = readForgeChecks([
      { __typename: 'CheckRun', conclusion: '__proto__', name: 'y', status: 'COMPLETED' },
    ]);
    expect(protoResult.ok).toBe(false);
    expect(protoResult.ok === false && protoResult.reason).toContain('__proto__');
  });

  it('does not resolve inherited Object.prototype keys as a recognized StatusContext state', () => {
    const result = readForgeChecks([
      { __typename: 'StatusContext', context: 'legacy', state: 'toString' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('toString');
  });

  it('only maps recognized in-progress statuses to pending; an unrecognized status fails', () => {
    const result = readForgeChecks([{ __typename: 'CheckRun', name: 'weird', status: 'BOGUS' }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('BOGUS');
  });

  it('maps every recognized in-progress CheckRun status to pending', () => {
    for (const status of ['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']) {
      expect(readForgeChecks([{ __typename: 'CheckRun', name: 'n', status }])).toEqual({
        ok: true,
        value: [{ conclusion: 'pending', name: 'n', url: null }],
      });
    }
  });

  it('discriminates by __typename first: an empty status on a CheckRun fails explicitly instead of being silently treated as pending', () => {
    const result = readForgeChecks([{ __typename: 'CheckRun', name: 'x', status: '' }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('status');
  });

  it('discriminates by __typename first: a StatusContext with a stray empty status field fails on the real problem (missing state), not the status field', () => {
    const result = readForgeChecks([{ __typename: 'StatusContext', context: 'y', status: '' }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain('state');
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

describe('forgePrCacheKey', () => {
  it('joins repoCommonDir and branch with a NUL byte', () => {
    expect(forgePrCacheKey('/repos/widgets/.git', 'main')).toBe('/repos/widgets/.git\0main');
  });

  it('keeps two repositories with the same branch name distinct', () => {
    expect(forgePrCacheKey('/repos/widgets/.git', 'main')).not.toBe(
      forgePrCacheKey('/repos/other/.git', 'main')
    );
  });
});

describe('FORGE_CHECK_CONCLUSIONS', () => {
  it('lists every ForgeCheckConclusion variant', () => {
    expect([...FORGE_CHECK_CONCLUSIONS].sort()).toEqual([
      'action_required',
      'cancelled',
      'failure',
      'neutral',
      'pending',
      'skipped',
      'success',
      'timed_out',
    ]);
  });
});

describe('readChecks — cached (already-normalized) ForgeCheck[]', () => {
  it('accepts a parsed array value', () => {
    expect(readChecks([{ conclusion: 'success', name: 'unit', url: null }])).toEqual([
      { conclusion: 'success', name: 'unit', url: null },
    ]);
  });

  it('accepts the same value delivered as a JSON string', () => {
    expect(
      readChecks(JSON.stringify([{ conclusion: 'pending', name: 'lint', url: null }]))
    ).toEqual([{ conclusion: 'pending', name: 'lint', url: null }]);
  });

  it('throws when the value is not an array', () => {
    expect(() => readChecks({ conclusion: 'success' })).toThrow(/not an array/);
  });

  it('throws on an entry with an unrecognized conclusion', () => {
    expect(() => readChecks([{ conclusion: 'bogus', name: 'unit', url: null }])).toThrow(
      /unrecognized conclusion/
    );
  });

  it('throws on an entry with no name', () => {
    expect(() => readChecks([{ conclusion: 'success', name: '', url: null }])).toThrow(/no name/);
  });

  it('throws on an entry with an unreadable URL', () => {
    expect(() => readChecks([{ conclusion: 'success', name: 'unit', url: 42 }])).toThrow(
      /unreadable URL/
    );
  });
});
