import { describe, expect, it } from 'vitest';
import { summarizeGitFailure } from '../git-failure-summary';

describe('summarizeGitFailure', () => {
  it('keeps the first non-empty line of a multi-line stderr', () => {
    expect(
      summarizeGitFailure(
        '\n  fatal: .git/index: index file smaller than expected\nerror: second line\n'
      )
    ).toBe('fatal: .git/index: index file smaller than expected');
  });

  it("leads a rejected push with git's reason, not the generic push error", () => {
    expect(
      summarizeGitFailure(
        [
          'To github.com:example/repo.git',
          ' ! [rejected]        main -> main (fetch first)',
          "error: failed to push some refs to 'github.com:example/repo.git'",
          'hint: Updates were rejected because the remote contains work',
        ].join('\n')
      )
    ).toBe('! [rejected] main -> main (fetch first)');
  });

  it("leads a hook or branch-rule rejection with the remote's own error", () => {
    expect(
      summarizeGitFailure(
        [
          'remote: error: GH006: Protected branch update failed for refs/heads/main.',
          'remote: error: Changes must be made through a pull request.',
          'To github.com:example/repo.git',
          ' ! [remote rejected] main -> main (protected branch hook declined)',
          "error: failed to push some refs to 'github.com:example/repo.git'",
        ].join('\n')
      )
    ).toBe('remote: error: GH006: Protected branch update failed for refs/heads/main.');
  });

  it("prefers git's fatal/error line over context lines", () => {
    expect(summarizeGitFailure('warning: something\nfatal: bad object HEAD')).toBe(
      'fatal: bad object HEAD'
    );
  });

  it('bounds a long line and marks the cut', () => {
    const summary = summarizeGitFailure(`fatal: ${'x'.repeat(5000)}`);
    expect(summary).toHaveLength(160);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('names an empty failure instead of showing nothing', () => {
    expect(summarizeGitFailure(' \n ')).toBe('unknown error');
  });
});
