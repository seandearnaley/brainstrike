/**
 * A thread's folders as the durable `roots` table records them now (BST-1990).
 * The host refuses a run or a binding write while any bound folder is not a
 * live row, so the workspace bar reads the same fact: each secondary resolves
 * to its row, and a folder whose row is gone or no longer live is marked
 * `removed` rather than shown as if it still worked.
 */
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useState } from 'react';
import type { ThreadCheckoutRoot } from './use-thread-folders-write';
import {
  type ResolvedSecondaryRoots,
  secondaryRootsStatus,
} from './use-workspace-bar-write-derive';

const logger = createLogger('WorkspaceBar');

interface RootRow {
  readonly displayName: string;
  readonly id: string;
  readonly path: string | null;
  readonly status: string;
}

const NO_ROOTS: readonly ThreadCheckoutRoot[] = [];
/** The display name of a bound folder whose row was deleted with its indexed data. */
export const UNKNOWN_REMOVED_FOLDER_NAME = 'Unknown folder';

interface ResolvedThreadRoots extends ResolvedSecondaryRoots {
  readonly primaryRemoved: boolean;
}

export interface ThreadRoots {
  readonly loadedSecondaryRoots: readonly ThreadCheckoutRoot[];
  /** True once the primary's row is read and is missing or not live. */
  readonly primaryRemoved: boolean;
  readonly secondaryRootsStatus: 'error' | 'pending' | 'ready';
}

function secondaryRoot(id: string, row: RootRow | undefined): ThreadCheckoutRoot {
  if (!row) {
    logger.warn('secondary root id has no roots row', { id });
    return { displayName: UNKNOWN_REMOVED_FOLDER_NAME, removed: true, rootId: id };
  }
  return {
    displayName: row.displayName,
    ...(row.path ? { path: row.path } : {}),
    ...(row.status === 'live' ? {} : { removed: true }),
    rootId: row.id,
  };
}

/**
 * `mountedKey` names the workspace's mounted folders: removing or re-adding a
 * folder changes it, and the rows are read again, because the folder's row
 * changes status without the thread's own ids changing.
 */
export function useThreadRoots(args: {
  readonly database: DbHandle | null;
  readonly mountedKey: string;
  readonly primaryRootId: string | undefined;
  readonly secondaryRootIds: readonly string[];
  readonly secondaryRootIdsKey: string;
}): ThreadRoots {
  const { database, mountedKey, primaryRootId, secondaryRootIds, secondaryRootIdsKey } = args;
  // Tagged with the ids it was read for, so a result is never rendered under
  // another thread's folders and a bail-out needs no clearing setState
  // (react-hooks/set-state-in-effect). A re-read for a mount change keeps the
  // same ids, so the chip keeps its rows while the statuses refresh.
  const key = `${secondaryRootIdsKey}\n${primaryRootId ?? ''}`;
  const [resolved, setResolved] = useState<ResolvedThreadRoots | null>(null);
  useEffect(() => {
    const ids = [...new Set([...(primaryRootId ? [primaryRootId] : []), ...secondaryRootIds])];
    if (!database || ids.length === 0) {
      return;
    }
    let cancelled = false;
    database
      .query<RootRow>(
        'SELECT id, display_name AS "displayName", path, status FROM roots WHERE id = ANY($1::text[])',
        [ids]
      )
      .then((result) => {
        if (cancelled) {
          return;
        }
        const byId = new Map(result.rows.map((row) => [row.id, row]));
        const primary = primaryRootId ? byId.get(primaryRootId) : undefined;
        setResolved({
          error: false,
          key,
          primaryRemoved: Boolean(primaryRootId) && primary?.status !== 'live',
          roots: secondaryRootIds.map((id) => secondaryRoot(id, byId.get(id))),
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.error('failed to load the thread secondary roots', { error });
          // Tagged with the key it failed for, so the failure is not retried on
          // every render and no other id list inherits an empty result.
          setResolved({ error: true, key, primaryRemoved: false, roots: NO_ROOTS });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [database, key, mountedKey, primaryRootId, secondaryRootIds]);
  const current = database && resolved?.key === key ? resolved : null;
  return {
    loadedSecondaryRoots: current?.roots ?? NO_ROOTS,
    primaryRemoved: current?.primaryRemoved ?? false,
    secondaryRootsStatus: secondaryRootsStatus(
      secondaryRootIds,
      key,
      current && { error: current.error, key: current.key, roots: current.roots }
    ),
  };
}
