/**
 * The web workspace file index's own worker (BST-1940; ADR-0022, 2026-10-16
 * amendment). The browser writer starts it on the tab that holds the lease,
 * so the scoped store keeps a single writer without a lease of its own. It
 * installs its own `opfs-sahpool` pool, so a publication here never queues
 * behind the writer's chat appends.
 *
 * It serves desktop's `ScopedIndexerPort` operations on one IndexWriter. The
 * store is authorized for exactly the roots, scopes and file bindings the
 * writer's catalogs hold; a change of authority reopens it.
 */
import {
  binaryVectorEngine,
  IndexWriter,
  SCOPED_INDEX_OPERATIONS,
  type ScopedIndexOperation,
  scopedIndexOperations,
} from '@brainstrike/indexer/browser';
import {
  asBetterSqlite3,
  SqliteWasmDatabase,
} from '@brainstrike/web-state-store/sqlite-wasm-database';
import sqlite3InitModule, {
  type Database,
  type SAHPoolUtil,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import type { FileIndexAuthority, FileIndexReply, FileIndexRequest } from './file-index-protocol';

declare const self: DedicatedWorkerGlobalScope;

/** The scoped store, in this worker's own pool. */
const FILE_INDEX_FILE = '/file-index.sqlite';

let sqlite3: Sqlite3Static | undefined;
let pool: SAHPoolUtil | undefined;
let writer: IndexWriter | undefined;

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

async function handle(request: FileIndexRequest): Promise<unknown> {
  switch (request.kind) {
    case 'open': {
      sqlite3 ??= await sqlite3InitModule();
      pool ??= await sqlite3.installOpfsSAHPoolVfs({
        directory: request.pool,
        initialCapacity: 4,
        name: request.vfs,
      });
      return open(request.authority);
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
  void handle(request).then(
    (result) => self.postMessage({ id: request.id, ok: true, result } satisfies FileIndexReply),
    (error: unknown) =>
      self.postMessage({
        error: {
          code: error instanceof Error ? Reflect.get(error, 'code') : undefined,
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : 'Error',
        },
        id: request.id,
        ok: false,
      } satisfies FileIndexReply)
  );
};
