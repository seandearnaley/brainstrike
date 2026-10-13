import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundaryTransport } from '../boundary-result.js';
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

  it('decodes the transport when every required method is a function', async () => {
    const bridge: BoundaryTransport<ContextFilesBridge> = {
      scan: () => Promise.resolve({ ok: true, value: [] }),
    };
    vi.stubGlobal('window', { contextFiles: bridge });
    await expect(resolveContextFilesBridge()?.scan()).resolves.toEqual([]);
  });
});
