import { getModelCapabilities } from '@ai-sdk/anthropic/internal';
import {
  BEDROCK_BUDGET_TOKENS_BY_EFFORT,
  BEDROCK_REASONING_EFFORTS,
  listProviderLlmModels,
} from '@brainstrike/assistant-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvider } from '../providers/provider-factory';

/**
 * BST-1354. Two guarantees, both about the SAME risk: the Bedrock reasoning
 * dialect a route accepts is an upstream fact, and getting it wrong is a hard
 * 400 rather than a degraded answer.
 *
 * 1. The registry's declared dialect agrees with the installed
 *    `@ai-sdk/amazon-bedrock`'s own capability table, so an SDK upgrade that
 *    moves a route between dialects fails here instead of in production.
 * 2. Each dialect actually serializes to the request AWS documents.
 */

interface BedrockModelLike {
  doGenerate: (params: unknown) => Promise<unknown>;
}

interface AdditionalModelRequestFields {
  readonly output_config?: { readonly effort?: string };
  readonly reasoningConfig?: { readonly maxReasoningEffort?: string; readonly type?: string };
  readonly thinking?: {
    readonly budget_tokens?: number;
    readonly display?: string;
    readonly type?: string;
  };
}

function converseResponse(): Response {
  return new Response(
    JSON.stringify({
      output: { message: { content: [{ text: 'ok' }], role: 'assistant' } },
      stopReason: 'end_turn',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }),
    { headers: { 'content-type': 'application/json' }, status: 200 }
  );
}

async function captureRequestBody(
  modelId: string,
  reasoningConfig: Record<string, unknown> | undefined
): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
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
    bodies.push(JSON.parse(rawBody) as Record<string, unknown>);
    return converseResponse();
  });

  const model = createProvider(
    'bedrock',
    { apiKey: 'test-key', kind: 'aws', region: 'us-east-1' },
    modelId
  ) as unknown as BedrockModelLike;

  await model.doGenerate({
    prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }],
    ...(reasoningConfig ? { providerOptions: { bedrock: { reasoningConfig } } } : {}),
  });

  const body = bodies[0];
  if (!body) {
    throw new Error('No Bedrock request captured');
  }
  return body;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bedrock reasoning dialect matches the installed provider', () => {
  /**
   * `isKnownModel` is load-bearing, not decoration. The capability table
   * DEFAULTS an unrecognized id to `supportsAdaptiveThinking: true`, so a
   * typo'd or retired registry id would satisfy an adaptive assertion without
   * anyone having verified anything. Asserting known-ness first turns that
   * silent pass into a failure.
   */
  it('pins every Claude-family Bedrock route against the SDK capability table', () => {
    const claudeRoutes = listProviderLlmModels('bedrock').filter(
      (model) => getModelCapabilities(model.id).isKnownModel
    );
    expect(claudeRoutes.length).toBeGreaterThan(0);
    for (const model of claudeRoutes) {
      const { isKnownModel, supportsAdaptiveThinking } = getModelCapabilities(model.id);
      expect(isKnownModel, `bedrock/${model.id} must be a recognized Anthropic route`).toBe(true);
      // REQUIRED, not skipped-when-absent: a Claude row with no declared
      // dialect silently loses reasoning, which is the failure this pin exists
      // to catch.
      expect(
        model.bedrockReasoning,
        `bedrock/${model.id} is a Claude route and must declare a reasoning dialect`
      ).toBeDefined();
      expect(model.bedrockReasoning, `bedrock/${model.id}`).toBe(
        supportsAdaptiveThinking ? 'adaptive' : 'budget-tokens'
      );
    }
  });

  it('never gives a non-Anthropic route a Claude-only dialect', () => {
    for (const model of listProviderLlmModels('bedrock')) {
      if (getModelCapabilities(model.id).isKnownModel) {
        continue;
      }
      expect(
        model.bedrockReasoning === 'adaptive' || model.bedrockReasoning === 'budget-tokens',
        `bedrock/${model.id} is not an Anthropic route and must not claim a Claude dialect`
      ).toBe(false);
    }
  });

  it('offers only efforts the budget table can price', () => {
    expect([...BEDROCK_REASONING_EFFORTS['budget-tokens']].sort()).toEqual(
      Object.keys(BEDROCK_BUDGET_TOKENS_BY_EFFORT).sort()
    );
  });
});

describe('bedrock reasoning wire shapes', () => {
  it('sends adaptive thinking with the effort in output_config for a Claude route', async () => {
    const body = await captureRequestBody('anthropic.claude-sonnet-5', {
      display: 'summarized',
      maxReasoningEffort: 'high',
      type: 'adaptive',
    });
    const fields = body['additionalModelRequestFields'] as AdditionalModelRequestFields;
    // AWS rejects the effort if it rides inside `thinking` — it must be its
    // own `output_config` object.
    expect(fields.thinking).toEqual({ display: 'summarized', type: 'adaptive' });
    expect(fields.output_config).toEqual({ effort: 'high' });
  });

  it('omits reasoning entirely when no config is sent', async () => {
    const body = await captureRequestBody('anthropic.claude-sonnet-5', undefined);
    const fields = body['additionalModelRequestFields'] as AdditionalModelRequestFields | undefined;
    expect(fields?.thinking).toBeUndefined();
    expect(fields?.output_config).toBeUndefined();
  });

  it('honors visibility off by sending display: omitted', async () => {
    const body = await captureRequestBody('anthropic.claude-sonnet-5', {
      display: 'omitted',
      maxReasoningEffort: 'low',
      type: 'adaptive',
    });
    const fields = body['additionalModelRequestFields'] as AdditionalModelRequestFields;
    expect(fields.thinking).toEqual({ display: 'omitted', type: 'adaptive' });
  });

  it('sends a snake_case token budget for the legacy Claude route', async () => {
    const body = await captureRequestBody('anthropic.claude-haiku-4-5-20251001-v1:0', {
      budgetTokens: BEDROCK_BUDGET_TOKENS_BY_EFFORT.high,
      type: 'enabled',
    });
    const fields = body['additionalModelRequestFields'] as AdditionalModelRequestFields;
    expect(fields.thinking).toEqual({ budget_tokens: 16_000, type: 'enabled' });
  });

  it('sends reasoningConfig with maxReasoningEffort for Amazon Nova', async () => {
    const body = await captureRequestBody('amazon.nova-2-lite-v1:0', {
      maxReasoningEffort: 'medium',
      type: 'enabled',
    });
    const fields = body['additionalModelRequestFields'] as AdditionalModelRequestFields;
    // Nova takes neither the Anthropic `thinking` block nor a token budget.
    expect(fields.reasoningConfig).toEqual({ maxReasoningEffort: 'medium', type: 'enabled' });
    expect(fields.thinking).toBeUndefined();
  });
});
