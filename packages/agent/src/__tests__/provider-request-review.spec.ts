import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import { MessageList } from '@mastra/core/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderRequestMiddleware,
  healInterruptedModelMessages,
  ProviderRequestContextOverflowError,
  prepareProviderRequest,
} from '../provider-request';
import { dropAbortedOpenAIItems } from '../providers/request-history';
import { createPreparedTokenMeasurement } from '../token-measurement';

const hostRequire = createRequire(new URL('../../../agent-host/package.json', import.meta.url));
interface PinnedSdk {
  generateText(options: {
    model: LanguageModelV4;
    messages: unknown[];
    tools?: Record<string, unknown>;
    maxRetries: number;
  }): Promise<{ response: { messages: unknown[] } }>;
  streamText(options: {
    model: LanguageModelV4;
    messages: unknown[];
    maxRetries: number;
    prepareStep?: (options: { messages: InputMessage[] }) => { messages: unknown[] };
  }): { fullStream: AsyncIterable<{ type: string; error?: unknown }> };
  wrapLanguageModel(options: {
    model: LanguageModelV4;
    middleware: LanguageModelV4Middleware;
  }): LanguageModelV4;
}
interface InputMessage {
  content: string | unknown[];
  role: 'system' | 'user' | 'assistant' | 'tool';
}
const sdk = (await import(hostRequire.resolve('ai'))) as PinnedSdk;
const measurement = await createPreparedTokenMeasurement({
  charactersPerToken: 4,
  mode: 'deterministic-serialized-character-backstop',
});
const user = (text: string): LanguageModelV4Prompt[number] => ({
  content: [{ text, type: 'text' }],
  role: 'user',
});
const model: LanguageModelV4 = {
  doGenerate: () => {
    throw new Error('No un-intercepted provider calls.');
  },
  doStream: () => {
    throw new Error('No un-intercepted provider calls.');
  },
  modelId: 'gpt-6-sol',
  provider: 'openai.responses',
  specificationVersion: 'v4',
  supportedUrls: {},
};
const call = (id: string, itemId: string): LanguageModelV4Prompt[number] => ({
  content: [
    {
      input: {},
      providerOptions: { openai: { itemId } },
      toolCallId: id,
      toolName: 'read',
      type: 'tool-call',
    },
  ],
  role: 'assistant',
});
const result = (id: string, text: string): LanguageModelV4Prompt[number] => ({
  content: [
    {
      output: { type: 'text', value: text },
      toolCallId: id,
      toolName: 'read',
      type: 'tool-result',
    },
  ],
  role: 'tool',
});
const prepare = (prompt: LanguageModelV4Prompt, limit?: number) =>
  prepareProviderRequest({ prompt }, model, {
    provider: 'openai',
    tokenMeasurement: measurement,
    ...(limit ? { inputTokenLimit: limit } : {}),
  });
afterEach(() => vi.unstubAllGlobals());

