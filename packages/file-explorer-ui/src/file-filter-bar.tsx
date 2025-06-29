import { Button } from '@brainstrike/ui';
import { Input } from '@brainstrike/ui';
import { Popover, PopoverContent, PopoverTrigger } from '@brainstrike/ui';
import { Info, X } from 'lucide-react';
import * as React from 'react';

interface FileFilterBarProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
}

export const FileFilterBar: React.FC<FileFilterBarProps> = React.memo(
  ({ value, onChange, onClear }) => {
    return (
      <div className="relative flex items-center gap-2 w-full">
        <div className="relative flex-1">
          <Input
            type="text"
            placeholder="Type to filter files... (e.g. 'test component -spec')"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full pr-8"
          />
          {value && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 hover:bg-transparent"
              aria-label="clear"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Filter syntax help">
              <Info className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="max-w-sm" align="end">
            <p className="font-medium mb-1">Filter Syntax:</p>
            <ul className="text-sm space-y-1">
              <li>• Use spaces to separate multiple terms (matches all terms)</li>
              <li>
                • Use <code className="bg-muted px-1 rounded">-term</code> to exclude files
                containing "term"
              </li>
              <li>
                • Example: <code className="bg-muted px-1 rounded">test component -spec</code>
              </li>
            </ul>
          </PopoverContent>
        </Popover>
      </div>
    );
  }
);

FileFilterBar.displayName = 'FileFilterBar';

export default FileFilterBar;
