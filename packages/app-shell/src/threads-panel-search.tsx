import type { ThreadSearchResultItem } from '@brainstrike/db';
import { Button } from '@brainstrike/ui';
import { Loader2, Search, TriangleAlert, X } from 'lucide-react';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import type { AssistantMemoryThread } from './assistant-memory-repository';
import { renderMarkedText } from './thread-search-headline';
import { useThreadSearchStore } from './thread-search-store';

function formatMatchDate(date: Date): string {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function roleLabel(role: string): string {
  if (role === 'user') {
    return 'You';
  }
  if (role === 'assistant') {
    return 'Assistant';
  }
  return role;
}

export interface ThreadsPanelSearchProps {
  readonly groupNameByThreadId: ReadonlyMap<string, string>;
  readonly onRetry: () => void;
  readonly onSelectThread: (threadId: string) => void;
  readonly threadsById: ReadonlyMap<string, AssistantMemoryThread>;
}

interface SearchResultRowProps {
  readonly active: boolean;
  readonly groupName: string | null;
  readonly onSelect: () => void;
  readonly optionId: string;
  readonly result: ThreadSearchResultItem;
  readonly title: string;
}

function SearchResultRow({
  active,
  groupName,
  onSelect,
  optionId,
  result,
  title,
}: SearchResultRowProps) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard interaction is owned by the searchbox (aria-activedescendant pattern).
    <div
      aria-selected={active}
      className={`cursor-pointer rounded-md px-2 py-1.5 ${
        active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
      }`}
      data-testid="thread-search-result"
      id={optionId}
      onClick={onSelect}
      role="option"
      tabIndex={-1}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-medium text-[13px] leading-5">{title}</span>
        {groupName ? (
          <span className="shrink-0 rounded-full border border-border bg-background px-1.5 py-px text-[10px] text-muted-foreground">
            {groupName}
          </span>
        ) : null}
      </div>
      {result.matches.length > 0 ? (
        <ul className="mt-0.5 space-y-0.5">
          {result.matches.map((match) => (
            <li
              className="flex min-w-0 items-baseline gap-1.5 text-[12px] text-muted-foreground leading-4"
              data-testid="thread-search-match"
              key={match.messageId}
            >
              <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-70">
                {roleLabel(match.role)}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {match.headline ? renderMarkedText(match.headline) : null}
              </span>
              <span className="shrink-0 text-[10px] opacity-70">
                {formatMatchDate(match.messageCreatedAt)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

interface SearchStatusNoticesProps {
  readonly coverage: ReturnType<typeof useThreadSearchStore.getState>['coverage'];
  readonly error: string | null;
  readonly onRetry: () => void;
  readonly pendingEmbeddings: number;
  readonly semantic: ReturnType<typeof useThreadSearchStore.getState>['semantic'];
  readonly status: ReturnType<typeof useThreadSearchStore.getState>['status'];
}

/** Honesty banners: semantic availability, indexing progress, failures. */
function SearchStatusNotices({
  coverage,
  error,
  onRetry,
  pendingEmbeddings,
  semantic,
  status,
}: SearchStatusNoticesProps) {
  return (
    <>
      {semantic.kind === 'unavailable' ? (
        <p
          className="flex items-center gap-1.5 px-2 pb-1 text-[11px] text-muted-foreground"
          data-testid="thread-search-semantic-unavailable"
          title={semantic.reason}
        >
          <TriangleAlert className="h-3 w-3 shrink-0" />
          Semantic search unavailable — showing keyword matches only.
        </p>
      ) : null}
      {pendingEmbeddings > 0 && coverage ? (
        <p
          className="px-2 pb-1 text-[11px] text-muted-foreground"
          data-testid="thread-search-indexing-progress"
        >
          Indexing message embeddings… {coverage.embeddedMessages} of {coverage.embeddableMessages}
        </p>
      ) : null}
      {coverage && coverage.erroredMessages > 0 ? (
        <p
          className="px-2 pb-1 text-[11px] text-muted-foreground"
          data-testid="thread-search-embedding-errors"
        >
          {coverage.erroredMessages} {coverage.erroredMessages === 1 ? 'message' : 'messages'} could
          not be embedded — keyword search still covers{' '}
          {coverage.erroredMessages === 1 ? 'it' : 'them'}.
        </p>
      ) : null}
      {status === 'error' ? (
        <div className="px-2 py-2" data-testid="thread-search-error">
          <p className="text-[12px] text-destructive">{error}</p>
          <Button
            className="mt-1.5 h-7 px-2 text-xs"
            onClick={onRetry}
            size="sm"
            type="button"
            variant="secondary"
          >
            Retry
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * Search box + results for the Threads panel. Debounce, generation guarding,
 * and the hybrid query live in `useThreadSearchController`; this component
 * only reads the session store and renders honestly: semantic-arm
 * unavailability and embedding-index progress are always visible, never a
 * silent lexical-only downgrade.
 */
export function ThreadsPanelSearch({
  groupNameByThreadId,
  onRetry,
  onSelectThread,
  threadsById,
}: ThreadsPanelSearchProps) {
  const query = useThreadSearchStore((state) => state.query);
  const status = useThreadSearchStore((state) => state.status);
  const results = useThreadSearchStore((state) => state.results);
  const error = useThreadSearchStore((state) => state.error);
  const semantic = useThreadSearchStore((state) => state.semantic);
  const coverage = useThreadSearchStore((state) => state.coverage);
  const setQuery = useThreadSearchStore((state) => state.setQuery);
  const clearSearch = useThreadSearchStore((state) => state.clearSearch);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // A new result set restarts keyboard navigation at the top. Adjusting the
  // state during render (React's "storing information from previous renders"
  // pattern) instead of in an effect keeps it compiler-optimizable and avoids
  // the extra commit an effect would cost.
  const [prevResults, setPrevResults] = useState(results);
  if (results !== prevResults) {
    setPrevResults(results);
    setActiveIndex(0);
  }

  const visibleResults = results ?? [];
  const resultCount = visibleResults.length;

  const pendingEmbeddings = useMemo(() => {
    if (!coverage) {
      return 0;
    }
    return Math.max(
      0,
      coverage.embeddableMessages - coverage.embeddedMessages - coverage.erroredMessages
    );
  }, [coverage]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      if (query) {
        event.preventDefault();
        clearSearch();
      }
      return;
    }
    if (resultCount === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % resultCount);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + resultCount) % resultCount);
    } else if (event.key === 'Enter') {
      const active = visibleResults[activeIndex];
      if (active) {
        event.preventDefault();
        onSelectThread(active.threadId);
      }
    }
  };

  const searchActive = status !== 'idle';
  const activeOptionId =
    searchActive && resultCount > 0 ? `thread-search-option-${activeIndex}` : undefined;

  return (
    <div
      className={searchActive ? 'flex min-h-0 flex-1 flex-col' : 'flex min-h-0 shrink-0 flex-col'}
      data-testid="threads-panel-search"
    >
      <div className="px-3 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          {status === 'searching' ? (
            <Loader2
              className="absolute top-1/2 right-2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
              data-testid="thread-search-spinner"
            />
          ) : null}
          {query && status !== 'searching' ? (
            <button
              aria-label="Clear search"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => {
                clearSearch();
                inputRef.current?.focus();
              }}
              type="button"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <input
            aria-activedescendant={activeOptionId}
            aria-controls="thread-search-results"
            aria-expanded={searchActive}
            aria-label="Search threads"
            className="w-full rounded-md border border-border bg-background py-1.5 pr-7 pl-7 text-[13px] leading-4 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="thread-search-input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search titles, messages, folders…"
            ref={inputRef}
            role="combobox"
            type="text"
            value={query}
          />
        </div>
      </div>

      {searchActive ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <SearchStatusNotices
            coverage={coverage}
            error={error}
            onRetry={onRetry}
            pendingEmbeddings={pendingEmbeddings}
            semantic={semantic}
            status={status}
          />

          {status === 'results' && resultCount === 0 ? (
            <p
              className="px-2 py-3 text-[12px] text-muted-foreground"
              data-testid="thread-search-empty"
            >
              No matching threads.
            </p>
          ) : null}

          <div
            aria-label="Thread search results"
            className="space-y-0.5"
            id="thread-search-results"
            role="listbox"
          >
            {visibleResults.map((result, index) => {
              const thread = threadsById.get(result.threadId);
              const title = result.title ?? thread?.title ?? 'Untitled thread';
              return (
                <SearchResultRow
                  active={index === activeIndex}
                  groupName={groupNameByThreadId.get(result.threadId) ?? null}
                  key={result.threadId}
                  onSelect={() => onSelectThread(result.threadId)}
                  optionId={`thread-search-option-${index}`}
                  result={result}
                  title={title}
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
