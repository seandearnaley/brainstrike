import { Plus } from 'lucide-react';
import { Button } from '../button';
import { Label } from '../label';
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
      <Button
        className="ml-auto h-7 gap-1 px-2 text-xs"
        onClick={onCreate}
        size="sm"
        title="Create new collection"
        variant="ghost"
      >
        <Plus className="h-3.5 w-3.5" />
        Create
      </Button>
    </div>
  );
}
