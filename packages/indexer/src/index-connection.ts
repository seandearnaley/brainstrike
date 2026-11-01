import type { StateTruthReader } from '@brainstrike/state-store/state-truth-reader';
import type Database from 'better-sqlite3';

/** What the derived store runs on, opened by its host (`desktop-index-connection.ts`). */
export interface IndexConnection {
  /** The index database's connection. The store owns it and closes it. */
  readonly db: Database.Database;
  /** True when no index existed before this open, so the store initializes one. */
  readonly fresh: boolean;
  /** The process and thread that hold the writer, as `IndexerInfo` reports them. */
  readonly owner: { readonly pid: number; readonly writerThreadId: number };
  /** The authoritative state truth the store projects. The store reads it but does not own it. */
  readonly truth: StateTruthReader;
}
