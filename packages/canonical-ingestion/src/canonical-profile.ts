// A collection's vector profile and the hosted provider that produces its vectors: desktop's native
// index embeds through these owners.
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { parseProviderModelKey } from '@brainstrike/embeddings/provider-core';
import type { VectorProfile } from '@brainstrike/indexer';
import { vectorProfileHash } from '@brainstrike/indexer';
import type { EmbeddingProviderType } from '@brainstrike/indexing-contract';
import type { CollectionPort } from '@brainstrike/state-store';
import type { CollectionRecord } from '@brainstrike/types';
import { Schema } from 'effect';
import type {
  CanonicalCatalogPort,
  CanonicalInferencePort,
  CanonicalOperationContext,
  CanonicalSourceScope,
} from './ports.ts';

const nonblank = Schema.String.check(Schema.isPattern(/\S/u));
const metadataSchema = Schema.Struct({
  dimensions: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(16_000)),
  distance: Schema.Literals(['cosine', 'l2', 'ip']),
  id: nonblank,
  modelId: nonblank,
  modelKey: nonblank,
});
const decodeMetadata = makeThrowingDecoder(metadataSchema);
type ProfileMetadata = Pick<
  CollectionRecord,
  'dimensions' | 'distance' | 'id' | 'modelId' | 'modelKey'
>;

/** A hosted provider's document embeddings, as the host reaches its provider. */
export type CanonicalHostedEmbeddings = (input: {
  readonly dimensions: number;
  readonly modelId: string;
  readonly provider: EmbeddingProviderType;
  readonly purpose: 'document';
  readonly signal: AbortSignal;
  readonly texts: string[];
}) => Promise<number[][]>;

export interface NativeCanonicalProfile {
  readonly modelKey: string;
  readonly profile: VectorProfile;
}

/** Pure resolution. Reading a profile neither enables vectors nor changes saved choices. */
export function resolveNativeCanonicalProfile(input: ProfileMetadata): NativeCanonicalProfile {
  const metadata = decodeMetadata(input);
  const parsed = parseProviderModelKey(metadata.modelKey);
  if (!parsed) {
    throw new Error('Canonical profile requires an explicit saved provider/model key.');
  }
  if (parsed.modelId !== metadata.modelId) {
    throw new Error('Canonical profile modelId disagrees with the saved provider/model key.');
  }
  return {
    modelKey: metadata.modelKey,
    profile: {
      dimensions: metadata.dimensions,
      distance: metadata.distance,
      modelId: metadata.modelId,
      provider: parsed.provider,
    },
  };
}

export interface NativeCanonicalProfileDependencies {
  readonly collections: CollectionPort;
  /** Existing catalog authority resolves a workspace's membership, without creation. */
  readonly resolveEmbeddingSetId: (
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ) => Promise<string>;
}

export class NativeCanonicalProfileResolver {
  private readonly dependencies: NativeCanonicalProfileDependencies;

  constructor(dependencies: NativeCanonicalProfileDependencies) {
    this.dependencies = dependencies;
  }

  readonly resolveProfile: CanonicalCatalogPort<VectorProfile>['resolveProfile'] = async (
    { scope },
    context
  ) => (await this.resolve(scope, context)).profile;

  /** An authorized workspace's profile: the vector space it joins. */
  async resolve(
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ): Promise<NativeCanonicalProfile> {
    context.signal.throwIfAborted();
    const id = await this.dependencies.resolveEmbeddingSetId(scope, context);
    context.signal.throwIfAborted();
    return this.resolveVectorSpace(id, context);
  }

  /** The saved vector space's profile, whatever folders join it. */
  async resolveVectorSpace(
    id: string,
    context: CanonicalOperationContext
  ): Promise<NativeCanonicalProfile> {
    if (!id.trim()) {
      throw new Error('Canonical profile embedding set is not authorized for this scope.');
    }
    const result = await this.dependencies.collections.collections({ id, operation: 'get' });
    context.signal.throwIfAborted();
    if (result.collections.length !== 1) {
      throw new Error('Canonical profile embedding set is missing or ambiguous.');
    }
    const metadata = decodeMetadata(result.collections[0]);
    if (metadata.id !== id) {
      throw new Error('Canonical profile query returned an unauthorized embedding set.');
    }
    return resolveNativeCanonicalProfile(metadata);
  }
}

export interface NativeCanonicalInferenceDependencies {
  /**
   * A hosted provider's document embeddings. Settlement proves the request ended, abort included;
   * a successful cancellation rejects with the supplied signal.reason, other failures stay visible.
   */
  readonly hostedEmbeddings: CanonicalHostedEmbeddings;
  readonly resolver: Pick<NativeCanonicalProfileResolver, 'resolve'>;
  readonly scope: CanonicalSourceScope;
}

