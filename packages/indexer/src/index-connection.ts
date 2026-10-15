import type { StateTruthReader } from '@brainstrike/state-store/state-truth-reader';
import type Database from 'better-sqlite3';
import type { CoarseVectorEngine } from './vector-engine.js';

/**
 * What the derived store runs on, opened by its host: on desktop a
 * better-sqlite3 connection with sqlite-vec loaded (`desktop-index-connection.ts`);
 * in the browser writer, the official sqlite-wasm build's (BST-1940).
 */
export interface IndexConnection {
  /** The index database's connection. The store owns it and closes it. */
  readonly db: Database.Database;
  readonly engine: CoarseVectorEngine;
  /** True when no index existed before this open, so the store initializes one. */
  readonly fresh: boolean;
  /** The process and thread that hold the writer, as `IndexerInfo` reports them. */
  readonly owner: { readonly pid: number; readonly writerThreadId: number };
  /**
   * The authoritative state truth the store projects, when its options name a
   * state root. The store reads it but does not own its connection.
   */
  readonly truth?: StateTruthReader | undefined;
}

/** A reader's connection to an index its host opened. */
export interface IndexReaderConnection extends Pick<IndexConnection, 'db' | 'engine'> {
  /**
   * True when the reader owns `db` and closes it if construction fails (the
   * desktop's separate read-only connection). False when it reads on a
   * connection another owner keeps, such as the browser writer's own: an
   * EXCLUSIVE database has no second connection.
   */
  readonly owned: boolean;
}
