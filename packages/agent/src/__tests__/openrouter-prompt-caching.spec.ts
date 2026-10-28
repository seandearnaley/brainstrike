import { generateText } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { materializeHostProviderModel } from '../providers/model-router-sdk';
import { createProvider } from '../providers/provider-factory';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Conversation = Pick<Parameters<typeof generateText>[0], 'messages' | 'system'>;

async function requestBodyFor(
  modelId: string,
  conversation: Conversation = { messages: [{ content: 'hi', role: 'user' }] }
): Promise<Record<string, unknown>> {
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
  await generateText({ maxRetries: 0, model, ...conversation } as Parameters<
    typeof generateText
  >[0]);
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
  const body = await requestBodyFor('deepseek/deepseek-v4.1-flash-1017');
  expect(body).not.toHaveProperty('cache_control');
  expect(JSON.stringify(body)).not.toContain('cache_control');
});

it('marks the system block and the last two user turns for Qwen served by Alibaba', async () => {
  // Alibaba caches only at content-block breakpoints; OpenRouter has no
  // request-level form for it.
  const body = await requestBodyFor('qwen/qwen3.8-max-0902', {
    messages: [
      { content: 'first question', role: 'user' },
      { content: 'first answer', role: 'assistant' },
      { content: 'second question', role: 'user' },
      { content: 'second answer', role: 'assistant' },
      { content: 'third question', role: 'user' },
    ],
    system: 'You are a coding agent.',
  });
  const ephemeral = { cache_control: { type: 'ephemeral' } };
  expect(body).not.toHaveProperty('cache_control');
  expect(body['messages']).toEqual([
    { content: [{ text: 'You are a coding agent.', type: 'text', ...ephemeral }], role: 'system' },
    { content: 'first question', role: 'user' },
    expect.not.objectContaining({ cache_control: expect.anything() }),
    { content: [{ text: 'second question', type: 'text', ...ephemeral }], role: 'user' },
    expect.not.objectContaining({ cache_control: expect.anything() }),
    { content: [{ text: 'third question', type: 'text', ...ephemeral }], role: 'user' },
  ]);
});
