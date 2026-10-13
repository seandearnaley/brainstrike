import type { WebGpuAdapterAvailability } from '@brainstrike/indexing-contract';
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
 * Settings asks the embedding host for its own WebGPU detection with one request and one
 * response (BST-1993). This exchange is the detection's only carrier: status reports never
 * carry it, so every status stays canonical for the renderer's runtime store.
 */
export type EmbeddingHostWebGpuAdapterRequest = RuntimeRequestEnvelope<
  'webgpu-adapter',
  Record<string, never>
>;
export type EmbeddingHostWebGpuAdapterResultReport = RuntimeResultEnvelope<
  'webgpu-adapter-result',
  WebGpuAdapterAvailability
>;
export type EmbeddingHostWebGpuAdapterErrorReport = RuntimeErrorEnvelope<'webgpu-adapter-error'>;
export type EmbeddingHostWebGpuAdapterResponseReport =
  | EmbeddingHostWebGpuAdapterErrorReport
  | EmbeddingHostWebGpuAdapterResultReport;

export function createEmbeddingHostWebGpuAdapterRequest(
  runtimeId: string
): EmbeddingHostWebGpuAdapterRequest {
  return {
    channel: 'webgpu-adapter',
    payload: {},
    requestId: createRequestId('embedding-host-webgpu-adapter'),
    runtimeId,
    type: 'request',
  };
}

export function assertEmbeddingHostWebGpuAdapterRequest(
  value: unknown
): EmbeddingHostWebGpuAdapterRequest {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Embedding host WebGPU adapter request'
  );
  if (envelopeBase.type !== 'request' || envelopeBase.channel !== 'webgpu-adapter') {
    throw new Error(
      'Embedding host WebGPU adapter request must have type="request" and channel="webgpu-adapter".'
    );
  }
  if (Object.keys(payload).length > 0) {
    throw new Error('Embedding host WebGPU adapter request carries no payload.');
  }
  return {
    channel: 'webgpu-adapter',
    payload: {},
    requestId: envelopeBase.requestId,
    runtimeId: envelopeBase.runtimeId,
    type: 'request',
  };
}

export function createEmbeddingHostWebGpuAdapterResultReport(
  request: EmbeddingHostWebGpuAdapterRequest,
  availability: WebGpuAdapterAvailability
): EmbeddingHostWebGpuAdapterResultReport {
  return {
    channel: 'webgpu-adapter-result',
    payload: { available: availability.available, reason: availability.reason },
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'result',
  };
}

export function createEmbeddingHostWebGpuAdapterErrorReport(
  request: EmbeddingHostWebGpuAdapterRequest,
  error: unknown
): EmbeddingHostWebGpuAdapterErrorReport {
  return {
    channel: 'webgpu-adapter-error',
    payload: serializeRuntimeError(error),
    requestId: request.requestId,
    runtimeId: request.runtimeId,
    type: 'error',
  };
}

export function assertEmbeddingHostWebGpuAdapterResponseReport(
  value: unknown
): EmbeddingHostWebGpuAdapterResponseReport {
  const { envelopeBase, payload } = assertRuntimeObjectPayloadEnvelope(
    value,
    'Embedding host WebGPU adapter response'
  );
  if (envelopeBase.type === 'result' && envelopeBase.channel === 'webgpu-adapter-result') {
    const { available, reason } = payload;
    if (
      Object.keys(payload).some((key) => key !== 'available' && key !== 'reason') ||
      typeof available !== 'boolean' ||
      !(typeof reason === 'string' && reason.trim().length > 0)
    ) {
      throw new Error(
        'Embedding host WebGPU adapter result must be exactly { available: boolean, reason: string }.'
      );
    }
    return {
      channel: 'webgpu-adapter-result',
      payload: { available, reason },
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      type: 'result',
    };
  }
  if (envelopeBase.type === 'error' && envelopeBase.channel === 'webgpu-adapter-error') {
    return {
      channel: 'webgpu-adapter-error',
      payload: assertEmbeddingHostErrorPayload(payload),
      requestId: envelopeBase.requestId,
      runtimeId: envelopeBase.runtimeId,
      type: 'error',
    };
  }
  throw new Error('Embedding host WebGPU adapter response has an unknown type or channel.');
}

/**
 * The exchange's correlation is the shared host request channel every host manager uses:
 * its per-request deadline, reject-all and runtime-scoped ids are the query requests' own.
 */
export function createWebGpuAdapterRequestChannel(
  send: (request: EmbeddingHostWebGpuAdapterRequest) => void,
  timeoutMs: number
): HostRequestChannel<EmbeddingHostWebGpuAdapterRequest, EmbeddingHostWebGpuAdapterResponseReport> {
  return createHostRequestChannel({
    requestId: (request) => `${request.runtimeId}:${request.requestId}`,
    responseId: (response) => `${response.runtimeId}:${response.requestId}`,
    role: 'Embedding host WebGPU adapter',
    send,
    timeoutMs: () => timeoutMs,
  });
}

/** The detection a response carries, or the host's detection failure as an error. */
export function readWebGpuAdapterResponse(
  response: EmbeddingHostWebGpuAdapterResponseReport
): WebGpuAdapterAvailability {
  if (response.type === 'error') {
    throw deserializeRuntimeError(response.payload);
  }
  return response.payload;
}
