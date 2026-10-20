import { assertModelCachePlan, type ModelCachePlan } from '@brainstrike/indexing-contract';
import type {
  RuntimeErrorEnvelope,
  RuntimeRequestEnvelope,
  RuntimeResultEnvelope,
} from '@brainstrike/worker-runtime';
import {
  createRequestId,
  deserializeRuntimeError,
  serializeRuntimeError,
} from '@brainstrike/worker-runtime';
import { assertRuntimeObjectPayloadEnvelope } from '@brainstrike/worker-runtime/validation';
import { assertEmbeddingHostErrorPayload } from './embedding-host-shared';
import { createHostRequestChannel, type HostRequestChannel } from './platform/host-request-channel';

/**
 * Settings asks the embedding host which catalog models' download plans are
 * fully in its model cache (BST-2241), with one request and one response, as
 * it asks for WebGPU detection (BST-1993). The host's own embedding worker
 * reads the cache; Settings never loads Transformers.js.
 */
export type EmbeddingHostModelCacheRequest = RuntimeRequestEnvelope<
  'model-cache-status',
  { readonly plans: readonly ModelCachePlan[] }
>;
export type EmbeddingHostModelCacheResultReport = RuntimeResultEnvelope<
  'model-cache-status-result',
  { readonly cached: readonly boolean[] }
>;
export type EmbeddingHostModelCacheErrorReport = RuntimeErrorEnvelope<'model-cache-status-error'>;
export type EmbeddingHostModelCacheResponseReport =
  | EmbeddingHostModelCacheErrorReport
  | EmbeddingHostModelCacheResultReport;

export function createEmbeddingHostModelCacheRequest(
  runtimeId: string,
  plans: readonly ModelCachePlan[]
): EmbeddingHostModelCacheRequest {
  return {
    channel: 'model-cache-status',
    payload: { plans: plans.map(assertModelCachePlan) },
    requestId: createRequestId('embedding-host-model-cache'),
    runtimeId,
    type: 'request',
  };
}

export function assertEmbeddingHostModelCacheRequest(
  value: unknown
): EmbeddingHostModelCacheRequest {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Embedding host model cache request'
  );
  if (envelopeBase.type !== 'request' || envelopeBase.channel !== 'model-cache-status') {
    throw new Error(
      'Embedding host model cache request must have type="request" and channel="model-cache-status".'
    );
  }
  const { plans } = payload;
  if (Object.keys(payload).some((key) => key !== 'plans') || !Array.isArray(plans)) {
    throw new Error('Embedding host model cache request must carry exactly { plans[] }.');
  }
  return {
    channel: 'model-cache-status',
    payload: { plans: plans.map(assertModelCachePlan) },
    requestId: envelopeBase.requestId,
    runtimeId: envelopeBase.runtimeId,
    type: 'request',
  };
}

export function createEmbeddingHostModelCacheResultReport(
  request: EmbeddingHostModelCacheRequest,
  cached: readonly boolean[]
): EmbeddingHostModelCacheResultReport {
  return {
    channel: 'model-cache-status-result',
    payload: { cached: [...cached] },
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'result',
  };
}

export function createEmbeddingHostModelCacheErrorReport(
  request: EmbeddingHostModelCacheRequest,
  error: unknown
): EmbeddingHostModelCacheErrorReport {
  return {
    channel: 'model-cache-status-error',
    payload: serializeRuntimeError(error),
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'error',
  };
}

export function assertEmbeddingHostModelCacheResponseReport(
  value: unknown
): EmbeddingHostModelCacheResponseReport {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Embedding host model cache response'
  );
  if (envelopeBase.type === 'result' && envelopeBase.channel === 'model-cache-status-result') {
    const { cached } = payload;
    if (
      Object.keys(payload).some((key) => key !== 'cached') ||
      !Array.isArray(cached) ||
      !cached.every((entry) => typeof entry === 'boolean')
    ) {
      throw new Error('Embedding host model cache result must be exactly { cached: boolean[] }.');
    }
    return {
      channel: 'model-cache-status-result',
      payload: { cached },
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      type: 'result',
    };
  }
  if (envelopeBase.type === 'error' && envelopeBase.channel === 'model-cache-status-error') {
    return {
      channel: 'model-cache-status-error',
      payload: assertEmbeddingHostErrorPayload(payload),
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      type: 'error',
    };
  }
  throw new Error('Embedding host model cache response has an unknown type or channel.');
}

/** The exchange's correlation is the shared host request channel, as WebGPU detection's is. */
export function createModelCacheRequestChannel(
  send: (request: EmbeddingHostModelCacheRequest) => void,
  timeoutMs: number
): HostRequestChannel<EmbeddingHostModelCacheRequest, EmbeddingHostModelCacheResponseReport> {
  return createHostRequestChannel({
    requestId: (request) => `${request.runtimeId}:${request.requestId}`,
    responseId: (response) => `${response.runtimeId}:${response.requestId}`,
    role: 'Embedding host model cache',
    send,
    timeoutMs: () => timeoutMs,
  });
}

/** One answer per requested plan, or the host's cache read failure as an error. */
export function readModelCacheResponse(
  request: EmbeddingHostModelCacheRequest,
  response: EmbeddingHostModelCacheResponseReport
): readonly boolean[] {
  if (response.type === 'error') {
    throw deserializeRuntimeError(response.payload);
  }
  if (response.payload.cached.length !== request.payload.plans.length) {
    throw new Error('The embedding host answered a different number of model cache plans.');
  }
  return response.payload.cached;
}
