import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4Middleware,
  type LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createPreparedTokenMeasurement } from '../mastra/token-measurement';
import {
  type CanonicalProviderSchemaLayer,
  createProviderRequestMiddleware,
  healInterruptedModelMessages,
  OpenAIStoredItemExpiredError,
  ProviderRequestBoundaryError,
  ProviderRequestContextOverflowError,
  preparedPromptBreakdown,
  preparedPromptToolCalls,
  prepareProviderRequest,
  prepareProviderToolInputSchema,
  SubscriptionQuotaExhaustedError,
} from '../provider-request';
import { createProvider } from '../providers/provider-factory';
import type { SupportedProvider } from '../providers/types';

// Resolve the exact SDK installed for the owning host without changing leaf
// dependencies/pins. Public contracts below are qualified by real SDK calls.
const hostRequire = createRequire(new URL('../../../agent-host/package.json', import.meta.url));
const agentRequire = createRequire(new URL('../../package.json', import.meta.url));
const mastraRequire = createRequire(agentRequire.resolve('@mastra/core'));
interface PinnedSdk {
  jsonSchema(
    schema: Record<string, unknown>,
    options: { validate: (value: unknown) => unknown }
  ): unknown;
  streamText(options: {
    model: LanguageModelV4;
    messages: unknown[];
    maxRetries: number;
    tools?: Record<string, unknown>;
    prepareStep?: (options: { messages: InputMessage[] }) => { messages: unknown[] };
  }): { fullStream: AsyncIterable<{ type: string; error?: unknown }> };
  wrapLanguageModel(options: {
    model: LanguageModelV4;
    middleware: LanguageModelV4Middleware;
  }): LanguageModelV4;
}
const sdk = (await import(hostRequire.resolve('ai'))) as PinnedSdk;
interface SchemaCompat {
  AnthropicSchemaCompatLayer: SchemaCompat['OpenAISchemaCompatLayer'];
  GoogleSchemaCompatLayer: SchemaCompat['OpenAISchemaCompatLayer'];
  OpenAIReasoningSchemaCompatLayer: SchemaCompat['OpenAISchemaCompatLayer'];
  OpenAISchemaCompatLayer: new (model: {
    provider: string;
    modelId: string;
    supportsStructuredOutputs: boolean;
  }) => CanonicalProviderSchemaLayer;
}
const schemaCompat = (await import(mastraRequire.resolve('@mastra/schema-compat'))) as SchemaCompat;

interface InputMessage {
  content: string | unknown[];
  role: 'system' | 'user' | 'assistant' | 'tool';
}
const user = (text: string): LanguageModelV4Prompt[number] => ({
  content: [{ text, type: 'text' }],
  role: 'user',
});
const model = (provider = 'openai.responses'): LanguageModelV4 => ({
  doGenerate: () => {
    throw new Error('No provider calls allowed.');
  },
  doStream: () => {
    throw new Error('No provider calls allowed.');
  },
  modelId: 'fixture-model',
  provider,
  specificationVersion: 'v4',
  supportedUrls: {},
});
const measurement = await createPreparedTokenMeasurement({
  charactersPerToken: 4,
  mode: 'deterministic-serialized-character-backstop',
});
const prepare = (
  prompt: LanguageModelV4Prompt,
  extra: Partial<Parameters<typeof prepareProviderRequest>[2]> = {}
) =>
  prepareProviderRequest({ prompt }, model(), {
    provider: 'openai',
    tokenMeasurement: measurement,
    ...extra,
  });

afterEach(() => vi.unstubAllGlobals());

