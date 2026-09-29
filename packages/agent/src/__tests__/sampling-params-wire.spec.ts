/**
 * BST-1699: per-adapter wire proof that a DEFAULT request carries no sampling
 * parameters.
 *
 * Three vendors have converged on rejecting or deprecating non-default
 * sampling params on their newest models:
 *
 * - OpenAI `gpt-6-astra`: no custom `temperature` / `top_p`.
 * - Google changelog 2026-07-21: `temperature` / `top_p` / `top_k` deprecated
 *   for the latest Gemini models.
 * - Anthropic Opus 4.7+: non-default `temperature` / `top_p` / `top_k` return
 *   HTTP 400. AWS's own Claude Fable 5.1 Bedrock model card repeats it
 *   verbatim ("temperature must be 1.0 or unset; top_p must be 0.99 or unset;
 *   temperature and top_p cannot be specified together; top_k is not
 *   supported").
 *
 * Brainstrike never sets these on a default request — `buildModelSettings`
 * (app-shell) emits only `maxOutputTokens`, and `buildModelSettingsOption`
 * (runtime-assembly/stream-options.ts) only ever ADDS a `maxOutputTokens`
 * backstop. The remaining risk is the ADAPTER: an AI SDK provider package
 * that injects a sampling default of its own would put us on the wrong side
 * of these rules without a single line changing in this repo.
 *
 * So this suite asserts on the SERIALIZED REQUEST BODY of the real installed
 * adapter, built through the production `createProvider` factory, with a
 * keyless HTTP fixture (not a live smoke) — the same harness shape as
 * `anthropic-opus-5-wire.spec.ts` and `bedrock-prompt-caching-wire.spec.ts`.
 *
 * The scan is RECURSIVE and covers both casings on purpose: the four adapters
 * nest these fields differently (OpenAI/OpenRouter top-level `temperature` /
 * `top_p`, Google under `generationConfig`, Bedrock under `inferenceConfig` /
 * `additionalModelRequestFields`), so a top-level-only assertion would go dark
 * on three of the five.
 *
 * The invariant this suite pins is recorded in docs/agents/assistant-providers.md
 * ("Sampling params are never sent on a default request").
 */
import type { LanguageModelV2Prompt } from '@ai-sdk/provider';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider } from '../providers/provider-factory';

/** Both the camelCase (AI SDK call-option) and wire spellings. */
const SAMPLING_KEYS = new Set(['temperature', 'topP', 'top_p', 'topK', 'top_k']);

/** An Anthropic model whose adapter entry declares no sampling-param support. */
const SAMPLING_REJECTING_ANTHROPIC_MODEL = 'claude-opus-5';

const DEFAULT_PROMPT: LanguageModelV2Prompt = [
  { content: [{ text: 'hi', type: 'text' }], role: 'user' },
];

interface ModelLike {
  doGenerate: (options: unknown) => Promise<unknown>;
}

/**
 * Structural view of the router's stream entry point. `ModelRouterLanguageModel`
 * types its options against Mastra's own bundled copy of `@ai-sdk/provider`,
 * which `exactOptionalPropertyTypes` will not unify with the workspace copy.
 */
interface StreamingModelLike {
  doStream: (options: unknown) => Promise<{ stream: ReadableStream<unknown> }>;
}

/** Every JSON path at which a sampling key appears, at any depth. */
function findSamplingKeyPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findSamplingKeyPaths(entry, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    const child = `${path}.${key}`;
    return SAMPLING_KEYS.has(key) ? [child] : findSamplingKeyPaths(entry, child);
  });
}

/**
 * Decode the request body from EITHER valid Fetch call shape.
 * `fetch(url, init)` and `fetch(new Request(url, init))` are both legal, and an
 * adapter may switch between them across a dependency bump with nothing in this
 * repo changing. Reading only `init.body` would record `null` for the Request
 * shape, the recursive scan would find no sampling keys in `null`, and the suite
 * would go green on exactly the drift it exists to catch. Returns `undefined`
 * when the request carried no body at all, so the caller can decline to record
 * it and the `bodies.length` assertion stays a real check.
 */
async function readJsonBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<unknown> {
  if (typeof init?.body === 'string') {
    return JSON.parse(init.body);
  }
  const raw = await new Request(input instanceof Request ? input : String(input), init).text();
  return raw === '' ? undefined : JSON.parse(raw);
}

/** Record a request body, skipping bodyless requests rather than storing `null`. */
async function captureBody(
  bodies: unknown[],
  input: RequestInfo | URL,
  init: RequestInit | undefined
): Promise<void> {
  const body = await readJsonBody(input, init);
  if (body !== undefined) {
    bodies.push(body);
  }
}

