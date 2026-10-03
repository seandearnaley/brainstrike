import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import { Button } from '@brainstrike/ui';
import { AlertCircle, Loader2, Search } from 'lucide-react';
import type * as React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';
import { SearchCollectionPicker } from './search-collection-picker';
import { SearchCoverageBanner } from './search-coverage-banner';
import { SearchInputBar } from './search-input-bar';
import { SearchModeToggle } from './search-mode-toggle';
import { type SearchOpenTarget, SearchResultsTree } from './search-results-tree';
import {
  SEMANTIC_UNAVAILABLE_NO_CHUNKS,
  type SemanticAvailability,
  useSemanticAvailability,
} from './use-semantic-availability';

/** Text-mode live-search debounce window. */
const TEXT_DEBOUNCE_MS = 250;
/** Minimum text-query length before an automatic search fires. */
const MIN_TEXT_QUERY_LENGTH = 3;

export interface WorkspaceSearchPanelProps {
  allowTextPaging?: boolean;
  onOpenFile: (compositeKey: string, target?: SearchOpenTarget) => void;
  resolveAdapterRootId: (dbRootId: string) => string | null;
  runSemanticSearch: () => void;
  runTextSearch: () => void;
  semanticAvailability?: SemanticAvailability;
  /** DB root ids of currently mounted, live workspace roots (query scope). */
  workspaceDbRootIds: readonly string[];
}

/**
 * The workspace-search tab content: mode + collection controls, the query
 * input, coverage banner, the status-driven results area, and a selection
 * footer. Presentation + store only — the executor lives at the composition
 * layer (Task 11) and is passed down as the two run callbacks.
 */
