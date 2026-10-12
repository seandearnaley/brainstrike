import type {
  CanonicalCatalogPort,
  CanonicalInferencePort,
  CanonicalOperationContext,
  CanonicalSourceScope,
} from '@brainstrike/canonical-ingestion';
import type { EmbeddingSet } from '@brainstrike/db';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import {
  type CatalogEmbeddingWorkerPlan,
  resolveCatalogEmbeddingPlan,
  type SelectedEmbeddingRequestPlan,
} from '@brainstrike/embeddings/inference-plan';
import { isHostedProvider, parseProviderModelKey } from '@brainstrike/embeddings/provider-core';
import { type VectorProfile, vectorProfileHash } from '@brainstrike/indexer';
import { Schema } from 'effect';
import type { EmbeddingHostDocumentEmbeddingsPayload } from './embedding-host-shared';
import { generateHostedEmbeddings } from './hosted-embeddings';
import { NativeIndexSetupRequiredError } from './native-index-setup-required';

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
  EmbeddingSet,
  'dimensions' | 'distance' | 'id' | 'modelId' | 'modelKey'
>;

export interface NativeCanonicalProfile {
  readonly modelKey: string;
  readonly profile: VectorProfile;
  readonly workerPlan: CatalogEmbeddingWorkerPlan | null;
}

/** Pure resolution. Reading a profile neither enables vectors nor changes saved choices. */
export function resolveNativeCanonicalProfile(
  input: ProfileMetadata,
  selection?: SelectedEmbeddingRequestPlan,
  model?: { readonly id: string; readonly dimensions: number; readonly contextWindow?: number }
): NativeCanonicalProfile {
  const metadata = decodeMetadata(input);
  const parsed = parseProviderModelKey(metadata.modelKey);
  if (!parsed) {
    throw new Error('Canonical profile requires an explicit saved provider/model key.');
  }
  if (parsed.modelId !== metadata.modelId) {
    throw new Error('Canonical profile modelId disagrees with the saved provider/model key.');
  }
  const base = {
    dimensions: metadata.dimensions,
    distance: metadata.distance,
    modelId: metadata.modelId,
    provider: parsed.provider,
  };
  if (base.provider !== 'local' && base.provider !== 'transformers') {
    return {
      modelKey: metadata.modelKey,
      profile: { ...base, provider: base.provider },
      workerPlan: null,
    };
  }
  if (!selection) {
    throw new NativeIndexSetupRequiredError(
      'Choose local model execution in Search & Indexing settings.'
    );
  }
  if (selection.modelId !== metadata.modelId || selection.dimensions !== metadata.dimensions) {
    throw new Error('Canonical local selection disagrees with saved model or dimensions.');
  }
  const plan = resolveCatalogEmbeddingPlan(
    selection,
    model ?? { dimensions: metadata.dimensions, id: metadata.modelId }
  );
  if (plan.kind === 'unavailable') {
    throw new Error(plan.reason);
  }
  return {
    modelKey: metadata.modelKey,
    profile: { ...plan.profile, distance: metadata.distance, provider: base.provider },
    workerPlan: plan.workerPlan,
  };
}

export interface NativeCanonicalProfileDependencies {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ readonly rows: unknown[] }>;
  /** Read the existing explicit preference/plan source. Never derive pins from names or defaults. */
  readonly readLocalSelection: (
    metadata: ProfileMetadata,
    context: CanonicalOperationContext
  ) => Promise<SelectedEmbeddingRequestPlan | undefined>;
  /** Existing catalog authority resolves workspace membership or collection access, without creation. */
  readonly resolveEmbeddingSetId: (
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ) => Promise<string>;
}

export class NativeCanonicalProfileResolver {
  constructor(private readonly dependencies: NativeCanonicalProfileDependencies) {}

  readonly resolveProfile: CanonicalCatalogPort<VectorProfile>['resolveProfile'] = async (
    { scope },
    context
  ) => (await this.resolve(scope, context)).profile;

  async resolve(
    scope: CanonicalSourceScope,
    context: CanonicalOperationContext
  ): Promise<NativeCanonicalProfile> {
    context.signal.throwIfAborted();
    const id = await this.dependencies.resolveEmbeddingSetId(scope, context);
    context.signal.throwIfAborted();
    if (!id.trim() || (scope.kind === 'collection' && id !== scope.embeddingSetId)) {
      throw new Error('Canonical profile embedding set is not authorized for this scope.');
    }
    const result = await this.dependencies.query(
      `SELECT id, model_key AS "modelKey", model_id AS "modelId", dimensions, distance
         FROM embedding_sets WHERE id = $1`,
      [id]
    );
    context.signal.throwIfAborted();
    if (result.rows.length !== 1) {
      throw new Error('Canonical profile embedding set is missing or ambiguous.');
    }
    const metadata = decodeMetadata(result.rows[0]);
    if (metadata.id !== id) {
      throw new Error('Canonical profile query returned an unauthorized embedding set.');
    }
    const parsed = parseProviderModelKey(metadata.modelKey);
    const selection =
      parsed?.provider === 'local' || parsed?.provider === 'transformers'
        ? await this.dependencies.readLocalSelection(metadata, context)
        : undefined;
    context.signal.throwIfAborted();
    return resolveNativeCanonicalProfile(metadata, selection);
  }
}

export interface NativeCanonicalInferenceDependencies {
  readonly hostedEmbeddings?: typeof generateHostedEmbeddings;
  readonly resolver: Pick<NativeCanonicalProfileResolver, 'resolve'>;
  readonly scope: CanonicalSourceScope;
  /**
   * REQUIRED: promise settlement proves physical renderer completion or joined host retirement,
   * including abort, timeout and failed cancellation delivery. An early local rejection is unsafe.
   * A successful cancellation rejects with the supplied signal.reason; other failures stay visible.
   * The uncorrected HostRequestChannel document relay does not meet this contract.
   */
  readonly transport: {
    readonly documentEmbeddings: (
      payload: EmbeddingHostDocumentEmbeddingsPayload,
      options?: { signal?: AbortSignal }
    ) => Promise<number[][]>;
  };
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

  constructor(private readonly dependencies: NativeCanonicalInferenceDependencies) {
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
    const completion = operation.then(
      () => undefined,
      (error: unknown) => {
        if (controller.signal.aborted && error === controller.signal.reason) {
          return;
        }
        throw error;
      }
    );
    // Observe rejection even when a caller has not joined yet; join still receives the same failure.
    completion.catch(() => undefined);
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
    if (this.pending.get(requestId) === pending) {
      this.pending.delete(requestId);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const results = await Promise.allSettled([...this.pending.keys()].map((id) => this.cancel(id)));
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : []
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Canonical inference retirement failed.');
    }
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
    const vectors = resolved.workerPlan
      ? await this.dependencies.transport.documentEmbeddings(
          {
            dimensions: profile.dimensions,
            inferencePlan: resolved.workerPlan,
            modelId: profile.modelId,
            modelKey: resolved.modelKey,
            texts: chunks.map((chunk) => chunk.content),
          },
          { signal: context.signal }
        )
      : isHostedProvider(profile.provider)
        ? await (this.dependencies.hostedEmbeddings ?? generateHostedEmbeddings)({
            dimensions: profile.dimensions,
            modelId: profile.modelId,
            provider: profile.provider,
            purpose: 'document',
            signal: context.signal,
            texts: chunks.map((chunk) => chunk.content),
          })
        : (() => {
            throw new Error(
              `Canonical inference execution is unsupported for provider ${profile.provider}.`
            );
          })();
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
