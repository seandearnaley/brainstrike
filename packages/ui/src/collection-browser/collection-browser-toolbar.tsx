import { ChevronsDownUp, ChevronsUpDown, Filter, Group, ListChecks } from 'lucide-react';
import * as React from 'react';
import { Button } from '../button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../dropdown-menu';
import { cn } from '../lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { FilterControls } from './filter-controls';
import { type CollectionBrowserToolbarProps, DEFAULT_FILTERS, type GroupByKey } from './types';

const GROUP_BY_OPTIONS: { value: GroupByKey; label: string }[] = [
  { value: 'none', label: 'No Grouping' },
  { value: 'status', label: 'By Status' },
  { value: 'type', label: 'By Type' },
];

// Container-query breakpoints that drive collapse of the inline filter UI.
// The toolbar root is `@container/cb-toolbar`, so these refer to its inline width.
// Class strings must be written literally so the Tailwind JIT can detect them.
const INLINE_INPUT_VISIBLE = 'hidden @[360px]/cb-toolbar:flex';
const INLINE_CHIP_VISIBLE = 'hidden @[460px]/cb-toolbar:inline-flex';
const POPOVER_TRIGGER_HIDDEN_AT_WIDE = '@[360px]/cb-toolbar:hidden';

export const CollectionBrowserToolbar = React.memo(function CollectionBrowserToolbar({
  filters,
  onFiltersChange,
  onExpandAll,
  onCollapseAll,
  multiSelectEnabled,
  onMultiSelectToggle,
  groupBy,
  onGroupByChange,
  className,
}: CollectionBrowserToolbarProps) {
  const hasActiveFilters = React.useMemo(() => {
    if (!filters) {
      return false;
    }
    return (
      filters.searchQuery !== '' ||
      filters.nodeTypes.size !== DEFAULT_FILTERS.nodeTypes.size ||
      Array.from(DEFAULT_FILTERS.nodeTypes).some((nodeType) => !filters.nodeTypes.has(nodeType)) ||
      filters.embeddingStatus !== 'all'
    );
  }, [filters]);

  const showFilterUi = Boolean(filters && onFiltersChange);
  const popoverFilterLabel = hasActiveFilters ? 'Filters (active)' : 'Filters';

  return (
    <div
      className={cn(
        '@container/cb-toolbar flex items-center gap-2 border-border border-b bg-background px-2 py-1.5',
        className
      )}
    >
      {showFilterUi && filters && onFiltersChange ? (
        <FilterControls
          className="min-w-0 flex-1"
          compact
          filters={filters}
          inputContainerClassName={INLINE_INPUT_VISIBLE}
          onFiltersChange={onFiltersChange}
          toggleClassName={INLINE_CHIP_VISIBLE}
        />
      ) : (
        <div className="min-w-0 flex-1" />
      )}

      <div className="flex shrink-0 items-center gap-0.5">
        {showFilterUi && filters && onFiltersChange && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                aria-label={popoverFilterLabel}
                className={cn(
                  'relative h-8 w-8 p-0',
                  POPOVER_TRIGGER_HIDDEN_AT_WIDE,
                  hasActiveFilters && 'bg-accent text-accent-foreground'
                )}
                size="sm"
                title={popoverFilterLabel}
                variant="ghost"
              >
                <Filter className="h-4 w-4" />
                {hasActiveFilters && (
                  <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72">
              <FilterControls
                className="flex-col items-stretch gap-3"
                filters={filters}
                onFiltersChange={onFiltersChange}
              />
            </PopoverContent>
          </Popover>
        )}

        {(onExpandAll || onCollapseAll) && (
          <>
            {showFilterUi && <div className="mx-0.5 h-5 w-px bg-border" />}
            {onExpandAll && (
              <Button
                aria-label="Expand all"
                className="h-8 w-8 p-0"
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
                className="h-8 w-8 p-0"
                onClick={onCollapseAll}
                size="sm"
                title="Collapse all"
                variant="ghost"
              >
                <ChevronsDownUp className="h-4 w-4" />
              </Button>
            )}
          </>
        )}

        {onMultiSelectToggle && (
          <>
            <div className="mx-0.5 h-5 w-px bg-border" />
            <Button
              aria-label="Toggle multi-select"
              aria-pressed={multiSelectEnabled ? 'true' : 'false'}
              className={cn(
                'h-8 w-8 p-0',
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
                  'h-8 w-8 p-0',
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
  );
});

CollectionBrowserToolbar.displayName = 'CollectionBrowserToolbar';

export default CollectionBrowserToolbar;
