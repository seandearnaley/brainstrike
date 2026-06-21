import { encodeFileMentionId } from '@brainstrike/assistant-contract';
import {
  makeLiveQueryKey,
  QUICK_OPEN_MAX_LIMIT,
  QUICK_OPEN_NAME_SEARCH_SQL,
  type QuickOpenFileRow,
  usePGliteLiveQuery,
} from '@brainstrike/db';
import { useFileExplorerStoreSelector } from '@brainstrike/file-explorer-ui/shell';
import type { FileMention } from '@brainstrike/ui/assistant-ui-panel';
import { useEffect, useMemo, useState } from 'react';
import { useOptionalRootIdentity } from './roots/root-identity-context';

/** Honest label for a file whose root has no display name (legacy NULL root). */
const WORKSPACE_FALLBACK_LABEL = 'Workspace';

/**
 * Debounce window for the "@" mention query. Each distinct query spins up a new
 * PGlite live subscription, so we wait for typing to settle before resubscribing
 * (mirrors the ⌘P quick-open debounce).
 */
const FILE_MENTION_DEBOUNCE_MS = 150;

export interface UseFileMentionsResult {
  readonly fileMentions: readonly FileMention[];
  readonly loading: boolean;
}

/**
 * Reactive "@" file-mention candidate list. Reuses the ⌘P quick-open file query
 * (`QUICK_OPEN_NAME_SEARCH_SQL`) — debounced, live, bounded — and maps each DB
 * row to a `FileMention` whose directive id encodes the DB `roots.id` + path.
 *
 * Directive id divergence vs ⌘P: quick-open encodes the ADAPTER rootId (the
 * file-tree open seam is keyed by it). The `@file` directive instead encodes the
 * DB `root_id` (`encodeFileMentionId`), because the desktop assistant server
 * resolves a referenced file against the DB `roots` table (`roots.id`), not the
 * adapter ids. We still GATE the list by active adapter roots (translate DB →
 * adapter via `RootIdentity`, keep only currently-mounted roots) so we never
 * offer a file whose folder is closed in the UI; a row whose DB root_id has no
 * adapter mapping, or whose mapped root is unmounted, or whose root_id is NULL,
 * is omitted.
 *
 * The empty query yields no candidates (the subscription is disabled), so "@"
 * with no following text shows nothing until the user types.
 */
export function useFileMentions(query: string): UseFileMentionsResult {
  const activeRootIds = useFileExplorerStoreSelector((state) => state.activeRootIds);
  const rootDescriptors = useFileExplorerStoreSelector((state) => state.rootDescriptors);
  const rootIdentity = useOptionalRootIdentity();

  const trimmed = query.trim();
  const debounced = useDebouncedQuery(trimmed, FILE_MENTION_DEBOUNCE_MS);
  const debouncePending = trimmed !== debounced;
  const enabled = debounced.length > 0;

  const { rows, loading } = usePGliteLiveQuery<QuickOpenFileRow>({
    cacheKey: makeLiveQueryKey('file-mention', debounced),
    query: QUICK_OPEN_NAME_SEARCH_SQL,
    params: [debounced, QUICK_OPEN_MAX_LIMIT],
    mode: 'incremental',
    key: 'id',
    enabled,
  });

  // Rows from a prior query (debounce pending or subscription loading) belong to
  // a different query — never expose them as candidates.
  const rowsAreStale = debouncePending || loading;

  const fileMentions = useMemo<readonly FileMention[]>(() => {
    if (!enabled || rowsAreStale) {
      return [];
    }
    const activeRootIdSet = new Set(activeRootIds);
    const items: FileMention[] = [];
    for (const row of rows) {
      if (row.root_id === null) {
        continue;
      }
      // Resolve the DB root_id to the file-explorer adapter rootId, then gate by
      // the currently-mounted roots.
      //
      // The RootIdentityProvider is the authoritative translator for the case
      // where the two identities DIVERGE (legacy / web same-named FSA roots).
      // But it is only mounted inside the workspace-sync subtree (⌘P quick-open
      // lives there); the assistant panel renders as a SIBLING of that subtree,
      // so here the translator is typically ABSENT.
      //
      // When absent, fall back to treating the DB root_id AS the adapter id —
      // but ONLY when it is itself a currently-mounted adapter root (verified
      // against the live `activeRootIds` set). This never invents a mapping: it
      // is exact wherever `reconcileRoots` established identity (roots.id ==
      // adapter rootId — all desktop roots, and @file is desktop-only), and a
      // divergent legacy id that matches no mounted root is dropped honestly.
      const adapterRootId = rootIdentity
        ? rootIdentity.resolveAdapterRootId(row.root_id)
        : activeRootIdSet.has(row.root_id)
          ? row.root_id
          : null;
      if (adapterRootId === null || !activeRootIdSet.has(adapterRootId)) {
        continue;
      }
      const descriptor = rootDescriptors[adapterRootId];
      const rootLabel = descriptor?.displayName ?? row.display_name ?? WORKSPACE_FALLBACK_LABEL;
      items.push({
        id: encodeFileMentionId(row.root_id, row.path),
        label: row.name,
        path: row.path,
        rootLabel,
      });
    }
    return items;
  }, [enabled, rowsAreStale, rows, activeRootIds, rootDescriptors, rootIdentity]);

  return { fileMentions, loading: trimmed.length > 0 && (rowsAreStale || loading) };
}

/**
 * Local debounce (mirrors `use-quick-open-files`). A time-delayed value can't be
 * derived during render, so the setState-in-effect is the canonical pattern.
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
