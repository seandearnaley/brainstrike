import { FolderBadge } from '@brainstrike/file-explorer-ui';
import type { DirectoryHandle } from '@brainstrike/file-system';
import { FileExplorerStrings } from '@brainstrike/types';
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import * as React from 'react';

export const DirectoryStatus: React.FC<{
  rootDirectoryHandle: DirectoryHandle | null;
}> = React.memo(({ rootDirectoryHandle }) => {
  if (!rootDirectoryHandle) return null;
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground px-2 py-2 border-b">
      <span>{FileExplorerStrings.status.currentDirectory}</span>
      <FolderBadge folderId={rootDirectoryHandle.name} />
    </div>
  );
});

const FilterBadge: React.FC<{
  label: string;
  value: string;
  variant?: 'default' | 'secondary' | 'destructive' | 'outline';
}> = React.memo(({ label, value, variant = 'secondary' }) => (
  <Tooltip>
    <TooltipTrigger>
      <Badge variant={variant} className="cursor-help">
        {value}
      </Badge>
    </TooltipTrigger>
    <TooltipContent>
      <p>{`${label}: ${value}`}</p>
    </TooltipContent>
  </Tooltip>
));

export const FilterStatus: React.FC<{
  includeFilters: string[];
  excludeFilters: string[];
  useRegex: boolean;
  quickFilter: string;
}> = React.memo(({ includeFilters, excludeFilters, useRegex, quickFilter }) => {
  const hasFilters = includeFilters.length > 0 || excludeFilters.length > 0 || quickFilter;

  if (!hasFilters) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap px-2 py-2 border-b">
      {includeFilters.map((filter) => (
        <FilterBadge
          key={`include-${filter}`}
          label={FileExplorerStrings.status.includeFilters}
          value={filter}
          variant="default"
        />
      ))}
      {excludeFilters.map((filter) => (
        <FilterBadge
          key={`exclude-${filter}`}
          label={FileExplorerStrings.status.excludeFilters}
          value={filter}
          variant="destructive"
        />
      ))}
      {quickFilter && (
        <FilterBadge
          label={FileExplorerStrings.status.quickFilter}
          value={quickFilter}
          variant="outline"
        />
      )}
      {useRegex && (
        <Tooltip>
          <TooltipTrigger>
            <Badge variant="secondary" className="cursor-help">
              regex
            </Badge>
          </TooltipTrigger>
          <TooltipContent>
            <p>{FileExplorerStrings.status.regexMode}</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
});
