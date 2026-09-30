import { Pencil, Trash2 } from 'lucide-react';
import { memo, useCallback } from 'react';
import { Badge } from '../badge';
import { Button } from '../button';
import { useResolvedTheme } from '../hooks/use-resolved-theme';
import { cn } from '../lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip';
import { getCollectionPickerProtection } from './protection';
import type { CollectionPickerCollection, CollectionPickerItemProps } from './types';
import { formatProviderLabel, getCollectionColor } from './utils/collection-colors';

interface CollectionPickerItemActionsProps {
  canDelete: boolean;
  canEdit: boolean;
  collection: CollectionPickerCollection;
  /** Non-null while edit/delete are refused; shown as the tooltip. */
  mutationBlockedReason: string | null;
  onDelete: (collection: CollectionPickerCollection) => void;
  onEdit: (collection: CollectionPickerCollection) => void;
}

function CollectionPickerItemActions({
  canDelete,
  canEdit,
  collection,
  mutationBlockedReason,
  onDelete,
  onEdit,
}: CollectionPickerItemActionsProps) {
  const blocked = mutationBlockedReason !== null;

  const handleEdit = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (blocked) {
        return;
      }
      onEdit(collection);
    },
    [blocked, collection, onEdit]
  );

  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (blocked) {
        return;
      }
      onDelete(collection);
    },
    [blocked, collection, onDelete]
  );

  if (!(canEdit || canDelete)) {
    return null;
  }

  return (
    <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      {canEdit && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={
                blocked
                  ? `Edit collection (unavailable: ${mutationBlockedReason})`
                  : 'Edit collection'
              }
              disabled={blocked}
              onClick={handleEdit}
              size="icon-xs"
              variant="ghost"
            >
              <Pencil aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{mutationBlockedReason ?? 'Edit collection'}</TooltipContent>
        </Tooltip>
      )}
      {canDelete && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label={
                blocked
                  ? `Delete collection (unavailable: ${mutationBlockedReason})`
                  : 'Delete collection'
              }
              className="text-destructive hover:text-destructive"
              disabled={blocked}
              onClick={handleDelete}
              size="icon-xs"
              variant="ghost"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{mutationBlockedReason ?? 'Delete collection'}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

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
  const protection = getCollectionPickerProtection(collection);

  const displayName = collection.name ?? collection.modelId;
  const providerLabel = formatProviderLabel(collection.modelKey);
  const embeddingSummary = `${collection.embeddingCount.toLocaleString()} of ${collection.chunkCount.toLocaleString()} chunks embedded`;
  const optionLabel = [
    displayName,
    providerLabel,
    `${collection.dimensions} dimensions`,
    collection.distance,
    `${collection.fileCount.toLocaleString()} ${collection.fileCount === 1 ? 'file' : 'files'}`,
    `${collection.chunkCount.toLocaleString()} ${collection.chunkCount === 1 ? 'chunk' : 'chunks'}`,
    embeddingSummary,
    protection.badgeLabel,
    protection.disabledReason,
  ]
    .filter((label): label is string => Boolean(label))
    .join(', ');

  const handleClick = useCallback(() => {
    if (protection.isDisabled) {
      return;
    }
    onSelect(collection.id);
  }, [collection.id, onSelect, protection.isDisabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (protection.isDisabled) {
          return;
        }
        onSelect(collection.id);
      }
    },
    [collection.id, onSelect, protection.isDisabled]
  );

  return (
    <div
      aria-disabled={protection.isDisabled ? true : undefined}
      aria-label={optionLabel}
      aria-selected={isSelected}
      className={cn(
        'group relative rounded-md border p-3 outline-none transition-all',
        protection.isDisabled ? 'cursor-default opacity-75' : 'cursor-pointer',
        !protection.isDisabled &&
          'hover:border-accent-foreground/20 focus-visible:ring-2 focus-visible:ring-ring',
        isSelected && 'border-l-2',
        isFocused && 'border-accent-foreground/30 ring-2 ring-ring ring-offset-1'
      )}
      id={id}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="option"
      style={{
        backgroundColor: isSelected ? background : undefined,
        borderLeftColor: isSelected ? primary : undefined,
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
            {protection.badgeLabel && (
              <Badge className="shrink-0 font-normal text-[10px]" variant="secondary">
                {protection.badgeLabel}
              </Badge>
            )}
          </div>

          {/* Description (optional) */}
          {collection.description && (
            <p className="mt-1 line-clamp-1 text-muted-foreground text-xs">
              {collection.description}
            </p>
          )}
          {protection.disabledReason && (
            <p className="mt-1 text-muted-foreground text-xs">{protection.disabledReason}</p>
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
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    'flex cursor-default items-center gap-1 rounded-sm border-0 bg-transparent p-0 text-left',
                    collection.embeddingCount >= collection.chunkCount && collection.chunkCount > 0
                      ? 'text-success'
                      : ''
                  )}
                >
                  <span className="font-medium text-foreground/60">
                    {collection.embeddingCount.toLocaleString()}/
                    {collection.chunkCount.toLocaleString()}
                  </span>
                  <span>embedded</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{embeddingSummary}</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Right: Action buttons - visible on hover */}
        <CollectionPickerItemActions
          canDelete={protection.canDelete}
          canEdit={protection.canEdit}
          collection={collection}
          mutationBlockedReason={protection.mutationBlockedReason}
          onDelete={onDelete}
          onEdit={onEdit}
        />
      </div>
    </div>
  );
});
