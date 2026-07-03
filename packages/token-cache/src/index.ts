/**
 * @brainstrike/token-cache
 *
 * Persistent token cache with background worker for file explorer.
 *
 * Features:
 * - runtime-store-backed persistent storage
 * - xxHash64 content hashing for change detection
 * - Background Web Worker for non-blocking token counting
 * - Two-level caching (hot memory + cold persistent store)
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
