import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAssistantBridge } from '../assistant-auth.js';

const loggerErrorMock = vi.hoisted(() => vi.fn());

vi.mock('@brainstrike/logging', () => ({
  createLogger: () => ({ error: loggerErrorMock }),
}));

describe('getAssistantBridge', () => {
  afterEach(() => {
    loggerErrorMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('reports and rejects a truthy primitive instead of silently disabling desktop capabilities', () => {
    vi.stubGlobal('window', { assistant: 'not-a-bridge' });

    expect(getAssistantBridge()).toBeUndefined();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'window.assistant is present but malformed; desktop assistant capabilities disabled.',
      { receivedType: 'string' }
    );
  });

  it('returns an object bridge for downstream capability probes', () => {
    const bridge = { getUrl: vi.fn() };
    vi.stubGlobal('window', { assistant: bridge });

    expect(getAssistantBridge()).toBe(bridge);
  });
});