describe('BST-1927 independent-review runtime counterexamples', () => {
  it('preserves execution-denied without converting a counting TypeError into context overflow', async () => {
    const denied: LanguageModelV4Prompt[number] = {
      content: [
        {
          output: { reason: 'User denied', type: 'execution-denied' },
          toolCallId: 'denied',
          toolName: 'read',
          type: 'tool-result',
        },
      ],
      role: 'tool',
    };
    const prompt = [user('read'), call('denied', 'fc_denied'), denied, user('continue')];
    const prepared = await prepare(prompt, 2000);
    expect(prepared.params.prompt).toEqual(prompt);
    expect(prepared.accounting.totalTokens).toBeLessThanOrEqual(2000);
  });

  it('enforces the final budget for tagged inline text files while preserving the outgoing shape', async () => {
    const file: LanguageModelV4Prompt[number] = {
      content: [
        {
          data: { text: 'word '.repeat(1000), type: 'text' },
          mediaType: 'text/plain',
          type: 'file',
        },
      ],
      role: 'user',
    };
    await expect(prepare([file], 1000)).rejects.toBeInstanceOf(ProviderRequestContextOverflowError);
    const prompt = [
      file,
      { content: [{ text: 'old answer', type: 'text' as const }], role: 'assistant' as const },
      user('latest'),
    ];
    const prepared = await prepare(prompt, 200);
    expect(prepared.params.prompt).toEqual([prompt[2]]);
    expect((await prepare([file], 10_000)).params.prompt).toEqual([file]);
  });

  it('heals the later interrupted occurrence of an ID after an earlier completed pair', async () => {
    const messages: InputMessage[] = [
      { content: 'old task', role: 'user' },
      {
        content: [
          { input: {}, toolCallId: 'recorded-call-1', toolName: 'read', type: 'tool-call' },
        ],
        role: 'assistant',
      },
      {
        content: [
          {
            output: { type: 'text', value: 'old completed output' },
            toolCallId: 'recorded-call-1',
            toolName: 'read',
            type: 'tool-result',
          },
        ],
        role: 'tool',
      },
      { content: 'new task', role: 'user' },
      {
        content: [
          { input: {}, toolCallId: 'recorded-call-1', toolName: 'read', type: 'tool-call' },
        ],
        role: 'assistant',
      },
      { content: 'continue', role: 'user' },
    ];
    const requests: LanguageModelV4CallOptions[] = [];
    const fixture: LanguageModelV4 = {
      ...model,
      doStream: (params) => {
        requests.push(params);
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
    const errors = [];
    for await (const part of sdk.streamText({
      maxRetries: 0,
      messages,
      model: sdk.wrapLanguageModel({
        middleware: createProviderRequestMiddleware({
          context: () => ({ provider: 'openai', tokenMeasurement: measurement }),
        }),
        model: fixture,
      }),
      prepareStep: ({ messages: current }) => ({
        messages: healInterruptedModelMessages(current, new Set(['recorded-call-1'])),
      }),
    }).fullStream) {
      if (part.type === 'error') {
        errors.push(part.error);
      }
    }
    expect(errors).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.prompt)).toContain('old completed output');
    expect(JSON.stringify(requests[0]?.prompt)).toContain('interrupted by Stop');
    expect(messages).toHaveLength(6);
  });

  it('enforces the observed final budget even for V4 parts the legacy estimator ignores', async () => {
    const prompt: LanguageModelV4Prompt = [
      user('start'),
      {
        content: [
          { text: 'continue', type: 'text' },
          {
            kind: 'openai.fixture' as const,
            providerOptions: { openai: { payload: 'long '.repeat(1000) } },
            type: 'custom',
          },
        ],
        role: 'assistant',
      },
      user('continue'),
    ];
    await expect(prepare(prompt, 200)).rejects.toMatchObject({
      accounting: { totalTokens: expect.any(Number) },
      code: 'provider_request_context_overflow',
    });
    expect((await prepare(prompt, 10_000)).params.prompt).toEqual(prompt);
  });

  it('drops only the exact aborted occurrence and preserves an older completed pair with the same call ID', () => {
    const prompt = [
      user('old'),
      call('recorded-call-1', 'fc_old'),
      result('recorded-call-1', 'old completed output'),
      user('new'),
      call('recorded-call-1', 'fc_new'),
      result('recorded-call-1', 'new aborted output'),
      user('continue'),
    ];
    const before = JSON.stringify(prompt);
    const prepared = dropAbortedOpenAIItems(prompt, new Set(['fc_new']));
    expect(prepared).toEqual([prompt[0], prompt[1], prompt[2], prompt[3], prompt[6]]);
    expect(JSON.stringify(prompt)).toBe(before);
  });

  it('preserves a split reasoning follower after an empty aborted row, and drops a genuine orphan', async () => {
    const reasoning: LanguageModelV4Prompt[number] = {
      content: [
        {
          providerOptions: {
            openai: { itemId: 'rs_surviving', reasoningEncryptedContent: 'offline-encrypted' },
          },
          text: 'recorded reasoning',
          type: 'reasoning',
        },
      ],
      role: 'assistant',
    };
    const answer: LanguageModelV4Prompt[number] = {
      content: [
        {
          providerOptions: { openai: { itemId: 'msg_surviving' } },
          text: 'valid follower',
          type: 'text',
        },
      ],
      role: 'assistant',
    };
    const prompt = [
      user('start'),
      reasoning,
      call('aborted', 'fc_aborted'),
      result('aborted', 'aborted output'),
      answer,
      user('continue'),
    ];
    const prepared = await prepareProviderRequest({ prompt }, model, {
      abortedItemIds: new Set(['fc_aborted']),
      provider: 'openai',
      tokenMeasurement: measurement,
    });
    expect(prepared.params.prompt).toEqual([prompt[0], reasoning, answer, prompt[5]]);
    const duplicateCall = call('split-call', 'fc_split');
    if (duplicateCall.role !== 'assistant' || reasoning.role !== 'assistant') {
      throw new Error('Expected recorded assistant parts');
    }
    const split = await prepare([
      user('start'),
      { content: [...reasoning.content, ...duplicateCall.content], role: 'assistant' },
      duplicateCall,
      result('split-call', 'completed output'),
      user('continue'),
    ]);
    expect(JSON.stringify(split.params.prompt)).toContain('rs_surviving');
    expect(split.params.prompt.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect((await prepare([user('start'), reasoning, user('continue')])).params.prompt).toEqual([
      user('start'),
      user('continue'),
    ]);
  });

  it('captures pinned split-row replay and provider-executed Anthropic history without part metadata', async () => {
    const recorded: Record<string, unknown> = {};
    for (const store of [true, false]) {
      let body: unknown;
      const client = createOpenAI({
        apiKey: 'offline-fixture',
        fetch: async (_input, init) => {
          body = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              created_at: 0,
              id: 'resp_offline',
              model: 'gpt-6-sol',
              output: [],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { headers: { 'content-type': 'application/json' }, status: 200 }
          );
        },
      });
      const prompt: LanguageModelV4Prompt = [
        user('old'),
        {
          content: [
            {
              providerOptions: {
                openai: {
                  itemId: 'rs_split',
                  reasoningEncryptedContent: 'offline-encrypted-split',
                },
              },
              text: 'recorded split reasoning',
              type: 'reasoning',
            },
          ],
          role: 'assistant',
        },
        {
          content: [
            {
              providerOptions: { openai: { itemId: 'msg_split' } },
              text: 'recorded split answer',
              type: 'text',
            },
          ],
          role: 'assistant',
        },
        user('continue'),
      ];
      const prepared = await prepareProviderRequest({ prompt }, client.responses('gpt-6-sol'), {
        provider: store ? 'openai' : 'openai-codex',
        tokenMeasurement: measurement,
      });
      await client.responses('gpt-6-sol').doGenerate(prepared.params);
      recorded[store ? 'stored_split' : 'stateless_split'] = body;
      expect.soft(JSON.stringify(body)).toContain(store ? 'rs_split' : 'offline-encrypted-split');
      expect.soft(JSON.stringify(body)).toContain(store ? 'msg_split' : 'recorded split answer');
    }
    const anthropic = createAnthropic({
      apiKey: 'offline-fixture',
      fetch: async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                id: 'srvtoolu_recorded',
                input: { query: 'brainstrike' },
                name: 'web_search',
                type: 'server_tool_use',
              },
              { content: [], tool_use_id: 'srvtoolu_recorded', type: 'web_search_tool_result' },
              { text: 'Earlier answer', type: 'text' },
            ],
            id: 'msg_offline_server',
            model: 'claude-sonnet-5',
            role: 'assistant',
            stop_reason: 'end_turn',
            stop_sequence: null,
            type: 'message',
            usage: { input_tokens: 11, output_tokens: 12 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        ),
    });
    const generated = await sdk.generateText({
      maxRetries: 0,
      messages: [{ content: 'search', role: 'user' }],
      model: anthropic.messages('claude-sonnet-5'),
      tools: { web_search: anthropic.tools.webSearch_20250305({ maxUses: 1 }) },
    });
    recorded['anthropic_server_response_messages'] = generated.response.messages;
    const list = new MessageList();
    list.add(
      [
        { content: 'search', role: 'user' },
        ...generated.response.messages,
        { content: 'continue', role: 'user' },
      ] as Parameters<MessageList['add']>[0],
      'memory'
    );
    for (const message of list.get.all.db()) {
      if (message.role === 'assistant') {
        message.content.metadata = { ...message.content.metadata, provider: 'anthropic.messages' };
      }
    }
    const history = list.get.all.db();
    const prompt = await list.get.all.aiV7.llmPrompt();
    const sameProvider = await prepareProviderRequest(
      { prompt: prompt as unknown as LanguageModelV4Prompt },
      anthropic.messages('claude-sonnet-5'),
      { history, provider: 'anthropic', tokenMeasurement: measurement }
    );
    expect(JSON.stringify(sameProvider.params.prompt)).toContain('srvtoolu_recorded');
    expect(JSON.stringify(sameProvider.params.prompt)).toContain('Earlier answer');
    let body: unknown;
    const openai = createOpenAI({
      apiKey: 'offline-fixture',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            created_at: 0,
            id: 'resp_offline_switch',
            model: 'gpt-6-sol',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        );
      },
    });
    const prepared = await prepareProviderRequest(
      { prompt: prompt as unknown as LanguageModelV4Prompt },
      openai.responses('gpt-6-sol'),
      { history, provider: 'openai', tokenMeasurement: measurement }
    );
    await openai.responses('gpt-6-sol').doGenerate(prepared.params);
    recorded['anthropic_to_openai'] = body;
    expect.soft(JSON.stringify(body)).not.toContain('srvtoolu_recorded');
    expect.soft(JSON.stringify(body)).toContain('Earlier answer');
    const denied = await prepare(
      [
        user('read'),
        call('denied', 'fc_denied'),
        {
          content: [
            {
              output: { reason: 'User denied', type: 'execution-denied' },
              toolCallId: 'denied',
              toolName: 'read',
              type: 'tool-result',
            },
          ],
          role: 'tool',
        },
        user('continue'),
      ],
      2000
    );
    await openai.responses('gpt-6-sol').doGenerate(denied.params);
    recorded['execution_denied_limited'] = body;
    expect.soft(JSON.stringify(body)).toContain('User denied');
    const google = createGoogleGenerativeAI({
      apiKey: 'offline-fixture',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: 'Offline answer' }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1, totalTokenCount: 2 },
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        );
      },
    });
    const inlineFile = await prepareProviderRequest(
      {
        prompt: [
          {
            content: [
              {
                data: { text: 'Recorded inline document.', type: 'text' },
                filename: 'offline.txt',
                mediaType: 'text/plain',
                type: 'file',
              },
            ],
            role: 'user',
          },
        ],
      },
      google('gemini-3.1-pro'),
      { inputTokenLimit: 2000, provider: 'google', tokenMeasurement: measurement }
    );
    await google('gemini-3.1-pro').doGenerate(inlineFile.params);
    recorded['google_inline_text_file_limited'] = body;
    // Preserve the pinned OpenAI contract too: it rejects tagged text files;
    // the counting view must not silently turn them into ordinary text.
    await expect(openai.responses('gpt-6-sol').doGenerate(inlineFile.params)).rejects.toMatchObject(
      { name: 'AI_UnsupportedFunctionalityError' }
    );
    const fixture = new URL(
      './fixtures/provider-requests/sdk7-review-payloads.json',
      import.meta.url
    );
    if (process.env['BST_RECORD_PROVIDER_FIXTURES'] === '1') {
      await writeFile(
        fixture,
        `${JSON.stringify({ payloads: recorded, sdk: '7.0.126', source: 'pinned runtime parsing/serialization; mocked HTTP; no real account' }, null, 2)}\n`
      );
    }
    if (process.env['BST_RECORD_PROVIDER_FIXTURES'] !== '1') {
      expect(recorded).toEqual(
        (JSON.parse(await readFile(fixture, 'utf8')) as { payloads: Record<string, unknown> })
          .payloads
      );
    }
  });
});
