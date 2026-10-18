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

  it("leads with git's error line, not the context lines before it", () => {
    expect(
      summarizeGitFailure(
        [
          'To github.com:example/repo.git',
          ' ! [rejected]        main -> main (fetch first)',
          "error: failed to push some refs to 'github.com:example/repo.git'",
          'hint: Updates were rejected because the remote contains work',
        ].join('\n')
      )
    ).toBe("error: failed to push some refs to 'github.com:example/repo.git'");
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
