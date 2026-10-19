/**
 * BST-754: an Ollama model talks to the native `/api/chat`, the only Ollama
 * route that sizes the context per request, and every call carries the window
 * its run was admitted with (`num_ctx`), the model's thinking capability and
 * the call's sampling settings, where Ollama reads them.
 */
import { generateText, jsonSchema, streamText, tool } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ollamaChatOptions } from '../providers/ollama-chat-model';
import { createProvider } from '../providers/provider-factory';

interface CapturedRequest {
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
  readonly url: string;
}

const FACTS = { contextWindow: 16_384, thinking: true } as const;

/** Every fetch intercepted: Ollama's reply, as NDJSON for a stream or JSON otherwise. */
function interceptOllama(): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    requests.push({ body, headers: request.headers, url: request.url });
    const created_at = '2026-10-18T00:00:00Z';
    const chunks = [
      { created_at, done: false, message: { content: 'Hi', role: 'assistant' }, model: 'qwen3' },
      {
        created_at,
        done: true,
        done_reason: 'stop',
        eval_count: 2,
        message: { content: '', role: 'assistant' },
        model: 'qwen3',
        prompt_eval_count: 7,
      },
    ];
    return body['stream'] === true
      ? new Response(chunks.map((chunk) => `${JSON.stringify(chunk)}\n`).join(''), {
          headers: { 'content-type': 'application/x-ndjson' },
        })
      : Response.json({ ...chunks[1], message: { content: 'Hi', role: 'assistant' } });
  });
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ollama native chat (BST-754)', () => {
  it('streams /api/chat with the admitted window, thinking and the call settings in options', async () => {
    const requests = interceptOllama();
    const model = createProvider('ollama', undefined, 'qwen3:14b', undefined, FACTS);
    let text = '';
    for await (const part of streamText({
      maxOutputTokens: 321,
      maxRetries: 0,
      model: model as Parameters<typeof streamText>[0]['model'],
      prompt: 'Say hi',
      seed: 7,
      stopSequences: ['END'],
      temperature: 0.2,
      tools: {
        read: tool({
          description: 'Read a file',
          inputSchema: jsonSchema({ properties: { path: { type: 'string' } }, type: 'object' }),
        }),
      },
      topK: 40,
      topP: 0.9,
    }).fullStream) {
      if (part.type === 'text-delta') {
        text += part.text;
      }
    }
    expect(text).toBe('Hi');
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(request?.body).toMatchObject({
      model: 'qwen3:14b',
      options: {
        num_ctx: 16_384,
        num_predict: 321,
        seed: 7,
        stop: ['END'],
        temperature: 0.2,
        top_k: 40,
        top_p: 0.9,
      },
      stream: true,
      think: true,
      tools: [expect.objectContaining({ function: expect.objectContaining({ name: 'read' }) })],
    });
  });

  it('every call carries the same window, so a title or summary never resizes the model', async () => {
    const requests = interceptOllama();
    const model = createProvider('ollama', undefined, 'gemma3:4b', undefined, {
      contextWindow: 32_768,
      thinking: false,
    });
    await generateText({
      maxRetries: 0,
      model: model as Parameters<typeof generateText>[0]['model'],
      prompt: 'Title this',
    });
    expect(requests[0]?.body).toMatchObject({
      options: { num_ctx: 32_768 },
      stream: false,
      think: false,
    });
  });

  it('reaches the configured server and sends a bearer token only when one is configured', async () => {
    const previousKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-real-secret-do-not-leak';
    try {
      const requests = interceptOllama();
      for (const providerOptions of [
        { ollama: { baseUrl: 'remote.box:11434' } },
        { ollama: { apiToken: 'tok_abc', baseUrl: 'https://gpu.lan:11434/v1/' } },
      ]) {
        await generateText({
          maxRetries: 0,
          model: createProvider(
            'ollama',
            undefined,
            'qwen3',
            { providerOptions },
            FACTS
          ) as Parameters<typeof generateText>[0]['model'],
          prompt: 'hi',
        });
      }
      expect(requests.map((request) => request.url)).toEqual([
        'http://remote.box:11434/api/chat',
        'https://gpu.lan:11434/api/chat',
      ]);
      // No environment key ever reaches a remote Ollama host.
      expect(requests[0]?.headers.get('authorization')).toBeNull();
      expect(requests[1]?.headers.get('authorization')).toBe('Bearer tok_abc');
    } finally {
      if (previousKey === undefined) {
        Reflect.deleteProperty(process.env, 'OPENAI_API_KEY');
      } else {
        process.env['OPENAI_API_KEY'] = previousKey;
      }
    }
  });

  it('replays a tool call and its result as Ollama chat messages, and reads its usage', async () => {
    const requests = interceptOllama();
    const result = await generateText({
      maxRetries: 0,
      messages: [
        { content: 'Find foo', role: 'user' },
        {
          content: [
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
      ],
      model: createProvider('ollama', undefined, 'qwen3', undefined, FACTS) as Parameters<
        typeof generateText
      >[0]['model'],
    });
    expect(result.text).toBe('Hi');
    expect(result.usage.inputTokens).toBe(7);
    expect(result.usage.outputTokens).toBe(2);
    expect(requests[0]?.body['messages']).toEqual([
      { content: 'Find foo', role: 'user' },
      {
        content: '',
        role: 'assistant',
        tool_calls: [
          {
            function: { arguments: { query: 'foo' }, name: 'grepSearch' },
            id: 'call_1',
            type: 'function',
          },
        ],
      },
      { content: 'no matches', role: 'tool', tool_call_id: 'call_1' },
    ]);
  });

  it('refuses an Ollama model without the window its run was admitted with', () => {
    expect(() => createProvider('ollama', undefined, 'qwen3')).toThrow(
      'An Ollama model needs the context window its run was admitted with.'
    );
  });

  it('omits each sampling setting the call did not make', () => {
    expect(ollamaChatOptions({}, { contextWindow: 8192, thinking: false })).toEqual({
      options: { num_ctx: 8192 },
      think: false,
    });
  });
});
