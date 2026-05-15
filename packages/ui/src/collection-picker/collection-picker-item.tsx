import { Pencil, Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';
import { Badge } from '../badge';
import { Button } from '../button';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
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
export const CollectionPickerItem = memo(function CollectionPickerItem({
  collection,
  id,
  isSelected,
  isFocused,
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
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(collection.id);
      }
    },
    [collection.id, onSelect]
  );

  return (
    <div
      aria-selected={isSelected}
      className={cn(
        'group relative cursor-pointer rounded-md border p-3 outline-none transition-all',
        'hover:border-accent-foreground/20 focus-visible:ring-2 focus-visible:ring-ring',
        isSelected && 'border-l-2',
        isFocused && 'border-accent-foreground/30 ring-2 ring-ring ring-offset-1'
      )}
      id={id}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="option"
      style={{
        borderLeftColor: isSelected ? primary : undefined,
        backgroundColor: isSelected ? background : undefined,
      }}
      tabIndex={-1}
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
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/80">
            <span className="flex items-center gap-1">
              <span className="font-medium text-foreground/60">{collection.dimensions}</span>
              <span>D</span>
            </span>
            <span className="h-1 w-1 rounded-full bg-border" />
            <span className="capitalize">{collection.distance}</span>
            <span className="h-1 w-1 rounded-full bg-border" />
            <span>
              <span className="font-medium text-foreground/60">
                {collection.fileCount.toLocaleString()}
              </span>{' '}
              {collection.fileCount === 1 ? 'file' : 'files'}
            </span>
            <span className="h-1 w-1 rounded-full bg-border" />
            <span>
              <span className="font-medium text-foreground/60">
                {collection.chunkCount.toLocaleString()}
              </span>{' '}
              {collection.chunkCount === 1 ? 'chunk' : 'chunks'}
            </span>
            {/* Embedding coverage display */}
            <span className="h-1 w-1 rounded-full bg-border" />
            <span
              className={cn(
                'flex items-center gap-1',
                collection.embeddingCount >= collection.chunkCount && collection.chunkCount > 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : ''
              )}
              title={`${collection.embeddingCount} of ${collection.chunkCount} chunks embedded`}
            >
              <span className="font-medium text-foreground/60">
                {collection.embeddingCount.toLocaleString()}/
                {collection.chunkCount.toLocaleString()}
              </span>
              <span>embedded</span>
            </span>
          </div>
        </div>

        {/* Right: Action buttons - visible on hover */}
        <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Edit collection"
                onClick={handleEdit}
                size="icon-xs"
                variant="ghost"
              >
                <Pencil aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Edit collection</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Delete collection"
                className="text-destructive hover:text-destructive"
                onClick={handleDelete}
                size="icon-xs"
                variant="ghost"
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Delete collection</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
});
