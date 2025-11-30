import { FolderBadge } from '@brainstrike/file-explorer-ui';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { Check, Code, Search, X } from 'lucide-react';
import * as React from 'react';

export const DirectoryStatus: React.FC<{
  rootDirectoryHandle: DirectoryHandle | null;
}> = React.memo(({ rootDirectoryHandle }) => {
  if (!rootDirectoryHandle) {
    return null;
  }
  return (
    <div className="flex items-center gap-2 border-b px-2 py-2 text-muted-foreground text-sm">
      <span>{FileExplorerStrings.status.currentDirectory}</span>
      <FolderBadge folderId={rootDirectoryHandle.name} />
    </div>
  );
});

/**
 * FilterChip - Unified filter chip matching the Collection Browser style
 * Used for both include/exclude filters in the Explorer sidebar
 */
const FilterChip: React.FC<{
  label: string;
  value: string;
  icon?: React.ReactNode;
  variant?: 'include' | 'exclude' | 'search' | 'regex';
}> = React.memo(({ label, value, icon, variant = 'include' }) => {
  return (
    <Tooltip>
      <TooltipTrigger
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium text-xs',
          'cursor-help transition-colors duration-150',
          // Include filters: primary style (active)
          variant === 'include' && 'bg-primary text-primary-foreground',
          // Exclude filters: dark outline with ring in dark mode, muted in light
          variant === 'exclude' &&
            'bg-muted text-muted-foreground ring-1 ring-border ring-inset dark:bg-background dark:ring-muted-foreground/50',
          // Search/quick filter: outline style
          variant === 'search' && 'bg-muted/50 text-muted-foreground ring-1 ring-border ring-inset',
          // Regex mode indicator
          variant === 'regex' && 'bg-secondary text-secondary-foreground'
        )}
      >
        {icon}
        <span>{value}</span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{`${label}: ${value}`}</p>
      </TooltipContent>
    </Tooltip>
  );
});

export const FilterStatus: React.FC<{
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  quickFilter: string;
}> = React.memo(({ includeFilters, excludeFilters, useRegex, quickFilter }) => {
  const hasFilters = includeFilters.length > 0 || excludeFilters.length > 0 || quickFilter;

  if (!hasFilters) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b px-2 py-2">
      {includeFilters.map((filter) => (
        <FilterChip
          icon={<Check className="h-3 w-3" />}
          key={`include-${filter}`}
          label={FileExplorerStrings.status.includeFilters}
          value={filter}
          variant="include"
        />
      ))}
      {excludeFilters.map((filter) => (
        <FilterChip
          icon={<X className="h-3 w-3" />}
          key={`exclude-${filter}`}
          label={FileExplorerStrings.status.excludeFilters}
          value={filter}
          variant="exclude"
        />
      ))}
      {quickFilter && (
        <FilterChip
          icon={<Search className="h-3 w-3" />}
          label={FileExplorerStrings.status.quickFilter}
          value={quickFilter}
          variant="search"
        />
      )}
      {useRegex && (
        <FilterChip
          icon={<Code className="h-3 w-3" />}
          label={FileExplorerStrings.status.regexMode}
          value="regex"
          variant="regex"
        />
      )}
    </div>
  );
});
