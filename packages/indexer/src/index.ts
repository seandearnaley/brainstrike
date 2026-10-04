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
} from './contracts.js';
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
  TextFileCommit,
  VectorProfile,
} from './contracts.js';
export { IndexerError } from './contracts.js';
export { vectorProfileHash } from './scope-authority.js';
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
/** Trusted main/catalog owner port. Never forward renderer-supplied binding inventories. */
export interface ScopedIndexerPort {
  commitScopedFile(commit: unknown): Promise<CommitResult>;
  commitScopedTextFile(commit: unknown): Promise<CommitResult>;
  coverageScope(request: unknown): Promise<ScopedCoverage>;
  prepareScopedFile(request: unknown): Promise<ScopedFilePlan>;
  removeScopedFile(identity: unknown): Promise<boolean>;
  replaceFileBindings(bindings: unknown): Promise<void>;
  searchScopes(request: unknown): Promise<ScopedSearchResult>;
  verifyScopedManifest(request: unknown): Promise<ScopedManifestResult>;
}
export interface StateIndexerPort {
  catchUpState(threads: readonly string[]): Promise<void>;
  dropStateThread(threadId: string): Promise<readonly string[]>;
  reindexState(threadId: string, seq: number): Promise<void>;
  stateBlobCounts(
    threads: readonly string[],
    hashes: readonly string[]
  ): Promise<Readonly<Record<string, number>>>;
}
export function createStateStoreIndexer(
  port: StateIndexerPort & Pick<IndexerPort, 'destroy'>
): StateStoreIndexerPort {
  return {
    catchUp: (threads) => port.catchUpState(threads),
    dropThread: (threadId) => port.dropStateThread(threadId),
    gcCheck: (threads, hashes) => port.stateBlobCounts(threads, hashes),
    reindex: (threadId, seq) => port.reindexState(threadId, seq),
    reset: () => port.destroy(),
  };
}
export async function openIndexer(
  input: unknown,
  deadlineInput: unknown
): Promise<IndexerPort & ScopedIndexerPort & StateIndexerPort> {
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
