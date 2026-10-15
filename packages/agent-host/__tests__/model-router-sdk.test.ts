import {
  apiKeyAuthInput,
  collectRouterGenerateResult,
  createProvider,
  materializeHostProviderModel,
} from '@brainstrike/agent/provider-runtime';
import { modelSupportsTemperature } from '@mastra/core/llm';
import { generateText, streamText } from 'ai';
import { afterEach, expect, test, vi } from 'vitest';

// Recorded chat-completion shapes used by the shipped strict-content/provider fixtures.
const completion = {
  choices: [
    {
      finish_reason: 'stop',
      index: 0,
      message: { content: 'ok', reasoning: 'checked', role: 'assistant' },
    },
  ],
  created: 1_700_000_000,
  id: 'cmpl-1',
  model: 'qwen/qwen3.8-max',
  object: 'chat.completion',
  usage: { completion_tokens: 2, cost: 0.001, prompt_tokens: 3, total_tokens: 5 },
};
const chunks = [
  {
    choices: [{ delta: { content: 'ok', role: 'assistant' }, index: 0 }],
    created: completion.created,
    id: completion.id,
    model: completion.model,
  },
  {
    choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
    created: completion.created,
    id: completion.id,
    model: completion.model,
    usage: completion.usage,
  },
];

afterEach(() => vi.unstubAllGlobals());

test.each(['openrouter', 'ollama', 'lmstudio'] as const)(
  'SDK 7 generate and stream preserve the shipped %s router request and actual usage',
  async (provider) => {
    const captures: { url: string; body: Record<string, unknown>; authorization: string | null }[] =
      [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe(
        provider === 'openrouter'
          ? 'https://openrouter.ai/api/v1/chat/completions'
          : `http://owned-${provider}.invalid:9999/v1/chat/completions`
      );
      const body: Record<string, unknown> = JSON.parse(String(init?.body));
      captures.push({ authorization: new Headers(init?.headers).get('authorization'), body, url });
      return body['stream'] === true
        ? new Response(
            `${chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } }
          )
        : Response.json(completion);
    });
    const modelId = provider === 'openrouter' ? completion.model : 'owned-model';
    const runtime =
      provider === 'openrouter'
        ? undefined
        : {
            providerOptions: {
              [provider]: {
                apiToken: 'owned-fixture-key',
                baseUrl: `http://owned-${provider}.invalid:9999`,
              },
            },
          };
    const model = materializeHostProviderModel(
      createProvider(provider, apiKeyAuthInput('owned-fixture-key'), modelId, runtime)
    );
    expect(model.specificationVersion).toBe('v4');
    const messages = [
      {
        content: [
          {
            input: { query: 'foo' },
            toolCallId: 'call_1',
            toolName: 'grepSearch',
            type: 'tool-call' as const,
          },
        ],
        role: 'assistant' as const,
      },
      {
        content: [
          {
            output: { type: 'text' as const, value: 'no matches' },
            toolCallId: 'call_1',
            toolName: 'grepSearch',
            type: 'tool-result' as const,
          },
        ],
        role: 'tool' as const,
      },
      { content: 'and now?', role: 'user' as const },
    ];
    const generated = await generateText({ maxRetries: 0, messages, model, temperature: 0.25 });
    expect(generated.text).toBe('ok');
    expect(generated.finishReason).toBe('stop');
    expect(generated.usage.inputTokens).toBe(3);
    expect(generated.usage.outputTokens).toBe(2);
    const streamed = streamText({ maxRetries: 0, messages, model, temperature: 0.25 });
    expect(await streamed.text).toBe('ok');
    expect(await streamed.finishReason).toBe('stop');
    expect((await streamed.usage).inputTokens).toBe(3);
    expect((await streamed.usage).outputTokens).toBe(2);
    expect(captures).toHaveLength(2);
    expect(captures[0]?.body['stream']).not.toBe(true);
    expect(captures[1]?.body['stream']).toBe(true);
    for (const capture of captures) {
      expect(capture.authorization).toBe('Bearer owned-fixture-key');
      expect(capture.body['model']).toBe(modelId);
      // The unchanged public router applies its registry's sampling capability,
      // including known-provider model IDs that the registry does not list.
      expect(capture.body['temperature']).toBe(
        modelSupportsTemperature(`${provider}/${modelId}`) === false ? undefined : 0.25
      );
      expect(JSON.stringify(capture.body)).not.toContain('owned-fixture-key');
    }
    if (provider === 'openrouter') {
      expect(generated.providerMetadata?.['openrouter']).toMatchObject({ usage: { cost: 0.001 } });
      expect((await streamed.providerMetadata)?.['openrouter']).toMatchObject({
        usage: { cost: 0.001 },
      });
      expect(captures[0]?.body['messages']).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: '', role: 'assistant' })])
      );
    }
  }
);

