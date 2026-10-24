import type { EmbeddingDevice, EmbeddingDType } from './embedding-worker-protocol.ts';

/**
 * BST-2241: whether a model's files for one load plan are all in the embedding
 * realm's model cache. The plan is the one a Settings download loads (the
 * catalog's pinned revision, the device's dtype), so "downloaded" means that
 * download would fetch nothing.
 */
export interface ModelCachePlan {
  readonly device: EmbeddingDevice;
  readonly dtype: EmbeddingDType;
  readonly modelId: string;
  readonly revision?: string;
}

/** Posted to an embedding worker; it answers with one result or error for `id`. */
export interface ModelCacheStatusRequest {
  readonly id: string;
  readonly plans: readonly ModelCachePlan[];
  readonly type: 'model-cache-status';
}

export interface ModelCacheStatusResult {
  /** One answer per requested plan, in request order. */
  readonly cached: readonly boolean[];
  readonly id: string;
  readonly type: 'model-cache-status-result';
}

export interface ModelCacheStatusError {
  readonly id: string;
  readonly message: string;
  readonly type: 'model-cache-status-error';
}

export type ModelCacheStatusResponse = ModelCacheStatusError | ModelCacheStatusResult;

const DEVICES: ReadonlySet<unknown> = new Set(['webgpu', 'wasm']);
const DTYPES: ReadonlySet<unknown> = new Set(['fp16', 'q4', 'q8', 'fp32']);
const REVISION = /^[a-f0-9]{40}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** Decode one plan; a malformed device, dtype or revision pin refuses. */
export function assertModelCachePlan(value: unknown): ModelCachePlan {
  const plan = record(value, 'Model cache plan');
  const { device, dtype, modelId, revision } = plan;
  if (
    Object.keys(plan).some(
      (key) => key !== 'device' && key !== 'dtype' && key !== 'modelId' && key !== 'revision'
    ) ||
    !DEVICES.has(device) ||
    !DTYPES.has(dtype) ||
    !(typeof modelId === 'string' && modelId.trim().length > 0) ||
    !(revision === undefined || (typeof revision === 'string' && REVISION.test(revision)))
  ) {
    throw new Error('Model cache plan must be { modelId, device, dtype, revision? }.');
  }
  return {
    device: device as EmbeddingDevice,
    dtype: dtype as EmbeddingDType,
    modelId,
    ...(revision === undefined ? {} : { revision: revision as string }),
  };
}

export function assertModelCacheStatusRequest(value: unknown): ModelCacheStatusRequest {
  const request = record(value, 'Model cache status request');
  const { id, plans, type } = request;
  if (
    type !== 'model-cache-status' ||
    !(typeof id === 'string' && id.length > 0) ||
    !Array.isArray(plans)
  ) {
    throw new Error('Model cache status request must be { type, id, plans[] }.');
  }
  return { id, plans: plans.map(assertModelCachePlan), type };
}

/** Decode the worker's answer to `request`; a count that differs from its plans refuses. */
export function assertModelCacheStatusResponse(
  value: unknown,
  request: Pick<ModelCacheStatusRequest, 'id' | 'plans'>
): ModelCacheStatusResponse {
  const response = record(value, 'Model cache status response');
  if (response['id'] !== request.id) {
    throw new Error('Model cache status response answers another request.');
  }
  if (response['type'] === 'model-cache-status-error') {
    const message = response['message'];
    if (!(typeof message === 'string' && message.length > 0)) {
      throw new Error('Model cache status error must carry a message.');
    }
    return { id: request.id, message, type: 'model-cache-status-error' };
  }
  const cached = response['cached'];
  if (
    response['type'] !== 'model-cache-status-result' ||
    !Array.isArray(cached) ||
    cached.length !== request.plans.length ||
    !cached.every((entry) => typeof entry === 'boolean')
  ) {
    throw new Error('Model cache status result must answer every plan with a boolean.');
  }
  return { cached, id: request.id, type: 'model-cache-status-result' };
}
