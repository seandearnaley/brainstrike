/**
 * SearchModeBar Component
 *
 * Unified top bar for semantic search controls.
 * Quick filtering is handled separately via the FilterBar toggle.
 *
 * When the semantic query is cleared, the component signals mode reset
 * via `onModeChange('quick')` to restore the full tree view.
 */

import {
  ChevronsDownUp,
  ChevronsUpDown,
  Filter,
  Group,
  ListChecks,
  Loader2,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { ExpandableTextarea } from '../expandable-textarea';
import { cn } from '../lib/utils';
import type { GroupByKey, SearchModeBarProps } from './types';

/**
 * SearchModeBar - Mode toggle and search input container
 */
/** Group-by option labels */
const GROUP_BY_OPTIONS: { value: GroupByKey; label: string }[] = [
  { value: 'none', label: 'No Grouping' },
  { value: 'status', label: 'By Status' },
  { value: 'type', label: 'By Type' },
];

export const SearchModeBar = React.memo(function SearchModeBar({
  mode,
  onModeChange,
  semanticQuery,
  onSemanticQueryChange,
  onSemanticSearch,
  isSearching,
  isConfigExpanded,
  onConfigExpandedChange,
  isFilterVisible,
  onFilterVisibleChange,
  filters,
  onExpandAll,
  onCollapseAll,
  hasSearched,
  multiSelectEnabled,
  onMultiSelectToggle,
  groupBy,
  onGroupByChange,
  className,
}: SearchModeBarProps) {
  // Handle semantic query change
  const handleSemanticQueryChange = React.useCallback(
    (value: string) => {
      onSemanticQueryChange(value);
      if (value.trim() === '' && mode === 'semantic' && hasSearched) {
        onModeChange('quick');
      }
    },
    [onSemanticQueryChange, mode, hasSearched, onModeChange]
  );

  // Handle clear semantic query
  const handleClearSemanticQuery = React.useCallback(() => {
    onSemanticQueryChange('');
    if (mode === 'semantic' && hasSearched) {
      onModeChange('quick');
    }
  }, [onSemanticQueryChange, mode, hasSearched, onModeChange]);

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

  return (
    <div className={cn('bg-background', className)}>
      <div className="flex flex-col p-2">
        {/* Main search row - all elements aligned to 36px height */}
        <div className="flex items-start gap-1.5">
          <div className="relative flex-1">
            <ExpandableTextarea
              aria-label="Semantic search query"
              className="py-[7px] pr-8 text-xs leading-5"
              disabled={isSearching}
              maxLength={10_000}
              maxRows={6}
              minHeight={36}
              minRows={1}
              onChange={handleSemanticQueryChange}
              onKeyDown={handleSemanticKeyDown}
              placeholder="Ask a question... (Cmd+Enter)"
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

          {/* All buttons use h-9 (36px) for consistent height */}
          <Button
            className="h-9 gap-1.5 px-3"
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

          <div className="flex items-center gap-0.5 border-l pl-1.5">
            {(onExpandAll || onCollapseAll) && (
              <>
                {onExpandAll && (
                  <Button
                    aria-label="Expand all"
                    className="h-9 w-9 p-0"
                    onClick={onExpandAll}
                    size="sm"
                    title="Expand all"
                    variant="ghost"
                  >
                    <ChevronsUpDown className="h-4 w-4" />
                  </Button>
                )}
                {onCollapseAll && (
                  <Button
                    aria-label="Collapse all"
                    className="h-9 w-9 p-0"
                    onClick={onCollapseAll}
                    size="sm"
                    title="Collapse all"
                    variant="ghost"
                  >
                    <ChevronsDownUp className="h-4 w-4" />
                  </Button>
                )}
                <div className="mx-0.5 h-5 w-px bg-border" />
              </>
            )}

            <div className="relative">
              <Button
                aria-expanded={isFilterVisible}
                aria-label="Toggle filters"
                className={cn(
                  'h-9 w-9 p-0',
                  (isFilterVisible || hasActiveFilters) && 'bg-accent text-accent-foreground'
                )}
                onClick={() => onFilterVisibleChange?.(!isFilterVisible)}
                size="sm"
                title="Filters"
                variant="ghost"
              >
                <Filter className="h-4 w-4" />
              </Button>
              {hasActiveFilters && (
                <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </div>

            <Button
              aria-expanded={isConfigExpanded}
              aria-label="Toggle search settings"
              className={cn('h-9 w-9 p-0', isConfigExpanded && 'bg-accent text-accent-foreground')}
              onClick={() => onConfigExpandedChange(!isConfigExpanded)}
              size="sm"
              title="Search Settings"
              variant="ghost"
            >
              <Settings className="h-4 w-4" />
            </Button>

            {onMultiSelectToggle && (
              <>
                <div className="mx-0.5 h-5 w-px bg-border" />
                <Button
                  aria-label="Toggle multi-select"
                  aria-pressed={multiSelectEnabled}
                  className={cn(
                    'h-9 w-9 p-0',
                    multiSelectEnabled && 'bg-accent text-accent-foreground'
                  )}
                  onClick={() => onMultiSelectToggle(!multiSelectEnabled)}
                  size="sm"
                  title="Multi-select"
                  variant="ghost"
                >
                  <ListChecks className="h-4 w-4" />
                </Button>
              </>
            )}

            {onGroupByChange && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    aria-label="Group by"
                    className={cn(
                      'h-9 w-9 p-0',
                      groupBy && groupBy !== 'none' && 'bg-accent text-accent-foreground'
                    )}
                    size="sm"
                    title="Group by"
                    variant="ghost"
                  >
                    <Group className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuRadioGroup
                    onValueChange={(value) => onGroupByChange(value as GroupByKey)}
                    value={groupBy ?? 'none'}
                  >
                    {GROUP_BY_OPTIONS.map((option) => (
                      <DropdownMenuRadioItem key={option.value} value={option.value}>
                        {option.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

SearchModeBar.displayName = 'SearchModeBar';

export default SearchModeBar;
