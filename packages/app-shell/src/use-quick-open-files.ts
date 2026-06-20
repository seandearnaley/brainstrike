import {
  makeLiveQueryKey,
  QUICK_OPEN_MAX_LIMIT,
  QUICK_OPEN_NAME_SEARCH_SQL,
  type QuickOpenFileRow,
  usePGliteLiveQuery,
} from '@brainstrike/db';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import type { QuickOpenFileItem } from '@brainstrike/ui';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useMemo } from 'react';

/** Honest label for a file whose root has no display name (legacy NULL root). */
const WORKSPACE_FALLBACK_LABEL = 'Workspace';

export interface UseQuickOpenFilesResult {
  readonly files: readonly QuickOpenFileItem[];
  readonly loading: boolean;
}

/**
 * Reactive quick-open file list. Runs the shared `QUICK_OPEN_NAME_SEARCH_SQL`
 * via a live query (re-runs as the user types — `params` change — AND as the
 * index changes), then maps each DB row to an openable `QuickOpenFileItem`.
 *
 * Multi-root open correctness: the compositeKey the open seam expects is
 * `${adapterRootId}|@|${path}`, where the adapter rootId is the file-explorer
 * store key. For roots registered through reconcileRoots the adapter rootId
 * EQUALS `file_records.root_id`, so a row's `root_id` indexes `rootDescriptors`
 * directly. A row whose `root_id` is NOT a currently-mounted root (NULL legacy
 * rows, or a root not open this session) is OMITTED — the live file tree the
 * open seam walks has no node for it, so offering it would silently no-op. This
 * is honest: quick-open only lists files it can actually open.
 *
 * The empty query yields no rows (the SQL would match everything; we skip the
 * subscription entirely so the palette shows its "type to search" prompt).
 */
export function useQuickOpenFiles(query: string): UseQuickOpenFilesResult {
  const activeRootIds = useFileExplorerStoreSelector((state) => state.activeRootIds);
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);

  const trimmed = query.trim();
  const enabled = trimmed.length > 0;

  const { rows, loading } = usePGliteLiveQuery<QuickOpenFileRow>({
    cacheKey: makeLiveQueryKey('quick-open', trimmed),
    query: QUICK_OPEN_NAME_SEARCH_SQL,
    params: [trimmed, QUICK_OPEN_MAX_LIMIT],
    mode: 'incremental',
    key: 'id',
    enabled,
  });

  const files = useMemo<readonly QuickOpenFileItem[]>(() => {
    if (!enabled) {
      return [];
    }
    const activeRootIdSet = new Set(activeRootIds);
    const items: QuickOpenFileItem[] = [];
    for (const row of rows) {
      // Only files under a currently-mounted root are openable (the open seam
      // resolves the file by walking that root's live file tree). adapter
      // rootId === file_records.root_id for reconciled roots.
      if (row.root_id === null || !activeRootIdSet.has(row.root_id)) {
        continue;
      }
      const descriptor = rootDescriptors[row.root_id];
      const rootLabel = descriptor?.displayName ?? row.display_name ?? WORKSPACE_FALLBACK_LABEL;
      items.push({
        id: row.id,
        name: row.name,
        path: row.path,
        rootLabel,
        compositeKey: encodeFileSelection(row.root_id, row.path),
      });
    }
    return items;
  }, [enabled, rows, activeRootIds, rootDescriptors]);

  return { files, loading: enabled && loading };
}
