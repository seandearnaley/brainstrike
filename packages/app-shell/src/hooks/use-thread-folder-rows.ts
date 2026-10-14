/**
 * Folder display rows for the Threads panel's `groupBy: 'folder'` view
 * (BST-1404). `thread-list-sections.ts` stays DB-free and takes
 * `folderRowsByRootId` from its caller; this hook is that caller's resolver.
 *
 * ONE batched `roots` query per distinct id set, NOT a live query. The columns
 * it reads are immutable after insert — `reconcileRoots` never modifies
 * `id`/`kind`/`path`/`display_name` on a matched row, and disconnecting a root
 * flips `status`, it does not delete the row — so there is no live-ness for a
 * subscription to track. A newly connected folder reaches the panel through the
 * INPUT instead: a thread only lands in a folder section once its
 * `metadata.operatingRootId` names that root, and that write changes the thread
 * row, hence the distinct id set, hence this query.
 *
 * Known bound: the ONE destructive path that removes a `roots` row (delete root
 * data) leaves a thread pointing at an id whose row is gone. The next query for
 * a changed id set drops it to "No folder" with the warning below; until then
 * the section keeps the name it resolved. Nothing is invented either way.
 */
import type { ThreadFolderRow } from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getThreadGroupsCapability } from '../thread-groups-capability';

const logger = createLogger('ThreadFolderRows');

const ROOT_DISPLAY_ROWS_SQL =
  'SELECT id, display_name AS "displayName", path FROM roots WHERE id = ANY($1::text[])';

const NO_FOLDER_ROWS: ReadonlyMap<string, ThreadFolderRow> = new Map();

interface RootRow {
  readonly displayName: string;
  readonly id: string;
  readonly path: string | null;
}

export interface ThreadFolderRowsState {
  /**
   * The failure of the CURRENT id set's query, or `null`. NOT decoration: with
   * `rowsByRootId` empty and `loading` false, a consumer that ignores this
   * renders every thread under "No folder" — presenting a failed lookup as the
   * honest fact that no thread has a folder. The same refusal the sibling
   * "needs you" projection makes, and the one
   * `docs/agents/assistant-persistence.md` already records for the panel's
   * run-state indicators ("render an explicit unavailable state instead of
   * silently presenting every thread as idle").
   *
   * No UI is built on it here: Task 4 owns the folder-section surface and is
   * the one that must render the unavailable state.
   */
  readonly error: Error | null;
  /**
   * True until the CURRENT id set has been resolved — including while there is
   * no database handle. An empty map reported as resolved would render every
   * thread under "No folder".
   */
  readonly loading: boolean;
  /**
   * Keyed by RAW `roots.id`, and each row's `path` is the RAW `roots.path`.
   * `useThreadBranchByRootPath` keys its map by NORMALIZED path instead
   * (`normalizeRootPathForLookup`), so a consumer joining the two MUST
   * normalize this `path` before that lookup — an un-normalized key silently
   * matches nothing and the branch chip simply never appears.
   */
  readonly rowsByRootId: ReadonlyMap<string, ThreadFolderRow>;
}

/**
 * Warns ONCE PER HOOK INSTANCE per root id that came back with no `roots` row
 * (the set lives in a ref, so it survives re-queries but not a remount — a
 * remounted panel warns again, which is the honest scope: nothing here is
 * module-global, and a module-scoped set would silence the warning for a
 * SECOND panel instance that has genuinely never reported the gap).
 *
 * The pure section builder deliberately says nothing about this (it has no
 * logger and no DB), so this is the only place the gap is observable. Nothing
 * is displayed for such an id — its threads fall into the trailing "No folder"
 * section.
 *
 * Called from the query's own continuation rather than a second effect, so the
 * observation lives exactly where the fact is established.
 */
function warnUnresolvedRootIds(
  rootIds: readonly string[],
  rowsByRootId: ReadonlyMap<string, ThreadFolderRow>,
  warnedRootIds: Set<string>
): void {
  for (const rootId of rootIds) {
    if (rowsByRootId.has(rootId) || warnedRootIds.has(rootId)) {
      continue;
    }
    warnedRootIds.add(rootId);
    logger.warn('thread folder root id has no roots row', { rootId });
  }
}

/**
 * Display rows for the workspace folders `rootIds` names, keyed by
 * `roots.id`. Ids with no row are simply absent from the map.
 */
export function useThreadFolderRows(
  database: DbHandle | null,
  rootIds: readonly string[]
): ThreadFolderRowsState {
  const catalog = getThreadGroupsCapability();
  // Value-keyed on the sorted, deduped id list: a thread-list refresh carrying
  // an EQUAL set (or the same set in another order) must not re-query. JSON,
  // not a joined string — a root id is opaque text, and any separator it could
  // itself contain would let two DIFFERENT id sets collapse to one key.
  const rootIdsKey = useMemo(() => JSON.stringify([...new Set(rootIds)].sort()), [rootIds]);
  const distinctRootIds = useMemo<readonly string[]>(
    () => JSON.parse(rootIdsKey) as readonly string[],
    [rootIdsKey]
  );

  // Tagged with the id set it was resolved FOR, so a resolution for one set is
  // never rendered under another and a bail-out needs no clearing setState
  // (react-hooks/set-state-in-effect).
  const [resolved, setResolved] = useState<{
    readonly error: Error | null;
    readonly key: string;
    readonly rowsByRootId: ReadonlyMap<string, ThreadFolderRow>;
  } | null>(null);
  // Survives re-queries so one unresolved id is reported once per hook
  // instance, not once per id-set change.
  const warnedRootIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!(database || catalog) || distinctRootIds.length === 0) {
      return;
    }
    let cancelled = false;
    const warnedRootIds = warnedRootIdsRef.current;
    (catalog
      ? catalog
          .readRoots()
          .then((rows) => ({ rows: rows.filter((row) => distinctRootIds.includes(row.id)) }))
      : database
        ? database.query<RootRow>(ROOT_DISPLAY_ROWS_SQL, [distinctRootIds])
        : Promise.reject(new Error('Thread root catalog unavailable'))
    )
      .then((result) => {
        if (cancelled) {
          return;
        }
        const rowsByRootId = new Map(
          result.rows.map((row) => [
            row.id,
            { displayName: row.displayName, path: row.path, rootId: row.id },
          ])
        );
        warnUnresolvedRootIds(distinctRootIds, rowsByRootId, warnedRootIds);
        setResolved({ error: null, key: rootIdsKey, rowsByRootId });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        logger.error('failed to load thread folder rows', { error });
        // Tagged with the key it failed for: the failure is not retried on
        // every render, and no other id set inherits the empty result OR the
        // error. The map stays EMPTY — no folder name is invented — and the
        // error is what stops the caller reading that emptiness as "no thread
        // has a folder".
        setResolved({
          error: error instanceof Error ? error : new Error(String(error)),
          key: rootIdsKey,
          rowsByRootId: NO_FOLDER_ROWS,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, database, distinctRootIds, rootIdsKey]);

  const isEmptyRequest = distinctRootIds.length === 0;
  const currentResolution = resolved?.key === rootIdsKey ? resolved : null;
  const rowsByRootId =
    isEmptyRequest || !currentResolution ? NO_FOLDER_ROWS : currentResolution.rowsByRootId;
  // An empty request is RESOLVED whatever the handle is — there was nothing to
  // ask. Anything else stays loading until ITS id set has come back.
  const loading = isEmptyRequest ? false : currentResolution === null;

  return { error: currentResolution?.error ?? null, loading, rowsByRootId };
}
