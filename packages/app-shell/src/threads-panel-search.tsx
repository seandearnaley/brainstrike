import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import { Button } from '@brainstrike/ui';
import { Loader2, Search, X } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { renderMarkedText } from './thread-search-headline';
import type { ThreadSearchResultItem } from './thread-search-service';
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
  readonly onSelectThread: (threadId: string, messageId?: string) => void;
  readonly threadsById: ReadonlyMap<string, AssistantMemoryThread>;
  readonly titlesByThreadId?: ReadonlyMap<string, string>;
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
        <span className="truncate text-[13px] leading-5 font-medium">{title}</span>
        {groupName ? (
          <span className="border-border bg-background text-muted-foreground shrink-0 rounded-full border px-1.5 py-px text-[10px]">
            {groupName}
          </span>
        ) : null}
      </div>
      {result.matches.length > 0 ? (
        <ul className="mt-0.5 space-y-0.5">
          {result.matches.map((match) => (
            <li
              className="text-muted-foreground flex min-w-0 items-baseline gap-1.5 text-[12px] leading-4"
              data-testid="thread-search-match"
              key={match.messageId}
            >
              <span className="shrink-0 text-[10px] tracking-wide uppercase opacity-70">
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

interface SearchErrorNoticeProps {
  readonly error: string | null;
  readonly onRetry: () => void;
}

function SearchErrorNotice({ error, onRetry }: SearchErrorNoticeProps) {
  return (
    <div className="px-2 py-2" data-testid="thread-search-error">
      <p className="text-destructive text-[12px]">{error}</p>
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
  );
}

/**
 * Search box + results for the Threads panel. Debounce, generation guarding,
 * and the query live in `useThreadSearchController`; this component only
 * reads the session store.
 */
export function ThreadsPanelSearch({
  titlesByThreadId,
  groupNameByThreadId,
  onRetry,
  onSelectThread,
  threadsById,
}: ThreadsPanelSearchProps) {
  const navigationError = useThreadSearchStore((state) => state.navigationError);
  const query = useThreadSearchStore((state) => state.query);
  const status = useThreadSearchStore((state) => state.status);
  const results = useThreadSearchStore((state) => state.results);
  const error = useThreadSearchStore((state) => state.error);
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

  const visibleResults = (results ?? []).flatMap((result) =>
    result.matches.length
      ? result.matches.map((match) => ({ ...result, matches: [match] }))
      : [result]
  );
  const resultCount = visibleResults.length;

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
        onSelectThread(active.threadId, active.matches[0]?.messageId);
      }
    }
  };

  const clearAndRefocus = (): void => {
    clearSearch();
    inputRef.current?.focus();
  };

  const searchActive = status !== 'idle';
  const activeOptionId =
    searchActive && resultCount > 0 ? `thread-search-option-${activeIndex}` : undefined;

  return (
    <div
      className={searchActive ? 'flex min-h-0 flex-1 flex-col' : 'flex min-h-0 shrink-0 flex-col'}
      data-testid="threads-panel-search"
    >
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2" />
          {/* The spinner sits left of the clear button, so clearing stays
              reachable while a search runs. */}
          {status === 'searching' ? (
            <Loader2
              className={`text-muted-foreground absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin ${
                query ? 'right-7' : 'right-2'
              }`}
              data-testid="thread-search-spinner"
            />
          ) : null}
          {query ? (
            <button
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-1/2 right-0.5 flex size-6 -translate-y-1/2 items-center justify-center rounded outline-hidden focus-visible:ring-2"
              onClick={clearAndRefocus}
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
            className={`border-border bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border py-1.5 pl-7 text-[13px] leading-4 outline-hidden focus-visible:ring-2 ${
              query && status === 'searching' ? 'pr-12' : 'pr-7'
            }`}
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
          {navigationError ? (
            <p className="text-destructive px-3 py-2 text-xs" role="alert">
              {navigationError}
            </p>
          ) : null}
          {status === 'error' ? <SearchErrorNotice error={error} onRetry={onRetry} /> : null}

          {status === 'results' && resultCount === 0 ? (
            <div className="px-2 py-3" data-testid="thread-search-empty">
              <p className="text-muted-foreground text-[12px]">No matching threads.</p>
              <Button
                className="mt-1.5 h-7 px-2 text-xs"
                onClick={clearAndRefocus}
                size="sm"
                type="button"
                variant="secondary"
              >
                Clear search
              </Button>
            </div>
          ) : null}

          <div
            aria-label="Thread search results"
            className="space-y-0.5"
            id="thread-search-results"
            role="listbox"
          >
            {visibleResults.map((result, index) => {
              const thread = threadsById.get(result.threadId);
              const title =
                titlesByThreadId?.get(result.threadId) ??
                result.title ??
                thread?.title ??
                'Untitled thread';
              return (
                <SearchResultRow
                  active={index === activeIndex}
                  groupName={groupNameByThreadId.get(result.threadId) ?? null}
                  key={`${result.threadId}:${result.matches[0]?.messageId ?? 'title'}`}
                  onSelect={() => onSelectThread(result.threadId, result.matches[0]?.messageId)}
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
