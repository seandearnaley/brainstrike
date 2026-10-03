import { fork } from 'node:child_process';
import type { CommitResult, FilePlan, IndexerInfo, SearchResult } from './contracts.js';
import {
  createIndexerConnection,
  validateIndexerDeadlines,
  validateIndexerOptions,
} from './transport.js';

export { embeddingProfileHash, fileChunks } from './chunks.js';
export type {
  CommitResult,
  EmbeddingProfile,
  FileChunk,
  FileCommit,
  FilePlan,
  FileSnapshot,
  FileSyntax,
  IndexerInfo,
  IndexerOptions,
  ProvidedChunk,
  ProvidedFileSnapshot,
  SearchRequest,
  SearchResult,
} from './contracts.js';
export { IndexerError } from './contracts.js';
export type { IndexerDeadlines } from './transport.js';
export { IndexerLifecycleError } from './transport.js';
export interface IndexerPort {
  close(): Promise<void>;
  commitFile(commit: unknown): Promise<CommitResult>;
  destroy(): Promise<void>;
  info(): Promise<IndexerInfo>;
  prepareFile(snapshot: unknown): Promise<FilePlan>;
  removeFile(identity: unknown): Promise<boolean>;
  search(request: unknown): Promise<SearchResult>;
}
export async function openIndexer(input: unknown, deadlineInput: unknown): Promise<IndexerPort> {
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
