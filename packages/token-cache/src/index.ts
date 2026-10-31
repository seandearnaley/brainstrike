/**
 * @brainstrike/token-cache
 *
 * Token cache with background worker for file explorer.
 *
 * Features:
 * - In-memory cache over a caller-supplied store (the explorer's is in-memory too)
 * - xxHash64 content hashing for change detection
 * - Background Web Worker for non-blocking token counting
 * - React hook for easy integration
 */

export * from './background-indexer';
export * from './cache-runtime';
// Telemetry (BST-154)
export type {
  IndexedFileTelemetryEvent,
  IndexerTelemetryEvent,
  IndexerTelemetryEventType,
  IndexerTelemetryListener,
  IndexerTelemetrySnapshot,
  IndexingBacklogTelemetryEvent,
  IndexingErrorTelemetryEvent,
} from './telemetry';
export {
  addIndexerTelemetryListener,
  createIndexerTelemetryAggregator,
  emitIndexedFile,
  emitIndexerTelemetry,
  emitIndexingBacklog,
  emitIndexingError,
} from './telemetry';
// Telemetry React Hook (BST-154)
export type {
  UseIndexerTelemetryOptions,
  UseIndexerTelemetryReturn,
} from './use-indexer-telemetry';
export { useIndexerTelemetry } from './use-indexer-telemetry';
