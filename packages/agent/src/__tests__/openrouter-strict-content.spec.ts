/**
 * OpenRouter strict-content compatibility (Alibaba/Qwen 400 regression).
 *
 * The OpenRouter chat serialization emits `content: text || null` for
 * assistant messages, so a replayed assistant turn that produced ONLY tool
 * calls (reasoning + tool-call parts, no text — e.g. persisted thread
 * `thread-f67e0474`, message `ysl0amz`, debug bundle 2026-08-16) reaches the
 * wire as `"content": null`. OpenAI accepts that; Alibaba's DashScope
 * validation rejects the whole request with
 * `invalid_parameter_error: The content field is a required field.` —
 * the exact 400 the desktop app surfaced after a Qwen 3.8 Max follow-up.
 *
 * The fix is a provider-aware wire normalization (`null` → `""`), the same
 * coercion LiteLLM applies and pydantic-ai proposed for this upstream
 * (pydantic/pydantic-ai#5287). It is scoped to model families whose primary
 * OpenRouter host enforces string content; everything else must pass through
 * byte-identical — OpenRouter normalizes for Anthropic-style upstreams where
 * an empty text block is itself invalid.
 */
import type { LanguageModelV2CallOptions, LanguageModelV2Prompt } from '@ai-sdk/provider';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createOpenRouterStrictContentFetch,
  OpenRouterStrictContentGateway,
  openRouterModelRequiresStringContent,
} from '../providers/openrouter-strict-content';
import { createProvider } from '../providers/provider-factory';

interface CapturedRequest {
  body: string;
  url: string;
}

function jsonBody(captured: CapturedRequest): {
  messages: Record<string, unknown>[];
  model: string;
} {
  return JSON.parse(captured.body) as {
    messages: Record<string, unknown>[];
    model: string;
  };
}

function makeCapturingFetch(captures: CapturedRequest[]): typeof fetch {
  return (input, init) => {
    captures.push({
      body: typeof init?.body === 'string' ? init.body : '',
      url: String(input),
    });
    const sse = [
      'data: {"id":"cmpl-1","model":"qwen/qwen3.8-max","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}',
      '',
      'data: {"id":"cmpl-1","model":"qwen/qwen3.8-max","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    return Promise.resolve(
      new Response(sse, {
        headers: { 'content-type': 'text/event-stream' },
        status: 200,
      })
    );
  };
}

/**
 * The production prompt shape: an assistant step that emitted reasoning and a
 * tool call but NO text part, followed by its tool result and a follow-up
 * user turn. This is what reload hydration replays for a tool-heavy run.
 */
const TOOL_CALL_ONLY_HISTORY: LanguageModelV2Prompt = [
  { content: 'You are a test assistant.', role: 'system' },
  { content: [{ text: 'inspect the workspace', type: 'text' }], role: 'user' },
  {
    content: [
      { text: 'I will look at the files first.', type: 'reasoning' },
      {
        input: { query: 'foo' },
        toolCallId: 'call_1',
        toolName: 'grepSearch',
        type: 'tool-call',
      },
    ],
    role: 'assistant',
  },
  {
    content: [
      {
        output: { type: 'text', value: 'no matches' },
        toolCallId: 'call_1',
        toolName: 'grepSearch',
        type: 'tool-result',
      },
    ],
    role: 'tool',
  },
  { content: [{ text: 'and now?', type: 'text' }], role: 'user' },
];

async function streamThroughRouter(modelName: string): Promise<void> {
  const config = createProvider('openrouter', 'test-key', modelName);
  const model =
    typeof config === 'object' && config !== null && 'doStream' in config
      ? (config as ModelRouterLanguageModel)
      : new ModelRouterLanguageModel(
          config as ConstructorParameters<typeof ModelRouterLanguageModel>[0]
        );
  const { stream } = await model.doStream({
    prompt: TOOL_CALL_ONLY_HISTORY,
  } as LanguageModelV2CallOptions);
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    // drain so the fake SSE response is fully consumed
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openRouterModelRequiresStringContent', () => {
  it('flags qwen models (Alibaba-hosted, strict content validation)', () => {
    expect(openRouterModelRequiresStringContent('qwen/qwen3.8-max')).toBe(true);
    expect(openRouterModelRequiresStringContent('qwen/qwen3-coder')).toBe(true);
  });

  it('leaves other model families alone', () => {
    expect(openRouterModelRequiresStringContent('z-ai/glm-5.2')).toBe(false);
    expect(openRouterModelRequiresStringContent('anthropic/claude-sonnet-5')).toBe(false);
    expect(openRouterModelRequiresStringContent('qwenlike/other')).toBe(false);
  });
});

