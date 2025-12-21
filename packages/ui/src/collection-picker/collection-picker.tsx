import { useCallback } from 'react';
import { cn } from '../lib/utils';
import { ScrollArea } from '../scroll-area';
import { CollectionPickerEmpty } from './collection-picker-empty';
import { CollectionPickerHeader } from './collection-picker-header';
import { CollectionPickerItem } from './collection-picker-item';
import type { CollectionPickerCollection, CollectionPickerProps } from './types';

/**
 * CollectionPicker - A scrollable picker for selecting embedding collections.
 *
 * Replaces the dropdown-based collection selector with an inline scrollable list
 * that shows all collections with rich metadata and inline edit/delete actions.
 *
 * Features:
 * - Scrollable list of collections with unique colors per collection
 * - Click to select, click again to deselect
 * - Inline edit and delete buttons (visible on hover)
 * - Optional header with label and create button
 * - Empty state with create CTA
 * - Loading state
 *
 * @example
 * ```tsx
 * <CollectionPicker
 *   collections={collections}
 *   selectedId={activeCollectionId}
 *   onSelect={handleSelect}
 *   onEdit={handleEdit}
 *   onDelete={handleDelete}
 *   onCreate={handleCreate}
 * />
 * ```
 */
export function CollectionPicker({
  collections,
  selectedId,
  onSelect,
  onEdit,
  onDelete,
  onCreate,
  loading = false,
  emptyState,
  maxHeight = '280px',
  showHeader = true,
  headerLabel = 'Search Collection',
  className,
}: CollectionPickerProps) {
  const handleSelect = useCallback(
    (id: string) => {
      // Click-to-select, click-again-to-deselect (supports "no collection selected" state)
      if (selectedId === id) {
        onSelect(null);
        return;
      }
      onSelect(id);
    },
    [onSelect, selectedId]
  );

  const handleEdit = useCallback(
    (collection: CollectionPickerCollection) => {
      onEdit(collection);
    },
    [onEdit]
  );

  const handleDelete = useCallback(
    (collection: CollectionPickerCollection) => {
      onDelete(collection);
    },
    [onDelete]
  );

  // Loading state
  if (loading) {
    return (
      <div className={cn('py-8 text-center text-muted-foreground text-sm', className)}>
        Loading collections...
      </div>
    );
  }

  // Empty state
  if (collections.length === 0) {
    return (
      <div className={className}>
        {showHeader && <CollectionPickerHeader label={headerLabel} onCreate={onCreate} />}
        {emptyState ?? <CollectionPickerEmpty onCreate={onCreate} />}
      </div>
    );
  }

  return (
    <div aria-label={headerLabel} className={className} role="listbox">
      {showHeader && <CollectionPickerHeader label={headerLabel} onCreate={onCreate} />}

      <ScrollArea className="pr-3" style={{ maxHeight }}>
        <div className="space-y-2 py-1">
          {collections.map((collection) => (
            <CollectionPickerItem
              collection={collection}
              isSelected={collection.id === selectedId}
              key={collection.id}
              onDelete={handleDelete}
              onEdit={handleEdit}
              onSelect={handleSelect}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
