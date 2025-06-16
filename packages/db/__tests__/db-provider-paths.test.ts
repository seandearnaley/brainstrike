import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDefaultDbPath } from '../src/db-provider';

describe('getDefaultDbPath additional coverage', () => {
  const originalWindow = global.window;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.window = originalWindow;
  });

  it('handles different environment configurations', () => {
    // Test browser environment
    global.window = {} as any;
    expect(getDefaultDbPath()).toBe('idb://app');

    // Test Node environment  
    global.window = undefined as any;
    const path = getDefaultDbPath();
    // Should return either an env var path or './app.db'
    expect(typeof path).toBe('string');
    expect(path.length).toBeGreaterThan(0);
  });
});