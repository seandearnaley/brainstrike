import type {
  CatalogEmbeddingModel,
  EmbeddingDType,
  EmbeddingPooling,
  EmbeddingPrompts,
  ModelCachePlan,
} from '@brainstrike/indexing-contract';

/**
 * Texts per worker slice when no `streamBatchSize` is configured. Each completed slice
 * reports progress, which is what keeps a document request's 60 s liveness window open
 * in the embedding host; one unsliced 64-text request outlived it on WASM (BST-2090).
 * The hidden host also runs a document batch one slice per inference turn, so a search
 * waits for at most one slice, never a whole batch.
 */
export const DEFAULT_WORKER_SLICE_SIZE = {
  // WASM cost is linear in slice size (1-64 texts measured), so one text is free; the chunker's
  // largest chunk (6,000 chars) takes 1.1 s in granite q8 on an M-series Mac: 3x inside 60 s on a
  // host up to 18x slower (a 2-vCPU runner measured over 5x).
  wasm: 1,
  // Slices of 16 cost WebGPU nothing: 16 granite fp16 chunks of 2,048 chars take 0.16 s on an
  // M-series Mac, the per-text cost of 64, while 4-text calls cost 55% more per text.
  webgpu: 16,
} as const satisfies Record<'wasm' | 'webgpu', number>;

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

/**
 * BST-2241: what a Settings download of `model` on `device` fetches, as a model
 * cache check names it: the catalog plan's model, device, dtype and revision.
 */
export function catalogModelCachePlan(
  model: CatalogModelFacts,
  device: 'webgpu' | 'wasm'
): ModelCachePlan {
  const plan = unpinnedCatalogEmbeddingPlan(model, device);
  return {
    device: plan.device,
    dtype: plan.dtype,
    modelId: plan.modelId,
    ...(plan.revision === undefined ? {} : { revision: plan.revision }),
  };
}
