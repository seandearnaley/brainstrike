import { fork } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Schema } from 'effect';
import {
  type CommitResult,
  commitResultSchema,
  commitSchema,
  decoder,
  type FilePlan,
  IndexerError,
  type IndexerInfo,
  identitySchema,
  infoSchema,
  optionsSchema,
  planSchema,
  type SearchResult,
  searchResultSchema,
  searchSchema,
  snapshotSchema,
} from './contracts.js';
import { RpcClient } from './rpc-client.js';

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
  SearchRequest,
  SearchResult,
} from './contracts.js';
export { IndexerError } from './contracts.js';
export interface IndexerPort {
  close(): Promise<void>;
  commitFile(commit: unknown): Promise<CommitResult>;
  destroy(): Promise<void>;
  info(): Promise<IndexerInfo>;
  prepareFile(snapshot: unknown): Promise<FilePlan>;
  removeFile(identity: unknown): Promise<boolean>;
  search(request: unknown): Promise<SearchResult>;
}
export async function openIndexer(input: unknown): Promise<IndexerPort> {
  const options = decoder(optionsSchema)(input);
  if (!path.isAbsolute(options.dbPath) || options.dbPath === ':memory:') {
    throw new TypeError('Indexer requires an absolute persistent database file path.');
  }
  const child = fork(new URL('./process-entry.js', import.meta.url), [], {
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const client = new RpcClient(
    (message) => {
      child.send(message, (error) => {
        if (error) {
          client.fail(error);
        }
      });
    },
    () => {
      child.kill();
    }
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.on('message', (message: unknown) => client.receive(message));
  child.on('error', (error) => client.fail(error));
  child.on('exit', (code, signal) =>
    client.fail(new IndexerError('indexer-exited', `Indexer process exited (${code}, ${signal}).`))
  );
  try {
    child.send(options, (error) => {
      if (error) {
        client.fail(error);
      }
    });
    decoder(infoSchema)(await client.ready);
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (!child.connected) {
        await exited;
        return;
      }
      try {
        await client.call('close', null, decoder(Schema.Boolean));
      } finally {
        await exited;
      }
    })();
    return closePromise;
  };
  return {
    close,
    commitFile: async (commit) =>
      client.call('commit-file', decoder(commitSchema)(commit), decoder(commitResultSchema)),
    destroy: async () => {
      await close();
      for (const file of [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`]) {
        await rm(file, { force: true });
      }
    },
    info: () => client.call('info', null, decoder(infoSchema)),
    prepareFile: async (snapshot) =>
      client.call('prepare-file', decoder(snapshotSchema)(snapshot), decoder(planSchema)),
    removeFile: async (identity) =>
      client.call('remove-file', decoder(identitySchema)(identity), decoder(Schema.Boolean)),
    search: async (request) =>
      client.call('search', decoder(searchSchema)(request), decoder(searchResultSchema)),
  };
}
