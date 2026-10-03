import type { IndexerEmbeddingProfile } from '@brainstrike/indexing-contract/indexer-client';

export interface SelectedEmbeddingRequestPlan {
  readonly device?: 'webgpu' | 'wasm';
  readonly dimensions: number;
  readonly dtype?: string;
  readonly modelId: string;
  readonly revision?: string;
}
export interface PinnedEmbeddingWorkerPlan {
  readonly device: 'webgpu' | 'wasm';
  readonly dimensions: 384;
  readonly dtype: 'fp16' | 'fp32' | 'q8';
  readonly modelId: string;
  readonly revision: string;
}
export type PinnedEmbeddingPlan =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | {
      readonly kind: 'ready';
      readonly profile: IndexerEmbeddingProfile;
      readonly workerPlan: PinnedEmbeddingWorkerPlan;
    };

// Published exports verified by the real Wave0 renderer worker, not model ID aliases.
const VERIFIED_EXPORTS = [
  {
    deviceDtypes: ['webgpu:fp16', 'wasm:fp32'],
    modelId: 'onnx-community/all-MiniLM-L6-v2-ONNX',
    revision: 'aff7a1dc4e8a1ea593e6ea21e95c22ef0a25966f',
    tokenCap: 256,
  },
  {
    deviceDtypes: ['wasm:q8', 'wasm:fp32'],
    modelId: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    tokenCap: 512,
  },
] as const;

/** Resolve identity before inference; never infer an omitted pin or execution choice. */
export function resolvePinnedEmbeddingPlan(
  request: SelectedEmbeddingRequestPlan
): PinnedEmbeddingPlan {
  if (!(request.revision && request.device && request.dtype)) {
    return {
      kind: 'unavailable',
      reason: 'The selected embedding request requires an explicit revision, device and dtype.',
    };
  }
  const verified = VERIFIED_EXPORTS.find(
    (entry) => entry.modelId === request.modelId && entry.revision === request.revision
  );
  if (!verified || request.dimensions !== 384) {
    return {
      kind: 'unavailable',
      reason:
        'The selected embedding export revision and dimensions are not a validated native vector profile.',
    };
  }
  if (
    !(
      verified.deviceDtypes.some((choice) => choice === `${request.device}:${request.dtype}`) &&
      (request.dtype === 'q8' || request.dtype === 'fp16' || request.dtype === 'fp32')
    )
  ) {
    return {
      kind: 'unavailable',
      reason:
        'The selected pinned embedding export does not support this validated device/dtype profile.',
    };
  }
  const workerPlan: PinnedEmbeddingWorkerPlan = {
    device: request.device,
    dimensions: 384,
    dtype: request.dtype,
    modelId: request.modelId,
    revision: request.revision,
  };
  return {
    kind: 'ready',
    profile: {
      dimensions: workerPlan.dimensions,
      dtype: workerPlan.dtype,
      modelId: workerPlan.modelId,
      revision: workerPlan.revision,
      tokenCap: verified.tokenCap,
    },
    workerPlan,
  };
}
