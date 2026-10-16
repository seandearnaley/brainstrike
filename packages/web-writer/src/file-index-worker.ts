/**
 * The web workspace file index's own worker (BST-1940; ADR-0022, 2026-10-16
 * amendment). The browser writer starts it on the tab that holds the lease,
 * so the scoped store keeps a single writer without a lease of its own. It
 * installs its own `opfs-sahpool` pool, so a publication here never queues
 * behind the writer's chat appends.
 *
 * It serves desktop's `ScopedIndexerPort` operations on one IndexWriter. The
 * store opens once a tab hands it the saved Search & Indexing preferences,
 * and is authorized for exactly their partition (BST-1988), as desktop's
 * native index is: the live roots, the saved collection, and their files in
 * the writer's catalogs. A change of authority reopens it. It also runs
 * canonical ingestion over the user's granted folders (`file-ingestion.ts`),
 * reading and writing the catalogs through the writer's own request order.
 */

import {
  assertSavedCollection,
  isPartitionRoot,
  loadPartitionRecords,
  type NativeIndexSettings,
  nativeIndexConfigurationIdentity,
  partitionAuthority,
  readNativeIndexSettings,
  retireUnownedRows,
} from '@brainstrike/canonical-ingestion/browser';
import {
  binaryVectorEngine,
  IndexWriter,
  SCOPED_INDEX_OPERATIONS,
  type ScopedIndexOperation,
  scopedIndexOperations,
} from '@brainstrike/indexer/browser';
import { createLogger } from '@brainstrike/logging';
import type {
  CollectionPort,
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
import { fileIdentity } from './file-index-authority';
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
let scanOptions: FileIndexScanOptions | undefined;
/** The settings a tab last handed over; until then, or after they fail, every op refuses. */
let configured: { readonly settings: NativeIndexSettings } | { readonly refusal: Error } = {
  refusal: new Error('The file index has no Search & Indexing settings until a tab configures it.'),
};

/**
 * Authority transitions (configure, reauthorize, a scan's first rebind) run one
 * at a time, so an older one never resumes over a newer one's outcome. The
 * rebind a running scan makes is not one of them: a configure waits for scans.
 */
let transitions: Promise<unknown> = Promise.resolve();
function transition<T>(run: () => Promise<T>): Promise<T> {
  const next = transitions.then(run, run);
  transitions = next.catch(() => undefined);
  return next;
}

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
const collections: CollectionPort = {
  collections: (request) => writerRequest<CollectionReply>('collections', request),
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

/** The configured settings, or the refusal that stands in for them. */
function settings(): NativeIndexSettings {
  if ('refusal' in configured) {
    throw configured.refusal;
  }
  return configured.settings;
}

/** The saved partition's authority over the writer's catalogs, as desktop's native index takes it. */
async function currentAuthority(partition: NativeIndexSettings): Promise<FileIndexAuthority> {
  const live = (await roots())
    .filter((root) => isPartitionRoot(root, partition))
    .map((root) => root.id);
  const liveRoots = new Set(live);
  const records = await loadPartitionRecords(
    sourceCatalog,
    partition,
    (rootId) => liveRoots.has(rootId),
    () => {}
  );
  return partitionAuthority({
    identity: fileIdentity,
    profile: null,
    records,
    rootIds: live,
    settings: partition,
  });
}

/**
 * Rebinds the store to the catalogs' authority, as desktop re-acquires its
 * index: a changed set of roots or collections reopens it; otherwise its
 * bindings are replaced in place.
 */
async function rebind(): Promise<void> {
  const authority = await currentAuthority(settings());
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
  await openOwned(authority);
}

function ingestionFor(scan: FileIndexScanOptions, partition: NativeIndexSettings): FileIngestion {
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
    settings: partition,
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

/**
 * Opens the store under `authority`, then retires the rows its scopes hold
 * that no binding owns: another partition's, as desktop's native index does
 * at every open (BST-1988, BST-2011).
 */
async function openOwned(
  authority: FileIndexAuthority
): Promise<{ readonly rebuilt: string | null }> {
  const opened = open(authority);
  await retireUnownedRows(port, authority);
  return opened;
}

function close(): void {
  const current = writer;
  writer = undefined;
  current?.close();
}

/** Retires the root ingestions and the store; until a tab configures it again, every op refuses with `refusal`. */
async function unconfigure(refusal: Error): Promise<void> {
  configured = { refusal };
  await ingestion?.close();
  ingestion = undefined;
  close();
}

/**
 * Applies the saved Search & Indexing preferences, as desktop's native index
 * reads them. A changed partition retires every root's ingestion and reopens
 * the store under it; a change of Pause alone keeps the store open. Settings
 * that fail leave the index refusing with their failure, visibly.
 */
async function configure(preferences: string | null): Promise<{ readonly rebuilt: string | null }> {
  if (!scanOptions) {
    throw new Error('The file index pool is not installed');
  }
  let next: NativeIndexSettings;
  try {
    next = readNativeIndexSettings(preferences);
    if (!next.enabled) {
      throw new Error('File indexing is disabled in saved settings.');
    }
    if (next.mode === 'VECTOR') {
      throw new Error('The browser file index does not run VECTOR search yet.');
    }
    await assertSavedCollection(next, collections, () => {});
  } catch (error) {
    await unconfigure(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
  const previous = 'settings' in configured ? configured.settings : undefined;
  if (
    previous &&
    writer &&
    nativeIndexConfigurationIdentity(previous) === nativeIndexConfigurationIdentity(next)
  ) {
    if (previous.paused !== next.paused) {
      // Pause admits no source: the roots' ingestion retires, and the store stays open.
      await ingestion?.close();
      ingestion = ingestionFor(scanOptions, next);
    }
    configured = { settings: next };
    return { rebuilt: null };
  }
  try {
    // Scans retire first: one still publishing would otherwise outlive the
    // authority read below, and its rows would then be retired as unowned.
    await ingestion?.close();
    ingestion = undefined;
    const authority = await currentAuthority(next);
    close();
    configured = { settings: next };
    ingestion = ingestionFor(scanOptions, next);
    return await openOwned(authority);
  } catch (error) {
    await unconfigure(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
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
      scanOptions = request.scan;
      return null;
    }
    case 'configure':
      return transition(() => configure(request.preferences));
    case 'scan': {
      if (settings().paused) {
        throw new Error('File ingestion is paused.');
      }
      if (!ingestion) {
        throw new Error('The file index is closed');
      }
      // A root registered since the store opened is authorized first.
      if (!authorized?.rootIds.includes(request.rootId)) {
        await transition(rebind);
      }
      if (!ingestion) {
        throw new Error('The file index is closed');
      }
      return ingestion.scan(request.rootId, request.folder);
    }
    case 'reauthorize':
      return transition(async () => {
        const authority = await currentAuthority(settings());
        close();
        return openOwned(authority);
      });
    case 'request': {
      settings();
      if (!writer) {
        throw new Error('The file index is closed');
      }
      if (!(SCOPED_INDEX_OPERATIONS as readonly string[]).includes(request.op)) {
        throw new Error(`Unknown file index operation ${request.op}`);
      }
      return scopedIndexOperations(writer)[request.op as ScopedIndexOperation](request.params);
    }
    case 'close':
      await unconfigure(new Error('The file index is closed'));
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