export function WorkspaceSearchPanel({
  allowTextPaging = true,
  semanticAvailability,
  onOpenFile,
  workspaceDbRootIds,
  resolveAdapterRootId,
  runTextSearch,
  runSemanticSearch,
}: WorkspaceSearchPanelProps): React.ReactNode {
  const mode = useWorkspaceSearchStore((state) => state.mode);
  const status = useWorkspaceSearchStore((state) => state.status);
  const error = useWorkspaceSearchStore((state) => state.error);
  const query = useWorkspaceSearchStore((state) => state.query);
  const caseSensitive = useWorkspaceSearchStore((state) => state.caseSensitive);
  const isRegex = useWorkspaceSearchStore((state) => state.isRegex);
  const wholeWord = useWorkspaceSearchStore((state) => state.wholeWord);
  const collectionId = useWorkspaceSearchStore((state) => state.collectionId);

  // Same live-stats signal (shared query + cache key) the mode toggle gates on
  // — see {@link useSemanticAvailability}. Load-bearing for the SUBMIT gate
  // below, not just the toggle's entry gate.
  const { available: semanticAvailable, reason: semanticReason } = useSemanticAvailability(
    collectionId,
    semanticAvailability
  );

  // Output (post-range) tokens match the per-file range model + the meters'
  // locked "output" language — source tokens would show a huge-file total even
  // when only one chunk is checked.
  const approxTokens = useWorkspaceContextCurationStore(
    (state) => state.contextSnapshot?.selectedOutputApproxTokens
  );

  // Gate the SUBMIT path, not just the toggle's ENTRY: the toggle only blocks
  // clicking into semantic, but Enter/Retry route to `runSemanticSearch` off the
  // store `mode` alone. Running a semantic search against a confirmed-zero
  // embedded set silently degrades — the hybrid executor's FTS arm scopes by
  // `embedding_set_id` WITHOUT `embedding IS NOT NULL`, so it returns
  // lexical-only matches under a pressed Semantic mode (a silent fallback).
  // Instead we fail VISIBLY (error card) while PRESERVING the user's mode —
  // `beginSearch` + `failSearch` reuse the generation-guarded store transition
  // so the surfaced error can't clobber a newer in-flight run.
  const onSubmit = useCallback(() => {
    if (mode !== 'semantic') {
      runTextSearch();
      return;
    }
    if (semanticAvailable) {
      runSemanticSearch();
      return;
    }
    const store = useWorkspaceSearchStore.getState();
    const generation = store.beginSearch();
    store.failSearch(semanticReason ?? SEMANTIC_UNAVAILABLE_NO_CHUNKS, generation);
  }, [mode, semanticAvailable, semanticReason, runSemanticSearch, runTextSearch]);

  // Show-more paging (text mode only, Task P2): bump the store's cap, then
  // rerun the current text search — `beginSearch()` inside `runTextSearch`
  // supplies the generation guard, so a mode switch (or any other invalidating
  // change) right after this click drops the late results instead of
  // resurrecting a now-stale run.
  const handleShowMore = useCallback(() => {
    useWorkspaceSearchStore.getState().increaseTextResultLimit();
    runTextSearch();
  }, [runTextSearch]);

  // Latest-value refs keep the debounce effect's dependency list scoped to the
  // query controls (not the run-callback/mode identity) while still calling the
  // current callback and checking the live mode at fire time. Assigned in an
  // effect (never during render) so the React Compiler can optimize the
  // component; the effect has no dep array so the refs track every render, and
  // it is declared BEFORE the debounce effect so it settles first each pass.
  const runTextSearchRef = useRef(runTextSearch);
  const modeRef = useRef(mode);
  useEffect(() => {
    runTextSearchRef.current = runTextSearch;
    modeRef.current = mode;
  });
  // Trimmed length of the query the previous effect run observed. `null` on the
  // initial mount so a seeded results/searching state is not wiped on first
  // render — only an actual shrink across the threshold clears results.
  const prevQueryLengthRef = useRef<number | null>(null);

  // caseSensitive/isRegex/wholeWord/collectionId are load-bearing deps even
  // though the body reads them via the run callback, not directly: changing any
  // search parameter must restart the 250ms debounce so a fresh query fires.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional restart triggers, not effect-body reads.
  useEffect(() => {
    const trimmedLength = query.trim().length;
    const previousLength = prevQueryLengthRef.current;
    prevQueryLengthRef.current = trimmedLength;
    if (trimmedLength < MIN_TEXT_QUERY_LENGTH) {
      // The query is too short to auto-search. In text mode, drop any results
      // (and any in-flight run) from a previous longer query so shrinking the
      // box below the threshold never leaves stale matches on screen. We clear
      // ONLY on an actual shrink across the threshold (previousLength was at or
      // above the minimum) — never on the initial mount, so an intentionally
      // seeded results/searching state survives first render. Semantic mode is
      // submit-driven and left untouched.
      if (
        modeRef.current === 'text' &&
        previousLength !== null &&
        previousLength >= MIN_TEXT_QUERY_LENGTH
      ) {
        const store = useWorkspaceSearchStore.getState();
        if (store.results !== null || store.status === 'searching') {
          store.clearResults();
        }
      }
      return;
    }
    const timer = setTimeout(() => {
      if (modeRef.current === 'text') {
        runTextSearchRef.current();
      }
    }, TEXT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, isRegex, wholeWord, collectionId]);

  const handleRetry = useCallback(() => {
    onSubmit();
  }, [onSubmit]);

  return (
    <div className="grid h-full grid-rows-[auto_1fr_auto]">
      {/* Fixed header: search controls, query input, coverage status. */}
      <div className="flex flex-col gap-2 border-b p-2">
        <div className="flex items-center gap-2">
          <SearchModeToggle {...(semanticAvailability ? { semanticAvailability } : {})} />
          <div className="min-w-0 flex-1">
            <SearchCollectionPicker />
          </div>
        </div>

        <SearchInputBar onSubmit={onSubmit} />

        <SearchCoverageBanner collectionId={collectionId} rootIds={workspaceDbRootIds} />
      </div>

      {/* Scrollable results / status area. */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        {status === 'idle' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
            <Search className="h-8 w-8 opacity-40" />
            <p className="text-sm">Search your workspace by text or meaning.</p>
          </div>
        ) : null}
        {status === 'searching' ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-6 w-6 animate-spin opacity-60" />
            <p className="text-sm">Searching…</p>
          </div>
        ) : null}
        {status === 'error' ? (
          <div className="p-2">
            <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
              <p
                className="flex items-center gap-2 text-destructive text-sm"
                data-testid="workspace-search-results-error"
                role="alert"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error ?? 'Search failed'}
              </p>
              <Button className="self-start" onClick={handleRetry} size="sm" variant="outline">
                Retry
              </Button>
            </div>
          </div>
        ) : null}
        {status === 'results' ? (
          // Flex column so SearchResultsTree's flex-1 height chain reaches the
          // TreeTable's 100%-height viewport (a plain block breaks it, collapsing
          // the tree to content height and shoving the pinned footer off-screen).
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
            <SearchResultsTree
              onOpenFile={onOpenFile}
              {...(allowTextPaging ? { onShowMore: handleShowMore } : {})}
              resolveAdapterRootId={resolveAdapterRootId}
              workspaceRootCount={workspaceDbRootIds.length}
            />
          </div>
        ) : null}
      </div>

      {/* Fixed footer: selection summary, matching the Explorer footer tone. */}
      <footer className="flex items-center border-t bg-gradient-to-t from-muted/20 to-transparent px-3 py-2 text-muted-foreground text-xs">
        <span>~{approxTokens ?? 0} tokens in context</span>
      </footer>
    </div>
  );
}
