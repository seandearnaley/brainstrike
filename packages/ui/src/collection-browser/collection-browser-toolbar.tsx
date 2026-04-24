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
import { type CollectionBrowserToolbarProps, DEFAULT_FILTERS, type GroupByKey } from './types';

const GROUP_BY_OPTIONS: { value: GroupByKey; label: string }[] = [
  { value: 'none', label: 'No Grouping' },
  { value: 'status', label: 'By Status' },
  { value: 'type', label: 'By Type' },
];

export const CollectionBrowserToolbar = React.memo(function CollectionBrowserToolbar({
  filters,
  isFilterVisible,
  onFilterVisibleChange,
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
      filters.embeddingStatus !== 'all'
    );
  }, [filters]);
  const filterToggleLabel = hasActiveFilters ? 'Toggle filters (active)' : 'Toggle filters';

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 border-border border-b bg-background px-2 py-1.5',
        className
      )}
    >
      <span className="min-w-0 truncate text-muted-foreground text-xs">Collection</span>
      <div className="flex shrink-0 items-center gap-0.5">
        {(onExpandAll || onCollapseAll) && (
          <>
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
            <div className="mx-0.5 h-5 w-px bg-border" />
          </>
        )}

        {onFilterVisibleChange && (
          <div className="relative">
            <Button
              aria-label={filterToggleLabel}
              aria-pressed={isFilterVisible ? 'true' : 'false'}
              className={cn(
                'h-8 w-8 p-0',
                (isFilterVisible || hasActiveFilters) && 'bg-accent text-accent-foreground'
              )}
              onClick={() => onFilterVisibleChange(!isFilterVisible)}
              size="sm"
              title="Quick filters"
              variant="ghost"
            >
              <Filter className="h-4 w-4" />
            </Button>
            {hasActiveFilters && (
              <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </div>
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
