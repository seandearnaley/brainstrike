import type {
  CollectionReply,
  CollectionRequest,
  ModelChoiceRequest,
  ModelChoiceResult,
  PromptCatalogReply,
  PromptCatalogRequest,
  ThreadGroupsReply,
  ThreadGroupsRequest,
} from '@brainstrike/state-store';
import type { ViewFilterPresetReply, ViewFilterPresetRequest } from '@brainstrike/types';

/**
 * The browser state writer's wire: a tab and its own worker exchange
 * `TabMessage`/`WorkerMessage`; the workers of one origin's tabs exchange
 * `ChannelMessage` over a BroadcastChannel. Every value is structured-clonable.
 */

/**
 * Who writes the state DB. The holder of the origin's exclusive Web Lock is
 * the only writer. It records an epoch one past the last writer's, so a newer
 * writer is always distinguishable from an older one, and announces this
 * record to the other tabs. There is no token: on the web the origin is the
 * principal, and only same-origin code can reach the lock or the channel.
 */
export interface WebStateLease {
  readonly epoch: number;
  /** The writing worker's random identity, fresh for every worker. */
  readonly instanceId: string;
}

export interface WebStateStoreConfig {
  /**
   * The app build this tab runs. Extensions may record it: the derived index
   * rebuilds its state projection when the build that projected it changes.
   */
  readonly build?: string | undefined;
  /**
   * The store's one identity: its Web Lock, its BroadcastChannel and its OPFS
   * pool directory all derive from it (`webStateNames`), so no two settings
   * can disagree. Tests give each case its own.
   */
  readonly name: string;
  readonly testHooks?: WebStateTestHooks | undefined;
}

/** Fault injection for the writer's own tests; production passes none. */
export interface WebStateTestHooks {
  /** Accept a `stall` request that never answers. */
  readonly allowStall?: boolean | undefined;
  /** The first OPFS access-handle acquisition during pool init throws. */
  readonly failPoolInitOnce?: boolean | undefined;
}

/** One run-log row to append: the desktop writer's `AppendRow`. */
export type WebStateAppendRow = readonly [
  threadId: string,
  type: string,
  runId: string | null,
  body: string,
  rawCount: number | null,
  hydrate: 0 | 1,
];

export interface WebStateStoredRow {
  readonly crc: number;
  readonly payload: string;
  readonly rawCount: number | null;
  readonly seq: number;
  readonly ts: number;
}

export type WebStateThreadStatus =
  | { readonly kind: 'ok'; readonly tail: number }
  | { readonly atSeq: number; readonly error: string; readonly kind: 'damaged' };

export type WebStateErrorKind =
  | 'checkpoint-blocked'
  | 'damaged'
  | 'failed'
  | 'leader-lost'
  | 'readonly'
  | 'unavailable';

/** A refused or failed request, in the desktop writer's error-reply shape. */
export interface WebStateErrorReply {
  readonly atSeq?: number;
  readonly detail?: string;
  readonly error: string;
  readonly errorKind: WebStateErrorKind;
  readonly threadId?: string;
}

export interface WebStateHydrationThread {
  readonly createdAt: number;
  readonly damage: WebStateErrorReply | null;
  readonly rows: readonly WebStateStoredRow[];
  readonly threadId: string;
  readonly updatedAt: number;
}

export interface WebStateCheckpoint {
  readonly busy: number;
  readonly checkpointed: number;
  readonly log: number;
}

/** The connection's settings as the writer applied them, read back from SQLite. */
export interface WebStateSettings {
  readonly foreignKeys: number;
  readonly journalMode: string;
  readonly lockingMode: string;
  readonly pageSize: number;
  /** 1 when the state DB was found damaged and opened read-only. */
  readonly queryOnly: number;
  readonly secureDelete: number;
  readonly sqliteVersion: string;
  readonly synchronous: number;
  readonly userVersion: number;
  readonly walAutocheckpoint: number;
}

