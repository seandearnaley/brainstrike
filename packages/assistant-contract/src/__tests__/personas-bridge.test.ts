import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoundaryTransport } from '../boundary-result.js';
import {
  ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHODS,
  type AssistantPersonasBridge,
  resolveAssistantPersonasBridge,
} from '../personas-bridge.js';

describe('ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHODS', () => {
  it('pins the exact method set (no optional bridge methods)', () => {
    expect([...ASSISTANT_PERSONAS_BRIDGE_REQUIRED_METHODS].sort()).toEqual(['list']);
  });
});

describe('resolveAssistantPersonasBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when there is no window (node / SSR)', () => {
    expect(resolveAssistantPersonasBridge()).toBeNull();
  });

  it('returns null when window exists but the bridge is absent (web)', () => {
    vi.stubGlobal('window', {});
    expect(resolveAssistantPersonasBridge()).toBeNull();
  });

  it('returns null for a present-but-malformed bridge (fail closed)', () => {
    vi.stubGlobal('window', { assistantPersonas: { list: 'not-a-function' } });
    expect(resolveAssistantPersonasBridge()).toBeNull();
  });

  it('decodes the transport when every required method is a function', async () => {
    const bridge: BoundaryTransport<AssistantPersonasBridge> = {
      list: () => Promise.resolve({ ok: true, value: { personas: [] } }),
    };
    vi.stubGlobal('window', { assistantPersonas: bridge });
    await expect(resolveAssistantPersonasBridge()?.list()).resolves.toEqual({ personas: [] });
  });
});
