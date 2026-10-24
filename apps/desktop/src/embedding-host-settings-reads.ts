import type { ModelCachePlan, WebGpuAdapterAvailability } from '@brainstrike/indexing-contract';
import {
  createEmbeddingHostModelCacheRequest,
  createModelCacheRequestChannel,
  type EmbeddingHostModelCacheResponseReport,
  readModelCacheResponse,
} from './embedding-host-model-cache';
import {
  EMBEDDING_HOST_MODEL_CACHE_STATUS_REQUEST_EVENT,
  EMBEDDING_HOST_WEBGPU_ADAPTER_REQUEST_EVENT,
} from './embedding-host-shared';
import {
  createEmbeddingHostWebGpuAdapterRequest,
  createWebGpuAdapterRequestChannel,
  type EmbeddingHostWebGpuAdapterResponseReport,
  readWebGpuAdapterResponse,
} from './embedding-host-webgpu-adapter';

/** What the settings reads need from the host manager that owns the window. */
export interface EmbeddingHostSettingsReadsPort {
  /** Starts the host without admitting a worker; resolves the running host's runtime id. */
  ensureRunning(): Promise<string>;
  /** The running host window's webContents id, the only sender a response is taken from. */
  hostSenderId(): number | undefined;
  send(event: string, request: unknown): void;
  readonly timeoutMs: number;
}

/**
 * Settings' reads of the running embedding host, each one request with one
 * response: its WebGPU detection (BST-1993) and which download plans are in
 * its model cache (BST-2241). Neither loads a model.
 */
export class EmbeddingHostSettingsReads {
  private readonly webgpuAdapterRequests: ReturnType<typeof createWebGpuAdapterRequestChannel>;
  private readonly modelCacheRequests: ReturnType<typeof createModelCacheRequestChannel>;

  private readonly port: EmbeddingHostSettingsReadsPort;

  constructor(port: EmbeddingHostSettingsReadsPort) {
    this.port = port;
    this.webgpuAdapterRequests = createWebGpuAdapterRequestChannel(
      (request) => port.send(EMBEDDING_HOST_WEBGPU_ADAPTER_REQUEST_EVENT, request),
      port.timeoutMs
    );
    this.modelCacheRequests = createModelCacheRequestChannel(
      (request) => port.send(EMBEDDING_HOST_MODEL_CACHE_STATUS_REQUEST_EVENT, request),
      port.timeoutMs
    );
  }

  async webgpuAdapter(): Promise<WebGpuAdapterAvailability> {
    const request = createEmbeddingHostWebGpuAdapterRequest(await this.port.ensureRunning());
    return readWebGpuAdapterResponse(await this.webgpuAdapterRequests.request(request));
  }

  acceptWebGpuAdapterResponseReport(
    senderId: number,
    report: EmbeddingHostWebGpuAdapterResponseReport
  ): void {
    if (senderId === this.port.hostSenderId()) {
      this.webgpuAdapterRequests.accept(report);
    }
  }

  /** One answer per plan, in order: whether the plan's files are all in the host's cache. */
  async modelCacheStatus(plans: readonly ModelCachePlan[]): Promise<readonly boolean[]> {
    if (plans.length === 0) {
      return [];
    }
    const request = createEmbeddingHostModelCacheRequest(await this.port.ensureRunning(), plans);
    return readModelCacheResponse(request, await this.modelCacheRequests.request(request));
  }

  acceptModelCacheStatusResponseReport(
    senderId: number,
    report: EmbeddingHostModelCacheResponseReport
  ): void {
    if (senderId === this.port.hostSenderId()) {
      this.modelCacheRequests.accept(report);
    }
  }

  rejectAll(failure: (requestId: string) => Error): void {
    this.webgpuAdapterRequests.rejectAll(failure);
    this.modelCacheRequests.rejectAll(failure);
  }
}
