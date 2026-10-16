/**
 * The web workspace file index's own worker (BST-1940; ADR-0022, 2026-10-16
 * amendment). The browser writer starts it on the tab that holds the lease,
 * so the scoped store keeps a single writer without a lease of its own. It
 * installs its own `opfs-sahpool` pool, so a publication here never queues
 * behind the writer's chat appends.
 *
 * It serves desktop's `ScopedIndexerPort` operations on one IndexWriter. The
 * store is authorized for exactly the roots, scopes and file bindings the
 * writer's catalogs hold; a change of authority reopens it. It also runs
 * canonical ingestion over the user's granted folders (`file-ingestion.ts`),
 * reading and writing the catalogs through the writer's own request order.
 */

import {
  binaryVectorEngine,
  IndexWriter,
  SCOPED_INDEX_OPERATIONS,
  type ScopedIndexOperation,
  scopedIndexOperations,
} from '@brainstrike/indexer/browser';
import { createLogger } from '@brainstrike/logging';
import type {
  CollectionReply,
  SourceCatalogPort,
  WorkspaceRootReply,
} from '@brainstrike/state-store';
import {
  asBetterSqlite3,
  SqliteWasmDatabase,
} from '@brainstrike/web-state-store/sqlite-wasm-database';
import sqlite3InitModule, {
  type Database,
  type SAHPoolUtil,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import { fileIndexAuthority } from './file-index-authority';
import {
  type FileIndexAuthority,
  type FileIndexMessage,
  type FileIndexRequest,
  type FileIndexScanOptions,
  fileIndexError,
  fileIndexFailure,
} from './file-index-protocol';
import { FileIngestion } from './file-ingestion';

declare const self: DedicatedWorkerGlobalScope;

const logger = createLogger('WebFileIndex');

/** The scoped store, in this worker's own pool. */
const FILE_INDEX_FILE = '/file-index.sqlite';

let sqlite3: Sqlite3Static | undefined;
let pool: SAHPoolUtil | undefined;
let writer: IndexWriter | undefined;
/** The authority the open store holds. */
let authorized: FileIndexAuthority | undefined;
let ingestion: FileIngestion | undefined;

/** The worker's calls on the writer's own ops, by id, waiting for their answers. */
const calls = new Map<number, { reject(error: Error): void; resolve(value: unknown): void }>();
let nextCall = 1;

function post(message: FileIndexMessage): void {
  self.postMessage(message);
}

/** Runs one of the writer's ops in its request order (`WebStateWriterContext.request`). */
function writerRequest<T>(op: string, params: unknown): Promise<T> {
  const id = nextCall++;
  return new Promise<T>((resolve, reject) => {
    calls.set(id, { reject, resolve: resolve as (value: unknown) => void });
    post({ id, kind: 'writer', op, params });
  });
}

const sourceCatalog: SourceCatalogPort = {
  sourceCatalog: (request) => writerRequest('sourceCatalog', request),
};
const roots = async () =>
  (await writerRequest<WorkspaceRootReply>('workspaceRoots', { operation: 'list' })).roots;

/** The scoped store as it stands, after any reopen: what publication writes through. */
const port = Object.fromEntries(
  SCOPED_INDEX_OPERATIONS.map((op) => [
    op,
    async (input: unknown) => {
      if (!writer) {
        throw new Error('The file index is closed');
      }
      return scopedIndexOperations(writer)[op](input);
    },
  ])
) as unknown as ConstructorParameters<typeof FileIngestion>[0]['port'];

/** The catalogs' full current authority, read through the writer. */
async function currentAuthority(): Promise<FileIndexAuthority> {
  const [workspaceRoots, collections, files] = await Promise.all([
    roots(),
    writerRequest<CollectionReply>('collections', { operation: 'list' }),
    sourceCatalog.sourceCatalog({ operation: 'list' }),
  ]);
  return fileIndexAuthority(
    workspaceRoots,
    collections.collections.map((collection) => collection.id),
    files.files
  );
}

/**
 * Rebinds the store to the catalogs' authority, as desktop re-acquires its
 * index: a changed set of roots or collections reopens it; otherwise its
 * bindings are replaced in place.
 */
async function rebind(): Promise<void> {
  const authority = await currentAuthority();
  const sameScopes =
    authorized &&
    JSON.stringify([authorized.rootIds, authorized.scopes]) ===
      JSON.stringify([authority.rootIds, authority.scopes]);
  if (sameScopes && writer) {
    writer.scoped.replaceBindings(authority.fileBindings);
    authorized = authority;
    return;
  }
  close();
  open(authority);
}

function ingestionFor(scan: FileIndexScanOptions): FileIngestion {
  return new FileIngestion({
    catalog: sourceCatalog,
    onError: (operation, error) => {
      logger.error('File ingestion failed', {
        code: 'web_file_ingestion_failed',
        error,
        operation,
      });
    },
    port,
    rebind,
    roots,
    scan,
  });
}

function isRebuildRequired(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.name === 'IndexerError' &&
    Reflect.get(cause, 'code') === 'rebuild-required'
  );
}

