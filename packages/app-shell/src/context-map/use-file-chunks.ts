/**
 * Index chunk bounds for the files a context map shows (BST-2017), read
 * through the native index's chunk-bounds capability in batches per root.
 * A file the index cannot answer for keeps an explicit state; it is never
 * drawn as if it had no chunks.
 */
import type {
  IndexChunkBoundsCapability,
  IndexerFileChunks,
} from '@brainstrike/indexing-contract/indexer-client';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContextFileRow } from './context-map-model';

const logger = createLogger('ContextMapFileChunks');
const MAX_PATHS_PER_REQUEST = 100;
const KEY_SEPARATOR = '\u0000';

export type FileChunksState =
  | IndexerFileChunks
  | { readonly kind: 'failed'; readonly path: string }
  | { readonly kind: 'loading'; readonly path: string };

interface ChunkRequest {
  readonly paths: readonly string[];
  readonly rootId: string;
}

/** A row key is `rootId NUL path` when the row has a root id (see `fileKey`). */
function chunkRequests(keys: readonly string[]): ChunkRequest[] {
  const byRoot = new Map<string, string[]>();
  for (const key of keys) {
    const separator = key.indexOf(KEY_SEPARATOR);
    const rootId = key.slice(0, separator);
    const paths = byRoot.get(rootId) ?? [];
    paths.push(key.slice(separator + 1));
    byRoot.set(rootId, paths);
  }
  const requests: ChunkRequest[] = [];
  for (const [rootId, paths] of byRoot) {
    for (let index = 0; index < paths.length; index += MAX_PATHS_PER_REQUEST) {
      requests.push({ paths: paths.slice(index, index + MAX_PATHS_PER_REQUEST), rootId });
    }
  }
  return requests;
}

function keyOf(rootId: string, path: string): string {
  return `${rootId}${KEY_SEPARATOR}${path}`;
}

interface Requested {
  readonly capability: IndexChunkBoundsCapability | null;
  readonly keys: Set<string>;
  readonly revision: string;
}

/**
 * Chunk bounds by row key; rows without a root id are absent (drawn by line
 * bands). Each file is read once per `revision`: pass a value that changes
 * when the thread may have changed files, so edited files are read again.
 * A file already shown keeps its bounds until the new read settles.
 */
export function useFileChunks(
  capability: IndexChunkBoundsCapability | null,
  rows: readonly ContextFileRow[],
  revision: string
): ReadonlyMap<string, FileChunksState> {
  const requestKey = useMemo(
    () =>
      [...new Set(rows.flatMap((row) => (row.rootId ? [keyOf(row.rootId, row.path)] : [])))]
        .sort()
        .join('\n'),
    [rows]
  );
  const [state, setState] = useState<ReadonlyMap<string, FileChunksState>>(new Map());
  const requested = useRef<Requested>({ capability, keys: new Set(), revision });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // biome-ignore lint/plugin: settles an IPC read into state; nothing here is derived during render
  useEffect(() => {
    if (!capability || requestKey === '') {
      return;
    }
    if (requested.current.capability !== capability || requested.current.revision !== revision) {
      requested.current = { capability, keys: new Set(), revision };
    }
    const current = requested.current;
    const missing = requestKey.split('\n').filter((key) => !current.keys.has(key));
    if (missing.length === 0) {
      return;
    }
    for (const key of missing) {
      current.keys.add(key);
    }
    // A reply settles only while this capability and revision are still the ones asked.
    const settle = (rootId: string, files: readonly FileChunksState[]) => {
      if (!mounted.current || requested.current !== current) {
        return;
      }
      setState((previous) => {
        const next = new Map(previous);
        for (const file of files) {
          next.set(keyOf(rootId, file.path), file);
        }
        return next;
      });
    };
    setState((previous) => {
      const next = new Map(previous);
      for (const key of missing) {
        if (!next.has(key)) {
          next.set(key, { kind: 'loading', path: key.slice(key.indexOf(KEY_SEPARATOR) + 1) });
        }
      }
      return next;
    });
    for (const request of chunkRequests(missing)) {
      capability
        .fileChunks({ paths: request.paths, rootId: request.rootId })
        .then((result) => settle(request.rootId, result.files))
        .catch((error: unknown) => {
          logger.warn('Index chunk bounds were unavailable for a context map batch', {
            error,
            paths: request.paths.length,
          });
          settle(
            request.rootId,
            request.paths.map((path) => ({ kind: 'failed', path }))
          );
        });
    }
  }, [capability, requestKey, revision]);

  return state;
}
