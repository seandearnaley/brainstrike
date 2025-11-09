import type { EmbeddingSet, usePGliteDatabase } from '@brainstrike/db';
import { usePGliteLiveQuery } from '@brainstrike/db';
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
  useToast,
} from '@brainstrike/ui';
import { HelpCircle, Plus, Settings2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';

type EmbeddingSetWithDocumentCount = EmbeddingSet & {
  documentCount: number;
};

type CollectionRow = {
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
  documentCount: string | number;
};

/**
 * SQL query to fetch all embedding sets with their chunk counts
 *
 * This query:
 * - Joins embedding_sets with file_chunks to count documents per collection
 * - Uses LEFT JOIN to include collections with zero chunks
 * - Lists all non-aggregated columns explicitly in GROUP BY (required for strict SQL mode)
 * - Orders by creation date (newest first)
 *
 * @returns SQL query string for fetching collections with metadata
 */
const COLLECTIONS_WITH_COUNTS_QUERY = `
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
    COUNT(DISTINCT fr.id) AS "documentCount"
  FROM embedding_sets s
  LEFT JOIN file_records fr ON fr.embedding_set_id = s.id
  GROUP BY s.id, s.model_key, s.model_id, s.dimensions, s.distance, s.created_at, s.name, s.description, s.tags, s.category
  ORDER BY s.created_at DESC
`.trim();

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
  const { toast } = useToast();
  const lastToastErrorRef = useRef<string | null>(null);

  const {
    rows: rawCollections,
    loading: liveLoading,
    error: liveError,
  } = usePGliteLiveQuery<CollectionRow>({
    query: COLLECTIONS_WITH_COUNTS_QUERY,
    enabled: Boolean(db),
  });

  const collections = useMemo<EmbeddingSetWithDocumentCount[]>(() => {
    return rawCollections.map((row) => {
      const set: EmbeddingSetWithDocumentCount = {
        id: row.id,
        modelKey: row.modelKey,
        modelId: row.modelId,
        dimensions: row.dimensions,
        distance: row.distance as 'cosine' | 'l2' | 'ip',
        createdAt: row.createdAt,
        documentCount: Number(row.documentCount ?? 0),
      };

      if (row.name) set.name = row.name;
      if (row.description) set.description = row.description;
      if (row.tags) set.tags = row.tags;
      if (row.category) set.category = row.category;

      return set;
    });
  }, [rawCollections]);

  useEffect(() => {
    if (!liveError) {
      lastToastErrorRef.current = null;
      return;
    }
    const message =
      liveError instanceof Error
        ? liveError.message
        : 'Unable to retrieve collections from database';
    if (lastToastErrorRef.current === message) {
      return;
    }
    lastToastErrorRef.current = message;
    toast({
      title: 'Failed to Load Collections',
      description: message,
      variant: 'destructive',
    });
  }, [liveError, toast]);

  const loading = liveLoading || !db;

  // Find active collection
  const activeCollection = useMemo(
    () => collections.find((c) => c.id === activeCollectionId) ?? null,
    [collections, activeCollectionId]
  );

  // Format collection label with stats
  const formatCollectionLabel = useCallback((collection: EmbeddingSetWithDocumentCount) => {
    const name = collection.name || collection.modelId;
    const count = collection.documentCount ?? 0;
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
            <div>{activeCollection.documentCount.toLocaleString()} documents</div>
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
