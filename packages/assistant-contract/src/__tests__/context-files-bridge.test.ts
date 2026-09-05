import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_FILES_BRIDGE_REQUIRED_METHODS,
  type ContextFilesBridge,
  resolveContextFilesBridge,
} from '../context-files-bridge.js';

describe('CONTEXT_FILES_BRIDGE_REQUIRED_METHODS', () => {
  it('pins the exact method set (no optional bridge methods)', () => {
    expect([...CONTEXT_FILES_BRIDGE_REQUIRED_METHODS].sort()).toEqual(['scan']);
  });
});

describe('resolveContextFilesBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when there is no window (node / SSR)', () => {
    expect(resolveContextFilesBridge()).toBeNull();
  });

  it('returns null when window exists but the bridge is absent (web)', () => {
    vi.stubGlobal('window', {});
    expect(resolveContextFilesBridge()).toBeNull();
  });

  it('returns null for a present-but-malformed bridge (fail closed)', () => {
    vi.stubGlobal('window', { contextFiles: { scan: 'not-a-function' } });
    expect(resolveContextFilesBridge()).toBeNull();
  });

  it('returns the bridge when every required method is a function', () => {
    const bridge: ContextFilesBridge = {
      scan: () => Promise.resolve([]),
    };
    vi.stubGlobal('window', { contextFiles: bridge });
    expect(resolveContextFilesBridge()).toBe(bridge);
  });
});
