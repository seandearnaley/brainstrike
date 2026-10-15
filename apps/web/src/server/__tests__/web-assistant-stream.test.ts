import type { StreamChunk } from '@brainstrike/agent/hosted-web';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@brainstrike/agent/hosted-web', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/agent/hosted-web')>(
    '@brainstrike/agent/hosted-web'
  );
  return {
    ...actual,
    createProvider: vi.fn(() => ({ configuration: 'stub' })),
    materializeHostProviderModel: vi.fn(() => ({ model: 'stub' })),
    streamHostedWebTurn: vi.fn(),
  };
});

import {
  createProvider,
  materializeHostProviderModel,
  streamHostedWebTurn,
} from '@brainstrike/agent/hosted-web';
import { buildWebAssistantStreamFromPrepared } from '../web-assistant-stream';

const userMessage = { id: 'user-1', parts: [{ text: 'hello', type: 'text' }], role: 'user' };

function emptyStream(): AsyncIterable<StreamChunk> {
  return (async function* stream(): AsyncIterable<StreamChunk> {})();
}

describe('buildWebAssistantStreamFromPrepared', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('projects the prepared typed credential into the provider auth input', async () => {
    const stream = emptyStream();
    vi.mocked(streamHostedWebTurn).mockResolvedValue(stream);
    const signal = new AbortController().signal;

    const result = await buildWebAssistantStreamFromPrepared({
      agentMessages: [userMessage as never],
      credential: { key: 'server-key', source: 'env', type: 'api_key' },
      runtimeData: { provider: 'openai' },
      signal,
    });

    expect(result).toBe(stream);
    // BST-1352 review finding 6: web is a PROJECTION of the prepared typed
    // credential — the auth input rides the model construction as a direct
    // parameter and the runtime carries NO apiKey field.
    expect(createProvider).toHaveBeenCalledWith(
      'openai',
      { apiKey: 'server-key', kind: 'api_key' },
      // Hosted Web owns model policy server-side: no model argument means the
      // provider registry default, exactly as before ADR-0022.
      undefined,
      { provider: 'openai', signal }
    );
    expect(materializeHostProviderModel).toHaveBeenCalledWith({ configuration: 'stub' });
  });

  it('passes no auth input when preparation resolved no credential', async () => {
    vi.mocked(streamHostedWebTurn).mockResolvedValue(emptyStream());

    await buildWebAssistantStreamFromPrepared({
      agentMessages: [],
      credential: undefined,
      runtimeData: { provider: 'openai' },
    });

    expect(createProvider).toHaveBeenCalledWith('openai', undefined, undefined, {
      provider: 'openai',
    });
  });

  it('omits the signal when none is provided', async () => {
    vi.mocked(streamHostedWebTurn).mockResolvedValue(emptyStream());

    await buildWebAssistantStreamFromPrepared({
      agentMessages: [],
      credential: { key: 'server-key', source: 'env', type: 'api_key' },
      runtimeData: { provider: 'openai' },
    });

    expect(vi.mocked(streamHostedWebTurn).mock.calls[0]?.[0]).not.toHaveProperty('signal');
  });

  it('prepends the workspace root manifest to the turn it streams', async () => {
    vi.mocked(streamHostedWebTurn).mockResolvedValue(emptyStream());

    await buildWebAssistantStreamFromPrepared({
      agentMessages: [userMessage as never],
      credential: { key: 'server-key', source: 'env', type: 'api_key' },
      runtimeData: { provider: 'openai' },
    });

    // The manifest is a prompt preamble derived from the allow-listed
    // workspace fields; retiring the agent loop must not drop it.
    const sent = vi.mocked(streamHostedWebTurn).mock.calls[0]?.[0];
    expect(sent?.messages[0]).toMatchObject({ role: 'system' });
    expect(sent?.messages.at(-1)).toMatchObject({ role: 'user' });
  });

  it('streams with the model the provider factory materialized', async () => {
    vi.mocked(streamHostedWebTurn).mockResolvedValue(emptyStream());

    await buildWebAssistantStreamFromPrepared({
      agentMessages: [userMessage as never],
      credential: { key: 'server-key', source: 'env', type: 'api_key' },
      runtimeData: { provider: 'openai' },
    });

    expect(vi.mocked(streamHostedWebTurn).mock.calls[0]?.[0]?.model).toEqual({ model: 'stub' });
  });
});