type Result = Parameters<typeof collectRouterGenerateResult>[0];
type Part = Result['stream'] extends ReadableStream<infer Value> ? Value : never;
function recordedStream(parts: readonly Part[]): Result {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) {
          controller.enqueue(part);
        }
        controller.close();
      },
    }),
  };
}

test('collector retains ordered completed parts and metadata without duplicating tool input deltas', async () => {
  const metadata = { openrouter: { signature: 'recorded-part-metadata' } };
  const result = await collectRouterGenerateResult({
    ...recordedStream([
      { type: 'stream-start', warnings: [{ message: 'recorded warning', type: 'other' }] },
      { id: 'reasoning-1', providerMetadata: metadata, type: 'reasoning-start' },
      { delta: 'checked', id: 'reasoning-1', type: 'reasoning-delta' },
      { id: 'reasoning-1', type: 'reasoning-end' },
      { id: 'call_1', toolName: 'grepSearch', type: 'tool-input-start' },
      { delta: '{"query":"foo"}', id: 'call_1', type: 'tool-input-delta' },
      { id: 'call_1', type: 'tool-input-end' },
      {
        input: '{"query":"foo"}',
        providerMetadata: metadata,
        toolCallId: 'call_1',
        toolName: 'grepSearch',
        type: 'tool-call',
      },
      {
        data: 'aW1hZ2UtYnl0ZXM=',
        mediaType: 'image/png',
        providerMetadata: metadata,
        type: 'file',
      },
      {
        id: 'source-1',
        providerMetadata: metadata,
        sourceType: 'url',
        type: 'source',
        url: 'https://example.test/recorded',
      },
      { id: 'text-1', type: 'text-start' },
      { delta: 'ok', id: 'text-1', type: 'text-delta' },
      { id: 'text-1', type: 'text-end' },
      {
        id: completion.id,
        modelId: completion.model,
        timestamp: new Date(completion.created * 1000),
        type: 'response-metadata',
      },
      {
        finishReason: { raw: 'stop', unified: 'stop' },
        providerMetadata: { openrouter: { cost: 0.001 } },
        type: 'finish',
        usage: {
          inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 3, total: 3 },
          outputTokens: { reasoning: 0, text: 2, total: 2 },
        },
      },
    ]),
    request: { body: 'recorded request' },
    response: { headers: { 'x-recorded': 'value' } },
  });
  expect(result.content.map((part) => part.type)).toEqual([
    'reasoning',
    'tool-call',
    'file',
    'source',
    'text',
  ]);
  expect(result.content[0]).toEqual({
    providerMetadata: metadata,
    text: 'checked',
    type: 'reasoning',
  });
  expect(result.content[1]).toMatchObject({ input: '{"query":"foo"}', providerMetadata: metadata });
  expect(result.providerMetadata).toEqual({ openrouter: { cost: 0.001 } });
  expect(result.request).toEqual({ body: 'recorded request' });
  expect(result.response).toMatchObject({
    headers: { 'x-recorded': 'value' },
    id: completion.id,
    timestamp: new Date(completion.created * 1000),
  });
  expect(result.warnings).toHaveLength(1);
});

test('collector propagates provider failure and rejects a missing finish instead of fabricating success', async () => {
  const failure = new Error('recorded provider failure');
  await expect(
    collectRouterGenerateResult(recordedStream([{ error: failure, type: 'error' }]))
  ).rejects.toBe(failure);
  await expect(collectRouterGenerateResult(recordedStream([]))).rejects.toThrow(
    'without complete content'
  );
});

test('collector cancellation joins the actual source cancellation before rejecting', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const signal = new AbortController();
  const reason = new Error('owned caller stopped');
  const source: Result = {
    stream: new ReadableStream({
      cancel: async () => {
        entered.resolve();
        await release.promise;
      },
    }),
  };
  let joined = false;
  const collecting = collectRouterGenerateResult(source, signal.signal).finally(() => {
    joined = true;
  });
  collecting.catch(() => undefined);
  signal.abort(reason);
  await entered.promise;
  expect(joined).toBe(false);
  release.resolve();
  await expect(collecting).rejects.toBe(reason);
});
