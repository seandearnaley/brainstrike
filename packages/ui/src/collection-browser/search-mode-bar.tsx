/**
 * SearchModeBar Component
 *
 * Mode toggle and search input container for the Collection Browser.
 * Provides explicit switching between Quick Filter and Semantic Search modes.
 */

import {
  ChevronsDownUp,
  ChevronsUpDown,
  Filter,
  Loader2,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { ExpandableTextarea } from '../expandable-textarea';
import { cn } from '../lib/utils';
import type { SearchModeBarProps } from './types';

/**
 * SearchModeBar - Mode toggle and search input container
 */
export const SearchModeBar = React.memo(function SearchModeBar({
  mode,
  semanticQuery,
  onSemanticQueryChange,
  onSemanticSearch,
  isSearching,
  isConfigExpanded,
  onConfigExpandedChange,
  isFilterVisible,
  onFilterVisibleChange,
  filters,
  onResetFilters,
  onExpandAll,
  onCollapseAll,
  resultCount,
  totalCount,
  hasSearched,
  className,
}: SearchModeBarProps) {
  // Handle semantic query change
  const handleSemanticQueryChange = React.useCallback(
    (value: string) => {
      onSemanticQueryChange(value);
    },
    [onSemanticQueryChange]
  );

  // Handle clear semantic query
  const handleClearSemanticQuery = React.useCallback(() => {
    onSemanticQueryChange('');
  }, [onSemanticQueryChange]);

  // Handle keyboard shortcuts for semantic search
  const handleSemanticKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

  // Check if any filters are active
  const hasActiveFilters = React.useMemo(() => {
    if (!filters) {
      return false;
    }
    return (
      filters.searchQuery !== '' ||
      filters.nodeTypes.size !== 4 ||
      filters.embeddingStatus !== 'all'
    );
  }, [filters]);

  const resultInfo = React.useMemo(() => {
    if (resultCount === undefined || totalCount === undefined || !hasSearched) {
      return null;
    }
    return mode === 'semantic'
      ? `${resultCount} match${resultCount !== 1 ? 'es' : ''}`
      : `${resultCount} of ${totalCount}`;
  }, [resultCount, totalCount, hasSearched, mode]);

  return (
    <div className={cn('bg-background', className)}>
      <div className="flex flex-col gap-1.5 p-1.5 px-2">
        <div className="flex items-start gap-2">
          <div className="relative flex-1">
            <ExpandableTextarea
              aria-label="Semantic search query"
              className="min-h-[36px] pr-8 text-xs"
              disabled={isSearching}
              maxRows={6}
              minRows={1}
              onChange={handleSemanticQueryChange}
              onKeyDown={handleSemanticKeyDown}
              placeholder="Ask a question... (Cmd+Enter)"
              value={semanticQuery}
            />
            {semanticQuery && !isSearching && (
              <Button
                aria-label="Clear query"
                className="absolute top-1.5 right-1 h-5 w-5 p-0"
                onClick={handleClearSemanticQuery}
                size="sm"
                variant="ghost"
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>

          <div className="flex items-center gap-1">
            <Button
              className="h-[36px] gap-1.5 px-3"
              disabled={isSearching || !semanticQuery.trim()}
              onClick={onSemanticSearch}
              size="sm"
            >
              {isSearching ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">Query</span>
            </Button>

            <div className="ml-1 flex items-center gap-1 border-l pl-1">
              {(onExpandAll || onCollapseAll) && (
                <div className="mr-0.5 flex items-center gap-0.5 border-r pr-1">
                  {onExpandAll && (
                    <Button
                      aria-label="Expand all"
                      className="h-7 w-7 p-0"
                      onClick={onExpandAll}
                      size="sm"
                      title="Expand all"
                      variant="ghost"
                    >
                      <ChevronsUpDown className="h-3.5 w-3.5" />
                    </Button>
                  )}
                  {onCollapseAll && (
                    <Button
                      aria-label="Collapse all"
                      className="h-7 w-7 p-0"
                      onClick={onCollapseAll}
                      size="sm"
                      title="Collapse all"
                      variant="ghost"
                    >
                      <ChevronsDownUp className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              )}

              <div className="relative">
                <Button
                  aria-label="Toggle filters"
                  className={cn(
                    'h-7 w-7 p-0',
                    (isFilterVisible || hasActiveFilters) && 'bg-accent text-accent-foreground'
                  )}
                  onClick={() => onFilterVisibleChange?.(!isFilterVisible)}
                  size="sm"
                  title="Filters"
                  variant="ghost"
                >
                  <Filter className="h-3.5 w-3.5" />
                </Button>
                {hasActiveFilters && (
                  <span className="absolute top-1 right-1 h-1 w-1 rounded-full bg-primary" />
                )}
              </div>

              <Button
                aria-label="Toggle search settings"
                className={cn(
                  'h-7 w-7 p-0',
                  isConfigExpanded && 'bg-accent text-accent-foreground'
                )}
                onClick={() => onConfigExpandedChange(!isConfigExpanded)}
                size="sm"
                title="Search Settings"
                variant="ghost"
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between px-0.5">
          <div className="flex items-center gap-2">
            {resultInfo && (
              <div className="font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
                {resultInfo}
              </div>
            )}

            {hasActiveFilters && (
              <div className={cn('flex items-center gap-1.5', resultInfo && 'border-l pl-2')}>
                <span className="text-[10px] text-muted-foreground/70 uppercase tracking-tighter">
                  Filtered
                </span>
                <button
                  className="rounded-sm px-1 text-[10px] text-primary transition-colors hover:bg-primary/10"
                  onClick={onResetFilters}
                  type="button"
                >
                  Reset
                </button>
              </div>
            )}
          </div>

          {!isSearching && semanticQuery.trim() && (
            <span className="text-[9px] text-muted-foreground/40 uppercase tracking-widest">
              Cmd+Enter to query
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

SearchModeBar.displayName = 'SearchModeBar';

export default SearchModeBar;
