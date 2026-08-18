/**
 * Amazon Bedrock factory case (BST-1350 phase 1): `createProvider('bedrock')`
 * consumes the `aws` ProviderAuthInput kind — bearer key + region — through
 * `createAmazonBedrock`, with the catalog's UNPREFIXED model id resolved to a
 * cross-region inference profile per request (resolveBedrockModelId).
 *
 * Region discipline: a missing region is a typed init failure with actionable
 * text — never a silent `us-east-1` default. Auth kinds the case cannot use
 * (`api_key` without a region, `custom_fetch`, absent auth) fail typed too.
 */
import { EventStreamCodec } from '@smithy/eventstream-codec';
import { fromUtf8, toUtf8 } from '@smithy/util-utf8';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MastraAgentError } from '../mastra/mastra-agent-error';
import {
  MISSING_AWS_REGION_DETAIL,
  type ProviderAuthInput,
} from '../providers/provider-auth-input';
import {
  createEmbeddingProvider,
  createLanguageModelProvider,
  createProvider,
} from '../providers/provider-factory';

const AWS_AUTH: ProviderAuthInput = {
  apiKey: 'test-bedrock-bearer',
  kind: 'aws',
  region: 'us-east-1',
};

interface CapturedRequest {
  readonly authorization: string | null;
  readonly url: string;
}

/**
 * Encode Converse-stream frames the way the service does: the event NAME
 * travels in the `:event-type` header and the frame body is the inner
 * payload — the SDK's decoder re-nests them as `{ [eventType]: payload }`.
 */
function encodeBedrockEventStream(
  events: readonly (readonly [eventType: string, payload: Record<string, unknown>])[]
): Uint8Array {
  const codec = new EventStreamCodec(toUtf8, fromUtf8);
  const frames = events.map(([eventType, payload]) =>
    codec.encode({
      body: fromUtf8(JSON.stringify(payload)),
      headers: {
        ':event-type': { type: 'string', value: eventType },
        ':message-type': { type: 'string', value: 'event' },
      },
    })
  );
  const total = frames.reduce((length, frame) => length + frame.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const frame of frames) {
    merged.set(frame, offset);
    offset += frame.length;
  }
  return merged;
}

function stubBedrockStreamFetch(): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  const stubbedFetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input as RequestInfo, init);
    captured.push({
      authorization: request.headers.get('authorization'),
      url: request.url,
    });
    const body = encodeBedrockEventStream([
      ['messageStart', { role: 'assistant' }],
      ['contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'Hello from Bedrock' } }],
      ['contentBlockStop', { contentBlockIndex: 0 }],
      ['messageStop', { stopReason: 'end_turn' }],
      ['metadata', { usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } }],
    ]);
    return Promise.resolve(
      new Response(new Blob([body as unknown as BlobPart]).stream(), {
        headers: { 'content-type': 'application/vnd.amazon.eventstream' },
        status: 200,
      })
    );
  };
  vi.stubGlobal('fetch', stubbedFetch);
  return captured;
}

function expectTypedInitFailure(run: () => unknown, messagePart: string): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(MastraAgentError);
  expect((thrown as MastraAgentError).code).toBe('mastra_agent_runtime_init_failed');
  expect((thrown as MastraAgentError).message).toContain(messagePart);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createProvider bedrock case (BST-1350)', () => {
  it('builds a language model on the region-resolved inference-profile id', () => {
    const model = createProvider('bedrock', AWS_AUTH, 'anthropic.claude-sonnet-5') as {
      modelId: string;
      provider: string;
    };
    // us-east-1 + claude ⇒ the us. cross-region profile, never double-prefixed.
    expect(model.modelId).toBe('us.anthropic.claude-sonnet-5');
    expect(
      (createProvider('bedrock', AWS_AUTH, 'us.anthropic.claude-sonnet-5') as { modelId: string })
        .modelId
    ).toBe('us.anthropic.claude-sonnet-5');
  });

  it('streams through the regional Bedrock endpoint with the bearer key (mocked fetch)', async () => {
    const captured = stubBedrockStreamFetch();
    const model = createProvider('bedrock', AWS_AUTH, 'anthropic.claude-sonnet-5') as {
      doStream: (options: unknown) => Promise<{ stream: ReadableStream<Record<string, unknown>> }>;
    };

    const { stream } = await model.doStream({
      prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }],
    });
    const parts: Record<string, unknown>[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      parts.push(value);
    }

    expect(captured).toHaveLength(1);
    const request = captured[0];
    if (!request) {
      throw new Error('stubbed fetch was not invoked');
    }
    expect(request.url).toContain('bedrock-runtime.us-east-1.amazonaws.com');
    expect(request.url).toContain(encodeURIComponent('us.anthropic.claude-sonnet-5'));
    expect(request.url).toContain('/converse-stream');
    expect(request.authorization).toBe('Bearer test-bedrock-bearer');

    const textDeltas = parts.filter((part) => part['type'] === 'text-delta');
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(parts.at(-1)?.['type']).toBe('finish');
  });

  it('rejects a missing region with actionable typed text (never a default region)', () => {
    expectTypedInitFailure(
      () => createProvider('bedrock', { kind: 'aws', region: '' }, 'anthropic.claude-sonnet-5'),
      MISSING_AWS_REGION_DETAIL
    );
    // The one canonical guidance string carries the Settings pointer.
    expect(MISSING_AWS_REGION_DETAIL).toContain('Configure an AWS region for Bedrock in Settings');
  });

  it('rejects absent auth input with the same actionable region guidance', () => {
    expectTypedInitFailure(
      () => createProvider('bedrock', undefined, 'anthropic.claude-sonnet-5'),
      'Configure an AWS region for Bedrock in Settings'
    );
  });

  it('rejects an api_key auth input (a bearer key alone carries no region)', () => {
    expectTypedInitFailure(
      () =>
        createProvider(
          'bedrock',
          { apiKey: 'bare-key', kind: 'api_key' },
          'anthropic.claude-sonnet-5'
        ),
      'Configure an AWS region for Bedrock in Settings'
    );
  });

  it('rejects custom_fetch auth input typed (no consumer on the bedrock case)', () => {
    expectTypedInitFailure(
      () =>
        createProvider(
          'bedrock',
          { apiKey: 'dummy', fetch: globalThis.fetch, kind: 'custom_fetch' },
          'anthropic.claude-sonnet-5'
        ),
      'custom_fetch'
    );
  });

  it('is excluded from persistent memory (PERSISTENT_MEMORY_LANGUAGE_MODEL_PROVIDERS)', () => {
    let thrown: unknown;
    try {
      createLanguageModelProvider('bedrock', 'some-key', 'anthropic.claude-sonnet-5');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MastraAgentError);
    expect((thrown as MastraAgentError).code).toBe('mastra_agent_unsupported_provider');
  });

  it('throws explicitly for embeddings (no Bedrock embedder in phase 1)', () => {
    let thrown: unknown;
    try {
      createEmbeddingProvider('bedrock', 'some-key', 'amazon.titan-embed-text-v2:0');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MastraAgentError);
    expect((thrown as MastraAgentError).code).toBe('mastra_agent_unsupported_provider');
  });
});
