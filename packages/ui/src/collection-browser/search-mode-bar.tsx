/**
 * SearchModeBar Component
 *
 * Collapsible hybrid search panel for collection semantic search.
 * Quick filtering and grid controls are handled by sibling toolbar/filter components.
 */

import { ChevronDown, ChevronUp, Loader2, Sparkles, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { Input } from '../input';
import { cn } from '../lib/utils';
import type { SearchModeBarProps } from './types';

export const SearchModeBar = React.memo(function SearchModeBar({
  mode,
  onModeChange,
  semanticQuery,
  onSemanticQueryChange,
  onSemanticSearch,
  isSearching,
  isSearchExpanded,
  onSearchExpandedChange,
  hasSearched,
  resultCount,
  advancedOptions,
  className,
}: SearchModeBarProps) {
  const handleSemanticQueryChange = React.useCallback(
    (value: string) => {
      onSemanticQueryChange(value);
      if (value.trim() === '' && mode === 'semantic' && hasSearched) {
        onModeChange('quick');
      }
    },
    [onSemanticQueryChange, mode, hasSearched, onModeChange]
  );

  const handleClearSemanticQuery = React.useCallback(() => {
    onSemanticQueryChange('');
    if (mode === 'semantic' && hasSearched) {
      onModeChange('quick');
    }
  }, [onSemanticQueryChange, mode, hasSearched, onModeChange]);

  const handleSemanticInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      handleSemanticQueryChange(event.currentTarget.value);
    },
    [handleSemanticQueryChange]
  );

  const handleSemanticKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!isSearching && semanticQuery.trim()) {
          onSemanticSearch();
        }
      }
      if (e.key === 'Escape') {
        e.currentTarget.blur();
      }
    },
    [isSearching, semanticQuery, onSemanticSearch]
  );

  const handleToggleExpanded = React.useCallback(() => {
    onSearchExpandedChange(!isSearchExpanded);
  }, [isSearchExpanded, onSearchExpandedChange]);

  const panelRef = React.useRef<HTMLElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  // useId() produces stable, collision-free ids so multiple SearchModeBar
  // instances on the same page don't clash on aria-controls/aria-labelledby.
  const reactId = React.useId();
  const triggerId = `hybrid-search-trigger-${reactId}`;
  const panelId = `hybrid-search-panel-${reactId}`;

  // Escape inside the expanded panel collapses it. If focus is in the query
  // input, the input's own Escape handler (blur) runs first and we leave the
  // panel alone so the user doesn't lose their typed query with their focus.
  // Using a document-level listener keeps the panel element itself free of
  // event handlers, satisfying a11y lint rules around non-interactive nodes.
  // After collapse, focus returns to the trigger button so keyboard users
  // aren't dropped onto <body> when their focused control disappears.
  React.useEffect(() => {
    if (!isSearchExpanded) {
      return;
    }
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const panel = panelRef.current;
      if (!(panel && target && panel.contains(target))) {
        return;
      }
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }
      event.preventDefault();
      onSearchExpandedChange(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [isSearchExpanded, onSearchExpandedChange]);

  const resultLabel =
    hasSearched && resultCount !== undefined
      ? `${resultCount} result${resultCount === 1 ? '' : 's'}`
      : null;

  return (
    <div className={cn('bg-background', className)}>
      {/* Live region lives OUTSIDE the trigger button. Live-region semantics
          on descendants of an interactive control are unreliable across
          screen readers (button descendants are exposed as presentational),
          so we keep this as a visually-hidden sibling that announces
          independently. */}
      {resultLabel ? (
        <span aria-live="polite" className="sr-only" role="status">
          {resultLabel}
        </span>
      ) : null}
      <Button
        aria-controls={panelId}
        aria-expanded={isSearchExpanded}
        aria-label="Hybrid search"
        className="h-auto w-full justify-between rounded-none px-3 py-2 text-left hover:bg-muted/50"
        depress={false}
        id={triggerId}
        onClick={handleToggleExpanded}
        ref={triggerRef}
        size="sm"
        variant="ghost"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="min-w-0">
            <span className="block font-medium text-sm">Hybrid search</span>
            <span className="block truncate text-muted-foreground text-xs">
              Semantic similarity with keyword matches across embedded chunks
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs">
          {resultLabel}
          {isSearchExpanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </span>
      </Button>

      {isSearchExpanded && (
        // <section> + aria-labelledby promotes the panel to a landmark named
        // by its trigger, giving screen reader users a navigable region.
        // Escape-to-collapse is wired up via a document-level keydown listener
        // (see effect above) so the panel itself stays free of event handlers.
        <section
          aria-labelledby={triggerId}
          className="overflow-hidden"
          data-testid="hybrid-search-panel"
          id={panelId}
          ref={panelRef}
        >
          <div className="space-y-2 px-3 pb-3">
            <p className="text-muted-foreground text-xs">
              Ask in natural language, then tune hybrid search when exact terms should carry more or
              less weight.
            </p>

            <div data-testid="hybrid-search-controls">
              <div className="flex min-w-0 items-stretch" data-testid="hybrid-search-input-group">
                <div className="relative min-w-0 flex-1">
                  <Input
                    aria-label="Hybrid search query"
                    className="h-9 rounded-r-none border-r-0 pr-8 text-xs"
                    disabled={isSearching}
                    maxLength={10_000}
                    onChange={handleSemanticInputChange}
                    onKeyDown={handleSemanticKeyDown}
                    placeholder="Describe what you want to find... (Cmd+Enter)"
                    value={semanticQuery}
                  />
                  {semanticQuery && !isSearching && (
                    <Button
                      aria-label="Clear query"
                      className="absolute top-1.5 right-1.5 h-6 w-6 p-0"
                      onClick={handleClearSemanticQuery}
                      size="sm"
                      variant="ghost"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                <Button
                  className="h-9 shrink-0 rounded-l-none px-2.5"
                  disabled={isSearching || !semanticQuery.trim()}
                  onClick={onSemanticSearch}
                  size="sm"
                >
                  {isSearching ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Sparkles className="h-4 w-4" />
                  )}
                  <span>Query</span>
                </Button>
              </div>
            </div>

            {advancedOptions}
          </div>
        </section>
      )}
    </div>
  );
});

SearchModeBar.displayName = 'SearchModeBar';

export default SearchModeBar;
