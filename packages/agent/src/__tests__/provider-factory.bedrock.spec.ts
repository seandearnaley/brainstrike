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
import {
  createMastraAgentError,
  isMastraAgentError,
  MastraAgentError,
} from '../mastra-boundary/mastra-agent-error';
import { resolveAwsCredentialChain } from '../providers/aws-credential-chain';
import {
  CONFLICTING_AWS_CREDENTIALS_DETAIL,
  MISSING_AWS_CREDENTIALS_DETAIL,
  MISSING_AWS_REGION_DETAIL,
  type ProviderAuthInput,
  providerFetchOptions,
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
  readonly body: string | undefined;
  readonly url: string;
}

/** A CredentialsProviderError look-alike; the SDK's class is not importable. */
function credentialsProviderError(message: string): Error {
  const error = new Error(message);
  error.name = 'CredentialsProviderError';
  return error;
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
      // Read from `init` rather than the Request: the body stream can only be
      // consumed once, and the SDK still needs it.
      body: typeof init?.body === 'string' ? init.body : undefined,
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

  it('streams with a PROFILE-CHAIN credential provider, signing SigV4 (mocked fetch)', async () => {
    // BST-1353 acceptance: the same mocked-wire path as the bearer test
    // above, but authenticated through the credentialProvider seam. The
    // resolver stands in for `createAwsCredentialChain` — this test owns the
    // factory wiring, while aws-credential-chain.spec.ts owns the real SDK.
    const captured = stubBedrockStreamFetch();
    const credentialProvider = vi.fn(async () => ({
      accessKeyId: 'AKIAPROFILECHAIN',
      secretAccessKey: 'chain-secret',
      sessionToken: 'chain-session',
    }));
    const model = createProvider(
      'bedrock',
      { credentialProvider, kind: 'aws', region: 'us-east-1' },
      'anthropic.claude-sonnet-5'
    ) as {
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

    // Resolution is LAZY — the chain is consulted when the request is signed,
    // which is exactly why chain failures surface mid-run.
    expect(credentialProvider).toHaveBeenCalled();

    const request = captured[0];
    if (!request) {
      throw new Error('stubbed fetch was not invoked');
    }
    expect(request.url).toContain('bedrock-runtime.us-east-1.amazonaws.com');
    expect(request.url).toContain('/converse-stream');
    // SigV4, NOT a bearer: the header must carry the resolved access key id
    // and never the string "Bearer".
    expect(request.authorization).toContain('AWS4-HMAC-SHA256');
    expect(request.authorization).toContain('AKIAPROFILECHAIN');
    expect(request.authorization).not.toContain('Bearer');

    const textDeltas = parts.filter((part) => part['type'] === 'text-delta');
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(parts.at(-1)?.['type']).toBe('finish');
  });

  it('DOCUMENTS the SDK behavior that forces pre-resolution: a rejecting credentialProvider loses its type', async () => {
    // PR #2525 review, finding 2. @ai-sdk/amazon-bedrock wraps the
    // credentialProvider call in try/catch and re-throws a PLAIN Error
    // ("AWS credential provider failed: <message>. Please ensure …"). The
    // message survives, which is exactly why this looked fine at first — but
    // the class, the `mastra_agent_runtime_init_failed` code, and the
    // awsAuthMode context are all destroyed, so the run-error envelope never
    // sees a typed error. This test pins that upstream behavior: if a future
    // SDK stops swallowing, this failing test is the signal to simplify
    // `resolveAwsCredentialChain` away.
    stubBedrockStreamFetch();
    const model = createProvider(
      'bedrock',
      {
        credentialProvider: () =>
          Promise.reject(
            createMastraAgentError('mastra_agent_runtime_init_failed', {
              detail: 'AWS SSO session expired',
            })
          ),
        kind: 'aws',
        region: 'us-east-1',
      },
      'anthropic.claude-sonnet-5'
    ) as { doStream: (options: unknown) => Promise<unknown> };

    const thrown = await model
      .doStream({ prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }] })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(thrown).toBeInstanceOf(Error);
    expect(isMastraAgentError(thrown)).toBe(false);
  });

  it('PRE-RESOLUTION keeps the typed error intact through the REAL SDK path', async () => {
    // The fix for finding 2: resolve the chain BEFORE the provider is handed
    // to the SDK, so the typed error is thrown outside the SDK's catch and
    // reaches the run-error envelope with its code and context.
    stubBedrockStreamFetch();

    const thrown = await resolveAwsCredentialChain('acme-dev', () =>
      Promise.reject(credentialsProviderError('Could not load credentials from any providers'))
    ).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(isMastraAgentError(thrown)).toBe(true);
    const typed = thrown as MastraAgentError;
    expect(typed.code).toBe('mastra_agent_runtime_init_failed');
    expect(typed.context).toMatchObject({ awsAuthMode: 'profile_chain' });
    expect(typed.message).toContain('acme-dev');
  });

  it('a PRE-RESOLVED chain still signs SigV4 and never re-resolves per signature', async () => {
    const captured = stubBedrockStreamFetch();
    const resolve = vi.fn(() =>
      Promise.resolve({ accessKeyId: 'AKIAPRERESOLVED', secretAccessKey: 'sec' })
    );
    const credentialProvider = await resolveAwsCredentialChain('acme-dev', resolve);

    const model = createProvider(
      'bedrock',
      { credentialProvider, kind: 'aws', region: 'us-east-1' },
      'anthropic.claude-sonnet-5'
    ) as {
      doStream: (options: unknown) => Promise<{ stream: ReadableStream<Record<string, unknown>> }>;
    };
    const { stream } = await model.doStream({
      prompt: [{ content: [{ text: 'hi', type: 'text' }], role: 'user' }],
    });
    const reader = stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }

    // Resolved exactly once, at construction — the signature replays it.
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(captured[0]?.authorization).toContain('AKIAPRERESOLVED');
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

  it('SECURITY: rejects regions that are not AWS region format (hostname injection)', () => {
    // The region is interpolated into the request hostname
    // (bedrock-runtime.<region>.amazonaws.com); a hostile region would ship
    // the bearer + prompts to an attacker host. The typed error text stays
    // STATIC — the hostile value is never echoed.
    for (const region of [
      'evil.example.com/',
      'us-east-1.evil.example.com',
      'us-east-1/',
      'us-east-1#x',
      ' us-east-1',
      'us east 1',
      'US-EAST-1',
    ]) {
      let thrown: unknown;
      try {
        createProvider(
          'bedrock',
          { apiKey: 'bearer', kind: 'aws', region },
          'anthropic.claude-sonnet-5'
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(MastraAgentError);
      expect((thrown as MastraAgentError).code).toBe('mastra_agent_runtime_init_failed');
      expect((thrown as MastraAgentError).message).toContain('region');
      expect((thrown as MastraAgentError).message).not.toContain('evil.example.com');
    }
  });

  it('rejects a region-only aws input typed — no ambient SDK credential fallback', () => {
    // Neither a bearer nor a chain: without one the AI SDK would fall back to
    // ambient AWS env credentials, signing with an identity the user never
    // chose. Credential-chain auth is opt-in and EXPLICIT (BST-1353).
    expectTypedInitFailure(
      () =>
        createProvider(
          'bedrock',
          { kind: 'aws', region: 'us-east-1' },
          'anthropic.claude-sonnet-5'
        ),
      MISSING_AWS_CREDENTIALS_DETAIL
    );
  });

  it('rejects BOTH a bearer and a chain provider — auth ambiguity is never resolved here', () => {
    expectTypedInitFailure(
      () =>
        createProvider(
          'bedrock',
          {
            apiKey: 'bearer',
            credentialProvider: async () => ({ accessKeyId: 'AKIA', secretAccessKey: 'sec' }),
            kind: 'aws',
            region: 'us-east-1',
          },
          'anthropic.claude-sonnet-5'
        ),
      CONFLICTING_AWS_CREDENTIALS_DETAIL
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

  it('providerFetchOptions projects the aws bearer ONLY for aws-authType providers', () => {
    // Finding 9 (PR #2522 review): bedrock builds its SDK settings through
    // the same providerFetchOptions seam as every other case, so a future
    // fetch-carrying kind composes; a non-aws provider receiving an aws
    // input still fails typed (never a silent bearer reuse).
    expect(providerFetchOptions(AWS_AUTH, 'bedrock')).toEqual({
      apiKey: 'test-bedrock-bearer',
    });
    let thrown: unknown;
    try {
      providerFetchOptions(AWS_AUTH, 'openai');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MastraAgentError);
    expect((thrown as MastraAgentError).message).toContain('aws');
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

/**
 * BST-1353 x BST-1354 COMPOSITION (PR #2525 rebase onto #2524).
 *
 * Both tickets edited the SAME `bedrock` factory case independently: #2524
 * wraps the model via `wrapModelWithDeclaredPromptCaching` (capability lookup
 * on the UNPREFIXED catalog id, SDK model built from the ROUTED id), while
 * BST-1353 swapped the bearer-only guard for `assertExactlyOneAwsCredential`
 * and spreads `credentialProvider` into `createAmazonBedrock`.
 *
 * git auto-merged them with NO textual conflict, which is the dangerous
 * shape: nothing about a clean merge proves the result is semantically right.
 * Every test below FAILS if either half is dropped.
 */
describe('bedrock case composes prompt caching (BST-1354) with chain auth (BST-1353)', () => {
  // A REAL catalog id that declares BOTH promptCaching 'bedrock' and
  // bedrockReasoning 'adaptive'. Using an uncatalogued id would make these
  // tests pass vacuously — the wrapper warns and returns the model unwrapped,
  // which is exactly what the first draft of this block did.
  const CLAUDE_MODEL = 'anthropic.claude-sonnet-5';

  function cachePointCount(body: string | undefined): number {
    // The Converse body carries `cachePoint` blocks inline; counting them on
    // the SERIALIZED request proves the wrapper survived into the wire, not
    // merely that some object was returned.
    return body === undefined ? 0 : (body.match(/"cachePoint"/g) ?? []).length;
  }

  async function streamOnce(auth: ProviderAuthInput, modelId: string) {
    const captured = stubBedrockStreamFetch();
    const model = createProvider('bedrock', auth, modelId) as {
      doStream: (options: unknown) => Promise<{ stream: ReadableStream<Record<string, unknown>> }>;
    };
    const { stream } = await model.doStream({
      prompt: [
        { content: [{ text: 'You are helpful.', type: 'text' }], role: 'system' },
        { content: [{ text: 'hi', type: 'text' }], role: 'user' },
      ],
    });
    const reader = stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) {
        break;
      }
    }
    return captured;
  }

  it('BEARER auth: a Claude model still receives the prompt-caching wrapper', async () => {
    const captured = await streamOnce(
      { apiKey: 'test-bedrock-bearer', kind: 'aws', region: 'us-east-1' },
      CLAUDE_MODEL
    );

    expect(captured[0]?.authorization).toBe('Bearer test-bedrock-bearer');
    // Loses #2524 => 0 cachePoints.
    expect(cachePointCount(captured[0]?.body)).toBeGreaterThan(0);
  });

  it('PROFILE_CHAIN auth: a Claude model receives the SAME wrapper', async () => {
    const captured = await streamOnce(
      {
        credentialProvider: () =>
          Promise.resolve({ accessKeyId: 'AKIACHAIN', secretAccessKey: 'sec' }),
        kind: 'aws',
        region: 'us-east-1',
      },
      CLAUDE_MODEL
    );

    // Loses BST-1353 => the chain never reaches the SDK and this is a Bearer
    // (or a throw); loses #2524 => 0 cachePoints. Both halves are required.
    expect(captured[0]?.authorization).toContain('AWS4-HMAC-SHA256');
    expect(captured[0]?.authorization).toContain('AKIACHAIN');
    expect(cachePointCount(captured[0]?.body)).toBeGreaterThan(0);
  });

  it('a ROUTED (pre-prefixed) id under chain auth still resolves caching', async () => {
    // The catalog lookup strips the cross-region prefix
    // (`findModelCapabilities`), so a routed id must not silently ship
    // uncached. The SDK model is still built from the routed id.
    const captured = await streamOnce(
      {
        credentialProvider: () =>
          Promise.resolve({ accessKeyId: 'AKIACHAIN', secretAccessKey: 'sec' }),
        kind: 'aws',
        region: 'us-east-1',
      },
      `us.${CLAUDE_MODEL}`
    );

    expect(captured[0]?.url).toContain(encodeURIComponent(`us.${CLAUDE_MODEL}`));
    expect(captured[0]?.url).not.toContain(encodeURIComponent(`us.us.${CLAUDE_MODEL}`));
    expect(cachePointCount(captured[0]?.body)).toBeGreaterThan(0);
  });

  it('the XOR guard still fires for BOTH invalid shapes, wrapper or not', () => {
    // Loses BST-1353 => neither throws (the old guard only checked apiKey, so
    // "both" would pass and silently prefer the bearer).
    expectTypedInitFailure(
      () => createProvider('bedrock', { kind: 'aws', region: 'us-east-1' }, CLAUDE_MODEL),
      MISSING_AWS_CREDENTIALS_DETAIL
    );
    expectTypedInitFailure(
      () =>
        createProvider(
          'bedrock',
          {
            apiKey: 'bearer',
            credentialProvider: () =>
              Promise.resolve({ accessKeyId: 'AKIA', secretAccessKey: 'sec' }),
            kind: 'aws',
            region: 'us-east-1',
          },
          CLAUDE_MODEL
        ),
      CONFLICTING_AWS_CREDENTIALS_DETAIL
    );
  });
});
