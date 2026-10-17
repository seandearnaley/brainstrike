// @vitest-environment node
import {
  BoundaryFailureError,
  BoundaryFailureSchema,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract/boundary-failure';
import { NativeCanonicalInference } from '@brainstrike/canonical-ingestion';
import { clearHostedProviderApiKeyCache } from '@brainstrike/embeddings/provider-core';
import { IndexerError } from '@brainstrike/indexer';
import { addLogListener, type LogRecord } from '@brainstrike/logging';
import { Schema } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanonicalUtilityChannel } from '../canonical-utility-channel';
import { canonicalFault, decodeCanonicalFrame } from '../canonical-utility-protocol';
import { generateHostedEmbeddings, HostedEmbeddingError } from '../hosted-embeddings';
import { nativeIndexBoundaryFailure } from '../native-index-boundary-failure';
import { nativeIndexStateError } from '../native-index-lifecycle-errors';
import { readNativeIndexSettings } from '../native-index-settings';

vi.mock('../secrets', () => ({
  getSecretsService: () => ({ getKey: async () => 'fake-boundary-test' }),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  clearHostedProviderApiKeyCache();
});
// Recorded c137 missing-key failure: generate and join each cross the utility
// channel, becoming distinct errors before CanonicalIngestionHost aggregates them.
async function roundTrip(error: unknown): Promise<unknown> {
  const channel = new CanonicalUtilityChannel(() => {});
  const pending = channel.call('owner', 'join-inference', {}, Schema.Unknown);
  channel.receive(
    decodeCanonicalFrame({
      channel: 'canonical-ingestion-v1',
      error: canonicalFault(error),
      id: 1,
      kind: 'result',
      ok: false,
      owner: 'owner',
    })
  );
  return await pending.catch((failure: unknown) => failure);
}
const missing = () =>
  new HostedEmbeddingError('missing-key', 'No API key configured for the embedding provider.', {
    cause: new Error('private fixture diagnostic'),
  });
describe('native missing-key outcome (BST-2008)', () => {
  it('reports the recorded generate failure once with its safe refusal through the channel', async () => {
    const original = missing();
    const profile = {
      dimensions: 1024,
      distance: 'cosine',
      modelId: 'embed-english-v3.0',
      provider: 'cohere',
    } as const;
    const inference = new NativeCanonicalInference({
      hostedEmbeddings: async () => {
        throw original;
      },
      resolver: {
        resolve: async () => ({
          modelKey: 'cohere::embed-english-v3.0',
          profile,
          workerPlan: null,
        }),
      },
      scope: { embeddingSetId: 'recorded-collection', kind: 'collection' },
      transport: { documentEmbeddings: vi.fn() },
    });
    const generationFailure = await inference
      .generate({
        chunks: [{ chunkId: 'first', content: 'notarize release' }],
        profile,
        requestId: 'recorded-operation',
      })
      .catch((error: unknown) => error);
    expect(generationFailure).toBe(original);
    // generate delivered the failure; join only proves physical settlement.
    await expect(inference.join('recorded-operation')).resolves.toBeUndefined();
    const generate = await roundTrip(generationFailure);
    expect(generate).toBeInstanceOf(BoundaryFailureError);
    const log = vi.fn();
    const failure = nativeIndexBoundaryFailure(generate, log);
    expect(
      Schema.decodeUnknownSync(BoundaryFailureSchema, { errors: 'all', onExcessProperty: 'error' })(
        failure
      )
    ).toMatchObject({
      category: 'configuration',
      code: 'embedding.missing-key',
      kind: 'refusal',
      remedy: expect.any(String),
    });
    expect(JSON.stringify(failure)).not.toContain('private fixture diagnostic');
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cause: generate })
    );
    expect(generate).toMatchObject({ cause: { message: 'private fixture diagnostic' } });
  });
  it.each([
    new Error('cleanup failed'),
    new Error('No API key configured for the embedding provider.'),
    new HostedEmbeddingError('network', 'network failed'),
  ])('keeps independent or untyped cleanup fatal', async (cleanup) => {
    const generate = await roundTrip(missing());
    const aggregate = await roundTrip(
      new AggregateError([generate, cleanup], 'Canonical inference and retirement failed.')
    );
    const log = vi.fn();
    expect(nativeIndexBoundaryFailure(aggregate, log)).toMatchObject(INTERNAL_FAULT);
    expect(log).toHaveBeenCalled();
  });
  it('keeps a separate aggregate cause fatal even when every child is missing-key', async () => {
    const error = await roundTrip(
      new AggregateError([missing(), missing()], 'Canonical inference and retirement failed.', {
        cause: new Error('independent cleanup cause'),
      })
    );
    expect(nativeIndexBoundaryFailure(error, vi.fn())).toMatchObject(INTERNAL_FAULT);
  });
  it('rejects an invalid public failure payload at the utility boundary', () => {
    expect(() =>
      decodeCanonicalFrame({
        channel: 'canonical-ingestion-v1',
        error: {
          failure: {
            category: 'configuration',
            code: 'embedding.missing-key',
            kind: 'refusal',
            message: 'x'.repeat(1001),
          },
          message: 'private',
          name: 'Error',
        },
        id: 1,
        kind: 'result',
        ok: false,
        owner: 'owner',
      })
    ).toThrow();
  });
});
// Existing hosted adapter HTTP fixtures are exercised through the real provider
// mapper before generate/join cross the utility boundary; no live call is made.
it.each([
  [413, 'input-too-long', 'input'],
  [429, 'rate-limit', 'availability'],
] as const)(
  'retains actionable HTTP %s through actual generate and its settled join',
  async (status, kind, category) => {
    const records: LogRecord[] = [];
    const unsubscribe = addLogListener((record) => records.push(record));
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'private provider fixture body' } }), {
          headers: { 'content-type': 'application/json' },
          status,
        })
    );
    vi.stubGlobal('fetch', fetch);
    const profile = {
      dimensions: 1536,
      distance: 'cosine',
      modelId: 'text-embedding-3-small',
      provider: 'openai',
    } as const;
    const inference = new NativeCanonicalInference({
      hostedEmbeddings: generateHostedEmbeddings,
      resolver: {
        resolve: async () => ({
          modelKey: 'openai::text-embedding-3-small',
          profile,
          workerPlan: null,
        }),
      },
      scope: { embeddingSetId: 'recorded-collection', kind: 'collection' },
      transport: { documentEmbeddings: vi.fn() },
    });
    const generated: unknown = await inference
      .generate({
        chunks: [{ chunkId: 'first', content: 'notarize release' }],
        profile,
        requestId: 'recorded-operation',
      })
      .catch((error: unknown) => error);
    unsubscribe();
    expect(generated).toBeInstanceOf(HostedEmbeddingError);
    expect(generated).toMatchObject({
      cause: { type: status === 429 ? 'rate_limit_exceeded' : 'api_error' },
    });
    expect(
      records.find((record) => record.scope === 'DesktopHostedEmbeddings')?.args.at(-1)
    ).toMatchObject({
      error: { provider: 'openai', type: status === 429 ? 'rate_limit_exceeded' : 'api_error' },
    });
    expect(generated).toMatchObject({ kind });
    expect(fetch).toHaveBeenCalledOnce();
    await expect(inference.join('recorded-operation')).resolves.toBeUndefined();
    const generate = await roundTrip(generated);
    const log = vi.fn();
    const failure = nativeIndexBoundaryFailure(generate, log);
    expect(
      Schema.decodeUnknownSync(BoundaryFailureSchema, { errors: 'all', onExcessProperty: 'error' })(
        failure
      )
    ).toMatchObject({
      category,
      code: `embedding.${kind}`,
      kind: 'refusal',
      remedy: expect.any(String),
    });
    expect(JSON.stringify(failure)).not.toContain('private provider fixture body');
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cause: generate })
    );
    expect(generate).toMatchObject({ cause: expect.any(Error) });
    await expect(inference.close()).resolves.toBeUndefined();
  }
);
it.each([
  new HostedEmbeddingError('input-too-long', 'safe producer message'),
  new HostedEmbeddingError('rate-limit', 'safe producer message'),
  new HostedEmbeddingError('provider-status', 'safe producer message'),
])('does not promote mixed hosted outcomes to a uniform refusal', async (other) => {
  const aggregate = await roundTrip(new AggregateError([missing(), other], 'Independent failures'));
  expect(nativeIndexBoundaryFailure(aggregate, vi.fn())).toMatchObject(INTERNAL_FAULT);
});
it('retains provider diagnostic facts privately through the real redacting logger', async () => {
  const original = Object.assign(new TypeError('fixture transport refused'), {
    details: { authorization: 'Bearer fake-private-auth', phase: 'connect' },
    token: 'fake-private-provider-token',
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw original;
    })
  );
  const records: LogRecord[] = [];
  const unsubscribe = addLogListener((record) => records.push(record));
  let failure: unknown;
  try {
    failure = await generateHostedEmbeddings({
      dimensions: 1536,
      modelId: 'text-embedding-3-small',
      provider: 'openai',
      purpose: 'document',
      signal: new AbortController().signal,
      texts: ['notarize release'],
    }).catch((error: unknown) => error);
  } finally {
    unsubscribe();
  }
  expect(failure).toMatchObject({
    cause: { originalError: original, type: 'network_error' },
    kind: 'network',
  });
  const diagnostic = records
    .find((record) => record.scope === 'DesktopHostedEmbeddings')
    ?.args.at(-1);
  expect(diagnostic).toMatchObject({
    error: {
      originalError: {
        details: { authorization: '[REDACTED]', phase: 'connect' },
        token: '[REDACTED]',
      },
      type: 'network_error',
    },
  });
  expect(JSON.stringify(diagnostic)).not.toContain('fake-private-provider-token');
  expect(JSON.stringify(diagnostic)).not.toContain('fake-private-auth');
  expect(original.token).toBe('fake-private-provider-token');
  expect(nativeIndexBoundaryFailure(failure, vi.fn())).toMatchObject(INTERNAL_FAULT);
});

