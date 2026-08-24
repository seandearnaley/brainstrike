import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAssistantBridge } from '../assistant-auth.js';

describe('getAssistantBridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects a truthy primitive instead of reporting a desktop capability', () => {
    vi.stubGlobal('window', { assistant: 'not-a-bridge' });

    expect(getAssistantBridge()).toBeUndefined();
  });

  it('returns an object bridge for downstream capability probes', () => {
    const bridge = { getUrl: vi.fn() };
    vi.stubGlobal('window', { assistant: bridge });

    expect(getAssistantBridge()).toBe(bridge);
  });
});
