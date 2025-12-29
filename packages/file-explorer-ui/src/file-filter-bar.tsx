import { Button, Input, Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Info, X } from 'lucide-react';
import * as React from 'react';

type FileFilterBarProps = {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
};

export const FileFilterBar: React.FC<FileFilterBarProps> = React.memo(
  ({ value, onChange, onClear }) => (
    <div className="relative flex w-full items-center gap-2">
      <div className="relative flex-1">
        <Input
          className="w-full pr-8"
          data-testid="file-filter-input"
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type to filter files... (e.g. 'test component -spec')"
          type="text"
          value={value}
        />
        {value && (
          <Button
            aria-label="clear"
            className="-translate-y-1/2 absolute top-1/2 right-2 h-6 w-6 hover:bg-transparent"
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
