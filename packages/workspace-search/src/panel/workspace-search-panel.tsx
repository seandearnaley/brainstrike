import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import { Button } from '@brainstrike/ui';
import { encodeFileSelection } from '@brainstrike/utils/selection-utils';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';
import { SearchCollectionPicker } from './search-collection-picker';
import { SearchCoverageBanner } from './search-coverage-banner';
import { SearchInputBar } from './search-input-bar';
import { SearchModeToggle } from './search-mode-toggle';
import { SearchResultsTree } from './search-results-tree';

/** Text-mode live-search debounce window. */
const TEXT_DEBOUNCE_MS = 250;
/** Minimum text-query length before an automatic search fires. */
const MIN_TEXT_QUERY_LENGTH = 3;

export interface WorkspaceSearchPanelProps {
  onOpenFile: (compositeKey: string, line?: number) => void;
  resolveAdapterRootId: (dbRootId: string) => string | null;
  runSemanticSearch: () => void;
  runTextSearch: () => void;
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
  const results = useWorkspaceSearchStore((state) => state.results);

  const approxTokens = useWorkspaceContextCurationStore(
    (state) => state.contextSnapshot?.selectedSourceApproxTokens
  );
  const tapestryRangesByKey = useWorkspaceContextCurationStore(
    (state) => state.tapestryRangesByKey
  );

  const onSubmit = mode === 'semantic' ? runSemanticSearch : runTextSearch;

  // Latest-value refs keep the debounce effect's dependency list scoped to the
  // query controls (not the run-callback/mode identity) while still calling the
  // current callback and checking the live mode at fire time.
  const runTextSearchRef = useRef(runTextSearch);
  runTextSearchRef.current = runTextSearch;
  const modeRef = useRef(mode);
  modeRef.current = mode;
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

  const hasChunkRanges = useMemo(() => {
    if (!results) {
      return false;
    }
    for (const file of results.files) {
      const adapterRootId = resolveAdapterRootId(file.dbRootId);
      if (adapterRootId === null) {
        continue;
      }
      const ranges = tapestryRangesByKey[encodeFileSelection(adapterRootId, file.path)];
      if (ranges && ranges.length > 0) {
        return true;
      }
    }
    return false;
  }, [results, tapestryRangesByKey, resolveAdapterRootId]);

  const handleRetry = useCallback(() => {
    onSubmit();
  }, [onSubmit]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <SearchModeToggle />
        <div className="min-w-0 flex-1">
          <SearchCollectionPicker />
        </div>
      </div>

      <SearchInputBar onSubmit={onSubmit} />

      <SearchCoverageBanner collectionId={collectionId} rootIds={workspaceDbRootIds} />

      <div className="flex min-h-0 flex-1 flex-col">
        {status === 'idle' ? (
          <p className="p-3 text-muted-foreground text-sm">
            Search your workspace by text or meaning.
          </p>
        ) : null}
        {status === 'searching' ? (
          <p className="p-3 text-muted-foreground text-sm" role="status">
            Searching…
          </p>
        ) : null}
        {status === 'error' ? (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <p className="text-destructive text-sm" role="alert">
              {error ?? 'Search failed'}
            </p>
            <Button className="self-start" onClick={handleRetry} size="sm" variant="outline">
              Retry
            </Button>
          </div>
        ) : null}
        {status === 'results' ? (
          <SearchResultsTree onOpenFile={onOpenFile} resolveAdapterRootId={resolveAdapterRootId} />
        ) : null}
      </div>

      <footer className="flex items-center justify-between border-border border-t pt-1 text-muted-foreground text-xs">
        <span>~{approxTokens ?? 0} tokens selected</span>
        {hasChunkRanges ? <span>Ranges apply in Tapestry ranges mode</span> : null}
      </footer>
    </div>
  );
}
