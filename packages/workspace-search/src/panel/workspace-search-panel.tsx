import { Button } from '@brainstrike/ui';
import { AlertCircle, Loader2, Search } from 'lucide-react';
import type * as React from 'react';
import { useEffect, useRef } from 'react';
import { useWorkspaceSearchStore } from '../core/workspace-search-store';
import { SearchInputBar } from './search-input-bar';
import {
  type SearchOpenTarget,
  SearchResultsTree,
  type SearchSelectionBridge,
} from './search-results-tree';

/**
 * Search-as-you-type debounce. Short: each search is a live ripgrep run the
 * next keystroke cancels, so waiting longer only delays the first result.
 */
const SEARCH_DEBOUNCE_MS = 100;
/** Minimum query length before an automatic search fires. */
const MIN_QUERY_LENGTH = 2;

export interface WorkspaceSearchPanelProps {
  /** Attach a result file to the active thread; absent where nothing reads mentions (web). */
  onAttachFile?: ((compositeKey: string) => void) | undefined;
  onOpenFile: (compositeKey: string, target?: SearchOpenTarget) => void;
  /** The name the Explorer shows for an open folder. */
  rootName: (rootId: string) => string;
  /** Starts a search of the store's query, cancelling the one running. */
  runSearch: () => void;
  /** The explorer selection that result checkboxes drive. */
  selection: SearchSelectionBridge;
  /** How many folders are open. */
  workspaceRootCount: number;
}

/**
 * The workspace-search tab content: the query input and the status-driven
 * results area. Results show as they stream in. Presentation + store only:
 * the search itself lives at the composition layer and arrives as `runSearch`.
 */
export function WorkspaceSearchPanel({
  onAttachFile,
  onOpenFile,
  rootName,
  runSearch,
  selection,
  workspaceRootCount,
}: WorkspaceSearchPanelProps): React.ReactNode {
  const status = useWorkspaceSearchStore((state) => state.status);
  const error = useWorkspaceSearchStore((state) => state.error);
  const query = useWorkspaceSearchStore((state) => state.query);
  const caseSensitive = useWorkspaceSearchStore((state) => state.caseSensitive);
  const isRegex = useWorkspaceSearchStore((state) => state.isRegex);
  const wholeWord = useWorkspaceSearchStore((state) => state.wholeWord);
  const hasMatches = useWorkspaceSearchStore((state) => state.files.length > 0);

  // A latest-value ref keeps the debounce effect's dependency list scoped to the
  // query controls (not the run-callback identity) while still calling the
  // current callback at fire time. Assigned in an
  // effect (never during render) so the React Compiler can optimize the
  // component; the effect has no dep array so the refs track every render, and
  // it is declared BEFORE the debounce effect so it settles first each pass.
  const runSearchRef = useRef(runSearch);
  useEffect(() => {
    runSearchRef.current = runSearch;
  });
  // Trimmed length of the query the previous effect run observed. `null` on the
  // initial mount so a seeded results/searching state is not wiped on first
  // render — only an actual shrink across the threshold clears results.
  const prevQueryLengthRef = useRef<number | null>(null);

  // caseSensitive/isRegex/wholeWord are load-bearing deps even though the body
  // reads them via the run callback, not directly: changing any search
  // parameter must restart the debounce so a fresh search fires.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional restart triggers, not effect-body reads.
  useEffect(() => {
    const trimmedLength = query.trim().length;
    const previousLength = prevQueryLengthRef.current;
    prevQueryLengthRef.current = trimmedLength;
    if (trimmedLength < MIN_QUERY_LENGTH) {
      // Too short to auto-search. Drop any results (and any running search)
      // from a previous longer query so shrinking the box below the threshold
      // never leaves stale matches on screen. Only on an actual shrink across
      // the threshold, never on the initial mount, so a seeded state survives
      // the first render.
      if (previousLength !== null && previousLength >= MIN_QUERY_LENGTH) {
        const store = useWorkspaceSearchStore.getState();
        if (store.status !== 'idle') {
          store.clearResults();
        }
      }
      return;
    }
    const timer = setTimeout(() => runSearchRef.current(), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, isRegex, wholeWord]);

  const showResults = status === 'results' || (status === 'searching' && hasMatches);

  return (
    // One column the panel's width: an `auto` track grew to its widest row's
    // unbreakable content (311px in a 180px panel, BST-1981), pushing controls
    // and results past the panel's clipped edge.
    <div className="grid h-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr]">
      {/* Fixed header: the query input and its toggles. */}
      <div className="flex flex-col gap-2 border-b p-2">
        <SearchInputBar onSubmit={runSearch} />
      </div>

      {/* Scrollable results / status area. */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        {status === 'idle' ? (
          <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <Search className="h-8 w-8 opacity-40" />
            <p className="text-sm">Search the text of your workspace's files.</p>
          </div>
        ) : null}
        {status === 'searching' && !hasMatches ? (
          <div
            className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
            role="status"
          >
            <Loader2 className="h-6 w-6 animate-spin opacity-60" />
            <p className="text-sm">Searching…</p>
          </div>
        ) : null}
        {status === 'error' ? (
          <div className="p-2">
            <div className="border-destructive/40 bg-destructive/10 flex flex-col gap-2 rounded-md border p-3">
              <p
                className="text-destructive flex items-center gap-2 text-sm"
                data-testid="workspace-search-results-error"
                role="alert"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error ?? 'Search failed'}
              </p>
              <Button className="self-start" onClick={runSearch} size="sm" variant="outline">
                Retry
              </Button>
            </div>
          </div>
        ) : null}
        {showResults ? (
          // Flex column so SearchResultsTree's flex-1 height chain reaches the
          // TreeTable's 100%-height viewport (a plain block breaks it, collapsing
          // the tree to content height).
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
            {status === 'searching' ? (
              <p
                className="text-muted-foreground flex items-center gap-1.5 pb-1 text-xs"
                data-testid="workspace-search-streaming"
                role="status"
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching…
              </p>
            ) : null}
            <SearchResultsTree
              onAttachFile={onAttachFile}
              onOpenFile={onOpenFile}
              rootName={rootName}
              selection={selection}
              workspaceRootCount={workspaceRootCount}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
