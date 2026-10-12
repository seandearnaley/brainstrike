import type {
  CatalogEmbeddingModel,
  EmbeddingDType,
  EmbeddingPooling,
  EmbeddingPrompts,
} from '@brainstrike/indexing-contract';

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
  /** The catalog model's pooling; absent asks the worker for 'mean'. */
  readonly pooling?: EmbeddingPooling;
  /** The catalog model's query/document prompts; absent embeds raw text. */
  readonly prompts?: EmbeddingPrompts;
  readonly revision?: string;
}
export interface CatalogEmbeddingProfile {
  readonly dimensions: number;
  readonly dtype: EmbeddingDType;
  readonly modelId: string;
  readonly pooling?: EmbeddingPooling;
  readonly prompts?: EmbeddingPrompts;
  readonly revision?: string;
  readonly tokenCap?: number;
}
/** The catalog facts a plan takes: a decoded row has them all; a caller may pass fewer. */
export type CatalogModelFacts = Pick<CatalogEmbeddingModel, 'dimensions' | 'id'> &
  Partial<
    Pick<CatalogEmbeddingModel, 'contextWindow' | 'execution' | 'pooling' | 'prompts' | 'revision'>
  >;

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

/**
 * Existing catalog authority selects the model; missing revisions remain missing.
 * The catalog's pooling joins the plan, and a catalog revision pin must be the
 * selection's revision.
 */
export function resolveCatalogEmbeddingPlan(
  request: SelectedEmbeddingRequestPlan,
  model: CatalogModelFacts
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
  if (model.revision !== undefined && request.revision !== model.revision) {
    return {
      kind: 'unavailable',
      reason: `Selected execution must use the catalog's pinned revision ${model.revision}.`,
    };
  }
  let workerPlan: CatalogEmbeddingWorkerPlan;
  try {
    workerPlan = {
      ...validateCatalogEmbeddingWorkerPlan(request),
      ...(model.pooling === undefined ? {} : { pooling: model.pooling }),
      ...(model.prompts === undefined ? {} : { prompts: model.prompts }),
    };
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

/**
 * The dtype an unpinned load runs: WebGPU loads fp16, and WASM loads q4 when
 * the load is quantized, otherwise fp32. TransformersBackend uses it for every
 * load without an explicit dtype.
 */
export function unpinnedEmbeddingDType(
  device: 'webgpu' | 'wasm',
  quantized: boolean | undefined
): EmbeddingDType {
  if (device === 'webgpu') {
    return 'fp16';
  }
  return quantized ? 'q4' : 'fp32';
}

/** An unpinned model load quantizes a model of 768 dimensions or fewer that is not already quantized. */
export function quantizesUnpinnedLoad(model: {
  readonly dimensions: number;
  readonly quantized?: boolean | undefined;
}): boolean {
  return model.dimensions <= 768 && !model.quantized;
}

/**
 * What the embedding host's unpinned catalog query loads (legacy local recall):
 * the host's device and the dtype the rules above give a catalog model, which
 * the host never loads as pre-quantized. Pinning it keeps every vector in one
 * execution space. A catalog row that states its execution dtype, revision and
 * pooling (BST-1993) is loaded exactly as it states.
 */
export function unpinnedCatalogEmbeddingPlan(
  model: CatalogModelFacts,
  device: 'webgpu' | 'wasm'
): CatalogEmbeddingWorkerPlan {
  return {
    device,
    dimensions: model.dimensions,
    dtype:
      model.execution?.[device] ??
      unpinnedEmbeddingDType(
        device,
        quantizesUnpinnedLoad({ dimensions: model.dimensions, quantized: false })
      ),
    modelId: model.id,
    ...(model.pooling === undefined ? {} : { pooling: model.pooling }),
    ...(model.prompts === undefined ? {} : { prompts: model.prompts }),
    ...(model.revision === undefined ? {} : { revision: model.revision }),
  };
}
