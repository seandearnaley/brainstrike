import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider } from '../providers/provider-factory';

/**
 * Keyless wire proof for BST-1354: drives the REAL `@ai-sdk/amazon-bedrock`
 * serializer through the factory-installed caching wrapper with a stubbed
 * global fetch, asserting the exact Converse request body a SECOND turn sends
 * and that a response reporting cache usage flows back out.
 *
 * The second turn is the whole point — the first turn can only write a cache;
 * the saving shows up when the next step reads it back.
 *
 * UNIT lane, deliberately. The `.integration` suffix marks ENV-SENSITIVE tests
 * (real PGlite, native binaries, wall-clock timing) and nothing here is: the
 * only I/O is a stubbed `fetch`, and the model comes straight from
 * `createProvider`. It does NOT run the Mastra loop — that is what makes it
 * differ from its Anthropic counterpart, which imports `streamMastraAgent` and
 * stays in the integration lane. Keeping this one in the unit lane puts the
 * central cost proof in the required Unit check.
 */

interface CapturedRequest {
  readonly authorization: string | null;
  readonly body: Record<string, unknown>;
  readonly url: string;
}

interface ConverseBlock {
  readonly cachePoint?: { readonly type: string };
  readonly text?: string;
}

interface BedrockModelLike {
  doGenerate: (params: unknown) => Promise<{
    usage?: {
      inputTokens?: { cacheRead?: number; cacheWrite?: number; noCache?: number; total?: number };
    };
  }>;
}

function converseResponse(): Response {
  return new Response(
    JSON.stringify({
      output: { message: { content: [{ text: 'cached hello' }], role: 'assistant' } },
      stopReason: 'end_turn',
      usage: {
        cacheReadInputTokens: 40,
        cacheWriteInputTokens: 60,
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 110,
      },
    }),
    { headers: { 'content-type': 'application/json' }, status: 200 }
  );
}

/** A second turn: system prompt, first exchange, and the new user message. */
const SECOND_TURN_PROMPT = [
  { content: 'stable system instructions', role: 'system' },
  { content: [{ text: 'first question', type: 'text' }], role: 'user' },
  { content: [{ text: 'first answer', type: 'text' }], role: 'assistant' },
  { content: [{ text: 'second question', type: 'text' }], role: 'user' },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bedrock prompt caching wire contract', () => {
  it('sends cache points on the second turn and surfaces cache-read usage', async () => {
    const captured: CapturedRequest[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('bedrock')) {
        return realFetch(input as RequestInfo, init);
      }
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      const rawBody =
        typeof init?.body === 'string'
          ? init.body
          : await new Request(input as RequestInfo, init).text();
      captured.push({
        authorization: headers.get('authorization'),
        body: JSON.parse(rawBody) as Record<string, unknown>,
        url,
      });
      return converseResponse();
    });

    const model = createProvider(
      'bedrock',
      { apiKey: 'test-bedrock-key', kind: 'aws', region: 'us-east-1' },
      'anthropic.claude-sonnet-5'
    ) as unknown as BedrockModelLike;

    const result = await model.doGenerate({ prompt: SECOND_TURN_PROMPT });

    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (!request) {
      throw new Error('No Bedrock request captured');
    }
    expect(request.url).toContain('/converse');
    expect(request.authorization).toBe('Bearer test-bedrock-key');

    // System: the stable block, followed by its cache checkpoint.
    const system = request.body['system'] as ConverseBlock[];
    expect(system[0]?.text).toBe('stable system instructions');
    expect(system[1]?.cachePoint).toEqual({ type: 'default' });

    // Messages: the LAST TWO carry checkpoints, so the next step reads this
    // turn's prefix instead of only rewriting it. The first user message —
    // already below the previous checkpoint — carries none.
    const messages = request.body['messages'] as { content: ConverseBlock[] }[];
    expect(messages).toHaveLength(3);
    expect(messages[0]?.content.some((block) => block.cachePoint)).toBe(false);
    expect(messages[1]?.content.at(-1)?.cachePoint).toEqual({ type: 'default' });
    expect(messages[2]?.content.at(-1)?.cachePoint).toEqual({ type: 'default' });

    // AWS allows four checkpoints per request; this is exactly three here
    // (one system block + two message tails) and can never exceed four.
    const totalCachePoints =
      system.filter((block) => block.cachePoint).length +
      messages.reduce(
        (sum, message) => sum + message.content.filter((block) => block.cachePoint).length,
        0
      );
    expect(totalCachePoints).toBe(3);

    // The response's cache accounting survives the wrapper: this is the number
    // the usage meter renders as a cache read.
    expect(result.usage?.inputTokens).toEqual({
      cacheRead: 40,
      cacheWrite: 60,
      noCache: 7,
      total: 107,
    });
  });

  it('sends no cache points for a Bedrock route with no declared dialect', async () => {
    const captured: CapturedRequest[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('bedrock')) {
        return realFetch(input as RequestInfo, init);
      }
      const rawBody =
        typeof init?.body === 'string'
          ? init.body
          : await new Request(input as RequestInfo, init).text();
      captured.push({
        authorization: null,
        body: JSON.parse(rawBody) as Record<string, unknown>,
        url,
      });
      return converseResponse();
    });

    const model = createProvider(
      'bedrock',
      { apiKey: 'test-bedrock-key', kind: 'aws', region: 'us-east-1' },
      'deepseek.v3.2'
    ) as unknown as BedrockModelLike;

    await model.doGenerate({ prompt: SECOND_TURN_PROMPT });

    const request = captured[0];
    if (!request) {
      throw new Error('No Bedrock request captured');
    }
    const system = request.body['system'] as ConverseBlock[];
    const messages = request.body['messages'] as { content: ConverseBlock[] }[];
    expect(system.some((block) => block.cachePoint)).toBe(false);
    expect(messages.some((message) => message.content.some((block) => block.cachePoint))).toBe(
      false
    );
  });
});
