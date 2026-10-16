import { generateText } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { materializeHostProviderModel } from '../providers/model-router-sdk';
import { createProvider } from '../providers/provider-factory';
import { readOpenRouterBilledCost } from '../usage-metering';

const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlSIAAAAASUVORK5CYII=',
  'base64'
);
const annotation = {
  file: {
    content: [{ text: 'retained file text', type: 'text' }],
    hash: 'offline-hash',
    name: 'fixture.pdf',
  },
  type: 'file',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  { cost: 0.0125, kind: 'reported' },
  { cost: 0, kind: 'reported' },
  { cost: undefined, kind: 'absent' },
  { cost: -0.01, kind: 'malformed' },
] as const)(
  'preserves V4 image, token details and $kind billing ($cost) through the host model',
  async ({ cost, kind }) => {
    vi.stubEnv('OPENROUTER_BASE_URL', 'https://provider.invalid/api/v1');
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe('https://provider.invalid/api/v1/chat/completions');
      requests.push(JSON.parse(String(init?.body)));
      return Promise.resolve(
        Response.json({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: { annotations: [annotation], content: 'ok', role: 'assistant' },
            },
          ],
          created: 0,
          id: 'offline-response',
          model: 'qwen/qwen3.8-max',
          usage: {
            completion_tokens: 5,
            completion_tokens_details: { reasoning_tokens: 2 },
            ...(cost === undefined ? {} : { cost }),
            cost_details: { upstream_inference_cost: 0.25 },
            is_byok: true,
            prompt_tokens: 10,
            prompt_tokens_details: { cached_tokens: 3 },
            total_tokens: 15,
          },
        })
      );
    });
    const model = materializeHostProviderModel(
      createProvider(
        'openrouter',
        { apiKey: 'offline-qualification', kind: 'api_key' },
        'qwen/qwen3.8-max'
      )
    );
    const result = await generateText({
      maxRetries: 0,
      messages: [
        { content: [{ data: image, mediaType: 'image/png', type: 'file' }], role: 'user' },
      ],
      model,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      messages: [
        {
          content: [
            {
              image_url: { url: `data:image/png;base64,${image.toString('base64')}` },
              type: 'image_url',
            },
          ],
          role: 'user',
        },
      ],
      model: 'qwen/qwen3.8-max',
    });
    expect(result.text).toBe('ok');
    expect(result.usage).toMatchObject({
      inputTokenDetails: { cacheReadTokens: 3 },
      inputTokens: 10,
      outputTokenDetails: { reasoningTokens: 2 },
      outputTokens: 5,
      raw: { is_byok: true },
      totalTokens: 15,
    });
    expect(result.providerMetadata).toMatchObject({
      openrouter: {
        annotations: [annotation],
        usage: { costDetails: { upstreamInferenceCost: 0.25 } },
      },
    });
    const billing = readOpenRouterBilledCost(result);
    expect(billing.kind).toBe(kind);
    if (kind === 'reported') {
      expect(billing).toEqual({ kind, usd: cost });
    }
  }
);
