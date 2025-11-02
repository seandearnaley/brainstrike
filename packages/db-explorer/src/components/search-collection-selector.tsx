import type { EmbeddingSet, usePGliteDatabase } from '@brainstrike/db';
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@brainstrike/ui';
import { HelpCircle, Plus, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

type EmbeddingSetWithChunkCount = EmbeddingSet & {
  chunkCount: number;
};

interface SearchCollectionSelectorProps {
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
}

/**
 * SearchCollectionSelector - User-friendly collection selector for Database Explorer
 *
 * This component provides:
 * - Dropdown with all available collections
 * - Stats display (document count, last updated)
 * - Help tooltip explaining collections
 * - Quick access to Create and Manage buttons
 */
export function SearchCollectionSelector({
  db,
  activeCollectionId,
  onCollectionChange,
  onManageCollections,
  onCreateCollection,
}: SearchCollectionSelectorProps) {
  const [collections, setCollections] = useState<EmbeddingSetWithChunkCount[]>([]);
  const [loading, setLoading] = useState(true);

  // Load collections from database
  const loadCollections = useCallback(async () => {
    if (!db) {
      setCollections([]);
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      const result = await db.query<{
        id: string;
        modelKey: string;
        modelId: string;
        dimensions: number;
        distance: string;
        createdAt: string;
        name: string | null;
        description: string | null;
        tags: string | null;
        category: string | null;
        chunkCount: string | number;
      }>(`
        SELECT
          s.id,
          s.model_key AS "modelKey",
          s.model_id AS "modelId",
          s.dimensions,
          s.distance,
          s.created_at AS "createdAt",
          s.name,
          s.description,
          s.tags,
          s.category,
          COUNT(c.id) AS "chunkCount"
        FROM embedding_sets s
        LEFT JOIN file_chunks c ON c.embedding_set_id = s.id
        GROUP BY s.id, s.model_key, s.model_id, s.dimensions, s.distance, s.created_at, s.name, s.description, s.tags, s.category
        ORDER BY s.created_at DESC
      `);

      const sets: EmbeddingSetWithChunkCount[] = result.rows.map(
        (row: {
          id: string;
          modelKey: string;
          modelId: string;
          dimensions: number;
          distance: string;
          createdAt: string;
          name: string | null;
          description: string | null;
          tags: string | null;
          category: string | null;
          chunkCount: string | number;
        }) => {
          const set: EmbeddingSetWithChunkCount = {
            id: row.id,
            modelKey: row.modelKey,
            modelId: row.modelId,
            dimensions: row.dimensions,
            distance: row.distance as 'cosine' | 'l2' | 'ip',
            createdAt: row.createdAt,
            chunkCount: Number(row.chunkCount ?? 0),
          };

          if (row.name) set.name = row.name;
          if (row.description) set.description = row.description;
          if (row.tags) set.tags = row.tags;
          if (row.category) set.category = row.category;

          return set;
        }
      );

      setCollections(sets);
    } catch (error) {
      console.error('[SearchCollectionSelector] Failed to load collections:', error);
      setCollections([]);
    } finally {
      setLoading(false);
    }
  }, [db]);

  // Load collections on mount and when repository changes
  useEffect(() => {
    void loadCollections();
  }, [loadCollections]);

  // Listen for collection changes (from manage dialog, etc.)
  useEffect(() => {
    const handleCollectionChange = () => {
      void loadCollections();
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('embedding-set-created', handleCollectionChange);
      window.addEventListener('embedding-set-updated', handleCollectionChange);
      window.addEventListener('embedding-set-deleted', handleCollectionChange);

      return () => {
        window.removeEventListener('embedding-set-created', handleCollectionChange);
        window.removeEventListener('embedding-set-updated', handleCollectionChange);
        window.removeEventListener('embedding-set-deleted', handleCollectionChange);
      };
    }
    return undefined;
  }, [loadCollections]);

  // Find active collection
  const activeCollection = useMemo(
    () => collections.find((c) => c.id === activeCollectionId) ?? null,
    [collections, activeCollectionId]
  );

  // Format collection label with stats
  const formatCollectionLabel = useCallback((collection: EmbeddingSetWithChunkCount) => {
    const name = collection.name || collection.modelId;
    const count = collection.chunkCount ?? 0;
    return `${name} (${count.toLocaleString()} docs)`;
  }, []);

  const hasCollections = collections.length > 0;

  return (
    <div className="space-y-2 pb-4 border-b">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Label className="text-sm font-medium">Search Collection</Label>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
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
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={onCreateCollection}
            title="Create new collection"
          >
            <Plus className="h-3.5 w-3.5" />
            Create
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1"
            onClick={onManageCollections}
            title="Manage all collections"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Manage
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <Select
          value={activeCollectionId ?? ''}
          onValueChange={(value) => onCollectionChange(value || null)}
          disabled={!hasCollections || loading}
        >
          <SelectTrigger className="w-full">
            <SelectValue
              placeholder={loading ? 'Loading...' : 'No collections yet – create one to start'}
            >
              {activeCollection ? formatCollectionLabel(activeCollection) : null}
            </SelectValue>
          </SelectTrigger>
          {hasCollections && (
            <SelectContent className="max-w-[400px]">
              {collections.map((collection) => (
                <SelectItem key={collection.id} value={collection.id}>
                  {formatCollectionLabel(collection)}
                </SelectItem>
              ))}
            </SelectContent>
          )}
        </Select>

        {activeCollection && (
          <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
            <div>
              <span className="font-medium">{activeCollection.modelId}</span>
              {' · '}
              <span>
                {activeCollection.dimensions}D {activeCollection.distance}
              </span>
            </div>
            <div>{activeCollection.chunkCount.toLocaleString()} documents</div>
          </div>
        )}

        {!hasCollections && !loading && (
          <div className="rounded-md border border-dashed bg-muted/20 p-3 text-center">
            <p className="text-sm text-muted-foreground mb-2">
              No collections yet. Create your first collection to start searching files.
            </p>
            <Button variant="outline" size="sm" onClick={onCreateCollection} className="gap-2">
              <Plus className="h-4 w-4" />
              Create First Collection
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
