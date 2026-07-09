import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { Check, Code, Search, X } from 'lucide-react';
import * as React from 'react';
import { FolderBadge } from './folder-badge';

// Stable module-level icon elements to avoid creating new JSX on each render
// (avoids breaking memo() on FilterChip)
const INCLUDE_ICON = <Check className="h-3 w-3" />;
const EXCLUDE_ICON = <X className="h-3 w-3" />;
const SEARCH_ICON = <Search className="h-3 w-3" />;
const REGEX_ICON = <Code className="h-3 w-3" />;

export const DirectoryStatus = React.memo(
  ({ rootDirectoryHandle }: { rootDirectoryHandle: DirectoryHandle | null }) => {
    if (!rootDirectoryHandle) {
      return null;
    }
    return (
      <div className="flex items-center gap-2 border-b px-2 py-2 text-muted-foreground text-sm">
        <span>{FileExplorerStrings.status.currentDirectory}</span>
        <FolderBadge folderId={rootDirectoryHandle.name} />
      </div>
    );
  }
);

/**
 * FilterChip - Unified filter chip matching the Collection Browser style
 * Used for both include/exclude filters in the Explorer sidebar
 */
const FilterChip = React.memo(
  ({
    label,
    value,
    icon,
    variant = 'include',
    disabled = false,
    onToggle,
  }: {
    label: string;
    value: string;
    icon?: React.ReactNode | undefined;
    variant?: 'include' | 'exclude' | 'search' | 'regex' | undefined;
    disabled?: boolean | undefined;
    onToggle?: (() => void) | undefined;
  }) => {
    const isToggleable = !!onToggle;

    return (
      <Tooltip>
        <TooltipTrigger
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-xs',
            'transition-colors duration-150',
            // Include filters: primary style (active)
            variant === 'include' && 'bg-primary text-primary-foreground',
            // Exclude filters: dark outline with ring in dark mode, muted in light
            variant === 'exclude' &&
              'bg-muted text-muted-foreground ring-1 ring-border ring-inset dark:bg-background dark:ring-muted-foreground/50',
            // Search/quick filter: outline style
            variant === 'search' &&
              'bg-muted/50 text-muted-foreground ring-1 ring-border ring-inset',
            // Regex mode indicator
            variant === 'regex' && 'bg-secondary text-secondary-foreground',
            // Disabled state: reduced opacity and strikethrough
            disabled && 'opacity-50',
            // Interactive state for toggleable chips
            isToggleable ? 'cursor-pointer hover:ring-2 hover:ring-primary/50' : 'cursor-help'
          )}
          onClick={onToggle}
          type="button"
        >
          {icon}
          <span className={cn(disabled && 'line-through')}>{value}</span>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {`${label}: ${value}`}
            {isToggleable && (disabled ? ' (click to enable)' : ' (click to disable)')}
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }
);

export const FilterStatus = React.memo(
  ({
    includeFilters,
    excludeFilters,
    useRegex,
    quickFilter,
    disabledIncludeFilters,
    disabledExcludeFilters,
    onToggleFilter,
  }: {
    includeFilters: string[];
    excludeFilters: string[];
    useRegex: boolean;
    quickFilter: string;
    disabledIncludeFilters?: ReadonlySet<string>;
    disabledExcludeFilters?: ReadonlySet<string>;
    onToggleFilter?: (filter: string, type: 'include' | 'exclude') => void;
  }) => {
    const hasFilters = includeFilters.length > 0 || excludeFilters.length > 0 || quickFilter;

    if (!hasFilters) {
      return null;
    }

    return (
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-2">
        {includeFilters.map((filter) => (
          <FilterChip
            disabled={disabledIncludeFilters?.has(filter) ?? false}
            icon={INCLUDE_ICON}
            key={`include-${filter}`}
            label={FileExplorerStrings.status.includeFilters}
            onToggle={onToggleFilter ? () => onToggleFilter(filter, 'include') : undefined}
            value={filter}
            variant="include"
          />
        ))}
        {excludeFilters.map((filter) => (
          <FilterChip
            disabled={disabledExcludeFilters?.has(filter) ?? false}
            icon={EXCLUDE_ICON}
            key={`exclude-${filter}`}
            label={FileExplorerStrings.status.excludeFilters}
            onToggle={onToggleFilter ? () => onToggleFilter(filter, 'exclude') : undefined}
            value={filter}
            variant="exclude"
          />
        ))}
        {quickFilter && (
          <FilterChip
            icon={SEARCH_ICON}
            label={FileExplorerStrings.status.quickFilter}
            value={quickFilter}
            variant="search"
          />
        )}
        {useRegex && (
          <FilterChip
            icon={REGEX_ICON}
            label={FileExplorerStrings.status.regexMode}
            value="regex"
            variant="regex"
          />
        )}
      </div>
    );
  }
);
