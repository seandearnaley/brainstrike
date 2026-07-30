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
import { buildWebAssistantStreamFromPrepared } from '../web-assistant-stream';

describe('buildWebAssistantStreamFromPrepared', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-attaches the separately-carried apiKey and signal to the prepared runtime', async () => {
    const stream = (async function* stream(): AsyncIterable<StreamChunk> {})();
    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);
    const signal = new AbortController().signal;

    const result = await buildWebAssistantStreamFromPrepared({
      agentMessages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      apiKey: 'server-key',
      runtimeData: { provider: 'openai' },
      signal,
    });

    expect(result).toBe(stream);
    expect(toAiSdkStyleStream).toHaveBeenCalledOnce();
    expect(toAiSdkStyleStream).toHaveBeenCalledWith(
      [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      {
        apiKey: 'server-key',
        provider: 'openai',
        signal,
      }
    );
  });

  it('omits signal from the runtime when none is provided', async () => {
    const stream = (async function* stream(): AsyncIterable<StreamChunk> {})();
    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);

    await buildWebAssistantStreamFromPrepared({
      agentMessages: [],
      apiKey: 'server-key',
      runtimeData: { provider: 'openai' },
    });

    expect(toAiSdkStyleStream).toHaveBeenCalledWith([], {
      apiKey: 'server-key',
      provider: 'openai',
    });
  });
});
