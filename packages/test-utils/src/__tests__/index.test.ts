import { describe, expect, it } from 'vitest';
import { createFileNode, resetAllMocks, resetStore } from '../index.js';

describe('index re-exports', () => {
  it('should export createFileNode', () => {
    expect(typeof createFileNode).toBe('function');
  });

  it('should export resetAllMocks', () => {
    expect(typeof resetAllMocks).toBe('function');
  });

  it('should export resetStore', () => {
    expect(typeof resetStore).toBe('function');
  });
});
