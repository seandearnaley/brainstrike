import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    global.window = {} as Window & typeof globalThis;
    expect(getDefaultDbPath()).toBe('idb://app-pg18');

    // Test Node environment
    global.window = undefined as unknown as Window & typeof globalThis;
    const nodePath = getDefaultDbPath();
    expect(nodePath).toBe(path.join(os.tmpdir(), 'app.db'));
  });
});