function openWriter(engine: Sqlite3Static, owned: SAHPoolUtil, authority: FileIndexAuthority) {
  // The pool's constructor takes oo1's (filename, flags); its declaration names only the filename.
  const PoolDb = owned.OpfsSAHPoolDb as unknown as new (
    filename: string,
    flags: string
  ) => Database;
  const db = new SqliteWasmDatabase(engine, new PoolDb(FILE_INDEX_FILE, 'c'), FILE_INDEX_FILE);
  // Desktop's page size, and EXCLUSIVE, as OPFS requires.
  db.pragma('page_size = 4096');
  db.pragma('locking_mode = EXCLUSIVE');
  const fresh = db.prepare('SELECT count(*) FROM sqlite_schema').pluck().get() === 0;
  return new IndexWriter(
    {
      dbPath: FILE_INDEX_FILE,
      embedding: { indexMode: 'text-only' },
      fileBindings: authority.fileBindings,
      rootIds: authority.rootIds,
      scopes: authority.scopes,
    },
    {
      db: asBetterSqlite3(db),
      engine: binaryVectorEngine,
      fresh,
      owner: { pid: 0, writerThreadId: 0 },
    }
  );
}

/** Opens the store under `authority`; a store this build cannot use is derived data, rebuilt empty. */
function open(authority: FileIndexAuthority): { readonly rebuilt: string | null } {
  if (!(sqlite3 && pool)) {
    throw new Error('The file index pool is not installed');
  }
  authorized = authority;
  try {
    writer = openWriter(sqlite3, pool, authority);
    return { rebuilt: null };
  } catch (cause) {
    if (!isRebuildRequired(cause)) {
      throw cause;
    }
    for (const suffix of ['', '-wal', '-journal']) {
      pool.unlink(`${FILE_INDEX_FILE}${suffix}`);
    }
    writer = openWriter(sqlite3, pool, authority);
    return { rebuilt: cause instanceof Error ? cause.message : String(cause) };
  }
}

function close(): void {
  const current = writer;
  writer = undefined;
  current?.close();
}

async function handle(
  request: Exclude<FileIndexRequest, { kind: 'writer-reply' }>
): Promise<unknown> {
  switch (request.kind) {
    case 'open': {
      sqlite3 ??= await sqlite3InitModule();
      pool ??= await sqlite3.installOpfsSAHPoolVfs({
        directory: request.pool,
        initialCapacity: 4,
        name: request.vfs,
      });
      ingestion = ingestionFor(request.scan);
      return open(request.authority);
    }
    case 'scan': {
      if (!ingestion) {
        throw new Error('The file index is closed');
      }
      // A root registered since the store opened is authorized first.
      if (!authorized?.rootIds.includes(request.rootId)) {
        await rebind();
      }
      return ingestion.scan(request.rootId, request.folder);
    }
    case 'reauthorize':
      close();
      return open(request.authority);
    case 'request': {
      if (!writer) {
        throw new Error('The file index is closed');
      }
      if (!(SCOPED_INDEX_OPERATIONS as readonly string[]).includes(request.op)) {
        throw new Error(`Unknown file index operation ${request.op}`);
      }
      return scopedIndexOperations(writer)[request.op as ScopedIndexOperation](request.params);
    }
    case 'close':
      await ingestion?.close();
      ingestion = undefined;
      close();
      // Releases the pool's OPFS handles, so factory reset can delete it.
      pool?.pauseVfs();
      return null;
    default:
      throw new Error('Unknown file index request');
  }
}

self.onmessage = (event: MessageEvent<FileIndexRequest>) => {
  const request = event.data;
  if (request.kind === 'writer-reply') {
    const call = calls.get(request.id);
    calls.delete(request.id);
    if (request.ok) {
      call?.resolve(request.result);
    } else {
      call?.reject(fileIndexFailure(request.error ?? fileIndexError('The writer refused')));
    }
    return;
  }
  void handle(request).then(
    (result) => post({ id: request.id, kind: 'reply', ok: true, result }),
    (error: unknown) =>
      post({ error: fileIndexError(error), id: request.id, kind: 'reply', ok: false })
  );
};
