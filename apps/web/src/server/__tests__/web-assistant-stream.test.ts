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

  it('projects the prepared typed credential into the stream-options auth input', async () => {
    const stream = (async function* stream(): AsyncIterable<StreamChunk> {})();
    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);
    const signal = new AbortController().signal;

    const result = await buildWebAssistantStreamFromPrepared({
      agentMessages: [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      credential: { key: 'server-key', source: 'env', type: 'api_key' },
      runtimeData: { provider: 'openai' },
      signal,
    });

    expect(result).toBe(stream);
    expect(toAiSdkStyleStream).toHaveBeenCalledOnce();
    // BST-1352 review finding 6: web is a PROJECTION of the prepared typed
    // credential — the auth input rides the stream OPTIONS (a direct
    // parameter) and the runtime carries NO apiKey field (RuntimeData reaches
    // Mastra RequestContext serialization).
    expect(toAiSdkStyleStream).toHaveBeenCalledWith(
      [{ id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' }],
      {
        provider: 'openai',
        signal,
      },
      { authInput: { apiKey: 'server-key', kind: 'api_key' } }
    );
  });

  it('omits signal from the runtime when none is provided', async () => {
    const stream = (async function* stream(): AsyncIterable<StreamChunk> {})();
    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);

    await buildWebAssistantStreamFromPrepared({
      agentMessages: [],
      credential: { key: 'server-key', source: 'env', type: 'api_key' },
      runtimeData: { provider: 'openai' },
    });

    expect(toAiSdkStyleStream).toHaveBeenCalledWith(
      [],
      { provider: 'openai' },
      { authInput: { apiKey: 'server-key', kind: 'api_key' } }
    );
  });

  it('passes no auth input when preparation resolved no credential (keyless-style turn)', async () => {
    const stream = (async function* stream(): AsyncIterable<StreamChunk> {})();
    vi.mocked(toAiSdkStyleStream).mockResolvedValue(stream);

    await buildWebAssistantStreamFromPrepared({
      agentMessages: [],
      credential: undefined,
      runtimeData: { provider: 'openai' },
    });

    expect(toAiSdkStyleStream).toHaveBeenCalledWith([], { provider: 'openai' }, {});
  });
});
