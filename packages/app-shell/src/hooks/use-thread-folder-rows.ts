/**
 * Folder display rows for the Threads panel's `groupBy: 'folder'` view
 * (BST-1404). `thread-list-sections.ts` stays DB-free and takes
 * `folderRowsByRootId` from its caller; this hook is that caller's resolver.
 *
 * ONE batched `roots` query per distinct id set, read again whenever a root
 * registration commits. A registration can change a recorded folder's row
 * under the same id: a folder picked again at a new place takes that path and
 * name, and joins the project already there, and a folder recorded before
 * projects gets one when it is next opened. A newly connected folder reaches
 * the panel through the INPUT: a thread only lands in a folder section once its
 * `metadata.operatingRootId` names that root, and that write changes the thread
 * row, hence the distinct id set, hence this query.
 *
 * Known bound: the ONE destructive path that removes a `roots` row (delete root
 * data) leaves a thread pointing at an id whose row is gone. The next query for
 * a changed id set drops it to "No folder" with the warning below; until then
 * the section keeps the name it resolved. Nothing is invented either way.
 */
import type { ThreadFolderGroupingRow } from '@brainstrike/assistant-data';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useMemo, useRef, useState } from 'react';
import { subscribeRootRegistered } from '../roots/root-registration-events';
import { getThreadGroupsCapability } from '../thread-groups-capability';

const logger = createLogger('ThreadFolderRows');

const NO_FOLDER_ROWS: ReadonlyMap<string, ThreadFolderGroupingRow> = new Map();

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
   * Keyed by RAW `roots.id`, and each row's `path` is the RAW `roots.path`:
   * the path the folder was mounted through, which git may report under
   * another spelling. Join on the id, never on this path.
   */
  readonly rowsByRootId: ReadonlyMap<string, ThreadFolderGroupingRow>;
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
  rowsByRootId: ReadonlyMap<string, ThreadFolderGroupingRow>,
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
export function useThreadFolderRows(rootIds: readonly string[]): ThreadFolderRowsState {
  const catalog = getThreadGroupsCapability();
  // Value-keyed on the sorted, deduped id list: a thread-list refresh carrying
  // an EQUAL set (or the same set in another order) must not re-query. JSON,
  // not a joined string — a root id is opaque text, and any separator it could
  // itself contain would let two DIFFERENT id sets collapse to one key.
  const rootIdsKey = JSON.stringify([...new Set(rootIds)].sort());
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
    readonly rowsByRootId: ReadonlyMap<string, ThreadFolderGroupingRow>;
  } | null>(null);
  // Survives re-queries so one unresolved id is reported once per hook
  // instance, not once per id-set change.
  const warnedRootIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!catalog || distinctRootIds.length === 0) {
      return;
    }
    const warnedRootIds = warnedRootIdsRef.current;
    let cancelRead = (): void => {};
    // A later read supersedes an earlier one still out, so an older result
    // never overwrites a newer registration's.
    const read = (): void => {
      cancelRead();
      let cancelled = false;
      cancelRead = () => {
        cancelled = true;
      };
      catalog
        .readRoots()
        .then((rows) => ({ rows: rows.filter((row) => distinctRootIds.includes(row.id)) }))
        .then((result) => {
          if (cancelled) {
            return;
          }
          const rowsByRootId = new Map(
            result.rows.map((row) => [
              row.id,
              {
                displayName: row.displayName,
                path: row.path,
                projectId: row.projectId,
                rootId: row.id,
                ...(row.scratch ? { scratch: true as const } : {}),
              },
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
    };
    // Subscribe before reading: a registration that commits during the first
    // read supersedes it.
    const unsubscribe = subscribeRootRegistered(read);
    read();
    return () => {
      unsubscribe();
      cancelRead();
    };
  }, [catalog, distinctRootIds, rootIdsKey]);

  const isEmptyRequest = distinctRootIds.length === 0;
  const currentResolution = resolved?.key === rootIdsKey ? resolved : null;
  const rowsByRootId =
    isEmptyRequest || !currentResolution ? NO_FOLDER_ROWS : currentResolution.rowsByRootId;
  // An empty request is RESOLVED whatever the handle is — there was nothing to
  // ask. Anything else stays loading until ITS id set has come back.
  const loading = isEmptyRequest ? false : currentResolution === null;

  return { error: currentResolution?.error ?? null, loading, rowsByRootId };
}
