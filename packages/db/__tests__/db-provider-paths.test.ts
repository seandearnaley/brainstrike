import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
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
    const nodePath = getDefaultDbPath();
    expect(nodePath).toBe(path.join(os.tmpdir(), 'app.db'));
  });
});