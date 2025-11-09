import type { EmbeddingSet, EmbeddingSetsRepository } from '@brainstrike/db';
import {
  type EmbeddingProviderType,
  ModelRegistryManager,
  parseProviderModelKey,
  STANDARD_EMBEDDING_DIMENSION,
} from '@brainstrike/embeddings';
import { useEmbeddingPreferencesStore } from '@brainstrike/preferences';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import type { PGlite } from '@electric-sql/pglite';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CreateEmbeddingSetDialog } from './create-embedding-set-dialog';
import { DeleteEmbeddingSetDialog } from './delete-embedding-set-dialog';
import { formatRelativeTimeFromNow } from './format-utils';
import { RenameEmbeddingSetDialog } from './rename-embedding-set-dialog';

type EmbeddingSetWithStats = EmbeddingSet & {
  chunkCount: number;
  lastEmbeddedAt: string | null;
};

interface ManageEmbeddingSetsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  db: PGlite | null;
  repository: EmbeddingSetsRepository | null;
  onSetSelected?: (setId: string) => void;
}

// Helper function to map database row to EmbeddingSetWithStats
function mapRowToSet(row: {
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
  lastEmbeddedAt: string | null;
}): EmbeddingSetWithStats {
  const base = {
    id: String(row.id),
    modelKey: String(row.modelKey),
    modelId: String(row.modelId),
    dimensions: Number(row.dimensions),
    distance: String(row.distance) as EmbeddingSet['distance'],
    createdAt: String(row.createdAt),
    chunkCount: Number(row.chunkCount ?? 0),
    lastEmbeddedAt: row.lastEmbeddedAt ? String(row.lastEmbeddedAt) : null,
  };

  // Only add optional properties if they have values
  return {
    ...base,
    ...(row.name ? { name: String(row.name) } : {}),
    ...(row.description ? { description: String(row.description) } : {}),
    ...(row.tags ? { tags: String(row.tags) } : {}),
    ...(row.category ? { category: String(row.category) } : {}),
  };
}

// Helper function to format provider label
function formatProviderLabel(modelKey: string): string {
  const parsed = parseProviderModelKey(modelKey);
  if (!parsed || parsed.provider === 'local') {
    return 'Local';
  }
  return parsed.provider.charAt(0).toUpperCase() + parsed.provider.slice(1);
}

// Helper function to create a model object from registry config
function createModelFromConfig(
  provider: EmbeddingProviderType,
  modelId: string,
  modelRegistry: Record<string, unknown>
): {
  modelKey: string;
  modelId: string;
  dimensions: number;
  distance: 'cosine' | 'l2' | 'ip';
  provider: string;
  description?: string;
  tags?: string[];
  pricePer1MTokens?: number;
  origin?: string;
} {
  const modelKey = provider === 'local' ? modelId : `${provider}::${modelId}`;
  const modelConfig = modelRegistry[modelKey] as
    | {
        dimensions?: number;
        description?: string;
        tags?: string[];
        pricePer1MTokens?: number;
        origin?: string;
      }
    | undefined;

  const dimensions = modelConfig?.dimensions ?? STANDARD_EMBEDDING_DIMENSION;

  const model: {
    modelKey: string;
    modelId: string;
    dimensions: number;
    distance: 'cosine' | 'l2' | 'ip';
    provider: string;
    description?: string;
    tags?: string[];
    pricePer1MTokens?: number;
    origin?: string;
  } = {
    modelKey,
    modelId,
    dimensions,
    distance: 'cosine',
    provider: formatProviderLabel(modelKey),
  };

  if (modelConfig?.description) model.description = modelConfig.description;
  if (modelConfig?.tags) model.tags = modelConfig.tags;
  if (modelConfig?.pricePer1MTokens !== undefined)
    model.pricePer1MTokens = modelConfig.pricePer1MTokens;
  if (modelConfig?.origin) model.origin = modelConfig.origin;

  return model;
}

