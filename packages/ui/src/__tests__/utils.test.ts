// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cn } from '../lib/utils';

describe('cn', () => {
  it('merges simple class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes and merges duplicates', () => {
    expect(cn('p-2', 'p-4', { active: true, hidden: false })).toBe('p-4 active');
  });
});
