import { Pencil, Trash2 } from 'lucide-react';
import { useCallback } from 'react';
import { Badge } from '../badge';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { useResolvedTheme } from './hooks/use-resolved-theme';
import type { CollectionPickerItemProps } from './types';
import { formatProviderLabel, getCollectionColor } from './utils/collection-colors';

/**
 * CollectionPickerItem - A single collection item in the picker.
 *
 * Displays collection name, provider badge, metadata (dimensions, distance, file count),
 * and action buttons (edit, delete) that appear on hover.
 *
 * When selected, shows a colored left border and subtle background tint.
 * Each collection has a unique color based on hashing its ID.
 */
export function CollectionPickerItem({
  collection,
  isSelected,
  onSelect,
  onEdit,
  onDelete,
}: CollectionPickerItemProps) {
  const theme = useResolvedTheme();
  const { primary, background } = getCollectionColor(collection.id, theme);

  const displayName = collection.name ?? collection.modelId;
  const providerLabel = formatProviderLabel(collection.modelKey);

  const handleClick = useCallback(() => {
    onSelect(collection.id);
  }, [collection.id, onSelect]);

  const handleEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onEdit(collection);
    },
    [collection, onEdit]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete(collection);
    },
    [collection, onDelete]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const current = e.currentTarget as HTMLElement;
      const listbox = current.closest<HTMLElement>('[role="listbox"]');
      const options = listbox?.querySelectorAll<HTMLElement>('[role="option"]');

      const focusByIndex = (targetIndex: number) => {
        if (!options || options.length === 0) {
          return;
        }
        const clampedIndex = Math.max(0, Math.min(options.length - 1, targetIndex));
        options[clampedIndex]?.focus();
      };

      const currentIndex = options ? Array.from(options).indexOf(current) : -1;

      switch (e.key) {
        case 'Enter':
        case ' ': {
          e.preventDefault();
          onSelect(collection.id);
          return;
        }
        case 'ArrowDown': {
          e.preventDefault();
          if (currentIndex >= 0) {
            focusByIndex(currentIndex + 1);
          }
          return;
        }
        case 'ArrowUp': {
          e.preventDefault();
          if (currentIndex >= 0) {
            focusByIndex(currentIndex - 1);
          }
          return;
        }
        case 'Home': {
          e.preventDefault();
          focusByIndex(0);
          return;
        }
        case 'End': {
          e.preventDefault();
          if (options) {
            focusByIndex(options.length - 1);
          }
          return;
        }
        default:
          return;
      }
    },
    [collection.id, onSelect]
  );

  return (
    <div
      aria-selected={isSelected}
      className={cn(
        'group relative cursor-pointer rounded-md border p-3 transition-all',
        'hover:border-accent-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isSelected && 'border-l-2'
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="option"
      style={{
        borderLeftColor: isSelected ? primary : undefined,
        backgroundColor: isSelected ? background : undefined,
      }}
      tabIndex={0}
    >
      <div className="flex items-start justify-between gap-2">
        {/* Left: Content */}
        <div className="min-w-0 flex-1">
          {/* Name + Provider Badge */}
          <div className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">{displayName}</span>
            <Badge
              className="shrink-0 font-normal text-[10px]"
              style={{ borderColor: primary, color: primary }}
              variant="outline"
            >
              {providerLabel}
            </Badge>
          </div>

          {/* Description (optional) */}
          {collection.description && (
            <p className="mt-1 line-clamp-1 text-muted-foreground text-xs">
              {collection.description}
            </p>
          )}

          {/* Metadata row */}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span>{collection.dimensions}D</span>
            <span>{collection.distance}</span>
            <span>
              {collection.fileCount.toLocaleString()}{' '}
              {collection.fileCount === 1 ? 'file' : 'files'}
            </span>
            <span>
              {collection.chunkCount.toLocaleString()}{' '}
              {collection.chunkCount === 1 ? 'chunk' : 'chunks'}
            </span>
            <span>{collection.embeddingCount.toLocaleString()} embeddings</span>
          </div>
        </div>

        {/* Right: Action buttons - visible on hover */}
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            className="h-7 w-7 p-0"
            onClick={handleEdit}
            size="sm"
            title="Edit collection"
            variant="ghost"
          >
            <Pencil className="h-3.5 w-3.5" />
            <span className="sr-only">Edit</span>
          </Button>
          <Button
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={handleDelete}
            size="sm"
            title="Delete collection"
            variant="ghost"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="sr-only">Delete</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
