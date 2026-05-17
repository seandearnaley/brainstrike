import { Plus } from 'lucide-react';
import { Button } from '../button';
import { Label } from '../label';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import type { CollectionPickerHeaderProps } from './types';

/**
 * CollectionPickerHeader - Header component with label and create button.
 *
 * Displays the section label and a "Create" button for adding new collections.
 */
export function CollectionPickerHeader({
  label,
  onCreate,
  showLabel = true,
}: CollectionPickerHeaderProps) {
  return (
    <div className="mb-2 flex items-center justify-between">
      {showLabel && <Label className="font-medium text-sm">{label}</Label>}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className="ml-auto h-7 gap-1 px-2 text-xs"
            onClick={onCreate}
            size="sm"
            variant="ghost"
          >
            <Plus className="h-3.5 w-3.5" />
            Create
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Create new collection</TooltipContent>
      </Tooltip>
    </div>
  );
}
