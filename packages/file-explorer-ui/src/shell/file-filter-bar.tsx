import { Button, cn, Input, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Info, Loader2, Search, X } from 'lucide-react';
import * as React from 'react';

interface FileFilterBarProps {
  /** When true, shows a subtle "filtering" indicator while deferred filtering catches up */
  isFiltering?: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  /**
   * Optional controls rendered between the filter input and the syntax-help
   * (info) button. Used to host the tree action buttons (refresh / expand /
   * collapse) inline in this row instead of as a floating overlay.
   */
  trailing?: React.ReactNode;
  value: string;
}

export const FileFilterBar: React.FC<FileFilterBarProps> = React.memo(
  ({ value, onChange, onClear, isFiltering, trailing }) => (
    <div className="relative flex w-full items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Filter files"
          className={cn('h-8 w-full bg-background pr-8 pl-9 text-sm', isFiltering && 'pr-16')}
          data-testid="file-filter-input"
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type to filter files... (e.g. 'test component -spec')"
          type="text"
          value={value}
        />
        {isFiltering && (
          <span className="pointer-events-none absolute top-1/2 right-9 flex -translate-y-1/2 items-center gap-1 text-muted-foreground text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
          </span>
        )}
        {value && (
          <Button
            aria-label="Clear filter"
            className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 hover:bg-transparent"
            onClick={onClear}
            size="icon"
            title="Clear filter"
            variant="ghost"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      {trailing}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            aria-label="Filter syntax help"
            className="h-8 w-8"
            size="icon"
            title="Filter syntax help"
            variant="ghost"
          >
            <Info className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="max-w-sm">
          <p className="mb-1 font-medium">Filter Syntax:</p>
          <ul className="space-y-1 text-sm">
            <li>• Use spaces to separate multiple terms (matches all terms)</li>
            <li>
              • Use <code className="rounded bg-muted px-1">-term</code> to exclude files containing
              "term"
            </li>
            <li>
              • Example: <code className="rounded bg-muted px-1">test component -spec</code>
            </li>
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  )
);

FileFilterBar.displayName = 'FileFilterBar';

export default FileFilterBar;
