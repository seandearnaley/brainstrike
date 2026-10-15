// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatTrailingPathSegments } from '../path-display';

describe('formatTrailingPathSegments', () => {
  it('returns the path unchanged when it has 2 or fewer segments', () => {
    expect(formatTrailingPathSegments('a/b')).toBe('a/b');
    expect(formatTrailingPathSegments('/a/b')).toBe('/a/b');
    expect(formatTrailingPathSegments('only-one')).toBe('only-one');
  });

  it('truncates to the trailing two segments with an ellipsis prefix', () => {
    expect(formatTrailingPathSegments('a/b/c/d')).toBe('.../c/d');
    expect(formatTrailingPathSegments('/Users/me/project/src/file.ts')).toBe('.../src/file.ts');
    expect(formatTrailingPathSegments('/Users/me/project/src/')).toBe('.../project/src/');
  });

  it('handles empty input', () => {
    expect(formatTrailingPathSegments('')).toBe('');
  });
});
