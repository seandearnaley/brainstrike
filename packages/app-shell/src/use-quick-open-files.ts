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
import { useEffect, useMemo, useState } from 'react';
import { useOptionalRootIdentity } from './roots/root-identity-context';

/** Honest label for a file whose root has no display name (legacy NULL root). */
const WORKSPACE_FALLBACK_LABEL = 'Workspace';

/**
 * Debounce window for the search query. Each distinct query spins up a new
 * PGlite live subscription, so we wait for typing to settle before resubscribing
 * — intermediate keystrokes (`r`,`re`,`rea`,…) never each spawn one.
 */
const QUICK_OPEN_DEBOUNCE_MS = 150;

export interface UseQuickOpenFilesResult {
  readonly files: readonly QuickOpenFileItem[];
  readonly loading: boolean;
}

/**
 * Reactive quick-open file list. Debounces the query, runs the shared
 * `QUICK_OPEN_NAME_SEARCH_SQL` via a live query (re-runs as the index changes),
 * then maps each DB row to an openable `QuickOpenFileItem`.
 *
 * Multi-root open correctness (the load-bearing part): `file_records.root_id`
 * stores the DB `roots.id`, which DIVERGES from the file-explorer adapter rootId
 * for legacy/path-matched roots (see migrations/047-run-usage-root-id.ts). The
 * open seam (`openFileInTab` / `encodeFileSelection` / the file-tree
 * `rootFolderId`) is keyed by the ADAPTER rootId. So we translate DB → adapter
 * through `RootIdentity` (built from the reconciliation map) and:
 *  - GATE: keep a row only if its DB root_id maps to a currently-mounted ADAPTER
 *    root (translate first — gating on the raw DB id would silently drop every
 *    legacy-root file, since activeRootIds holds adapter ids),
 *  - ENCODE: build the compositeKey with the ADAPTER rootId, never the DB id.
 * A row whose DB root_id has no adapter mapping (unmounted / unreconciled, or
 * NULL legacy) is omitted; the translator logs once so the drop is observable.
 *
 * Stale-row safety: the live query keeps the PREVIOUS result set until the new
 * subscription resolves. So while a debounce is pending OR the live query is
 * loading the CURRENT query, we expose NO files — pressing Enter during the
 * transition can never open a file from a prior result set.
 *
 * The empty query yields no rows (the SQL would match everything; we skip the
 * subscription entirely so the palette shows its "type to search" prompt).
 */
export function useQuickOpenFiles(query: string): UseQuickOpenFilesResult {
  const activeRootIds = useFileExplorerStoreSelector((state) => state.activeRootIds);
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const rootIdentity = useOptionalRootIdentity();

  const trimmed = query.trim();
  const debounced = useDebouncedQuery(trimmed, QUICK_OPEN_DEBOUNCE_MS);
  // A debounce is pending whenever the live (trimmed) query has not yet caught
  // up to the debounced one the subscription is keyed on.
  const debouncePending = trimmed !== debounced;
  const enabled = debounced.length > 0;

  const { rows, loading } = usePGliteLiveQuery<QuickOpenFileRow>({
    cacheKey: makeLiveQueryKey('quick-open', debounced),
    enabled,
    key: 'id',
    mode: 'incremental',
    params: [debounced, QUICK_OPEN_MAX_LIMIT],
    query: QUICK_OPEN_NAME_SEARCH_SQL,
  });

  // While typing is still settling OR the current query's results have not yet
  // arrived, the `rows` belong to a PRIOR query — never expose them as
  // actionable (Enter must not open a stale file).
  const rowsAreStale = debouncePending || loading;

  const files = useMemo<readonly QuickOpenFileItem[]>(() => {
    if (!enabled || rowsAreStale) {
      return [];
    }
    const activeRootIdSet = new Set(activeRootIds);
    const items: QuickOpenFileItem[] = [];
    for (const row of rows) {
      if (row.root_id === null) {
        continue;
      }
      // Translate the DB root_id back to the adapter rootId the open seam uses.
      // No translator (provider absent) ⇒ no honest way to open ⇒ omit.
      const adapterRootId = rootIdentity?.resolveAdapterRootId(row.root_id) ?? null;
      if (adapterRootId === null || !activeRootIdSet.has(adapterRootId)) {
        continue;
      }
      const descriptor = rootDescriptors[adapterRootId];
      const rootLabel = descriptor?.displayName ?? row.display_name ?? WORKSPACE_FALLBACK_LABEL;
      items.push({
        // ADAPTER rootId, NOT the DB root_id — disambiguates the open by root.
        compositeKey: encodeFileSelection(adapterRootId, row.path),
        id: row.id,
        name: row.name,
        path: row.path,
        rootLabel,
      });
    }
    return items;
  }, [enabled, rowsAreStale, rows, activeRootIds, rootDescriptors, rootIdentity]);

  // Report loading while a query is in flight OR a debounce is pending, so the
  // palette shows "Searching…" instead of a misleading "No files found.".
  return { files, loading: trimmed.length > 0 && (rowsAreStale || loading) };
}

/**
 * Local debounce (mirrors `@brainstrike/hooks` `useDebouncedValue`) — inlined to
 * avoid adding a package dependency just for one call. Derived during render is
 * impossible for a time-delayed value, so the setState-in-effect here is the
 * canonical debounce pattern (cleared on every change).
 */
function useDebouncedQuery(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debounced;
}
