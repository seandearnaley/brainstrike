export type { ThreadGroupsPort, ThreadGroupsReply, ThreadGroupsRequest } from '@brainstrike/types';
export {
  IndexerRequiredError,
  StateStoreReadOnlyError,
  ThreadDamagedError,
  ThreadReadOnlyError,
} from './errors.ts';
export {
  type Decoded,
  decodeEvent,
  type EventSchema,
  type LooseEvent,
  type Mode,
  type Purged,
  UnknownEventError,
  type Unreadable,
} from './event-schema.ts';
export {
  ForeignLockError,
  joinProcessExit,
  type LockOptions,
  type LockOwner,
  processStartTime,
  type RootHolder,
  RootLock,
  RootLockedError,
} from './lock.ts';
export type {
  McpTaskDomainReply,
  McpTaskDomainRequest,
  McpTaskDomainRow,
  McpTaskIdentityWire,
  McpTaskInsertWire,
  McpTaskLeaseWire,
  McpTaskPatchWire,
  McpTaskScopeWire,
  McpTaskStatusWire,
} from './mcp-task-types.ts';
export { MemoryCalculatorError } from './memory-calculator.ts';
export type {
  MemoryCalculation,
  MemoryDomainPort,
  MemoryDomainRequest,
  MemoryEntity,
  MemoryEntityChange,
  MemoryJson,
  MemoryJsonObject,
  MemoryNativeCalculator,
  MemoryNativeMethod,
  MemoryNativeRequest,
  MemorySnapshot,
} from './memory-types.ts';
export type {
  ModelChoice,
  ModelChoicePort,
  ModelChoiceRequest,
  ModelChoiceResult,
  ModelChoiceSnapshot,
  ProviderChoice,
} from './model-choice-types.ts';
export {
  CHILD_CLOSE_BUDGET_MS,
  CHILD_SIGNAL_GRACE_MS,
  type NativeChild,
  type NativeChildObserver,
  observeNativeChildren,
  spawnNativeChild,
  trackNativeChild,
} from './native-children.ts';
export { canonicalRoot } from './root-identity.ts';
export { blobsOf, TOMBSTONE_BODY, withSeq } from './run-log-format.mjs';
export type { AppendItem, BlobContent, LogRow, RunEvent, ThreadStatus } from './run-log-types.ts';
export { SCHEMA_VERSION } from './schema.mjs';
export { CheckpointBlockedError } from './sqlite-checkpoint.mjs';
export {
  type MemoryObservationRecord,
  type MemoryThreadBinding,
  type ReadItem,
  readAll,
  SqliteReader,
} from './sqlite-reader.ts';
export {
  BLOB_MIN_BYTES,
  BLOBS_DIR,
  type HydrationThread,
  type IndexerPort,
  largeText,
  PREVIEW_CHARS,
  type PurgeReport,
  STATE_DB,
  STORE_ENTRIES,
  StateStore,
  type StateStoreHooks,
  type StateStoreOptions,
  StateStoreStartupError,
  type StateStoreStartupOwner,
  type StoredText,
  type StoreSettings,
  type SyncSpan,
  sha256Hex,
  type WriteSpan,
} from './state-store.ts';
export { StateTruthReader, type TruthConnection } from './state-truth-reader.ts';
export { assertNotSyncedRoot, type SyncEnv, SyncedRootError } from './sync-roots.ts';
export type { ViewFilterPresetPort } from './view-filter-preset-types.ts';
export type {
  WorkspaceRootPort,
  WorkspaceRootRecord,
  WorkspaceRootReply,
  WorkspaceRootRequest,
} from './workspace-root-types.ts';
export type {
  WorktreeLedgerPort,
  WorktreeLedgerReply,
  WorktreeLedgerRequest,
} from './worktree-ledger-types.ts';
export { repositoryRootFromCommonDir } from './worktree-repository-root.ts';
