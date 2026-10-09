export {
  Coalescer,
  type CoalescerLog,
  type CoalescerProbe,
  type Deliver,
  mergeChunk,
  type RunChunk,
} from './coalescer.js';
export { IndexerRequiredError, ThreadDamagedError, ThreadReadOnlyError } from './errors.js';
export {
  type Decoded,
  decodeEvent,
  type EventSchema,
  type LooseEvent,
  type Mode,
  type Purged,
  UnknownEventError,
  type Unreadable,
} from './event-schema.js';
export {
  ForeignLockError,
  type LockOptions,
  type LockOwner,
  processStartTime,
  RootLock,
  RootLockedError,
} from './lock.js';
export type {
  McpTaskDomainReply,
  McpTaskDomainRequest,
  McpTaskDomainRow,
  McpTaskIdentityWire,
  McpTaskInsertWire,
  McpTaskLeaseWire,
  McpTaskLegacyAuthorityWire,
  McpTaskLegacyTaskWire,
  McpTaskPatchWire,
  McpTaskScopeWire,
  McpTaskStatusWire,
} from './mcp-task-types.js';
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
} from './memory-types.js';
export { blobsOf, TOMBSTONE_BODY, withSeq } from './run-log-format.mjs';
export type { AppendItem, BlobContent, LogRow, RunEvent, ThreadStatus } from './run-log-types.js';
export { SCHEMA_VERSION } from './schema.mjs';
export { CheckpointBlockedError } from './sqlite-checkpoint.mjs';
export {
  type MemoryObservationRecord,
  type MemoryThreadBinding,
  type ReadItem,
  readAll,
  SqliteReader,
} from './sqlite-reader.js';
export {
  BLOB_MIN_BYTES,
  BLOBS_DIR,
  type ExportedThread,
  type IndexerPort,
  largeText,
  type Manifest,
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
} from './state-store.js';
export { assertNotSyncedRoot, type SyncEnv, SyncedRootError } from './sync-roots.js';