// BST-1878: the agent hears the same remedy the user reads, and the engine's
// wording stays in Main's log under the refusal's correlation id.
it('names the rebuild as the remedy for a store that refused its index file', () => {
  const log = vi.fn();
  const failure = nativeIndexBoundaryFailure(
    nativeIndexStateError({
      cause: {
        error: new IndexerError(
          'rebuild-required',
          'SQLite integrity_check refused the existing derived index.'
        ),
        kind: 'source-failure',
        message: 'SQLite integrity_check refused the existing derived index.',
      },
      generation: 3,
      kind: 'failed',
      settings: readNativeIndexSettings(
        '{"state":{"enabled":true,"indexingPolicyPreset":"balanced","managedCollectionId":null,"mode":"root-folder-cache","nativeIndexMode":"TEXT","nativeLocalSelection":null,"paused":false,"worktreeRootIndexingOptInById":{}},"version":6}'
      ),
    }),
    log
  );

  expect(failure).toMatchObject({
    category: 'availability',
    code: 'native-index-rebuild-required',
    kind: 'refusal',
    message: 'The search index needs a rebuild.',
    remedy:
      'Rebuild the search index in Settings, Search & Indexing. Chats, folders and settings are kept.',
  });
  expect(JSON.stringify(failure)).not.toContain('integrity_check');
  expect(log).toHaveBeenCalledWith(
    'Native index refusal retained its original cause',
    expect.objectContaining({ code: 'native-index-rebuild-required' })
  );
});