type InferencePort = CanonicalInferencePort<VectorProfile>;
interface PendingInference {
  readonly completion: Promise<void>;
  readonly controller: AbortController;
}

/** One operation-scope owner; close it with the scan/runtime before replacing its request namespace. */
export class NativeCanonicalInference implements InferencePort {
  private readonly pending = new Map<string, PendingInference>();
  private readonly usedRequestIds = new Set<string>();
  private readonly scope: CanonicalSourceScope;
  private closed = false;

  private readonly dependencies: NativeCanonicalInferenceDependencies;

  constructor(dependencies: NativeCanonicalInferenceDependencies) {
    this.dependencies = dependencies;
    this.scope = { ...dependencies.scope };
  }

  readonly generate: InferencePort['generate'] = async (input) => {
    const requestId = input.requestId;
    if (this.closed) {
      throw new Error('Canonical inference is closed.');
    }
    if (!requestId.trim() || this.usedRequestIds.has(requestId)) {
      throw new Error('Canonical inference request identity is blank or already used.');
    }
    if (input.chunks.length === 0 || input.chunks.length > 64) {
      throw new Error('Canonical inference requires between 1 and 64 ordered chunks.');
    }
    for (let index = 0; index < input.chunks.length; index += 1) {
      if (!Object.hasOwn(input.chunks, index)) {
        throw new Error(
          'Canonical inference requires actual chunks at every index; sparse batches are invalid.'
        );
      }
    }
    const chunks = input.chunks.map((chunk) => ({ ...chunk }));
    if (
      chunks.some((chunk) => !(chunk.chunkId.trim() && chunk.content.trim())) ||
      new Set(chunks.map((chunk) => chunk.chunkId)).size !== chunks.length
    ) {
      throw new Error('Canonical inference requires unique nonblank chunk IDs and text.');
    }
    const profile = { ...input.profile };
    const requestedHash = vectorProfileHash(profile);
    const controller = new AbortController();
    this.usedRequestIds.add(requestId);
    // Register ownership before invoking injected authority or transport callbacks.
    const operation = Promise.resolve().then(() =>
      this.generateOwned(chunks, profile, requestedHash, {
        requestId,
        signal: controller.signal,
      })
    );
    // Cancel and join prove physical settlement only: generate alone delivers how it ended.
    const completion = operation.then(
      () => undefined,
      () => undefined
    );
    this.pending.set(requestId, { completion, controller });
    return await operation;
  };

  async cancel(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    pending.controller.abort(new DOMException('Canonical inference canceled.', 'AbortError'));
    await pending.completion;
  }

  async join(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }
    await pending.completion;
    // Completion proves physical settlement on every outcome: retain no settled request.
    if (this.pending.get(requestId) === pending) {
      this.pending.delete(requestId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const requestIds = [...this.pending.keys()];
    await Promise.all(requestIds.map((id) => this.cancel(id)));
    await Promise.all(requestIds.map((id) => this.join(id)));
    this.pending.clear();
    this.usedRequestIds.clear();
  }

  private async generateOwned(
    chunks: Parameters<InferencePort['generate']>[0]['chunks'],
    profile: VectorProfile,
    requestedHash: string,
    context: CanonicalOperationContext
  ): ReturnType<InferencePort['generate']> {
    const resolved = await this.dependencies.resolver.resolve(this.scope, context);
    context.signal.throwIfAborted();
    if (requestedHash !== vectorProfileHash(resolved.profile)) {
      throw new Error('Canonical inference profile differs from current saved selection.');
    }
    const vectors = await this.dependencies.hostedEmbeddings({
      dimensions: profile.dimensions,
      modelId: profile.modelId,
      provider: profile.provider,
      purpose: 'document',
      signal: context.signal,
      texts: chunks.map((chunk) => chunk.content),
    });
    context.signal.throwIfAborted();
    if (
      !Array.isArray(vectors) ||
      vectors.length !== chunks.length ||
      Array.from(vectors).some(
        (vector) =>
          !Array.isArray(vector) ||
          vector.length !== profile.dimensions ||
          !Array.from(vector).every(Number.isFinite)
      )
    ) {
      throw new Error(
        'Canonical inference response count, dimensions or finite values are invalid.'
      );
    }
    return {
      profile,
      requestId: context.requestId,
      vectors: chunks.map((chunk, index) => {
        const vector = vectors[index];
        if (!vector) {
          throw new Error('Canonical inference response is missing a vector.');
        }
        return { chunkId: chunk.chunkId, vector: [...vector] };
      }),
    };
  }
}
