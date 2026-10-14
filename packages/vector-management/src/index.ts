// Main components

// Shared collection select base component
export type {
  CollectionRow,
  CollectionSelectProps,
  CollectionSelectSize,
  CollectionWithDocCount,
  EmbeddingSetEventCollection,
  EmbeddingSetUpdatedEventDetail,
} from './collection-select/index.js';
export {
  CollectionSelect,
  canonicalizeCollectionTimestamps,
  dispatchEmbeddingSetUpdated,
  fetchCollectionsSnapshot,
  formatCollectionLabel,
  toCanonicalTimestamp,
  useCollections,
} from './collection-select/index.js';
// Embedding actions dropdown (split button for backfill/retry/clear/wipe)
export type { EmbeddingActionsDropdownProps } from './embedding-actions-dropdown';
export { EmbeddingActionsDropdown } from './embedding-actions-dropdown';
// Embedding controls panel (self-contained controls with status bar)
export type { EmbeddingControlsPanelProps } from './embedding-controls-panel';
export { EmbeddingControlsPanel } from './embedding-controls-panel';
export { EmbeddingJobQueueTracker } from './embedding-job-queue-tracker';
export {
  EmbeddingQueueProvider,
  useEmbeddingQueue,
  useEmbeddingQueueSafe,
} from './embedding-queue-provider';
export { EmbeddingRuntimeProvider, useSharedEmbeddingRuntime } from './embedding-runtime-provider';
// Embedding set management
export * from './embedding-set-management';
// Embedding status bar (compact metrics display)
export type { EmbeddingStatusBarProps } from './embedding-status-bar';
export { EmbeddingStatusBar } from './embedding-status-bar';
export { IndexingActivityCoordinator } from './indexing-activity-coordinator';
// Queue HUD and Diagnostics (BST-166)
export { QueueDiagnosticsPanel } from './queue-diagnostics-panel';
export { QueueHud } from './queue-hud';
export { QueueStatusPopover } from './queue-status-popover';
// Shared search embedder resolution + device-loss recovery
export type {
  EmbedderRuntime,
  EmbeddingSetModelInfo,
  LocalSearchEmbedderFactory,
  SearchEmbedder,
  UseSearchEmbedderResult,
} from './search-embedder/index.js';
export {
  SearchEmbedderProvider,
  useSearchEmbedder,
  useSharedSearchEmbedder,
} from './search-embedder/index.js';
// Hook for embedding controls state (use with EmbeddingActionsDropdown and EmbeddingStatusBar)
export type {
  UseEmbeddingControlsOptions,
  UseEmbeddingControlsResult,
} from './use-embedding-controls';
export { useEmbeddingControls } from './use-embedding-controls';
export type {
  UseQueueHealthMetricsOptions,
  UseQueueHealthMetricsReturn,
} from './use-queue-health-metrics';
export { useQueueHealthMetrics } from './use-queue-health-metrics';
// Vector preferences
export * from './vector-preferences';
export { VectorStatus, VectorStatusWithDb } from './vector-status';
export { EMBEDDING_RUNTIME_STATUS_EXTENSION_KEYS } from './vector-status/embedding-runtime-controller';
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
