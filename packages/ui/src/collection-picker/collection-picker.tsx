import { useCallback, useId, useState } from 'react';
import { Label } from '../label';
import { cn } from '../lib/utils';
import { ScrollArea } from '../scroll-area';
import { TooltipProvider } from '../tooltip';
import { CollectionPickerEmpty } from './collection-picker-empty';
import { CollectionPickerHeader } from './collection-picker-header';
import { CollectionPickerItem } from './collection-picker-item';
import { getCollectionPickerProtection } from './protection';
import type { CollectionPickerCollection, CollectionPickerProps } from './types';

/**
 * CollectionPicker - A scrollable picker for selecting embedding collections.
 *
 * Replaces the dropdown-based collection selector with an inline scrollable list
 * that shows all collections with rich metadata and inline edit/delete actions.
 *
 * Features:
 * - Scrollable list of collections with unique colors per collection
 * - Click or arrow keys to navigate, Enter/Space to select
 * - Full WCAG 2.1 keyboard navigation support
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
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [isKeyboardFocused, setIsKeyboardFocused] = useState(false);
  const listboxId = useId();
  const labelId = `${listboxId}-label`;

  const handleSelect = useCallback(
    (id: string) => {
      const collection = collections.find((candidate) => candidate.id === id);
      if (!collection || getCollectionPickerProtection(collection).isDisabled) {
        return;
      }
      // Always select, do not toggle to null
      onSelect(id);
    },
    [collections, onSelect]
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

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      setIsKeyboardFocused(true);
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setFocusedIndex((prev) => Math.min(prev + 1, collections.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case 'Home':
          e.preventDefault();
          setFocusedIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setFocusedIndex(collections.length - 1);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (collections[focusedIndex]) {
            handleSelect(collections[focusedIndex].id);
          }
          break;
      }
    },
    [collections, focusedIndex, handleSelect]
  );

  const handleBlur = useCallback(() => {
    setIsKeyboardFocused(false);
  }, []);

  const handlePointerDown = useCallback(() => {
    setIsKeyboardFocused(false);
  }, []);

  // Loading state
  // Keep already-known collections visible while a refresh is in flight so optimistic
  // collection updates do not disappear behind a spinner.
  if (loading && collections.length === 0) {
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
    <div className={className}>
      {showHeader && (
        <div className="mb-2 flex items-center justify-between">
          <Label className="font-medium text-sm" id={labelId}>
            {headerLabel}
          </Label>
          <CollectionPickerHeader label={headerLabel} onCreate={onCreate} showLabel={false} />
        </div>
      )}

      <div
        aria-activedescendant={
          focusedIndex >= 0 ? `collection-option-${collections[focusedIndex]?.id}` : undefined
        }
        aria-label={showHeader ? undefined : headerLabel}
        aria-labelledby={showHeader ? labelId : undefined}
        className="outline-none"
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        role="listbox"
        tabIndex={0}
      >
        <TooltipProvider delayDuration={300}>
          <ScrollArea className="flex-1" style={{ maxHeight }}>
            <div className="space-y-2 px-1 py-1">
              {collections.map((collection, index) => (
                <CollectionPickerItem
                  collection={collection}
                  id={`collection-option-${collection.id}`}
                  isFocused={isKeyboardFocused && index === focusedIndex}
                  isSelected={collection.id === selectedId}
                  key={collection.id}
                  onDelete={handleDelete}
                  onEdit={handleEdit}
                  onSelect={handleSelect}
                />
              ))}
            </div>
          </ScrollArea>
        </TooltipProvider>
      </div>
    </div>
  );
}
