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

  it('bounds a long line and marks the cut', () => {
    const summary = summarizeGitFailure(`fatal: ${'x'.repeat(5000)}`);
    expect(summary).toHaveLength(160);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('names an empty failure instead of showing nothing', () => {
    expect(summarizeGitFailure(' \n ')).toBe('unknown error');
  });
});
