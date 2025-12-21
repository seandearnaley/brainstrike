import type { usePGliteDatabase } from '@brainstrike/db';
import {
  Button,
  CollectionPicker,
  type CollectionPickerCollection,
  Label,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useToast,
} from '@brainstrike/ui';
import { useCollections } from '@brainstrike/vector-management';
import { HelpCircle, Plus } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';

type SearchCollectionSelectorProps = {
  /**
   * The database instance for querying collections
   */
  db: ReturnType<typeof usePGliteDatabase>;

  /**
   * Currently active collection ID
   */
  activeCollectionId: string | null;

  /**
   * Callback when collection selection changes
   */
  onCollectionChange: (collectionId: string | null) => void;

  /**
   * Callback to open the create collection dialog
   */
  onCreateCollection: () => void;

  /**
   * Callback when edit is clicked on a collection
   */
  onEditCollection: (collection: CollectionPickerCollection) => void;

  /**
   * Callback when delete is clicked on a collection
   */
  onDeleteCollection: (collection: CollectionPickerCollection) => void;
};

/**
 * SearchCollectionSelector - User-friendly collection picker for Database Explorer
 *
 * This component displays a scrollable list of collections with:
 * - Label with help tooltip explaining collections
 * - Inline Create button in the picker header
 * - Rich metadata display (provider, dimensions, distance, file count)
 * - Inline edit and delete buttons per collection
 * - Unique colors per collection
 * - Empty state with "Create First Collection" CTA
 *
 * For the compact dropdown version, see EmbeddingSetSelector in vector-management.
 */
export function SearchCollectionSelector({
  db,
  activeCollectionId,
  onCollectionChange,
  onCreateCollection,
  onEditCollection,
  onDeleteCollection,
}: SearchCollectionSelectorProps) {
  const { toast } = useToast();
  const lastToastErrorRef = useRef<string | null>(null);

  // Use shared hook for collection data
  const { collections, loading, error } = useCollections(db);

  // Handle errors with toast notifications
  useEffect(() => {
    if (!error) {
      lastToastErrorRef.current = null;
      return;
    }
    const message =
      error instanceof Error ? error.message : 'Unable to retrieve collections from database';
    if (lastToastErrorRef.current === message) {
      return;
    }
    lastToastErrorRef.current = message;
    toast({
      title: 'Failed to Load Collections',
      description: message,
      variant: 'destructive',
    });
  }, [error, toast]);

  const handleEdit = useCallback(
    (collection: CollectionPickerCollection) => {
      onEditCollection(collection);
    },
    [onEditCollection]
  );

  const handleDelete = useCallback(
    (collection: CollectionPickerCollection) => {
      onDeleteCollection(collection);
    },
    [onDeleteCollection]
  );

  const isLoading = loading || !db;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label className="font-medium text-sm">Search Collection</Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 cursor-help text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent className="max-w-[300px]">
                <p className="text-sm">
                  Collections let you search files with different AI models. Create separate
                  collections for code, documentation, or general content to get better search
                  results optimized for each use case.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <Button
          className="h-7 gap-1 px-2 text-xs"
          onClick={onCreateCollection}
          size="sm"
          title="Create new collection"
          variant="ghost"
        >
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <CollectionPicker
        collections={collections}
        loading={isLoading}
        maxHeight="260px"
        onCreate={onCreateCollection}
        onDelete={handleDelete}
        onEdit={handleEdit}
        onSelect={onCollectionChange}
        selectedId={activeCollectionId}
        showHeader={false}
      />
    </div>
  );
}

// Re-export the type for use in parent components
export type { CollectionPickerCollection };