export interface WebStateRequests {
  append: {
    readonly params: { readonly boundary?: boolean; readonly rows: readonly WebStateAppendRow[] };
    readonly result: { readonly seqs: readonly number[]; readonly ts: number };
  };
  boundary: {
    readonly params: { readonly threadId: string };
    readonly result: {
      readonly checkpoint: {
        readonly after: WebStateCheckpoint;
        readonly before: WebStateCheckpoint;
      } | null;
    };
  };
  check: {
    readonly params: Record<string, never>;
    readonly result: { readonly gaps: number; readonly integrity: string };
  };
  /** The desktop writer's catalog operations, on the same domain modules (`@brainstrike/state-store/catalog-domains`). */
  collections: { readonly params: CollectionRequest; readonly result: CollectionReply };
  /** Blob hashes named by the rows of threads whose rows fail verification. */
  damagedBlobRefs: {
    readonly params: Record<string, never>;
    readonly result: { readonly hashes: readonly string[] };
  };
  modelChoices: { readonly params: ModelChoiceRequest; readonly result: ModelChoiceResult };
  promptCatalog: { readonly params: PromptCatalogRequest; readonly result: PromptCatalogReply };
  /** Content-addressed: `hash` is the SHA-256 of `content`'s UTF-8 bytes. */
  putBlob: {
    readonly params: { readonly content: string; readonly hash: string };
    readonly result: Record<string, never>;
  };
  read: {
    readonly params: {
      readonly fromSeq: number;
      readonly limit: number;
      readonly threadId: string;
    };
    readonly result: {
      readonly damage: WebStateErrorReply | null;
      readonly rows: readonly WebStateStoredRow[];
    };
  };
  /** A verified blob's content, or null when it is larger than `maxBytes`. */
  readBlob: {
    readonly params: { readonly hash: string; readonly maxBytes: number };
    readonly result: { readonly content: string | null };
  };
  readHydration: {
    readonly params: Record<string, never>;
    readonly result: { readonly threads: readonly WebStateHydrationThread[] };
  };
  /**
   * Factory reset: the writer closes the store and releases the pool's OPFS
   * handles but keeps the lock, so no tab reopens the pool before the reset
   * deletes it; every tab's store then refuses requests until it reloads.
   */
  retire: {
    readonly params: Record<string, never>;
    readonly result: Record<string, never>;
  };
  settings: {
    readonly params: Record<string, never>;
    readonly result: WebStateSettings;
  };
  stall: {
    readonly params: Record<string, never>;
    readonly result: never;
  };
  status: {
    readonly params: { readonly threadId: string };
    readonly result: { readonly status: WebStateThreadStatus };
  };
  /** The blob hashes a thread's stored rows may reference, verified or not. */
  storedBlobRefs: {
    readonly params: { readonly threadId: string };
    readonly result: { readonly hashes: readonly string[] };
  };
  threadGroups: { readonly params: ThreadGroupsRequest; readonly result: ThreadGroupsReply };
  threads: {
    readonly params: Record<string, never>;
    readonly result: { readonly threads: readonly string[] };
  };
  /** Removes blobs a collection found unreferenced; returns the hashes actually removed. */
  unlinkBlobs: {
    readonly params: { readonly hashes: readonly string[] };
    readonly result: { readonly deleted: readonly string[] };
  };
  viewFilterPresets: {
    readonly params: ViewFilterPresetRequest;
    readonly result: ViewFilterPresetReply;
  };
}

export type WebStateOp = keyof WebStateRequests;

export interface WebStateRequest<Op extends WebStateOp = WebStateOp> {
  readonly op: Op;
  readonly params: WebStateRequests[Op]['params'];
}

export type WebStateReply =
  | { readonly id: number; readonly ok: true; readonly result: unknown }
  | { readonly error: WebStateErrorReply; readonly id: number; readonly ok: false };

/** A request as the wire carries it: a writer op, or an extension's namespaced op. */
export interface WireRequest {
  readonly op: string;
  readonly params: unknown;
}

export type TabMessage =
  | { readonly config: WebStateStoreConfig; readonly kind: 'open' }
  | { readonly id: number; readonly kind: 'request'; readonly request: WireRequest };

export type WorkerMessage =
  /** The writer could not open the store, or this tab cannot use it; the worker can be dropped. */
  | { readonly error: string; readonly kind: 'failed' }
  /** The store was retired for factory reset; the worker must live until the tab reloads. */
  | { readonly kind: 'retired' }
  | { readonly kind: 'lease'; readonly lease: WebStateLease; readonly leader: boolean }
  | ({ readonly kind: 'reply' } & WebStateReply);

export type ChannelMessage =
  /** A worker that just joined asks the writer to announce itself. */
  | { readonly kind: 'who' }
  | { readonly kind: 'leader'; readonly lease: WebStateLease; readonly protocol: string }
  /** The writer retired the store for factory reset: no worker may open it again. */
  | { readonly kind: 'retired' }
  | {
      readonly from: string;
      readonly id: number;
      readonly kind: 'request';
      readonly protocol: string;
      readonly request: WireRequest;
      /** The writer this request is for; any other worker ignores it. */
      readonly to: string;
    }
  | ({ readonly kind: 'reply'; readonly to: string } & WebStateReply);

/**
 * This wire's version. Tabs of different builds can share an origin; a tab
 * whose writer speaks another version refuses it visibly instead of guessing.
 * Bump it whenever `WebStateRequests`, a request's params or result, or a
 * channel message changes: version 2 added the catalog and blob requests,
 * version 3 writer extensions.
 */
export const WEB_STATE_PROTOCOL = 3;

/** The protocol a writer announces: this wire's version and the extensions it runs, by id. */
export function webStateWireProtocol(extensionIds: readonly string[]): string {
  return [String(WEB_STATE_PROTOCOL), ...[...extensionIds].sort()].join('+');
}

/** The app's store; tests and isolated E2E sessions name their own. */
export const DEFAULT_WEB_STATE_STORE = 'default';

/** Every store's OPFS pool directory starts with this; factory reset removes them all. */
export const WEB_STATE_POOL_PREFIX = 'brainstrike-web-state-';

const STORE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A store's lock, channel, pool directory and VFS, all from its one name. */
export function webStateNames(name: string): {
  readonly channel: string;
  readonly lock: string;
  readonly pool: string;
  readonly vfs: string;
} {
  if (!STORE_NAME.test(name)) {
    throw new RangeError(`Invalid state store name ${JSON.stringify(name)}`);
  }
  const pool = `${WEB_STATE_POOL_PREFIX}${name}`;
  return { channel: pool, lock: pool, pool, vfs: pool };
}
