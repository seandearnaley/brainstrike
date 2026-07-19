import type { StreamChunk } from '@brainstrike/agent/hosted-web';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent/hosted-web', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent/hosted-web')>(
    '@brainstrike/agent/hosted-web'
  );
  return {
    ...actual,
    toAiSdkStyleStream: vi.fn(),
  };
});

import { toAiSdkStyleStream } from '@brainstrike/agent/hosted-web';
import { buildWebAssistantStream } from '../web-assistant-stream';

describe('buildWebAssistantStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a request-scoped stream without workflow storage', async () => {
    const stream = (async function* stream(): AsyncIterable<StreamChunk> {})();
    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);
    const signal = new AbortController().signal;

    const result = await buildWebAssistantStream({
      agentMessages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      apiKey: 'server-key',
      data: undefined,
      signal,
    });

    expect(result).toBe(stream);
    expect(toAiSdkStyleStream).toHaveBeenCalledOnce();
    expect(toAiSdkStyleStream).toHaveBeenCalledWith(
      [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      expect.objectContaining({
        apiKey: 'server-key',
        provider: 'openai',
        signal,
      })
    );
    expect(vi.mocked(toAiSdkStyleStream).mock.calls[0]).toHaveLength(2);
  });
});