describe('canonical provider request preparation', () => {
  it.each([
    ['anthropic', 'anthropic.messages', 'amazon-bedrock'],
    ['bedrock', 'amazon-bedrock', 'anthropic.messages'],
  ] as const)(
    'reuses signed-reasoning provenance on switch to %s without mutating history',
    async (provider, target, origin) => {
      const recorded = new MessageList();
      const signed = (id: string, stampedProvider: string): MastraDBMessage => ({
        content: {
          format: 2,
          metadata: { provider: stampedProvider },
          parts: [
            {
              details: [{ text: `${id} reasoning`, type: 'text' }],
              providerMetadata: { anthropic: { signature: id } },
              reasoning: `${id} reasoning`,
              type: 'reasoning',
            },
            { text: `${id} answer`, type: 'text' },
          ],
        },
        createdAt: new Date('2026-10-06T16:41:00.000Z'),
        id,
        role: 'assistant',
      });
      recorded.add(
        {
          content: { format: 2, parts: [{ text: 'previous task', type: 'text' }] },
          createdAt: new Date('2026-10-06T16:40:00.000Z'),
          id: 'user-before',
          role: 'user',
        },
        'memory'
      );
      recorded.add(signed('foreign-signature', origin), 'memory');
      recorded.add(signed('native-signature', target), 'memory');
      recorded.add(
        {
          content: { format: 2, parts: [{ text: 'continue', type: 'text' }] },
          createdAt: new Date('2026-10-06T16:42:00.000Z'),
          id: 'user-after',
          role: 'user',
        },
        'memory'
      );
      const history = recorded.get.all.db();
      const before = JSON.stringify(history);
      const prompt = await recorded.get.all.aiV7.llmPrompt({ targetProvider: target });
      const prepared = await prepareProviderRequest(
        { prompt: prompt as unknown as LanguageModelV4Prompt },
        model(target),
        { history, provider, tokenMeasurement: measurement }
      );
      const serialized = JSON.stringify(prepared.params.prompt);
      expect(serialized).not.toContain('foreign-signature reasoning');
      expect(serialized).toContain('foreign-signature answer');
      expect(serialized).toContain('native-signature reasoning');
      expect(JSON.stringify(history)).toBe(before);
    }
  );

  it('sweeps an orphan reasoning item even when there are no duplicates', async () => {
    const prompt: LanguageModelV4Prompt = [
      user('earlier'),
      {
        content: [
          { providerOptions: { openai: { itemId: 'rs_orphan' } }, text: '', type: 'reasoning' },
        ],
        role: 'assistant',
      },
      user('continue'),
    ];
    const before = JSON.stringify(prompt);
    expect((await prepare(prompt)).params.prompt).toEqual([prompt[0], prompt[2]]);
    expect(JSON.stringify(prompt)).toBe(before);
  });

  it('drops all aborted step items and their paired outputs, preserving prior completed tools', async () => {
    const prompt: LanguageModelV4Prompt = [
      user('earlier'),
      {
        content: [
          { text: 'kept', type: 'text' },
          { providerOptions: { openai: { itemId: 'rs_abort' } }, text: '', type: 'reasoning' },
          {
            input: {},
            providerOptions: { openai: { itemId: 'fc_abort' } },
            toolCallId: 'call_abort',
            toolName: 'read',
            type: 'tool-call',
          },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'json', value: {} },
            toolCallId: 'call_abort',
            toolName: 'read',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
      user('continue'),
    ];
    const prepared = await prepare(prompt, { abortedItemIds: new Set(['rs_abort', 'fc_abort']) });
    expect(JSON.stringify(prepared.params.prompt)).not.toContain('abort');
    expect(JSON.stringify(prepared.params.prompt)).toContain('kept');
  });

  it.each(['anthropic', 'google', 'bedrock', 'openrouter', 'ollama', 'lmstudio'] as const)(
    'strips an OpenAI executed call AND assistant-carried result on switch to %s',
    async (provider) => {
      const prompt: LanguageModelV4Prompt = [
        user('search'),
        {
          content: [
            {
              input: {},
              providerExecuted: true,
              providerOptions: { openai: { itemId: 'ws_foreign' } },
              toolCallId: 'ws_foreign',
              toolName: 'web_search',
              type: 'tool-call',
            },
            {
              output: { type: 'json', value: { urls: [] } },
              providerOptions: { openai: { itemId: 'ws_foreign' } },
              toolCallId: 'ws_foreign',
              toolName: 'web_search',
              type: 'tool-result',
            },
            { text: 'Earlier answer', type: 'text' },
          ],
          role: 'assistant',
        },
        user('continue'),
      ];
      const prepared = await prepareProviderRequest({ prompt }, model(`${provider}.messages`), {
        provider,
        tokenMeasurement: measurement,
      });
      expect(JSON.stringify(prepared.params.prompt)).not.toContain('ws_foreign');
      expect(JSON.stringify(prepared.params.prompt)).toContain('Earlier answer');
    }
  );

  it('preserves a same-provider executed pair and distinct tool-search references', async () => {
    const prompt: LanguageModelV4Prompt = [
      user('search'),
      {
        content: [
          {
            input: {},
            providerExecuted: true,
            providerOptions: { openai: { itemId: 'tso_kept' } },
            toolCallId: 'tsc_kept',
            toolName: 'tool_search',
            type: 'tool-call',
          },
          {
            output: { type: 'json', value: {} },
            providerOptions: { openai: { itemId: 'tso_kept' } },
            toolCallId: 'tsc_kept',
            toolName: 'tool_search',
            type: 'tool-result',
          },
        ],
        role: 'assistant',
      },
      user('continue'),
    ];
    const prepared = await prepare(prompt);
    expect(JSON.stringify(prepared.params.prompt)).toContain('tsc_kept');
    expect(JSON.stringify(prepared.params.prompt)).toContain('tso_kept');
  });

  it('rejects assistant request boundaries without inventing a continuation', async () => {
    await expect(
      prepare([
        { content: [{ text: 'prefill', type: 'text' }], role: 'assistant' },
        user('continue'),
      ])
    ).rejects.toBeInstanceOf(ProviderRequestBoundaryError);
    await expect(
      prepare([user('start'), { content: [{ text: 'prefill', type: 'text' }], role: 'assistant' }])
    ).rejects.toBeInstanceOf(ProviderRequestBoundaryError);
  });

  it('reuses projection filtering and rewrites, and counts only memory actually in the final prompt', async () => {
    const history: MastraDBMessage[] = ['old', 'recent'].map((id) => ({
      content: {
        format: 2,
        parts: [
          { type: 'step-start' },
          {
            providerMetadata: { mastra: { modelOutput: { lines: [id] } } },
            toolInvocation: {
              args: { path: 'README.md' },
              result: { rawBody: 'large raw body' },
              state: 'result',
              toolCallId: `call_${id}`,
              toolName: 'brainstrike_readWorkspaceFile',
            },
            type: 'tool-invocation',
          },
        ],
      },
      createdAt: new Date('2026-10-06T00:00:00Z'),
      id,
      role: 'assistant',
    }));
    const prompt: LanguageModelV4Prompt = [
      { content: 'Only included observations', role: 'system' },
      user('read'),
      ...['old', 'recent'].flatMap<LanguageModelV4Prompt[number]>((id) => [
        {
          content: [
            {
              input: { path: 'README.md' },
              toolCallId: `call_${id}`,
              toolName: 'brainstrike_readWorkspaceFile',
              type: 'tool-call',
            },
          ],
          role: 'assistant',
        },
        {
          content: [
            {
              output: { type: 'json', value: { lines: [id] } },
              toolCallId: `call_${id}`,
              toolName: 'brainstrike_readWorkspaceFile',
              type: 'tool-result',
            },
          ],
          role: 'tool',
        },
      ]),
      user('continue'),
    ];
    const prepared = await prepare(prompt, {
      history,
      rewrites: new Map([
        [
          'call_recent',
          {
            kind: 'prune',
            markerText: '[already summarized]',
            supersededByToolCallId: null,
            toolCallId: 'call_recent',
          },
        ],
      ]),
      toolNameMap: new Map([['brainstrike_readWorkspaceFile', 'brainstrike.readWorkspaceFile']]),
    });
    const serialized = JSON.stringify(prepared.params.prompt);
    expect(serialized).toContain('REPLAYED TOOL OUTPUT');
    expect(serialized).toContain('[already summarized]');
    expect(serialized).not.toContain('large raw body');
    expect(prepared.accounting.promptTokens).toBe(Math.ceil(serialized.length / 4));
    expect(prepared.projectedPrompt).toEqual(prepared.params.prompt);
    expect(prepared.rewrittenToolCallIds).toEqual(new Set(['call_recent']));
  });

  it('measures each tool call as sent, marking a committed rewrite and naming the native tool', async () => {
    const pair = (
      id: string,
      toolName: string,
      input: unknown,
      output: Extract<
        Exclude<LanguageModelV4Prompt[number]['content'], string>[number],
        { type: 'tool-result' }
      >['output']
    ): LanguageModelV4Prompt => [
      { content: [{ input, toolCallId: id, toolName, type: 'tool-call' }], role: 'assistant' },
      { content: [{ output, toolCallId: id, toolName, type: 'tool-result' }], role: 'tool' },
    ];
    const prompt: LanguageModelV4Prompt = [
      { content: 'system', role: 'system' },
      user('go'),
      ...pair(
        'call_read',
        'brainstrike_readWorkspaceFile',
        { path: 'a.ts' },
        {
          type: 'text',
          value: 'x'.repeat(400),
        }
      ),
      ...pair(
        'call_grep',
        'brainstrike_grepSearch',
        { pattern: 'needle' },
        {
          type: 'json',
          value: { matches: ['a.ts:1'] },
        }
      ),
      ...pair(
        'call_denied',
        'brainstrike_executeCommand',
        { command: 'ls' },
        {
          reason: 'denied by user',
          type: 'execution-denied',
        }
      ),
      ...pair(
        'call_shot',
        'browser_screenshot',
        {},
        {
          type: 'content',
          value: [
            { text: 'captured', type: 'text' },
            { data: { data: 'aGVsbG8=', type: 'data' }, mediaType: 'image/png', type: 'file' },
          ],
        }
      ),
      user('again'),
    ];
    const prepared = await prepare(prompt, {
      rewrites: new Map([
        [
          'call_grep',
          {
            kind: 'prune',
            markerText: '[pruned]',
            supersededByToolCallId: null,
            toolCallId: 'call_grep',
          },
        ],
      ]),
    });
    const calls = preparedPromptToolCalls(prepared);
    expect(calls).toEqual([
      {
        inputTokens: Math.ceil(JSON.stringify({ path: 'a.ts' }).length / 4),
        output: 'full',
        outputTokens: 100,
        toolCallId: 'call_read',
        toolName: 'brainstrike.readWorkspaceFile',
      },
      {
        inputTokens: Math.ceil(JSON.stringify({ pattern: 'needle' }).length / 4),
        output: 'marker',
        outputTokens: Math.ceil('[pruned]'.length / 4),
        toolCallId: 'call_grep',
        toolName: 'brainstrike.grepSearch',
      },
      expect.objectContaining({
        output: 'full',
        outputTokens: Math.ceil('denied by user'.length / 4),
        toolCallId: 'call_denied',
        toolName: 'brainstrike.executeCommand',
      }),
      // An inline file counts as its label, never its bytes.
      expect.objectContaining({
        outputTokens: Math.ceil('captured\n[attachment file]'.length / 4),
        toolCallId: 'call_shot',
        toolName: 'browser_screenshot',
      }),
    ]);
    const breakdown = preparedPromptBreakdown(prepared, calls);
    const total = calls.reduce((sum, c) => sum + c.inputTokens + c.outputTokens, 0);
    expect(breakdown.toolCallsTokens).toBe(total);
    expect(breakdown.toolCallsByTool?.reduce((sum, row) => sum + row.tokens, 0)).toBe(total);
    expect(breakdown.toolCallsByTool?.[0]).toEqual({
      calls: 1,
      tokens: (calls[0]?.inputTokens ?? 0) + 100,
      toolName: 'brainstrike.readWorkspaceFile',
    });
    // Text parts stay the conversation's: tool calls are a separate category.
    expect(breakdown.historyMessagesTokens).toBe(
      Math.ceil('go'.length / 4) + Math.ceil('again'.length / 4)
    );
  });

  it('limits contiguous final context including system observations and tool definitions', async () => {
    const prompt = [
      { content: 'memory observations', role: 'system' as const },
      user('a'.repeat(2400)),
      { content: [{ text: 'old answer', type: 'text' as const }], role: 'assistant' as const },
      user('latest'),
    ];
    const prepared = await prepare(prompt, { inputTokenLimit: 100 });
    expect(prepared.params.prompt).toEqual([prompt[0], prompt[3]]);
    expect(prepared.accounting.totalTokens).toBeLessThanOrEqual(100);
    expect(prepared.accounting.toolTokens).toBe(0);
    expect(prepared.accounting.removedMessages).toBe(2);
    await expect(
      prepare([{ content: 'x'.repeat(1000), role: 'system' }, user('latest')], {
        inputTokenLimit: 100,
      })
    ).rejects.toBeInstanceOf(ProviderRequestContextOverflowError);
    await expect(
      prepareProviderRequest(
        {
          prompt: [user('latest')],
          tools: [
            {
              inputSchema: { description: 'x'.repeat(1000), type: 'object' },
              name: 'read',
              type: 'function',
            },
          ],
        },
        model(),
        { inputTokenLimit: 100, provider: 'openai', tokenMeasurement: measurement }
      )
    ).rejects.toBeInstanceOf(ProviderRequestContextOverflowError);
  });

  it('retains selected settings while stripping local transport configuration', async () => {
    const params = {
      prompt: [user('start')],
      providerOptions: {
        google: { thinkingConfig: { includeThoughts: false } },
        lmstudio: { baseUrl: 'http://fixture' },
        ollama: { apiToken: 'not-a-credential', baseUrl: 'http://fixture' },
      },
    };
    const prepared = await prepareProviderRequest(params, model('google.generative-ai'), {
      provider: 'google',
      runtimeData: {
        modelSettings: { maxOutputTokens: 1234 },
        providerOptions: { google: { thinkingConfig: { includeThoughts: true } } },
      },
      tokenMeasurement: measurement,
    });
    expect(prepared.params.maxOutputTokens).toBe(1234);
    expect(prepared.params.providerOptions).toEqual({
      google: { thinkingConfig: { includeThoughts: true } },
    });
    expect(params.providerOptions.ollama).toBeDefined();
  });

  it('rejects cancellation before provider preparation or schema/usage callbacks', async () => {
    const controller = new AbortController();
    controller.abort(new Error('User Stop'));
    await expect(
      prepareProviderRequest(
        { abortSignal: controller.signal, prompt: [user('continue')] },
        model(),
        { provider: 'openai' }
      )
    ).rejects.toThrow('User Stop');
  });

  it('preserves canonical validation of required inputs while normalizing optional provider nulls', async () => {
    const authored = z.object({ line: z.number().int().optional(), path: z.string().min(1) });
    const schema = prepareProviderToolInputSchema(
      authored,
      new schemaCompat.OpenAISchemaCompatLayer({
        modelId: 'gpt-6-sol',
        provider: 'openai.responses',
        supportsStructuredOutputs: true,
      })
    );
    expect(await schema.validate({ line: null, path: 'README.md' })).toEqual({
      success: true,
      value: { path: 'README.md' },
    });
    expect((await schema.validate({ line: null, path: null })).success).toBe(false);
    expect((await schema.validate({ line: 'wrong type', path: 'README.md' })).success).toBe(false);
  });

  it('heals before SDK7 prompt conversion and never executes interrupted tools', async () => {
    const captured: LanguageModelV4CallOptions[] = [];
    const messages: InputMessage[] = [
      { content: 'run', role: 'user' },
      {
        content: [
          { input: {}, toolCallId: 'call_interrupted', toolName: 'execute', type: 'tool-call' },
        ],
        role: 'assistant',
      },
      { content: 'continue', role: 'user' },
    ];
    const fixture: LanguageModelV4 = {
      ...model(),
      doStream: (params) => {
        captured.push(params);
        return Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                finishReason: { raw: 'stop', unified: 'stop' },
                type: 'finish',
                usage: {
                  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                  outputTokens: { reasoning: 0, text: 1, total: 1 },
                },
              });
              controller.close();
            },
          }),
        });
      },
    };
    const result = sdk.streamText({
      maxRetries: 0,
      messages,
      model: sdk.wrapLanguageModel({
        middleware: createProviderRequestMiddleware({
          context: () => ({ provider: 'openai', tokenMeasurement: measurement }),
        }),
        model: fixture,
      }),
      prepareStep: ({ messages: current }) => ({
        messages: healInterruptedModelMessages(current, new Set(['call_interrupted'])),
      }),
    });
    const errors = [];
    for await (const part of result.fullStream) {
      if (part.type === 'error') {
        errors.push(part.error);
      }
    }
    expect(errors).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(JSON.stringify(captured[0]?.prompt)).toContain('interrupted by Stop');
    expect(messages).toHaveLength(3);
  });

  it('surfaces an expired item as a typed failure with exactly one provider request', async () => {
    let requests = 0;
    const fixture: LanguageModelV4 = {
      ...model(),
      doStream: () => {
        requests += 1;
        return Promise.resolve({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                error: {
                  responseBody: JSON.stringify({
                    error: { code: 'item_expired', message: 'stored item expired' },
                  }),
                  statusCode: 400,
                },
                type: 'error',
              });
              controller.close();
            },
          }),
        });
      },
    };
    const wrapped = sdk.wrapLanguageModel({
      middleware: createProviderRequestMiddleware({
        context: () => ({ provider: 'openai', tokenMeasurement: measurement }),
      }),
      model: fixture,
    });
    const errors = [];
    for await (const part of sdk.streamText({
      maxRetries: 0,
      messages: [{ content: 'continue', role: 'user' }],
      model: wrapped,
    }).fullStream) {
      if (part.type === 'error') {
        errors.push(part.error);
      }
    }
    expect(requests).toBe(1);
    expect(errors[0]).toBeInstanceOf(OpenAIStoredItemExpiredError);
    expect(errors[0]).toMatchObject({ code: 'openai_stored_item_expired', retryable: false });
  });

  it('prevents SDK retry of a thrown expired-item APICallError even when transport marks it retryable', async () => {
    let requests = 0;
    const fixture: LanguageModelV4 = {
      ...model(),
      doStream: () => {
        requests += 1;
        throw new APICallError({
          isRetryable: true,
          message: 'Item with id rs_expired not found',
          requestBodyValues: {},
          statusCode: 400,
          url: 'https://example.test/responses',
        });
      },
    };
    const errors = [];
    for await (const part of sdk.streamText({
      maxRetries: 2,
      messages: [{ content: 'continue', role: 'user' }],
      model: sdk.wrapLanguageModel({
        middleware: createProviderRequestMiddleware({
          context: () => ({ provider: 'openai', tokenMeasurement: measurement }),
        }),
        model: fixture,
      }),
    }).fullStream) {
      if (part.type === 'error') {
        errors.push(part.error);
      }
    }
    expect(requests).toBe(1);
    expect(errors[0]).toBeInstanceOf(OpenAIStoredItemExpiredError);
  });

  it.each([
    ['openai-codex', 1],
    ['openai', 3],
  ] as const)(
    'a %s HTTP 429 is retried by the SDK only when it is not subscription quota',
    async (provider, expectedRequests) => {
      let requests = 0;
      const fixture: LanguageModelV4 = {
        ...model(),
        doStream: () => {
          requests += 1;
          throw new APICallError({
            isRetryable: true,
            message: 'You have hit your usage limit.',
            requestBodyValues: {},
            // Keep the SDK's own Retry-After handling in the path without a real wait.
            responseHeaders: { 'retry-after': '0' },
            statusCode: 429,
            url: 'https://example.test/responses',
          });
        },
      };
      const errors: unknown[] = [];
      for await (const part of sdk.streamText({
        maxRetries: 2,
        messages: [{ content: 'continue', role: 'user' }],
        model: sdk.wrapLanguageModel({
          middleware: createProviderRequestMiddleware({
            context: () => ({ provider, tokenMeasurement: measurement }),
          }),
          model: fixture,
        }),
      }).fullStream) {
        if (part.type === 'error') {
          errors.push(part.error);
        }
      }
      expect(requests).toBe(expectedRequests);
      expect(errors).toHaveLength(1);
      if (provider === 'openai-codex') {
        expect(errors[0]).toBeInstanceOf(SubscriptionQuotaExhaustedError);
        expect(errors[0]).toMatchObject({
          code: 'subscription_quota_exhausted',
          message: 'You have hit your usage limit.',
          retryable: false,
        });
      }
    }
  );
});

