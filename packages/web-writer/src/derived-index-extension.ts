import { decodeHostRow, messages, search, text } from '@brainstrike/agent-host/host-state-producer';
import {
  binaryVectorEngine,
  createStateProjection,
  IndexWriter,
} from '@brainstrike/indexer/browser';
import { createLogger } from '@brainstrike/logging';
import { StateTruthReader } from '@brainstrike/state-store/state-truth-reader';
import { sha256Hex } from '@brainstrike/utils/crypto';
import {
  type SqliteWasmDatabase,
  type WebStateExtension,
  type WebStateStoreConfig,
  type WebStateWriterContext,
  webStateNames,
} from '@brainstrike/web-state-store';
import { asBetterSqlite3 } from '@brainstrike/web-state-store/sqlite-wasm-database';

/** The derived index's database in the store's pool. */
export const DERIVED_INDEX_FILE = '/state-index.sqlite';
export const DERIVED_INDEX_EXTENSION_ID = 'derived-index@1';

const logger = createLogger('WebDerivedIndex');

/** Names the producer in the index's options; nothing loads it by this name. */
const PRODUCER = 'browser:@brainstrike/agent-host/host-state-producer';

/** A database in the pool as the derived index needs it: desktop's page size, and EXCLUSIVE, as OPFS requires. */
function indexDatabase(context: WebStateWriterContext): SqliteWasmDatabase {
  const db = context.openDatabase(DERIVED_INDEX_FILE);
  db.pragma('page_size = 4096');
  db.pragma('locking_mode = EXCLUSIVE');
  return db;
}

/**
 * The derived index projecting the store's run log, as the desktop's host
 * state index does. Its projection identity names the producer and the app
 * build, so a new build re-projects. The writer is constructed over the
 * pool's own connections: the state DB's for truth, and `blobs.db` for the
 * blobs a row names.
 */
/**
 * The app build the projection is held to. The build stands for the
 * producer's code, as desktop's identity hashes the producer's sources, so an
 * index cannot be held to a build it does not know.
 */
function buildOf(config: WebStateStoreConfig): string {
  if (!config.build) {
    throw new Error('The derived index needs the app build to hold its projection to');
  }
  return config.build;
}

/** The projection's identity: its producer and the app build that runs it. */
function projectionIdentity(context: WebStateWriterContext): string {
  return sha256Hex(JSON.stringify([PRODUCER, 'prod', buildOf(context.config)]));
}

function openIndexWriter(context: WebStateWriterContext): IndexWriter {
  const root = `opfs:${webStateNames(context.config.name).pool}`;
  const projection = createStateProjection(
    {
      decode: (raw: string, mode: 'dev' | 'prod') =>
        decodeHostRow(raw, mode, (hash) => context.blobs.bytes(hash)),
      messages,
      search,
      text,
    },
    'prod',
    projectionIdentity(context),
    root
  );
  const db = indexDatabase(context);
  const fresh = db.prepare('SELECT count(*) FROM sqlite_schema').pluck().get() === 0;
  return new IndexWriter(
    {
      dbPath: DERIVED_INDEX_FILE,
      embedding: { indexMode: 'text-only' },
      rootIds: [],
      stateProjection: { mode: 'prod', module: PRODUCER },
      stateRoot: root,
    },
    {
      db: asBetterSqlite3(db),
      engine: binaryVectorEngine,
      fresh,
      owner: { pid: 0, writerThreadId: 0 },
      truth: new StateTruthReader(() => asBetterSqlite3(context.state)),
    },
    projection
  );
}

/** How the writer opened its derived index. */
export interface WebDerivedIndexStatus {
  /** The projection identity the index is held to. */
  readonly projection: string;
  /** Why this writer rebuilt the index from the log when it opened; null when it kept it. */
  readonly rebuilt: string | null;
}

function isRebuildRequired(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.name === 'IndexerError' &&
    Reflect.get(cause, 'code') === 'rebuild-required'
  );
}

/**
 * The derived index beside the state DB (ADR-0011's "one derived SQLite
 * store", BST-1940). An index the current producer or build cannot use is
 * rebuilt from the log, as the desktop's host state index rebuilds.
 */
export const derivedIndexExtension: WebStateExtension = {
  id: DERIVED_INDEX_EXTENSION_ID,
  open(context) {
    let writer: IndexWriter;
    /** Why this open rebuilt the index, if it did. */
    let rebuilt: string | null = null;
    try {
      writer = openIndexWriter(context);
    } catch (cause) {
      if (!isRebuildRequired(cause)) {
        throw cause;
      }
      // As the desktop's host state index: derived data, rebuilt from the log.
      rebuilt = cause instanceof Error ? cause.message : String(cause);
      logger.warn('Rebuilding the derived index from the state log', {
        code: 'web_state_index_rebuilt',
        reason: rebuilt,
      });
      context.removeDatabase(DERIVED_INDEX_FILE);
      writer = openIndexWriter(context);
    }
    const state = () => writer.requireState();
    return {
      close: () => writer.close(),
      handlers: {
        'index.catchUp': (params) => {
          const threads = (params as { readonly threadIds?: readonly string[] }).threadIds;
          return state().catchUp(threads ?? context.log.threads());
        },
        'index.dropThread': (params) => state().dropThread(params),
        'index.gcCheck': (params) => state().gcCheck(params),
        'index.reindex': (params) => state().reindex(params),
        'index.search': (params) => state().search(params),
        'index.stats': (params) => state().stats(params),
        'index.status': (): WebDerivedIndexStatus => ({
          projection: projectionIdentity(context),
          rebuilt,
        }),
      },
    };
  },
  validate(config) {
    buildOf(config);
  },
};