/** Capturing fetch for the `custom_fetch` auth seam (openai/anthropic/google). */
function makeCapturingFetch(bodies: unknown[]): typeof globalThis.fetch {
  return async (input, init) => {
    await captureBody(bodies, input, init);
    // Reaching fetch at all is what the assertion needs; a 500 makes the SDK
    // throw AFTER the capture, so no per-adapter success fixture is required.
    return new Response('{}', { status: 500 });
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BST-1699 default request carries no sampling params', () => {
  it.each([
    ['openai', undefined],
    ['anthropic', SAMPLING_REJECTING_ANTHROPIC_MODEL],
    ['google', undefined],
  ] as const)('%s adapter', async (provider, model) => {
    const bodies: unknown[] = [];
    const created = createProvider(
      provider,
      { apiKey: 'fixture-key', fetch: makeCapturingFetch(bodies), kind: 'custom_fetch' },
      model
    ) as unknown as ModelLike;

    await created.doGenerate({ prompt: DEFAULT_PROMPT }).catch(() => {
      // The 500 fixture makes the SDK throw after the body we assert on.
    });

    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.flatMap((body) => findSamplingKeyPaths(body))).toEqual([]);
  });

  it('bedrock adapter', async () => {
    const bodies: unknown[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('bedrock')) {
        return realFetch(input as RequestInfo, init);
      }
      await captureBody(bodies, input, init);
      return new Response(
        JSON.stringify({
          output: { message: { content: [{ text: 'ok' }], role: 'assistant' } },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      );
    });

    const model = createProvider(
      'bedrock',
      { apiKey: 'test-bedrock-key', kind: 'aws', region: 'us-east-1' },
      'anthropic.claude-sonnet-5'
    ) as unknown as ModelLike;
    await model.doGenerate({ prompt: DEFAULT_PROMPT });

    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.flatMap((body) => findSamplingKeyPaths(body))).toEqual([]);
  });

  /**
   * CHARACTERIZATION, not an endorsement (BST-1699). This pins what happens
   * TODAY when a user HAS set a sampling param — the Prompt Workbench is the
   * only surface that can produce one (`buildPromptModelSettings`,
   * packages/app-shell/src/prompt-workbench-shared.ts) — and the selected
   * model rejects it.
   *
   * The installed `@ai-sdk/anthropic` adapter does NOT forward the value and
   * does NOT 400: it DROPS it and reports an `unsupported` entry on
   * `warnings`. Nothing in the Brainstrike stream pipeline reads that array
   * (no reference to it anywhere in packages/agent's stream path,
   * packages/assistant-ui or packages/app-shell), so the user's explicit
   * setting currently vanishes with no user-visible notice — a
   * silent-degradation gap that needs a product decision, NOT a quiet fix
   * inside this audit. Flagged on BST-1699; when it is closed, this test
   * becomes the "before" half of the fix.
   */
  it('drops an explicitly-set sampling param and reports it only on warnings', async () => {
    const bodies: unknown[] = [];
    const model = createProvider(
      'anthropic',
      {
        apiKey: 'fixture-key',
        fetch: (async (input: RequestInfo | URL, init: RequestInit | undefined) => {
          await captureBody(bodies, input, init);
          return Response.json({
            content: [{ text: 'ok', type: 'text' }],
            id: 'msg_fixture',
            model: 'claude-opus-5',
            role: 'assistant',
            stop_reason: 'end_turn',
            stop_sequence: null,
            type: 'message',
            usage: { input_tokens: 1, output_tokens: 1 },
          });
        }) as unknown as typeof globalThis.fetch,
        kind: 'custom_fetch',
      },
      SAMPLING_REJECTING_ANTHROPIC_MODEL
    ) as unknown as {
      doGenerate: (options: unknown) => Promise<{
        warnings?: readonly { feature?: string; type: string }[];
      }>;
    };

    const result = await model.doGenerate({
      prompt: DEFAULT_PROMPT,
      temperature: 0.7,
      topK: 40,
      topP: 0.9,
    });

    // Not on the wire, so no 400 — and no notice either.
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.flatMap((body) => findSamplingKeyPaths(body))).toEqual([]);
    expect(
      (result.warnings ?? [])
        .filter((warning) => warning.type === 'unsupported')
        .map((warning) => warning.feature)
        .sort()
    ).toEqual(['temperature', 'topK', 'topP']);
  });

  it('openrouter pass-through', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      await captureBody(bodies, input, init);
      const sse = [
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}',
        '',
        'data: {"id":"cmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n');
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' }, status: 200 });
    });

    const config = createProvider('openrouter', { apiKey: 'test-key', kind: 'api_key' });
    expect(config).toBeInstanceOf(ModelRouterLanguageModel);
    const { stream } = await (config as unknown as StreamingModelLike).doStream({
      prompt: DEFAULT_PROMPT,
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done) {
      // drain so the fake SSE response is fully consumed
    }

    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.flatMap((body) => findSamplingKeyPaths(body))).toEqual([]);
  });
});
