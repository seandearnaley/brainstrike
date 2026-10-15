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
   * Names the Web Lock and the BroadcastChannel: one writer per name per
   * origin. Tests give each case its own.
   */
  readonly name: string;
  /** The OPFS directory of the store's `opfs-sahpool` VFS. */
  readonly poolDirectory: string;
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
  readHydration: {
    readonly params: Record<string, never>;
    readonly result: { readonly threads: readonly WebStateHydrationThread[] };
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
  threads: {
    readonly params: Record<string, never>;
    readonly result: { readonly threads: readonly string[] };
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

export type TabMessage =
  | { readonly config: WebStateStoreConfig; readonly kind: 'open' }
  | { readonly id: number; readonly kind: 'request'; readonly request: WebStateRequest };

export type WorkerMessage =
  /** The writer could not open the store; this worker has released the lock. */
  | { readonly error: string; readonly kind: 'failed' }
  | { readonly kind: 'lease'; readonly lease: WebStateLease; readonly leader: boolean }
  | ({ readonly kind: 'reply' } & WebStateReply);

export type ChannelMessage =
  /** A worker that just joined asks the writer to announce itself. */
  | { readonly kind: 'who' }
  | { readonly kind: 'leader'; readonly lease: WebStateLease }
  | {
      readonly from: string;
      readonly id: number;
      readonly kind: 'request';
      readonly request: WebStateRequest;
      /** The writer this request is for; any other worker ignores it. */
      readonly to: string;
    }
  | ({ readonly kind: 'reply'; readonly to: string } & WebStateReply);

/** The Web Lock and BroadcastChannel names for a store. */
export function webStateNames(name: string): { readonly channel: string; readonly lock: string } {
  return { channel: `brainstrike-web-state:${name}`, lock: `brainstrike-web-state:${name}` };
}
