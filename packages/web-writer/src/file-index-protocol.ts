import type { IndexFileBinding, IndexScope } from '@brainstrike/indexer';

/**
 * What the file index is authorized for: the saved partition (BST-1988) over
 * the writer's catalogs, its live roots and the saved collection, and their files.
 */
export interface FileIndexAuthority {
  readonly fileBindings: readonly IndexFileBinding[];
  readonly rootIds: readonly string[];
  readonly scopes: readonly IndexScope[];
}

/** A failure as it crosses between the workers, its code kept (an IndexerError's). */
export interface FileIndexError {
  readonly code: unknown;
  readonly message: string;
  readonly name: string;
}

/** What one scan of a root reads: its byte bound and batch size. */
export interface FileIndexScanOptions {
  readonly batchSize: number;
  readonly maxFileBytes: number;
}

/** The writer's messages to the file index worker. */
export type FileIndexRequest =
  /** Installs the worker's pool; the store opens once a tab configures it. */
  | {
      readonly id: number;
      readonly kind: 'open';
      readonly pool: string;
      readonly scan: FileIndexScanOptions;
      readonly vfs: string;
    }
  /**
   * The Search & Indexing preferences as the visible settings stored them
   * (`NATIVE_INDEX_SETTINGS_KEY`), or null when none are saved. The tab hands
   * them over: a worker cannot read the tab's storage.
   */
  | { readonly id: number; readonly kind: 'configure'; readonly preferences: string | null }
  | { readonly id: number; readonly kind: 'reauthorize' }
  | { readonly id: number; readonly kind: 'request'; readonly op: string; readonly params: unknown }
  /**
   * Scans a live root's folder into the catalog and the index; answers with
   * its receipt. The tab supplies the folder it holds the user's grant for.
   */
  | {
      readonly folder: FileSystemDirectoryHandle;
      readonly id: number;
      readonly kind: 'scan';
      readonly rootId: string;
    }
  | { readonly id: number; readonly kind: 'close' }
  /** The writer's answer to the worker's `writer` call of the same id. */
  | {
      readonly error?: FileIndexError;
      readonly id: number;
      readonly kind: 'writer-reply';
      readonly ok: boolean;
      readonly result?: unknown;
    };

/** The file index worker's messages to the writer. */
export type FileIndexMessage =
  | { readonly id: number; readonly kind: 'reply'; readonly ok: true; readonly result: unknown }
  | {
      readonly error: FileIndexError;
      readonly id: number;
      readonly kind: 'reply';
      readonly ok: false;
    }
  /** Runs one of the writer's ops in its request order (`WebStateWriterContext.request`). */
  | { readonly id: number; readonly kind: 'writer'; readonly op: string; readonly params: unknown };

/** A failure's message, with an aggregate's own failures, which no other field carries across. */
function failureMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return error instanceof AggregateError && error.errors.length > 0
    ? `${error.message} (${error.errors.map(failureMessage).join('; ')})`
    : error.message;
}

export function fileIndexError(error: unknown): FileIndexError {
  return {
    code: error instanceof Error ? Reflect.get(error, 'code') : undefined,
    message: failureMessage(error),
    name: error instanceof Error ? error.name : 'Error',
  };
}

/** The failure as an Error again, with its name and code. */
export function fileIndexFailure(error: FileIndexError): Error {
  return Object.assign(new Error(error.message), error);
}
