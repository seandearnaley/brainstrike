import { describe, expect, it } from 'vitest';
import { isDevEnv } from '../env-utils';

describe('isDevEnv', () => {
  it('returns a boolean value', () => {
    const result = isDevEnv();
    expect(typeof result).toBe('boolean');
  });

  it('handles normal environment correctly', () => {
    // This test just verifies the function doesn't throw
    expect(() => isDevEnv()).not.toThrow();
  });
});
