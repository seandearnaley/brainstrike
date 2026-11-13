/**
 * A thread may move between the two OpenAI routes (ADR-0038): the API-key
 * route, which stores its responses, and Sign in with ChatGPT, which stores
 * nothing. What one route produced is never replayed to the other as an item.
 */
import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepOwnOpenAIRouteItems } from '../providers/openai-route-items';
import { createProvider } from '../providers/provider-factory';

interface StreamingModel {
  doStream(options: unknown): Promise<{ stream: ReadableStream<Record<string, unknown>> }>;
}

const USER: LanguageModelV4Prompt[number] = {
  content: [{ text: 'list the files', type: 'text' }],
  role: 'user',
};

/** One assistant turn with reasoning, text and a tool call, as `openai` options carry them. */
function turn(marks: Record<string, Record<string, unknown>>): LanguageModelV4Prompt {
  const item = (itemId: string) => ({ ...marks, openai: { itemId } });
  return [
    USER,
    {
      content: [
        {
          providerOptions: {
            ...marks,
            openai: { itemId: 'rs_1', reasoningEncryptedContent: 'opaque' },
          },
          text: 'thinking',
          type: 'reasoning',
        },
        { providerOptions: item('msg_1'), text: 'Looking.', type: 'text' },
        {
          input: { path: '.' },
          providerOptions: item('fc_1'),
          toolCallId: 'call_1',
          toolName: 'list_files',
          type: 'tool-call',
        },
      ],
      role: 'assistant',
    },
    {
      content: [
        {
          output: { type: 'text', value: 'a.ts' },
          toolCallId: 'call_1',
          toolName: 'list_files',
          type: 'tool-result',
        },
      ],
      role: 'tool',
    },
    { content: [{ text: 'and now?', type: 'text' }], role: 'user' },
  ];
}

const PLAN_TURN = turn({ chatgpt: { planItem: true } });
const STORED_TURN = turn({});

function serverSentEvents(events: readonly unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
    status: 200,
  });
}

const REPLY = [
  {
    response: { created_at: 1, id: 'resp_1', model: 'gpt-6.1-sol', service_tier: null },
    type: 'response.created',
  },
  { item: { id: 'msg_9', type: 'message' }, output_index: 0, type: 'response.output_item.added' },
  { delta: 'Done.', item_id: 'msg_9', type: 'response.output_text.delta' },
  { item: { id: 'msg_9', type: 'message' }, output_index: 0, type: 'response.output_item.done' },
  {
    response: { incomplete_details: null, usage: { input_tokens: 1, output_tokens: 1 } },
    type: 'response.completed',
  },
];

/** The `input` items one request sends to OpenAI, and the parts its reply streams. */
async function send(
  model: StreamingModel,
  prompt: LanguageModelV4Prompt,
  providerOptions: Record<string, unknown>
): Promise<{ input: Record<string, unknown>[]; parts: Record<string, unknown>[] }> {
  let body: { input?: Record<string, unknown>[] } = {};
  vi.stubGlobal('fetch', (_input: RequestInfo, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return Promise.resolve(serverSentEvents(REPLY));
  });
  const { stream } = await model.doStream({ prompt, providerOptions });
  const parts: Record<string, unknown>[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { input: body.input ?? [], parts };
    }
    parts.push(value);
  }
}

const apiKeyModel = () =>
  createProvider(
    'openai',
    { apiKey: 'sk-fixture', kind: 'api_key' },
    'gpt-6.1-sol'
  ) as unknown as StreamingModel;
const planModel = () =>
  createProvider(
    'chatgpt',
    { accessToken: () => Promise.resolve('token'), kind: 'access_token' },
    'chatgpt/gpt-6.1-sol'
  ) as unknown as StreamingModel;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAI items stay with the route that produced them', () => {
  it('sends a ChatGPT plan turn to the API-key route as plain content, never as stored items', async () => {
    const prompt = keepOwnOpenAIRouteItems(PLAN_TURN, 'openai');

    const { input } = await send(apiKeyModel(), prompt, { openai: { store: true } });

    // A reference would name an item OpenAI never stored, and fail the turn.
    expect(input.filter((item) => item['type'] === 'item_reference')).toEqual([]);
    expect(input.filter((item) => item['type'] === 'reasoning')).toEqual([]);
    expect(input.map((item) => item['type'] ?? item['role'])).toEqual([
      'user',
      'assistant',
      'function_call',
      'function_call_output',
      'user',
    ]);
    expect(input.find((item) => item['type'] === 'function_call')).not.toHaveProperty('id');
  });

  it('sends a stored turn to the ChatGPT plan route without its item ids or its reasoning', async () => {
    const prompt = keepOwnOpenAIRouteItems(STORED_TURN, 'chatgpt');

    const { input } = await send(planModel(), prompt, {});

    // Stored reasoning has no encrypted content to send, and a stored item's id names nothing here.
    expect(input.filter((item) => item['type'] === 'reasoning')).toEqual([]);
    expect(JSON.stringify(input)).not.toMatch(/rs_1|msg_1|fc_1/u);
    expect(input.find((item) => item['type'] === 'function_call')).toMatchObject({
      call_id: 'call_1',
      name: 'list_files',
    });
  });

  it("replays each route's own turn to it untouched", async () => {
    expect(keepOwnOpenAIRouteItems(STORED_TURN, 'openai')).toBe(STORED_TURN);
    expect(keepOwnOpenAIRouteItems(PLAN_TURN, 'chatgpt')).toBe(PLAN_TURN);

    // The plan route replays its own reasoning inline, as encrypted content.
    const { input } = await send(planModel(), PLAN_TURN, {});
    expect(input.find((item) => item['type'] === 'reasoning')).toMatchObject({
      encrypted_content: 'opaque',
      id: 'rs_1',
    });
  });

  it('marks what a ChatGPT plan turn produces, and nothing the API-key route produces', async () => {
    const produced = async (model: StreamingModel) =>
      (await send(model, [USER], {})).parts.filter(
        (part) => (part['providerMetadata'] as Record<string, unknown> | undefined)?.['openai']
      );

    const plan = await produced(planModel());
    expect(plan.length).toBeGreaterThan(0);
    for (const part of plan) {
      expect(part['providerMetadata']).toMatchObject({ chatgpt: { planItem: true } });
    }
    for (const part of await produced(apiKeyModel())) {
      expect(part['providerMetadata']).not.toHaveProperty('chatgpt');
    }
  });

  it("leaves another provider's turn alone", () => {
    const anthropic: LanguageModelV4Prompt = [
      USER,
      {
        content: [
          { providerOptions: { anthropic: { signature: 'sig' } }, text: 'hm', type: 'reasoning' },
          { text: 'ok', type: 'text' },
        ],
        role: 'assistant',
      },
    ];
    expect(keepOwnOpenAIRouteItems(anthropic, 'openai')).toBe(anthropic);
    expect(keepOwnOpenAIRouteItems(anthropic, 'chatgpt')).toBe(anthropic);
  });
});
