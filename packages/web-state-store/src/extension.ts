import type { RunLog } from '@brainstrike/state-store/run-log';
import type { SqliteBlobStore } from './blob-store';
import type { WebStateStoreConfig } from './protocol';
import type { SqliteWasmDatabase } from './sqlite-wasm-database';

/**
 * What a writer extension works with, on the worker that holds the lease:
 * the state DB and its run log, the blob store, and databases of its own in
 * the same OPFS pool. Only the writer opens extensions, so an extension's
 * databases have the same single writer as the state DB.
 */
export interface WebStateWriterContext {
  readonly blobs: SqliteBlobStore;
  readonly config: WebStateStoreConfig;
  readonly log: RunLog;
  /** Opens (creating if absent) a database in the store's pool; the extension owns and closes it. */
  openDatabase(file: string): SqliteWasmDatabase;
  /** Deletes a closed database of the pool, with its journal, so the extension can recreate it. */
  removeDatabase(file: string): void;
  /** The state DB's connection, which the writer owns; an extension only reads through it. */
  readonly state: SqliteWasmDatabase;
}

/** An extension's requests, by op name, run in the writer's request order. */
export type WebStateExtensionHandlers = Readonly<
  Record<string, (params: unknown) => unknown | Promise<unknown>>
>;

export interface WebStateExtensionInstance {
  /** Closes the extension's databases: when the writer closes or retires for factory reset. */
  close(): void;
  /**
   * Ops are namespaced by the extension (`index.search`); the writer refuses
   * to open with one that is not, or that another extension also names.
   */
  readonly handlers: WebStateExtensionHandlers;
}

/**
 * Something the browser writer composes beside the state DB, such as the
 * derived index. Its id is part of the wire protocol, so a tab whose writer
 * runs other extensions refuses that writer visibly.
 */
export interface WebStateExtension {
  readonly id: string;
  open(context: WebStateWriterContext): WebStateExtensionInstance;
}

/**
 * The extensions' ops, by name. An op must name its extension's namespace, so
 * it can neither shadow a writer op, none of which has one, nor another
 * extension's op.
 */
export function extensionOps(
  instances: readonly WebStateExtensionInstance[]
): ReadonlyMap<string, WebStateExtensionHandlers[string]> {
  const ops = new Map<string, WebStateExtensionHandlers[string]>();
  for (const instance of instances) {
    for (const [op, handler] of Object.entries(instance.handlers)) {
      if (!/^[a-z][a-zA-Z0-9-]*\.[a-zA-Z0-9.]+$/.test(op)) {
        throw new Error(`A writer extension's op ${op} is not namespaced`);
      }
      if (ops.has(op)) {
        throw new Error(`Two writer extensions both serve ${op}`);
      }
      ops.set(op, handler);
    }
  }
  return ops;
}
