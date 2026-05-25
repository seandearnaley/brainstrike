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

  return (
    <div className={cn('bg-background', className)}>
      <Button
        aria-controls="hybrid-search-panel"
        aria-expanded={isSearchExpanded}
        aria-label={`${isSearchExpanded ? 'Collapse' : 'Expand'} hybrid search`}
        className="h-auto w-full justify-between rounded-none px-3 py-2 text-left hover:bg-muted/50"
        depress={false}
        onClick={handleToggleExpanded}
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
          {hasSearched && resultCount !== undefined
            ? `${resultCount} result${resultCount === 1 ? '' : 's'}`
            : null}
          {isSearchExpanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </span>
      </Button>
      <div
        className="overflow-hidden"
        data-testid="hybrid-search-panel"
        hidden={!isSearchExpanded}
        id="hybrid-search-panel"
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
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Sparkles className="h-4 w-4" />
                )}
                <span>Query</span>
              </Button>
            </div>
          </div>

          {advancedOptions}
        </div>
      </div>
    </div>
  );
});

SearchModeBar.displayName = 'SearchModeBar';

export default SearchModeBar;
