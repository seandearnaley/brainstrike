/**
 * Embedding Set Validation Utilities (BST-168)
 *
 * Validates embedding set creation parameters against provider metadata to ensure
 * consistency between declared model capabilities and stored embedding sets.
 */

import type { DistanceMetric, ProviderMetadata, Result } from './provider-types';

/**
 * Parameters required to create an embedding set.
 * Maps to IEmbeddingSetsRepository.getOrCreateSet parameters.
 */
export interface EmbeddingSetCreateParams {
  /** Expected embedding dimensions */
  dimensions: number;
  /** Distance metric for similarity calculations */
  distance: DistanceMetric;
  /** Optional user-provided metadata */
  metadata?: {
    name?: string;
    description?: string;
    tags?: string;
    category?: string;
  };
  /** Model identifier (e.g., 'text-embedding-3-small', 'voyage-3') */
  modelId: string;
  /** Provider identifier (e.g., 'openai', 'voyage', 'local') */
  modelKey: string;
}

/**
 * Validation error types for embedding set creation
 */
export type EmbeddingSetValidationError =
  | {
      type: 'dimension_mismatch';
      expected: number;
      provided: number;
      modelKey: string;
    }
  | {
      type: 'distance_mismatch';
      expected: DistanceMetric;
      provided: DistanceMetric;
      modelKey: string;
    }
  | {
      type: 'provider_mismatch';
      expected: string;
      provided: string;
    }
  | {
      type: 'missing_metadata';
      field: 'providerId' | 'modelKey' | 'dimensions' | 'distance';
    };

/**
 * Validates embedding set creation parameters against provider metadata.
 *
 * Use this before calling getOrCreateSet to ensure the parameters match
 * the provider's actual model capabilities.
 *
 * @param params - The parameters to validate
 * @param providerMetadata - Metadata from the embedding provider
 * @returns Result indicating success or validation error
 *
 * @example
 * ```typescript
 * const provider = new OpenAIEmbeddingProvider({ modelId: 'text-embedding-3-small', apiKey });
 * const metadata = provider.getMetadata('text-embedding-3-small');
 * if (!metadata) throw new Error('Unknown model');
 *
 * const params = createEmbeddingSetParamsFromMetadata(metadata, { name: 'My Set' });
 * const validation = validateEmbeddingSetParams(params, metadata);
 * if (!validation.ok) {
 *   console.error('Validation failed:', validation.error);
 *   return;
 * }
 *
 * await repository.getOrCreateSet(
 *   params.modelKey,
 *   params.modelId,
 *   params.dimensions,
 *   params.distance,
 *   params.metadata
 * );
 * ```
 */
export function validateEmbeddingSetParams(
  params: EmbeddingSetCreateParams,
  providerMetadata: ProviderMetadata
): Result<void, EmbeddingSetValidationError> {
  // Validate dimensions match
  if (params.dimensions !== providerMetadata.dimensions) {
    return {
      error: {
        expected: providerMetadata.dimensions,
        modelKey: providerMetadata.modelKey,
        provided: params.dimensions,
        type: 'dimension_mismatch',
      },
      ok: false,
    };
  }

  // Validate distance metric matches
  if (params.distance !== providerMetadata.distance) {
    return {
      error: {
        expected: providerMetadata.distance,
        modelKey: providerMetadata.modelKey,
        provided: params.distance,
        type: 'distance_mismatch',
      },
      ok: false,
    };
  }

  return { ok: true, value: undefined };
}

/**
 * Creates embedding set creation parameters from provider metadata.
 *
 * This ensures the parameters are derived from the provider's actual
 * capabilities rather than being manually specified.
 *
 * @param providerMetadata - Metadata from the embedding provider
 * @param userMetadata - Optional user-provided metadata (name, description, etc.)
 * @returns Parameters ready for getOrCreateSet
 *
 * @example
 * ```typescript
 * const provider = new VoyageEmbeddingProvider({ modelId: 'voyage-3', apiKey });
 * const metadata = provider.getMetadata('voyage-3');
 * if (!metadata) throw new Error('Unknown model');
 *
 * const params = createEmbeddingSetParamsFromMetadata(metadata, {
 *   name: 'Code Embeddings',
 *   description: 'Voyage v3 embeddings for code analysis',
 *   category: 'development',
 * });
 *
 * await repository.getOrCreateSet(
 *   params.modelKey,
 *   params.modelId,
 *   params.dimensions,
 *   params.distance,
 *   params.metadata
 * );
 * ```
 */
