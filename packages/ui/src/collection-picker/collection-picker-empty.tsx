import { Plus } from 'lucide-react';
import { Button } from '../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import type { CollectionPickerEmptyProps } from './types';

/**
 * CollectionPickerEmpty - Empty state for the collection picker.
 *
 * Displays a friendly message and CTA button when no collections exist.
 */
export function CollectionPickerEmpty({ onCreate }: CollectionPickerEmptyProps) {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 p-4 text-center">
      <p className="mb-3 text-muted-foreground text-sm">
        No collections yet. Create your first collection to start searching files.
      </p>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button className="gap-2" onClick={onCreate} size="sm" variant="outline">
            <Plus className="h-4 w-4" />
            Create First Collection
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Create new collection</TooltipContent>
      </Tooltip>
    </div>
  );
}
