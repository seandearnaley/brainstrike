/**
 * FilterControls Component
 *
 * Shared filter row used both inline in the CollectionBrowserToolbar and inside
 * the narrow-width filter popover. Renders the "Filter by name" input and the
 * Embedded status toggle, plus a clear button when the search query is non-empty.
 */

import { Search, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import { Input } from '../input';
import { cn } from '../lib/utils';
import { FilterChip } from './filter-chip';
import type { CollectionBrowserFilters } from './types';

export interface FilterControlsProps {
  className?: string;
  /** Compact mode reduces internal spacing — used inside the toolbar row */
  compact?: boolean;
  filters: CollectionBrowserFilters;
  /** className applied directly to the input wrapper for container-query control */
  inputContainerClassName?: string;
  onFiltersChange: (filters: CollectionBrowserFilters) => void;
  /** className applied directly to the Embedded chip for container-query control */
  toggleClassName?: string;
}

export const FilterControls = React.memo(function FilterControls({
  filters,
  onFiltersChange,
  className,
  inputContainerClassName,
  toggleClassName,
  compact = false,
}: FilterControlsProps) {
  const handleSearchChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onFiltersChange({ ...filters, searchQuery: e.target.value });
    },
    [filters, onFiltersChange]
  );

  const handleClearSearch = React.useCallback(() => {
    onFiltersChange({ ...filters, searchQuery: '' });
  }, [filters, onFiltersChange]);

  const handleToggleEmbedded = React.useCallback(() => {
    onFiltersChange({
      ...filters,
      embeddingStatus: filters.embeddingStatus === 'complete' ? 'all' : 'complete',
    });
  }, [filters, onFiltersChange]);

  const isEmbeddedActive = filters.embeddingStatus === 'complete';
  const inputHeight = compact ? 'h-8' : 'h-9';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className={cn('relative min-w-0 flex-1', inputContainerClassName)}
        data-testid="filter-search-input-container"
      >
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Filter by name"
          className={cn(inputHeight, 'bg-background pr-8 pl-9 text-sm')}
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
      <FilterChip
        active={isEmbeddedActive}
        label="Embedded"
        onClick={handleToggleEmbedded}
        {...(toggleClassName ? { className: toggleClassName } : {})}
      />
    </div>
  );
});

FilterControls.displayName = 'FilterControls';

export default FilterControls;