export function ManageEmbeddingSetsDialog({
  open,
  onOpenChange,
  db,
  repository,
  onSetSelected,
}: ManageEmbeddingSetsDialogProps) {
  const [sets, setSets] = useState<EmbeddingSetWithStats[]>([]);
  const [loading, setLoading] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedSet, setSelectedSet] = useState<EmbeddingSetWithStats | null>(null);

  // Get enabled models from preferences
  const { enabledModelsByProvider } = useEmbeddingPreferencesStore();

  const loadSets = useCallback(async () => {
    if (!db) return;

    setLoading(true);
    try {
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
        lastEmbeddedAt: string | null;
      }>(
        `SELECT s.id,
                s.model_key AS "modelKey",
                s.model_id AS "modelId",
                s.dimensions,
                s.distance,
                s.created_at AS "createdAt",
                s.name,
                s.description,
                s.tags,
                s.category,
                COUNT(c.id) AS "chunkCount",
                MAX(c.updated_at) AS "lastEmbeddedAt"
           FROM embedding_sets s
           LEFT JOIN file_chunks c ON c.embedding_set_id = s.id
       GROUP BY s.id, s.model_key, s.model_id, s.dimensions, s.distance, s.created_at, s.name, s.description, s.tags, s.category
       ORDER BY s.created_at DESC`
      );

      const mapped: EmbeddingSetWithStats[] = result.rows.map(mapRowToSet);

      setSets(mapped);
    } catch (error) {
      console.error('[ManageEmbeddingSetsDialog] Failed to load sets:', error);
    } finally {
      setLoading(false);
    }
  }, [db]);

  useEffect(() => {
    if (open) {
      void loadSets();
    }
  }, [open, loadSets]);

  const handleCreateSet = () => {
    setCreateDialogOpen(true);
  };

  const handleEditSet = (set: EmbeddingSetWithStats) => {
    setSelectedSet(set);
    setRenameDialogOpen(true);
  };

  const handleDeleteSet = (set: EmbeddingSetWithStats) => {
    setSelectedSet(set);
    setDeleteDialogOpen(true);
  };

  const handleSetAction = async (newSetId?: string) => {
    await loadSets();
    setSelectedSet(null);
    // Auto-select newly created collection
    if (newSetId && onSetSelected) {
      onSetSelected(newSetId);
    }
  };

  // Get available models from preferences and model registry
  const availableModels = useMemo(() => {
    const models: Array<{
      modelKey: string;
      modelId: string;
      dimensions: number;
      distance: 'cosine' | 'l2' | 'ip';
      provider: string;
      description?: string;
      tags?: string[];
      pricePer1MTokens?: number;
      origin?: string;
    }> = [];

    const modelRegistry = ModelRegistryManager.listModels();

    // Iterate through each provider's enabled models
    (Object.keys(enabledModelsByProvider) as EmbeddingProviderType[]).forEach((provider) => {
      const enabledModels = enabledModelsByProvider[provider] ?? [];

      enabledModels.forEach((modelId) => {
        const model = createModelFromConfig(provider, modelId, modelRegistry);
        models.push(model);
      });
    });

    return models;
  }, [enabledModelsByProvider]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[700px] max-h-[80vh] flex flex-col">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>Manage Search Collections</DialogTitle>
                <DialogDescription>
                  Create, edit, and manage your search collections. Each collection represents a
                  unique vector repository.
                </DialogDescription>
              </div>
              <Button onClick={handleCreateSet} size="sm" className="gap-2">
                <Plus className="h-4 w-4" />
                New Collection
              </Button>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-auto py-4">
            {loading ? (
              <div className="text-center py-8 text-sm text-muted-foreground">Loading sets...</div>
            ) : sets.length === 0 ? (
              <div className="text-center py-8 border rounded-lg border-dashed">
                <div className="text-sm text-muted-foreground mb-4">
                  No collections yet. Create your first collection to get started.
                </div>
                <Button onClick={handleCreateSet} variant="outline" size="sm" className="gap-2">
                  <Plus className="h-4 w-4" />
                  Create First Collection
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {sets.map((set) => (
                  <div
                    key={set.id}
                    className="border rounded-lg p-4 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0 space-y-2">
                        <div>
                          <div className="font-medium text-sm flex items-center gap-2">
                            {set.name ?? set.modelId}
                            <Badge variant="outline" className="text-[10px] font-normal">
                              {formatProviderLabel(set.modelKey)}
                            </Badge>
                          </div>
                          {set.description && (
                            <div className="text-xs text-muted-foreground mt-1">
                              {set.description}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-wrap gap-3 text-xs">
                          <div>
                            <span className="text-muted-foreground">Model:</span>{' '}
                            <span className="font-medium">{set.modelId}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Dimensions:</span>{' '}
                            <span className="font-medium">{set.dimensions}D</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Distance:</span>{' '}
                            <span className="font-medium">{set.distance}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Chunks:</span>{' '}
                            <span className="font-medium">{set.chunkCount.toLocaleString()}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Updated:</span>{' '}
                            <span className="font-medium">
                              {formatRelativeTimeFromNow(set.lastEmbeddedAt)}
                            </span>
                          </div>
                        </div>

                        {set.tags && (
                          <div className="flex flex-wrap gap-1">
                            {set.tags.split(',').map((tag) => {
                              const trimmedTag = tag.trim();
                              return (
                                <Badge
                                  key={trimmedTag}
                                  variant="secondary"
                                  className="text-[10px] py-0"
                                >
                                  {trimmedTag}
                                </Badge>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="flex gap-1 flex-shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => handleEditSet(set)}
                          title="Edit metadata"
                        >
                          <Pencil className="h-4 w-4" />
                          <span className="sr-only">Edit</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleDeleteSet(set)}
                          title="Delete set"
                        >
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">Delete</span>
                        </Button>
                      </div>
                    </div>

                    {onSetSelected && (
                      <div className="mt-3 pt-3 border-t">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            onSetSelected(set.id);
                            onOpenChange(false);
                          }}
                          className="w-full"
                        >
                          Set as Active
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <CreateEmbeddingSetDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        repository={repository}
        availableModels={availableModels}
        onSetCreated={handleSetAction}
      />

      <RenameEmbeddingSetDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        repository={repository}
        embeddingSet={selectedSet}
        onSetRenamed={handleSetAction}
      />

      <DeleteEmbeddingSetDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        db={db}
        embeddingSet={selectedSet}
        onSetDeleted={handleSetAction}
      />
    </>
  );
}
