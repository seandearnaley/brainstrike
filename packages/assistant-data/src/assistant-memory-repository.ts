/**
 * The assistant thread repository's public surface.
 *
 * BST-1651 split the 4,180-line original along cohesion seams into
 * `./assistant-memory/`; this module keeps the import path every caller and
 * test already uses, and names each export explicitly so the internal helpers
 * the split had to export across module boundaries do NOT leak into the
 * package's public API.
 */
export {
  CROSS_ROOT_USAGE_AGGREGATION_SQL,
  mapCrossRootUsageRow,
  mapRunLedgerRow,
  RUN_LEDGER_AGGREGATION_SQL,
  RUN_LEDGER_DEFAULT_LIMIT,
} from './assistant-memory/assistant-run-ledger.js';
export { createAssistantThreadHistoryAdapter } from './assistant-memory/assistant-thread-history-adapter.js';
export {
  assertBulkThreadMetadataPatch,
  assertPersistableThreadMetadataForTest,
  sanitizeThreadMetadataForTest,
} from './assistant-memory/assistant-thread-metadata.js';
export { createPgliteAssistantThreadRepository } from './assistant-memory/assistant-thread-repository.js';
export {
  AssistantMemorySchemaMissingError,
  requiredAssistantMemoryRelations,
} from './assistant-memory/assistant-thread-schema.js';
export type {
  AssistantMemoryThread,
  AssistantRunOutcomeSource,
  AssistantRunOutcomeVerdict,
  AssistantThreadColorId,
  AssistantThreadIconId,
  AssistantThreadMessageListOptions,
  AssistantThreadMetadata,
  AssistantThreadRepository,
  AssistantThreadRunEventListOptions,
  AssistantThreadRunRecord,
  AssistantThreadRunStatus,
  AssistantThreadRuntimeKind,
  CompleteAssistantThreadRunInput,
  CreateAssistantThreadRunInput,
  CrossRootUsageRow,
  RecordAssistantMessageParentInput,
  RecordRunOutcomeInput,
  RecordRunUsageInput,
  RunLedgerListOptions,
  RunLedgerRow,
  ThreadCumulativeUsage,
  ThreadModelUsageSubtotal,
} from './assistant-memory/assistant-thread-types.js';
export {
  ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
  ASSISTANT_THREAD_COLOR_IDS,
  ASSISTANT_THREAD_ICON_IDS,
} from './assistant-memory/assistant-thread-types.js';