export function createEmbeddingSetParamsFromMetadata(
  providerMetadata: ProviderMetadata,
  userMetadata?: EmbeddingSetCreateParams['metadata']
): EmbeddingSetCreateParams {
  // Generate default name from provider metadata if not provided
  const defaultName = `${providerMetadata.displayName} (${providerMetadata.dimensions}D)`;

  return {
    dimensions: providerMetadata.dimensions,
    distance: providerMetadata.distance,
    modelId: providerMetadata.modelKey,
    // Map ProviderMetadata fields to EmbeddingSet creation params
    // Note: EmbeddingSet.modelKey stores the providerId (e.g., 'openai')
    // while EmbeddingSet.modelId stores the model key (e.g., 'text-embedding-3-small')
    modelKey: providerMetadata.providerId,
    ...(userMetadata
      ? {
          metadata: {
            name: userMetadata.name ?? defaultName,
            ...(userMetadata.description ? { description: userMetadata.description } : {}),
            ...(userMetadata.tags ? { tags: userMetadata.tags } : {}),
            ...(userMetadata.category ? { category: userMetadata.category } : {}),
          },
        }
      : {
          metadata: { name: defaultName },
        }),
  };
}

/**
 * Validates that an embedding vector has the correct dimensions for an embedding set.
 *
 * Use this when storing embeddings to ensure dimension consistency.
 *
 * @param embedding - The embedding vector to validate
 * @param expectedDimensions - Expected number of dimensions
 * @returns Result indicating success or dimension mismatch error
 *
 * @example
 * ```typescript
 * const embeddingResult = await provider.embed({ text: 'Hello world', modelId });
 * if (!embeddingResult.ok) throw embeddingResult.error;
 *
 * const validation = validateEmbeddingDimensions(
 *   embeddingResult.value.embedding,
 *   embeddingSet.dimensions
 * );
 * if (!validation.ok) {
 *   console.error(`Dimension mismatch: got ${validation.error.actual}, expected ${validation.error.expected}`);
 *   return;
 * }
 *
 * await chunkRepository.updateChunkEmbedding(chunkId, embeddingResult.value.embedding);
 * ```
 */
export function validateEmbeddingDimensions(
  embedding: number[] | Float32Array,
  expectedDimensions: number
): Result<void, { type: 'dimension_mismatch'; expected: number; actual: number }> {
  const actualDimensions = embedding.length;

  if (actualDimensions !== expectedDimensions) {
    return {
      error: {
        actual: actualDimensions,
        expected: expectedDimensions,
        type: 'dimension_mismatch',
      },
      ok: false,
    };
  }

  return { ok: true, value: undefined };
}

/**
 * Checks if a ProviderMetadata is compatible with an existing embedding set configuration.
 *
 * Use this to verify that a provider/model can be used with an existing embedding set
 * before attempting to generate and store embeddings.
 *
 * @param setConfig - Configuration from an existing embedding set
 * @param providerMetadata - Metadata from the embedding provider
 * @returns Result indicating compatibility or specific mismatch
 */
export function isProviderCompatibleWithSet(
  setConfig: { modelKey: string; modelId: string; dimensions: number; distance: DistanceMetric },
  providerMetadata: ProviderMetadata
): Result<void, EmbeddingSetValidationError> {
  // Check provider matches
  if (setConfig.modelKey !== providerMetadata.providerId) {
    return {
      error: {
        expected: setConfig.modelKey,
        provided: providerMetadata.providerId,
        type: 'provider_mismatch',
      },
      ok: false,
    };
  }

  // Check dimensions match
  if (setConfig.dimensions !== providerMetadata.dimensions) {
    return {
      error: {
        expected: setConfig.dimensions,
        modelKey: providerMetadata.modelKey,
        provided: providerMetadata.dimensions,
        type: 'dimension_mismatch',
      },
      ok: false,
    };
  }

  // Check distance metric matches
  if (setConfig.distance !== providerMetadata.distance) {
    return {
      error: {
        expected: setConfig.distance,
        modelKey: providerMetadata.modelKey,
        provided: providerMetadata.distance,
        type: 'distance_mismatch',
      },
      ok: false,
    };
  }

  return { ok: true, value: undefined };
}
