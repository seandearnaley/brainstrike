import { fork } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexerPort as StateStoreIndexerPort } from '@brainstrike/state-store';
import type {
  CommitResult,
  FilePlan,
  IndexerCoverage,
  IndexerInfo,
  IndexerManifestResult,
  ScopedCoverage,
  ScopedFileChunkBounds,
  ScopedFilePage,
  ScopedFilePlan,
  ScopedManifestResult,
  ScopedSearchResult,
  SearchResult,
  StateProjectionStats,
  StateSearch,
  StateSearchHit,
} from './contracts.ts';
import type { CoverageAuthorityPort } from './coverage-authority.ts';
import {
  createIndexerConnection,
  validateIndexerDeadlines,
  validateIndexerOptions,
} from './transport.ts';

export { fileChunks, vectorProfileHash } from './chunks.ts';
export type {
  CommitResult,
  FileChunk,
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
  ScopedFileChunkBounds,
  ScopedFileChunkBoundsRequest,
  ScopedFilePage,
  ScopedFilePageRequest,
  ScopedFilePlan,
  ScopedFileSnapshot,
  ScopedManifestChunk,
  ScopedManifestFile,
  ScopedManifestRequest,
  ScopedManifestResult,
  ScopedSearchResult,
  SearchRequest,
  SearchResult,
  StateProjectionOptions,
  StateProjectionStats,
  StateSearch,
  StateSearchHit,
  TextFileCommit,
  VectorProfile,
} from './contracts.ts';
export { decodeVectorProfile, IndexerError, STATE_CATCH_UP_STEP_EVENTS } from './contracts.ts';
export type { StateProducerDecoder } from './state-projection.ts';
export type { IndexerDeadlines } from './transport.ts';
export interface IndexerPort {
  close(): Promise<void>;
  commitTextFile(commit: unknown): Promise<CommitResult>;
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
  /** Prepare and commit TEXT files in one writer transaction; each file's plan, in order. */
  commitScopedTextFiles(batch: unknown): Promise<readonly ScopedFilePlan[]>;
  coverageBatch(requests: unknown): Promise<readonly ScopedCoverage[]>;
  coverageScope(request: unknown): Promise<ScopedCoverage>;
  prepareScopedFile(request: unknown): Promise<ScopedFilePlan>;
  readScopedFileChunkBounds(request: unknown): Promise<ScopedFileChunkBounds>;
  readScopedFilePage(request: unknown): Promise<ScopedFilePage>;
  removeScopedFile(identity: unknown): Promise<boolean>;
  /** Remove one scope's files in one writer transaction; how many were stored. */
  removeScopedFiles(batch: unknown): Promise<number>;
  replaceFileBindings(bindings: unknown): Promise<void>;
  searchScopes(request: unknown): Promise<ScopedSearchResult>;
  verifyScopedManifest(request: unknown): Promise<ScopedManifestResult>;
}
export interface StateIndexerPort {
  catchUpState(threads: readonly string[]): Promise<void>;
  /**
   * Projects at most `maxEvents` committed events of `threads`, resuming where the
   * last step committed. True once every thread is current. The Node transport's
   * catch-up, rebuild and thread-scoped reads all catch up through it.
   */
  catchUpStateStep(threads: readonly string[], maxEvents: number): Promise<boolean>;
  dropStateThread(threadId: string): Promise<readonly string[]>;
  matchState(threadId: string, query: string): Promise<readonly number[]>;
  rebuildState(threadId: string): Promise<void>;
  reindexState(threadId: string, seq: number): Promise<void>;
  /** Gap 10: committed conversation rows of the requested threads matching every query word. */
  searchState(request: StateSearch): Promise<readonly StateSearchHit[]>;
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
  IndexerPort & PurgeIndexerPort & ScopedIndexerPort & StateIndexerPort & CoverageAuthorityPort
> {
  if (process.versions['electron']) {
    throw new Error('Standalone indexer requires Node; use the explicit Electron utility adapter.');
  }
  const options = validateIndexerOptions(input);
  const deadlines = validateIndexerDeadlines(deadlineInput);
  const child = fork(
    new URL(`./process-entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
    [],
    {
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }
  );
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