describe('createOpenRouterStrictContentFetch', () => {
  it('coerces null assistant content to an empty string for strict models', async () => {
    const inner: Array<{ body: unknown; init: RequestInit | undefined }> = [];
    const base: typeof fetch = (_input, init) => {
      inner.push({ body: typeof init?.body === 'string' ? JSON.parse(init.body) : null, init });
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const wrapped = createOpenRouterStrictContentFetch(base);

    await wrapped('https://openrouter.ai/api/v1/chat/completions', {
      body: JSON.stringify({
        messages: [
          { content: 'sys', role: 'system' },
          { content: null, role: 'assistant', tool_calls: [{ id: 'call_1' }] },
          { content: 'tool says hi', role: 'tool', tool_call_id: 'call_1' },
          { content: 'follow-up', role: 'user' },
        ],
        model: 'qwen/qwen3.8-max',
      }),
      method: 'POST',
    });

    const body = inner[0]?.body as { messages: Record<string, unknown>[] };
    expect(body.messages[1]).toMatchObject({ content: '', role: 'assistant' });
    // every other message is untouched
    expect(body.messages[0]).toEqual({ content: 'sys', role: 'system' });
    expect(body.messages[2]).toEqual({
      content: 'tool says hi',
      role: 'tool',
      tool_call_id: 'call_1',
    });
    expect(body.messages[3]).toEqual({ content: 'follow-up', role: 'user' });
  });

  it('forwards non-strict models byte-identical', async () => {
    const seen: Array<string | undefined> = [];
    const base: typeof fetch = (_input, init) => {
      seen.push(typeof init?.body === 'string' ? init.body : undefined);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const wrapped = createOpenRouterStrictContentFetch(base);
    const original = JSON.stringify({
      messages: [{ content: null, role: 'assistant', tool_calls: [{ id: 'x' }] }],
      model: 'z-ai/glm-5.2',
    });

    await wrapped('https://openrouter.ai/api/v1/chat/completions', {
      body: original,
      method: 'POST',
    });

    expect(seen[0]).toBe(original);
  });

  it('forwards requests without a JSON body untouched', async () => {
    const calls: Array<RequestInit | undefined> = [];
    const base: typeof fetch = (_input, init) => {
      calls.push(init);
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const wrapped = createOpenRouterStrictContentFetch(base);

    const init: RequestInit = { method: 'GET' };
    await wrapped('https://openrouter.ai/api/v1/models', init);

    expect(calls[0]).toBe(init);
  });
});

describe('OpenRouterStrictContentGateway', () => {
  it('claims openrouter router ids and nothing else', () => {
    const gateway = new OpenRouterStrictContentGateway();
    expect(gateway.handlesModel('openrouter/qwen/qwen3.8-max')).toBe(true);
    expect(gateway.handlesModel('openrouter/z-ai/glm-5.2')).toBe(true);
    expect(gateway.handlesModel('anthropic/claude-sonnet-5')).toBe(false);
  });
});

describe('createProvider openrouter wiring', () => {
  it('routes openrouter models through the strict-content gateway', () => {
    const model = createProvider('openrouter', 'test-key', 'qwen/qwen3.8-max');
    expect(model).toBeInstanceOf(ModelRouterLanguageModel);
    const router = model as ModelRouterLanguageModel;
    expect(router.provider).toBe('openrouter');
    expect(router.modelId).toBe('qwen/qwen3.8-max');
    expect(router.gatewayId).toBe(new OpenRouterStrictContentGateway().id);
  });

  it('serializes replayed tool-call-only assistant turns with string content for qwen', async () => {
    const captures: CapturedRequest[] = [];
    vi.stubGlobal('fetch', makeCapturingFetch(captures));

    await streamThroughRouter('qwen/qwen3.8-max');

    expect(captures).toHaveLength(1);
    const body = jsonBody(captures[0] as CapturedRequest);
    expect(body.model).toBe('qwen/qwen3.8-max');
    const assistants = body.messages.filter((message) => message['role'] === 'assistant');
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants.some((message) => Array.isArray(message['tool_calls']))).toBe(true);
    for (const message of assistants) {
      // THE regression: `content: null` is what Alibaba 400s on.
      expect(typeof message['content']).toBe('string');
    }
  });

  it('keeps the OpenAI-spec null content for non-strict model families', async () => {
    const captures: CapturedRequest[] = [];
    vi.stubGlobal('fetch', makeCapturingFetch(captures));

    await streamThroughRouter('z-ai/glm-5.2');

    expect(captures).toHaveLength(1);
    const body = jsonBody(captures[0] as CapturedRequest);
    const toolCallTurn = body.messages.find((message) => Array.isArray(message['tool_calls']));
    expect(toolCallTurn).toBeDefined();
    expect(toolCallTurn?.['content']).toBeNull();
  });
});
