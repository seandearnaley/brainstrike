/**
 * BST-1352 review finding 1: the provider-native web-search tool builds a
 * SECOND AI SDK client, and that client must be constructed through the SAME
 * ProviderAuthInput seam as the chat model. These specs capture the exact
 * settings each SDK factory receives.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createAnthropicMock = vi.hoisted(() => vi.fn());
const createOpenAIMock = vi.hoisted(() => vi.fn());

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: createAnthropicMock,
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: createOpenAIMock,
}));

import { MastraAgentError } from '../mastra-boundary/mastra-agent-error';
import { createProviderNativeWebSearchTool } from '../providers/native-web-search';

const fakeAnthropicClient = {
  tools: { webSearch_20250305: vi.fn(() => ({ id: 'anthropic.web_search_20250305' })) },
};
const fakeOpenAiClient = {
  tools: { webSearch: vi.fn(() => ({ id: 'openai.web_search' })) },
};

beforeEach(() => {
  vi.clearAllMocks();
  createAnthropicMock.mockReturnValue(fakeAnthropicClient);
  createOpenAIMock.mockReturnValue(fakeOpenAiClient);
});

describe('createProviderNativeWebSearchTool auth-input seam (BST-1352)', () => {
  it('keeps api_key parity with the old bare-key construction', () => {
    createProviderNativeWebSearchTool('anthropic', { apiKey: 'k', kind: 'api_key' });
    expect(createAnthropicMock).toHaveBeenCalledWith({ apiKey: 'k' });

    createProviderNativeWebSearchTool('openai', undefined);
    expect(createOpenAIMock).toHaveBeenCalledWith(undefined);
  });

  it('rejects aws auth input typed (no consumer yet) instead of building a keyless client', () => {
    let thrown: unknown;
    try {
      createProviderNativeWebSearchTool('anthropic', { kind: 'aws', region: 'us-east-1' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MastraAgentError);
    expect((thrown as MastraAgentError).code).toBe('mastra_agent_runtime_init_failed');
    expect(createAnthropicMock).not.toHaveBeenCalled();
  });
});
