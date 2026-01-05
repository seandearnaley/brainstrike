// Main components

// Shared collection select base component
export type {
  CollectionRow,
  CollectionSelectProps,
  CollectionSelectSize,
  CollectionWithDocCount,
} from './collection-select';
export { CollectionSelect, formatCollectionLabel, useCollections } from './collection-select';
export { EmbeddingJobQueueTracker } from './embedding-job-queue-tracker';
export {
  EmbeddingQueueProvider,
  useEmbeddingQueue,
  useEmbeddingQueueSafe,
} from './embedding-queue-provider';
// Embedding set management
export * from './embedding-set-management';
// Queue HUD and Diagnostics (BST-166)
export { QueueDiagnosticsPanel } from './queue-diagnostics-panel';
export { QueueHud } from './queue-hud';
export type {
  UseQueueHealthMetricsOptions,
  UseQueueHealthMetricsReturn,
} from './use-queue-health-metrics';
export { useQueueHealthMetrics } from './use-queue-health-metrics';
// Vector preferences
export * from './vector-preferences';
export { VectorStatus, VectorStatusWithDb } from './vector-status';
// Embedding set selector for self-contained vector status
export type { EmbeddingSetSelectorProps } from './vector-status/embedding-set-selector';
export {
  EmbeddingSetSelector,
  useEmbeddingSetSelection,
} from './vector-status/embedding-set-selector';
// Vector status hooks
export { useEmbeddingWorkerControls } from './vector-status/use-embedding-worker-controls';
export { useVectorQueueState } from './vector-status/use-vector-queue-state';
export type { VectorQueueService } from './vector-status/vector-queue-service';
// Vector queue service
export { createVectorQueueService } from './vector-status/vector-queue-service';
export { VectorStatusWithDialog } from './vector-status-with-dialog';
