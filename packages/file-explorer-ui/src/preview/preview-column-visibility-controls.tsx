import {
  Button,
  Checkbox,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Columns3 } from 'lucide-react';
import { memo } from 'react';
import { COLUMN_CONFIGS } from './preview-column-visibility';
import type { ColumnVisibility } from './use-preview-panel-persistence';

interface ColumnVisibilityControlsProps {
  columnVisibility: ColumnVisibility;
  onColumnVisibilityChange: (visibility: ColumnVisibility) => void;
}

export const ColumnVisibilityControls = memo<ColumnVisibilityControlsProps>(
  function ColumnVisibilityControlsComponent({ columnVisibility, onColumnVisibilityChange }) {
    const hasCustomizedColumns = COLUMN_CONFIGS.some(
      (column) =>
        column.canHide &&
        (columnVisibility[column.id] ?? column.defaultVisible) !== column.defaultVisible
    );

    return (
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                aria-label="Select visible columns"
                className={cn(
                  'relative h-9 w-9 p-0',
                  hasCustomizedColumns && 'bg-accent text-accent-foreground'
                )}
                size="sm"
                title="Columns"
                variant="ghost"
              >
                <Columns3 className="size-4" />
                {hasCustomizedColumns ? (
                  <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
                ) : null}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>Select visible columns</TooltipContent>
        </Tooltip>
        <PopoverContent align="end" className="w-48 p-2">
          <div className="space-y-1">
            {COLUMN_CONFIGS.filter((column) => column.canHide).map((column) => (
              <div
                className="flex cursor-pointer items-center space-x-2 rounded px-2 py-1.5 hover:bg-accent"
                key={column.id}
              >
                <Checkbox
                  checked={columnVisibility[column.id] ?? false}
                  disabled={column.id === 'checkbox' || column.id === 'path'}
                  id={`column-${column.id}`}
                  onCheckedChange={(checked) => {
                    onColumnVisibilityChange({
                      ...columnVisibility,
                      [column.id]: !!checked,
                    });
                  }}
                />
                <label
                  className="cursor-pointer select-none text-sm"
                  htmlFor={`column-${column.id}`}
                >
                  {column.label}
                </label>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    );
  }
);

ColumnVisibilityControls.displayName = 'ColumnVisibilityControls';
