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

interface PendingWebGpuAdapterRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (availability: WebGpuAdapterAvailability) => void;
  readonly runtimeId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Main's outstanding WebGPU adapter requests, settled only by their exact response. */
export class EmbeddingHostWebGpuAdapterRequests {
  private readonly pending = new Map<string, PendingWebGpuAdapterRequest>();

  /** Starts the host on demand, then asks it; a host that did not start refuses. */
  async detect(
    start: () => Promise<{
      readonly lastError: string | null;
      readonly runtimeId: string;
      readonly state: string;
    }>,
    send: (request: EmbeddingHostWebGpuAdapterRequest) => void,
    timeoutMs: number
  ): Promise<WebGpuAdapterAvailability> {
    const status = await start();
    if (status.state !== 'running') {
      throw new Error(status.lastError ?? 'The embedding host is not running.');
    }
    return await this.request(status.runtimeId, send, timeoutMs);
  }

  request(
    runtimeId: string,
    send: (request: EmbeddingHostWebGpuAdapterRequest) => void,
    timeoutMs: number
  ): Promise<WebGpuAdapterAvailability> {
    const request = createEmbeddingHostWebGpuAdapterRequest(runtimeId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(
          new Error(`The embedding host did not report WebGPU availability in ${timeoutMs} ms.`)
        );
      }, timeoutMs);
      this.pending.set(request.requestId, { reject, resolve, runtimeId, timer });
      try {
        send(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  accept(report: EmbeddingHostWebGpuAdapterResponseReport): void {
    const pending = this.pending.get(report.requestId);
    if (!pending || pending.runtimeId !== report.runtimeId) {
      return;
    }
    this.pending.delete(report.requestId);
    clearTimeout(pending.timer);
    if (report.type === 'result') {
      pending.resolve(report.payload);
      return;
    }
    pending.reject(deserializeRuntimeError(report.payload));
  }

  rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }
}
