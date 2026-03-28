/**
 * FilterBar Component
 *
 * A streamlined filter bar for the Collection Browser that provides:
 * - Text search with clear button
 * - Embedded status toggle
 */

import { ChevronDown, ChevronUp, Filter, Search, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { Input } from '../input';
import { cn } from '../lib/utils';
import { FilterChip } from './filter-chip';
import type { FilterBarProps } from './types';

/**
 * FilterBar - Streamlined filtering controls for the Collection Browser
 *
 * Provides text search and an embedded status toggle in a single row.
 *
 * @example
 * ```tsx
 * <FilterBar
 *   filters={filters}
 *   onFiltersChange={setFilters}
 *   isExpanded={isExpanded}
 *   onExpandedChange={setIsExpanded}
 * />
 * ```
 */
export const FilterBar = React.memo(function FilterBar({
  filters,
  onFiltersChange,
  isExpanded,
  onExpandedChange,
  className,
}: FilterBarProps) {
  // Handle search input change
  const handleSearchChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onFiltersChange({
        ...filters,
        searchQuery: e.target.value,
      });
    },
    [filters, onFiltersChange]
  );

  // Handle clearing search
  const handleClearSearch = React.useCallback(() => {
    onFiltersChange({
      ...filters,
      searchQuery: '',
    });
  }, [filters, onFiltersChange]);

  // Toggle embedded filter (complete vs all)
  const handleToggleEmbedded = React.useCallback(() => {
    onFiltersChange({
      ...filters,
      embeddingStatus: filters.embeddingStatus === 'complete' ? 'all' : 'complete',
    });
  }, [filters, onFiltersChange]);

  // Toggle expanded state
  const handleToggle = React.useCallback(() => {
    onExpandedChange(!isExpanded);
  }, [isExpanded, onExpandedChange]);

  const isEmbeddedFilterActive = filters.embeddingStatus === 'complete';

  return (
    <div className={cn('border-border border-t bg-background', className)}>
      {/* Toggle button */}
      <Button
        aria-controls="filter-bar-content"
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} quick filters`}
        className="h-auto w-full justify-between px-3 py-2 hover:bg-muted/50"
        depress={false}
        onClick={handleToggle}
        size="sm"
        variant="ghost"
      >
        <span className="flex items-center gap-2 text-muted-foreground text-xs">
          <Filter className="h-3 w-3" />
          Quick Filters
        </span>
        {isExpanded ? (
          <ChevronUp className="h-3 w-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        )}
      </Button>

      {/* Collapsible content */}
      <div
        className={cn(
          'overflow-hidden transition-all duration-200 ease-out',
          isExpanded ? 'max-h-32 opacity-100' : 'max-h-0 opacity-0'
        )}
        id="filter-bar-content"
      >
        <div className="flex items-center gap-2 p-3 pt-1.5">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 bg-background pr-8 pl-9 text-sm"
              data-testid="filter-search-input"
              onChange={handleSearchChange}
              placeholder="Filter by name..."
              type="text"
              value={filters.searchQuery}
            />
            {filters.searchQuery && (
              <Button
                aria-label="Clear search"
                className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 hover:bg-transparent"
                onClick={handleClearSearch}
                size="icon"
                title="Clear search"
                variant="ghost"
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Embedded status toggle */}
          <FilterChip
            active={isEmbeddedFilterActive}
            label="Embedded"
            onClick={handleToggleEmbedded}
          />
        </div>
      </div>
    </div>
  );
});

FilterBar.displayName = 'FilterBar';

export default FilterBar;
