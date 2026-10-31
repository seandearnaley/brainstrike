import { describeBoundaryFailure } from '@brainstrike/assistant-contract/boundary-failure';
import { describe, expect, it } from 'vitest';
import { gitCommandFailed } from '../../src/git-workspace/git-failure.ts';
import type { GitCommandRun } from '../../src/git-workspace/git-service.ts';

function exited(stderr: string): GitCommandRun {
  return { exitCode: 1, stderr, stdout: '', timedOut: false };
}

describe('gitCommandFailed', () => {
  it.each([
    {
      code: 'git.push-rejected',
      remedy: 'Fetch and integrate the remote changes, then push again.',
      stderr:
        " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'origin'",
    },
    {
      code: 'git.authentication-failed',
      remedy: 'Check the credentials git uses for this remote.',
      stderr: "fatal: Authentication failed for 'https://example.test/repo.git/'",
    },
    {
      code: 'git.authentication-failed',
      remedy: 'Check the credentials git uses for this remote.',
      stderr: 'git@example.test: Permission denied (publickey).',
    },
    {
      code: 'git.not-a-repository',
      remedy: undefined,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    },
    {
      code: 'git.command-failed',
      remedy: undefined,
      stderr: 'error: pathspec missing.txt did not match any file(s) known to git',
    },
  ])('reports $code in git’s own words', ({ code, remedy, stderr }) => {
    const { error } = gitCommandFailed(exited(stderr));

    expect(error.code).toBe(code);
    expect(error.remedy).toBe(remedy);
    expect(describeBoundaryFailure(error)).toBe(
      remedy === undefined ? stderr.trim() : `${stderr.trim()} ${remedy}`
    );
  });

  it('reports a timeout as a fault, whatever the exit code says', () => {
    const { error } = gitCommandFailed({
      exitCode: null,
      failureReason: 'timeout',
      stderr: '',
      stdout: '',
      timedOut: true,
    });

    expect(error).toMatchObject({ code: 'git.timeout', kind: 'fault' });
    expect(describeBoundaryFailure(error)).toBe('git command timed out');
  });

  it('tells the user to install git when the binary is missing', () => {
    const { error } = gitCommandFailed({
      exitCode: null,
      failureReason: 'notFound',
      stderr: '',
      stdout: '',
      timedOut: false,
    });

    expect(error.code).toBe('git.not-installed');
    expect(describeBoundaryFailure(error)).toBe(
      'git is not installed or not on PATH Install git and make sure it is on PATH.'
    );
  });
});
