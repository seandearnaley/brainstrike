export {
  assertEmbeddingTelemetrySnapshot,
  createEmptyEmbeddingTelemetrySnapshot,
  type EmbeddingBatchTransferTelemetry,
  type EmbeddingPipelineCacheTelemetry,
  type EmbeddingTelemetrySnapshot,
  getEmbeddingTelemetrySnapshot,
  recordEmbeddingBatchTelemetry,
  recordEmbeddingPipelineCacheTelemetry,
  removeEmbeddingTelemetrySource,
  resetEmbeddingTelemetryForTests,
  subscribeEmbeddingTelemetry,
} from './embedding-telemetry';
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
