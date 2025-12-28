import {
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Columns3 } from 'lucide-react';
import { memo } from 'react';
import type { ColumnVisibility } from './hooks/use-preview-panel-persistence';
import { COLUMN_CONFIGS } from './preview-column-visibility';

type ColumnVisibilityControlsProps = {
  columnVisibility: ColumnVisibility;
  onColumnVisibilityChange: (visibility: ColumnVisibility) => void;
};

export const ColumnVisibilityControls = memo<ColumnVisibilityControlsProps>(
  function ColumnVisibilityControlsComponent({ columnVisibility, onColumnVisibilityChange }) {
    return (
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button className="@[600px]:h-9 h-8 @[600px]:px-3 px-2" size="sm" variant="outline">
                <Columns3 className="@[600px]:mr-2 size-3.5" />
                <span className="@[600px]:inline hidden">Columns</span>
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