const fixtureUrl = new URL(
  './fixtures/provider-requests/sdk7-recorded-payloads.json',
  import.meta.url
);
const providers = [
  ['openai', 'gpt-6-sol'],
  ['openai-codex', 'codex/gpt-6-sol'],
  ['anthropic', 'claude-sonnet-5'],
  ['google', 'gemini-3.1-pro-preview'],
  ['bedrock', 'anthropic.claude-sonnet-5'],
  ['openrouter', 'qwen/qwen3-coder'],
  ['ollama', 'qwen3'],
  ['lmstudio', 'qwen3'],
] as const;

describe('recorded installed-provider payloads (offline)', () => {
  it('matches all shipped routes through SDK7 and the canonical schema layers', async () => {
    expect((hostRequire('ai/package.json') as { version: string }).version).toBe('7.0.126');
    const recorded: Record<string, unknown> = {};
    const cases = [
      ...providers.map(([provider, modelId]) => ({
        key: provider,
        modelId,
        provider,
        replay: false,
      })),
      {
        key: 'openai-stored-replay',
        modelId: 'gpt-6-sol',
        provider: 'openai' as const,
        replay: true,
      },
      {
        key: 'openai-stateless-replay',
        modelId: 'codex/gpt-6-sol',
        provider: 'openai-codex' as const,
        replay: true,
      },
    ];
    for (const { provider, modelId, key, replay } of cases) {
      const bodies: unknown[] = [];
      // Intercept EVERY fetch. No network passthrough, accounts or keys are read.
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        bodies.push(JSON.parse(await request.text()));
        return Response.json(
          {
            error: {
              message: 'Offline fixture stops after request serialization',
              type: 'fixture_terminal',
            },
          },
          { status: 400 }
        );
      });
      const auth =
        provider === 'bedrock'
          ? { apiKey: 'offline-fixture', kind: 'aws' as const, region: 'us-east-1' }
          : provider === 'openai-codex'
            ? { apiKey: 'offline-fixture', fetch: globalThis.fetch, kind: 'custom_fetch' as const }
            : { apiKey: 'offline-fixture', kind: 'api_key' as const };
      const config = createProvider(provider, auth, modelId);
      const resolved =
        typeof config === 'object' && 'doStream' in config
          ? config
          : new ModelRouterLanguageModel(
              config as ConstructorParameters<typeof ModelRouterLanguageModel>[0]
            );
      const identity = { modelId, provider: resolved.provider, supportsStructuredOutputs: true };
      const Layer =
        provider === 'google'
          ? schemaCompat.GoogleSchemaCompatLayer
          : provider === 'anthropic' || provider === 'bedrock'
            ? schemaCompat.AnthropicSchemaCompatLayer
            : schemaCompat.OpenAISchemaCompatLayer;
      const preparedSchema = prepareProviderToolInputSchema(
        z.object({ line: z.number().int().optional(), path: z.string() }),
        new Layer(identity)
      );
      const inputSchema = sdk.jsonSchema(preparedSchema.jsonSchema, {
        validate: preparedSchema.validate,
      });
      const wrapped = sdk.wrapLanguageModel({
        middleware: createProviderRequestMiddleware({
          context: () => ({
            provider: provider as SupportedProvider,
            runtimeData: { model: modelId, modelSettings: { maxOutputTokens: 321 } },
            tokenMeasurement: measurement,
          }),
        }),
        model: resolved as unknown as LanguageModelV4,
      });
      const errors: unknown[] = [];
      const messages: InputMessage[] = replay
        ? [
            { content: 'Read README.md', role: 'user' },
            {
              content: [
                {
                  providerOptions: {
                    openai: {
                      itemId: 'rs_recorded',
                      reasoningEncryptedContent: 'offline-encrypted-content',
                    },
                  },
                  text: 'Read the requested file',
                  type: 'reasoning',
                },
                {
                  input: { path: 'README.md' },
                  providerOptions: { openai: { itemId: 'fc_recorded' } },
                  toolCallId: 'call_recorded',
                  toolName: 'read',
                  type: 'tool-call',
                },
              ],
              role: 'assistant',
            },
            {
              content: [
                {
                  output: { type: 'text', value: 'Recorded file projection' },
                  toolCallId: 'call_recorded',
                  toolName: 'read',
                  type: 'tool-result',
                },
              ],
              role: 'tool',
            },
            { content: 'Continue with those results', role: 'user' },
          ]
        : [{ content: 'Read README.md', role: 'user' }];
      for await (const part of sdk.streamText({
        maxRetries: 0,
        messages,
        model: wrapped,
        tools: { read: { description: 'Read a workspace file', inputSchema } },
      }).fullStream) {
        if (part.type === 'error') {
          errors.push(part.error);
        }
      }
      expect(bodies, `${provider}: ${errors.map(String).join('; ')}`).toHaveLength(1);
      recorded[key] = bodies[0];
    }
    if (process.env['BST_RECORD_PROVIDER_FIXTURES'] === '1') {
      await writeFile(
        fixtureUrl,
        `${JSON.stringify({ payloads: recorded, source: { base: 'be835943559ab751c9c0267b5572104eaecbe357', capture: 'real installed SDK/provider serialization; fully intercepted fetch; no real account', sdk: '7.0.126' } }, null, 2)}\n`
      );
    }
    const fixtures = JSON.parse(await readFile(fixtureUrl, 'utf8')) as {
      payloads: Record<string, unknown>;
    };
    expect(recorded).toEqual(fixtures.payloads);
  });
});
