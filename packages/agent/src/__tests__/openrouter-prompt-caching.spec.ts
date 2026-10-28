import { generateText } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { materializeHostProviderModel } from '../providers/model-router-sdk';
import { createProvider } from '../providers/provider-factory';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function requestBodyFor(modelId: string): Promise<Record<string, unknown>> {
  vi.stubEnv('OPENROUTER_BASE_URL', 'https://provider.invalid/api/v1');
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return Promise.resolve(
      Response.json({
        choices: [
          { finish_reason: 'stop', index: 0, message: { content: 'ok', role: 'assistant' } },
        ],
        created: 0,
        id: 'offline-response',
        model: modelId,
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
      })
    );
  });
  const model = materializeHostProviderModel(
    createProvider('openrouter', { apiKey: 'offline-qualification', kind: 'api_key' }, modelId)
  );
  await generateText({ maxRetries: 0, model, prompt: 'hi' });
  expect(requests).toHaveLength(1);
  return requests[0] ?? {};
}

it('sends top-level automatic cache_control for Claude routed through OpenRouter', async () => {
  // OpenRouter caches Anthropic upstreams only when the request asks for it.
  expect(await requestBodyFor('anthropic/claude-opus-5.5')).toMatchObject({
    cache_control: { type: 'ephemeral' },
  });
});

it('sends no cache_control to an OpenRouter route that caches automatically', async () => {
  expect(await requestBodyFor('qwen/qwen3.8-max')).not.toHaveProperty('cache_control');
});
