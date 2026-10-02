import { beforeEach, describe, expect, it, vi } from 'vitest';

const doStream = vi.fn().mockResolvedValue({ stream: 'codex-stream' });
const doGenerate = vi.fn().mockResolvedValue({ finishReason: 'stop' });

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => (modelId: string) => ({
    doGenerate,
    doStream,
    modelId,
    provider: 'openai.responses',
    specificationVersion: 'v2',
  })),
}));

import { createProvider } from '../providers/provider-factory';

interface CodexModelLike {
  doGenerate: (params: unknown) => Promise<unknown>;
  doStream: (params: unknown) => Promise<unknown>;
}

interface ForwardedParams {
  providerOptions?: { openai?: Record<string, unknown> };
}

const callParams = {
  prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }],
  providerOptions: { openai: { reasoningEffort: 'high' } },
};

function createCodexModel(): CodexModelLike {
  return createProvider(
    'openai-codex',
    {
      apiKey: 'oauth-subscription-no-api-key',
      fetch: async () => new Response('{}'),
      kind: 'custom_fetch',
    },
    'codex/gpt-5.5'
  ) as unknown as CodexModelLike;
}

describe('provider-factory openai-codex store wiring (BST-1918)', () => {
  beforeEach(() => {
    doStream.mockClear();
    doGenerate.mockClear();
  });

  it('forces store:false on doStream before the SDK serializes, keeping existing options', async () => {
    await createCodexModel().doStream(callParams);

    const forwarded = doStream.mock.calls[0]?.[0] as ForwardedParams;
    expect(forwarded.providerOptions?.openai?.['store']).toBe(false);
    expect(forwarded.providerOptions?.openai?.['reasoningEffort']).toBe('high');
  });

  it('forces store:false on doGenerate before the SDK serializes, keeping existing options', async () => {
    await createCodexModel().doGenerate(callParams);

    const forwarded = doGenerate.mock.calls[0]?.[0] as ForwardedParams;
    expect(forwarded.providerOptions?.openai?.['store']).toBe(false);
    expect(forwarded.providerOptions?.openai?.['reasoningEffort']).toBe('high');
  });
});
