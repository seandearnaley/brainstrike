// @vitest-environment node
import {
  BoundaryFailureError,
  BoundaryFailureSchema,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract/boundary-failure';
import { Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalUtilityChannel } from '../canonical-utility-channel';
import { canonicalFault, decodeCanonicalFrame } from '../canonical-utility-protocol';
import { HostedEmbeddingError } from '../hosted-embeddings';
import { NativeCanonicalInference } from '../native-canonical-profile';
import { nativeIndexBoundaryFailure } from '../native-index-boundary-failure';

vi.mock('../secrets', () => ({ getSecretsService: vi.fn() }));

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
  it('preserves both recorded generate/join failures and their safe refusal through the channel', async () => {
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
    const joinFailure = await inference.join('recorded-operation').catch((error: unknown) => error);
    expect(generationFailure).toBe(original);
    expect(joinFailure).toBe(original);
    const [generate, join] = await Promise.all([
      roundTrip(generationFailure),
      roundTrip(joinFailure),
    ]);
    expect(generate).toBeInstanceOf(BoundaryFailureError);
    expect(join).not.toBe(generate);
    const aggregate = await roundTrip(
      new AggregateError([generate, join], 'Canonical inference and retirement failed.')
    );
    const log = vi.fn();
    const failure = nativeIndexBoundaryFailure(aggregate, log);
    expect(BoundaryFailureSchema.parse(failure)).toMatchObject({
      category: 'configuration',
      code: 'embedding.missing-key',
      kind: 'refusal',
      remedy: expect.any(String),
    });
    expect(JSON.stringify(failure)).not.toContain('private fixture diagnostic');
    expect(log).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cause: aggregate })
    );
    expect(aggregate).toBeInstanceOf(AggregateError);
    if (!(aggregate instanceof AggregateError)) {
      throw new Error('Missing aggregate');
    }
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0].cause.message).toBe('private fixture diagnostic');
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
