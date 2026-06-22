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
import { createLogger } from '@brainstrike/utils/logger';
import { useEffect, useMemo, useState } from 'react';
import { type RootIdentity, useOptionalRootIdentity } from './roots/root-identity-context';

const logger = createLogger('useFileMentions');

/** Honest label for a file whose root has no display name (legacy NULL root). */
const WORKSPACE_FALLBACK_LABEL = 'Workspace';

// Module-level dedupe so a dropped DB root_id only warns ONCE across the app's
// lifetime (not once per render / per "@" keystroke). Mirrors the provider
// path's `warnedUnmappedDbRoots` (root-identity-context.tsx) so the
// no-translator fallback honours the same no-silent-drop contract.
const warnedFallbackDropRootIds = new Set<string>();

/**
 * Resolve a DB `root_id` to the file-explorer adapter rootId (or `null` when it
 * cannot be resolved / the root is unmounted).
 *
 * The RootIdentityProvider is the authoritative translator for the case where
 * the two identities DIVERGE (legacy / web same-named FSA roots, and desktop
 * roots whose adapter id was path-matched to a pre-existing roots.id by
 * `reconcileRoots`). It is only mounted inside the workspace-sync subtree (⌘P
 * quick-open lives there); the assistant panel renders as a SIBLING of it, so
 * the translator is typically ABSENT here.
 *
 * When absent, fall back to treating the DB root_id AS the adapter id — but ONLY
 * when it is itself a currently-mounted adapter root (verified membership, never
 * an invented mapping). Exact wherever `reconcileRoots` established identity
 * (roots.id == adapter rootId, the common case; @file is desktop-only). KNOWN
 * LIMITATION: a MOUNTED root whose roots.id != adapter rootId (path-matched)
 * can't be resolved without the provider — logged once per id so the drop is
 * observable, never a silent empty popover. Durable fix: mount the provider
 * around the assistant subtree too (tracked follow-up).
 */
function resolveMentionAdapterRootId(
  rootIdentity: RootIdentity | null,
  dbRootId: string,
  activeRootIdSet: ReadonlySet<string>
): string | null {
  if (rootIdentity) {
    return rootIdentity.resolveAdapterRootId(dbRootId);
  }
  if (activeRootIdSet.has(dbRootId)) {
    return dbRootId;
  }
  if (!warnedFallbackDropRootIds.has(dbRootId)) {
    warnedFallbackDropRootIds.add(dbRootId);
    logger.warn(
      'file-mention dropped: no root-identity provider and the DB root_id is not a mounted adapter root',
      { dbRootId }
    );
  }
  return null;
}

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
      // Translate DB root_id → adapter rootId (provider-authoritative, with a
      // verified-membership fallback when the provider is absent — see
      // resolveMentionAdapterRootId), then gate by the currently-mounted roots.
      const adapterRootId = resolveMentionAdapterRootId(rootIdentity, row.root_id, activeRootIdSet);
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
