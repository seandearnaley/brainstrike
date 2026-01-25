import { Button, cn, Input, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Info, Loader2, X } from 'lucide-react';
import * as React from 'react';

interface FileFilterBarProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  /** When true, shows a subtle "filtering" indicator while deferred filtering catches up */
  isFiltering?: boolean;
}

export const FileFilterBar: React.FC<FileFilterBarProps> = React.memo(
  ({ value, onChange, onClear, isFiltering }) => (
    <div className="relative flex w-full items-center gap-2">
      <div className="relative flex-1">
        <Input
          className={cn('w-full pr-8', isFiltering && 'pr-20')}
          data-testid="file-filter-input"
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type to filter files... (e.g. 'test component -spec')"
          type="text"
          value={value}
        />
        {/* Filtering indicator - shown while deferred value catches up */}
        {isFiltering && (
          <span className="pointer-events-none absolute top-1/2 right-9 flex -translate-y-1/2 items-center gap-1 text-muted-foreground text-xs">
            <Loader2 className="h-3 w-3 animate-spin" />
          </span>
        )}
        {value && (
          <Button
            aria-label="clear"
            className="absolute top-1/2 right-2 h-6 w-6 -translate-y-1/2 hover:bg-transparent"
            onClick={onClear}
            size="icon"
            variant="ghost"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <Button aria-label="Filter syntax help" className="h-8 w-8" size="icon" variant="ghost">
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
