import type { EmbeddingDType } from '@brainstrike/indexing-contract';

export interface SelectedEmbeddingRequestPlan {
  readonly device?: 'webgpu' | 'wasm';
  readonly dimensions: number;
  readonly dtype?: string;
  readonly modelId: string;
  readonly revision?: string;
}
export interface CatalogEmbeddingWorkerPlan {
  readonly device: 'webgpu' | 'wasm';
  readonly dimensions: number;
  readonly dtype: EmbeddingDType;
  readonly modelId: string;
  readonly revision?: string;
}
export interface CatalogEmbeddingProfile {
  readonly dimensions: number;
  readonly dtype: EmbeddingDType;
  readonly modelId: string;
  readonly revision?: string;
  readonly tokenCap?: number;
}

/** Validate execution DTOs independently of catalog authorization, including in preload. */
export function validateCatalogEmbeddingWorkerPlan(
  request: SelectedEmbeddingRequestPlan
): CatalogEmbeddingWorkerPlan {
  if (
    !(
      request.modelId.trim() &&
      Number.isSafeInteger(request.dimensions) &&
      request.dimensions > 0 &&
      request.dimensions <= 16_000 &&
      (request.device === 'wasm' || request.device === 'webgpu') &&
      (request.dtype === 'q4' ||
        request.dtype === 'q8' ||
        request.dtype === 'fp16' ||
        request.dtype === 'fp32') &&
      (request.revision === undefined || /^[a-f0-9]{40}$/u.test(request.revision))
    )
  ) {
    throw new Error(
      'Catalog embedding execution requires exact model, dimensions, device, dtype and a valid optional revision.'
    );
  }
  return {
    device: request.device,
    dimensions: request.dimensions,
    dtype: request.dtype,
    modelId: request.modelId,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
  };
}

/** Existing catalog authority selects the model; missing revisions remain missing. */
export function resolveCatalogEmbeddingPlan(
  request: SelectedEmbeddingRequestPlan,
  model: { readonly id: string; readonly dimensions: number; readonly contextWindow?: number }
):
  | { readonly kind: 'unavailable'; readonly reason: string }
  | {
      readonly kind: 'ready';
      readonly profile: CatalogEmbeddingProfile;
      readonly workerPlan: CatalogEmbeddingWorkerPlan;
    } {
  if (request.modelId !== model.id || request.dimensions !== model.dimensions) {
    return {
      kind: 'unavailable',
      reason: 'Selected execution differs from the authorized catalog model or dimensions.',
    };
  }
  let workerPlan: CatalogEmbeddingWorkerPlan;
  try {
    workerPlan = validateCatalogEmbeddingWorkerPlan(request);
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  const { device: _device, ...profile } = workerPlan;
  return {
    kind: 'ready',
    profile: {
      ...profile,
      ...(model.contextWindow === undefined ? {} : { tokenCap: model.contextWindow }),
    },
    workerPlan,
  };
}
