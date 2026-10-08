import { fork } from 'node:child_process';
import type { IndexerPort as StateStoreIndexerPort } from '@brainstrike/state-store';
import type {
  CommitResult,
  FilePlan,
  IndexerCoverage,
  IndexerIdentity,
  IndexerInfo,
  IndexerManifestResult,
  ScopedCoverage,
  ScopedFilePlan,
  ScopedManifestResult,
  ScopedSearchResult,
  SearchResult,
  StateMessageHit,
  StateMessagePlan,
  StateMessagePrepare,
  StateMessagePurge,
  StateMessageQuery,
  StateMessageUpsert,
  StateMessageUpsertResult,
  StateObservationHit,
  StateObservationPlan,
  StateObservationPrepare,
  StateObservationPurge,
  StateObservationQuery,
  StateObservationUpsert,
  StateProjectionStats,
} from './contracts.js';
import type { CoverageAuthorityPort } from './coverage-authority.js';
import {
  createIndexerConnection,
  validateIndexerDeadlines,
  validateIndexerOptions,
} from './transport.js';

export { embeddingProfileHash, fileChunks } from './chunks.js';
export type {
  CommitResult,
  EmbeddingProfile,
  EmbeddingState,
  FileChunk,
  FileCommit,
  FilePlan,
  FileSnapshot,
  FileSyntax,
  IndexerCoverage,
  IndexerIdentity,
  IndexerInfo,
  IndexerManifestRequest,
  IndexerManifestResult,
  IndexerOptions,
  IndexFileBinding,
  IndexScope,
  ProvidedChunk,
  ProvidedFileSnapshot,
  ScopedCoverage,
  ScopedCoverageRequest,
  ScopedFilePlan,
  ScopedFileSnapshot,
  ScopedManifestChunk,
  ScopedManifestFile,
  ScopedManifestRequest,
  ScopedManifestResult,
  ScopedSearchResult,
  SearchRequest,
  SearchResult,
  StateMessageHit,
  StateMessageIdentity,
  StateMessagePlan,
  StateMessagePrepare,
  StateMessagePurge,
  StateMessageQuery,
  StateMessageScope,
  StateMessageUpsert,
  StateMessageUpsertResult,
  StateObservationGroup,
  StateObservationHit,
  StateObservationPlan,
  StateObservationPrepare,
  StateObservationPurge,
  StateObservationQuery,
  StateObservationScope,
  StateObservationSource,
  StateObservationUpsert,
  StateProjectionOptions,
  StateProjectionStats,
  TextFileCommit,
  VectorProfile,
} from './contracts.js';
export { IndexerError } from './contracts.js';
export { vectorProfileHash } from './scope-authority.js';
export type { StateMessageEvent, StateProducerDecoder } from './state-projection.js';
export type { IndexerDeadlines } from './transport.js';
export { IndexerLifecycleError } from './transport.js';
export interface IndexerPort {
  close(): Promise<void>;
  commitFile(commit: unknown): Promise<CommitResult>;
  commitTextFile(commit: unknown): Promise<CommitResult>;
  configureVectorProfile(profile: unknown): Promise<IndexerIdentity>;
  coverage(request: unknown): Promise<IndexerCoverage>;
  destroy(): Promise<void>;
  info(): Promise<IndexerInfo>;
  prepareFile(snapshot: unknown): Promise<FilePlan>;
  removeFile(identity: unknown): Promise<boolean>;
  search(request: unknown): Promise<SearchResult>;
  verifyManifest(request: unknown): Promise<IndexerManifestResult>;
}
/** Physical canonical vector-payload erasure; ordinary logical removal keeps its existing cost. */
export interface PurgeIndexerPort {
  /**
   * Returns whether rows were removed. Every success completes the checked vector-payload/WAL
   * checkpoint. File rows and FTS entries are deleted logically; historical FTS token erasure
   * is outside this capability's physical-erasure promise.
   */
  purgeFile(identity: unknown): Promise<boolean>;
}
/** Trusted main/catalog owner port. Never forward renderer-supplied binding inventories. */
export interface ScopedIndexerPort {
  commitScopedFile(commit: unknown): Promise<CommitResult>;
  commitScopedTextFile(commit: unknown): Promise<CommitResult>;
  coverageBatch(requests: unknown): Promise<readonly ScopedCoverage[]>;
  coverageScope(request: unknown): Promise<ScopedCoverage>;
  prepareScopedFile(request: unknown): Promise<ScopedFilePlan>;
  removeScopedFile(identity: unknown): Promise<boolean>;
  replaceFileBindings(bindings: unknown): Promise<void>;
  searchScopes(request: unknown): Promise<ScopedSearchResult>;
  verifyScopedManifest(request: unknown): Promise<ScopedManifestResult>;
}
/** Acquired Root owner only. Join external inference before purge/reset. */
export interface StateMessageVectorPort {
  prepareStateMessageVectors(request: StateMessagePrepare): Promise<StateMessagePlan>;
  purgeStateMessageVectors(request: StateMessagePurge): Promise<boolean>;
  queryStateMessageVectors(request: StateMessageQuery): Promise<readonly StateMessageHit[]>;
  upsertStateMessageVectors(request: StateMessageUpsert): Promise<StateMessageUpsertResult>;
}
/** Borrowed native OM route, sharing the existing writer and lifecycle fence. */
export interface StateObservationVectorPort {
  prepareStateObservationVectors(request: StateObservationPrepare): Promise<StateObservationPlan>;
  purgeStateObservationVectors(request: StateObservationPurge): Promise<boolean>;
  queryStateObservationVectors(
    request: StateObservationQuery
  ): Promise<readonly StateObservationHit[]>;
  upsertStateObservationVectors(request: StateObservationUpsert): Promise<readonly string[]>;
}
export interface StateIndexerPort {
  catchUpState(threads: readonly string[]): Promise<void>;
  dropStateThread(threadId: string): Promise<readonly string[]>;
  matchState(threadId: string, query: string): Promise<readonly number[]>;
  rebuildState(threadId: string): Promise<void>;
  reindexState(threadId: string, seq: number): Promise<void>;
  stateBlobCounts(
    threads: readonly string[],
    hashes: readonly string[]
  ): Promise<Readonly<Record<string, number>>>;
  stateHealth(): Promise<{ readonly indexerErrors: readonly string[] }>;
  stateStats(threadId: string): Promise<StateProjectionStats>;
}
export interface StateStoreProjectionPort extends StateStoreIndexerPort {
  health(): Promise<{ readonly indexerErrors: readonly string[] }>;
  match(threadId: string, query: string): Promise<readonly number[]>;
  rebuild(threadId: string): Promise<void>;
  stats(threadId: string): Promise<StateProjectionStats>;
}
export function createStateStoreIndexer(
  port: StateIndexerPort & Pick<IndexerPort, 'destroy'>
): StateStoreProjectionPort {
  return {
    catchUp: (threads) => port.catchUpState(threads),
    dropThread: (threadId) => port.dropStateThread(threadId),
    gcCheck: (threads, hashes) => port.stateBlobCounts(threads, hashes),
    health: () => port.stateHealth(),
    match: (threadId, query) => port.matchState(threadId, query),
    rebuild: (threadId) => port.rebuildState(threadId),
    reindex: (threadId, seq) => port.reindexState(threadId, seq),
    reset: () => port.destroy(),
    stats: (threadId) => port.stateStats(threadId),
  };
}
export async function openIndexer(
  input: unknown,
  deadlineInput: unknown
): Promise<
  IndexerPort &
    PurgeIndexerPort &
    ScopedIndexerPort &
    StateIndexerPort &
    StateMessageVectorPort &
    StateObservationVectorPort &
    CoverageAuthorityPort
> {
  if (process.versions['electron']) {
    throw new Error('Standalone indexer requires Node; use the explicit Electron utility adapter.');
  }
  const options = validateIndexerOptions(input);
  const deadlines = validateIndexerDeadlines(deadlineInput);
  const child = fork(new URL('./process-entry.js', import.meta.url), [], {
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const sendErrors = new Set<(error: unknown) => void>();
  const connection = createIndexerConnection(options, deadlines, {
    kill: () => child.kill(),
    onError: (listener) => {
      child.on('error', listener);
      sendErrors.add(listener);
      return () => {
        child.off('error', listener);
        sendErrors.delete(listener);
      };
    },
    onExit: (listener) => {
      child.on('exit', listener);
      return () => {
        child.off('exit', listener);
      };
    },
    onMessage: (listener) => {
      child.on('message', listener);
      return () => {
        child.off('message', listener);
      };
    },
    send: (message) => {
      child.send(message, (error) => {
        if (error) {
          // Route asynchronous send failures through the transport owner.
          // Re-emitting Node's special 'error' event after exit/listener disposal
          // would throw; pending operations already fail on the joined exit.
          for (const listener of sendErrors) {
            listener(error);
          }
        }
      });
    },
  });
  return connection.ready;
}
