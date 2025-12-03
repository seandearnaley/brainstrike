import type { usePGliteDatabase } from '@brainstrike/db';
import {
  Button,
  Label,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useToast,
} from '@brainstrike/ui';
import {
  CollectionSelect,
  type CollectionWithDocCount,
  useCollections,
} from '@brainstrike/vector-management';
import { HelpCircle, Plus, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

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
   * Callback to open the manage collections dialog
   */
  onManageCollections: () => void;

  /**
   * Callback to open the create collection dialog
   */
  onCreateCollection: () => void;
};

/**
 * SearchCollectionSelector - User-friendly collection selector for Database Explorer
 *
 * This component wraps CollectionSelect with additional UI:
 * - Label with help tooltip explaining collections
 * - Create and Manage action buttons
 * - Metadata display (model, dimensions, distance)
 * - Empty state with "Create First Collection" CTA
 *
 * For the compact version without chrome, see EmbeddingSetSelector.
 */
export function SearchCollectionSelector({
  db,
  activeCollectionId,
  onCollectionChange,
  onManageCollections,
  onCreateCollection,
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

  // Error callback for CollectionSelect
  const handleError = useCallback(
    (err: Error) => {
      if (lastToastErrorRef.current === err.message) {
        return;
      }
      lastToastErrorRef.current = err.message;
      toast({
        title: 'Failed to Load Collections',
        description: err.message,
        variant: 'destructive',
      });
    },
    [toast]
  );

  const isLoading = loading || !db;

  // Find active collection for metadata display
  const activeCollection = useMemo<CollectionWithDocCount | null>(
    () => collections.find((c) => c.id === activeCollectionId) ?? null,
    [collections, activeCollectionId]
  );

  const hasCollections = collections.length > 0;

  return (
    <div className="space-y-2 border-b pb-4">
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
        <div className="flex gap-2">
          <Button
            className="h-7 gap-1 px-2 text-xs"
            onClick={onCreateCollection}
            size="sm"
            title="Create new collection"
            variant="ghost"
          >
            <Plus className="h-3.5 w-3.5" />
            Create
          </Button>
          <Button
            className="h-7 gap-1 px-2 text-xs"
            onClick={onManageCollections}
            size="sm"
            title="Manage all collections"
            variant="ghost"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Manage
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <CollectionSelect
          collections={collections}
          error={error instanceof Error ? error : null}
          loading={loading}
          loadingPlaceholder="Loading..."
          onError={handleError}
          onSelectionChange={onCollectionChange}
          placeholder="No collections yet – create one to start"
          selectedId={activeCollectionId}
          size="default"
        />

        {activeCollection && (
          <div className="flex items-center justify-between px-1 text-muted-foreground text-xs">
            <div>
              <span className="font-medium">{activeCollection.modelId}</span>
              {' · '}
              <span>
                {activeCollection.dimensions}D {activeCollection.distance}
              </span>
            </div>
            <div>
              {activeCollection.fileCount.toLocaleString()}{' '}
              {activeCollection.fileCount === 1 ? 'file' : 'files'}
            </div>
          </div>
        )}

        {!(hasCollections || isLoading) && (
          <div className="rounded-md border border-dashed bg-muted/20 p-3 text-center">
            <p className="mb-2 text-muted-foreground text-sm">
              No collections yet. Create your first collection to start searching files.
            </p>
            <Button className="gap-2" onClick={onCreateCollection} size="sm" variant="outline">
              <Plus className="h-4 w-4" />
              Create First Collection
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
