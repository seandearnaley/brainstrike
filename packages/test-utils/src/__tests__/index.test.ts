import { describe, expect, it } from 'vitest';
import { resetAllMocks, resetStore } from '../index.js';

describe('index re-exports', () => {
  it('should export resetAllMocks', () => {
    expect(typeof resetAllMocks).toBe('function');
  });

  it('should export resetStore', () => {
    expect(typeof resetStore).toBe('function');
  });
});
