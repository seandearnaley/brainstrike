export {
  assertEmbeddingTelemetrySnapshot,
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingBatchTransferTelemetry,
  type EmbeddingPipelineCacheTelemetry,
  type EmbeddingPipelineCacheTelemetryEntry,
  type EmbeddingTelemetrySnapshot,
  embeddingWorkerTelemetrySink,
  getEmbeddingTelemetrySnapshot,
  recordEmbeddingBatchTelemetry,
  recordEmbeddingPipelineCacheTelemetry,
  recordEmbeddingTelemetryFailure,
  removeEmbeddingTelemetrySource,
  subscribeEmbeddingTelemetry,
  subscribeEmbeddingTelemetryThrottled,
} from './embedding-telemetry';
export {
  createEmbeddingPipelineCacheController,
  type EmbeddingPipelineCacheController,
  type EmbeddingPipelineCacheLoadRequest,
  type EmbeddingPipelineResource,
  MAX_GPU_PIPELINES,
  MAX_WASM_PIPELINES,
  type PipelineCacheDiagnosticSink,
} from './pipeline-cache-controller';
export type {
  EmbeddingDevice,
  EmbeddingDeviceHint,
  EmbeddingDType,
  EmbedWorkerBatch,
  EmbedWorkerComplete,
  EmbedWorkerError,
  EmbedWorkerPipelineCacheDiagnostic,
  EmbedWorkerPipelineCacheEntryDiagnostic,
  EmbedWorkerPipelineCacheMemoryDiagnostic,
  EmbedWorkerProgress,
  EmbedWorkerRequest,
  EmbedWorkerStreamEvent,
  EmbedWorkerSuccess,
} from './shared';
export {
  cloneAsFloat32,
  computeInitialBatchSize,
  l2Normalize,
  POWER_BROADCAST_CHANNEL,
  truncateVector,
  vectorsFromPipelineOutput,
} from './shared';
export {
  StreamingEmbeddingWorkerClient,
  type StreamingEmbedOptions,
} from './streaming-worker-client';
