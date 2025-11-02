// Main components

export {
  EmbeddingQueueProvider,
  useEmbeddingQueue,
} from './embedding-queue-provider';
// Embedding set management
export * from './embedding-set-management';
export { QueueHud } from './queue-hud';
// Vector preferences
export * from './vector-preferences';
export { VectorStatus, VectorStatusWithDb } from './vector-status';
// Vector status hooks
export { useEmbeddingWorkerControls } from './vector-status/use-embedding-worker-controls';
export { useVectorQueueState } from './vector-status/use-vector-queue-state';
export type { VectorQueueService } from './vector-status/vector-queue-service';
// Vector queue service
export { createVectorQueueService } from './vector-status/vector-queue-service';
export { VectorStatusWithDialog } from './vector-status-with-dialog';
