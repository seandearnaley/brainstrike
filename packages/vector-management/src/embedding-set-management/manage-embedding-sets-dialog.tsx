import type { EmbeddingSet, IEmbeddingSetsRepository } from '@brainstrike/db';
import { type EmbeddingProviderType, parseProviderModelKey } from '@brainstrike/embeddings';
import { type DbModel, useModelRegistryStore } from '@brainstrike/preferences';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  type ModelPickerModel,
  type ModelPickerProvider,
} from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
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
  repository: IEmbeddingSetsRepository | null;
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

/**
 * Convert a database model to ModelPickerModel format.
 * Single source of truth: database models table.
 */
function dbModelToPickerModel(dbModel: DbModel): ModelPickerModel {
  const providerId = dbModel.providerId as EmbeddingProviderType;
  // For local models, the modelKey IS the model ID (HuggingFace format)
  // For hosted models, use provider::modelId format
  const isLocal = providerId === 'local' || providerId === 'transformers';
  const modelKey = isLocal ? dbModel.id : `${providerId}::${dbModel.id}`;

  return {
    id: modelKey,
    providerId: isLocal ? 'local' : providerId,
    name: dbModel.name ?? dbModel.id,
    description: dbModel.description ?? dbModel.tagline ?? null,
    capabilities: {
      type: 'embedding',
      defaultDimension: dbModel.capabilities.defaultDimension ?? 768,
    },
  };
}

const logger = createLogger('ManageEmbeddingSetsDialog');

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

  // Get all models from database - single source of truth
  const dbModels = useModelRegistryStore((state) => state.models);
  const ensureRegistry = useModelRegistryStore((state) => state.ensureRegistry);

  // Load models from database when dialog opens
  // biome-ignore lint/plugin: Load registry when dialog opens - ensureRegistry is stable from zustand
  useEffect(() => {
    if (open && db) {
      void ensureRegistry(db);
    }
  }, [open, db, ensureRegistry]);

  const loadSets = useCallback(async () => {
    if (!db) {
      return;
    }

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
      logger.error('Failed to load embedding sets', { error });
    } finally {
      setLoading(false);
    }
  }, [db]);

  // biome-ignore lint/plugin: Load sets when dialog opens - standard modal data loading
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

  // Build available models from database
  // Single source of truth: database models table (is_enabled column)
  const availableModels = useMemo(() => {
    const embeddingModels = dbModels.filter((m) => m.capabilities.type === 'embedding');
    const enabledModels = embeddingModels.filter((m) => m.isEnabled);
    const pickerModels = enabledModels.map(dbModelToPickerModel);
    return pickerModels;
  }, [dbModels]);

  const providers = useMemo((): ModelPickerProvider[] => {
    const uniqueProviders = Array.from(new Set(availableModels.map((m) => m.providerId)));
    return uniqueProviders.map((p) => ({
      id: p,
      name: p.charAt(0).toUpperCase() + p.slice(1),
    }));
  }, [availableModels]);

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent className="flex max-h-[80vh] flex-col sm:max-w-[700px]">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <div>
                <DialogTitle>Manage Search Collections</DialogTitle>
                <DialogDescription>
                  Create, edit, and manage your search collections. Each collection represents a
                  unique vector repository.
                </DialogDescription>
              </div>
              <Button className="gap-2" onClick={handleCreateSet} size="sm">
                <Plus className="h-4 w-4" />
                New Collection
              </Button>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-auto py-4">
            {loading ? (
              <div className="py-8 text-center text-muted-foreground text-sm">Loading sets...</div>
            ) : sets.length === 0 ? (
              <div className="rounded-lg border border-dashed py-8 text-center">
                <div className="mb-4 text-muted-foreground text-sm">
                  No collections yet. Create your first collection to get started.
                </div>
                <Button className="gap-2" onClick={handleCreateSet} size="sm" variant="outline">
                  <Plus className="h-4 w-4" />
                  Create First Collection
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                {sets.map((set) => (
                  <div
                    className="rounded-lg border p-4 transition-colors hover:bg-muted/50"
                    key={set.id}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div>
                          <div className="flex items-center gap-2 font-medium text-sm">
                            {set.name ?? set.modelId}
                            <Badge className="font-normal text-[10px]" variant="outline">
                              {formatProviderLabel(set.modelKey)}
                            </Badge>
                          </div>
                          {set.description && (
                            <div className="mt-1 text-muted-foreground text-xs">
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
                                  className="py-0 text-[10px]"
                                  key={trimmedTag}
                                  variant="secondary"
                                >
                                  {trimmedTag}
                                </Badge>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-shrink-0 gap-1">
                        <Button
                          className="h-8 w-8 p-0"
                          onClick={() => handleEditSet(set)}
                          size="sm"
                          title="Edit metadata"
                          variant="ghost"
                        >
                          <Pencil className="h-4 w-4" />
                          <span className="sr-only">Edit</span>
                        </Button>
                        <Button
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => handleDeleteSet(set)}
                          size="sm"
                          title="Delete set"
                          variant="ghost"
                        >
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">Delete</span>
                        </Button>
                      </div>
                    </div>

                    {onSetSelected && (
                      <div className="mt-3 border-t pt-3">
                        <Button
                          className="w-full"
                          onClick={() => {
                            onSetSelected(set.id);
                            onOpenChange(false);
                          }}
                          size="sm"
                          variant="outline"
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
        models={availableModels}
        onOpenChange={setCreateDialogOpen}
        onSetCreated={handleSetAction}
        open={createDialogOpen}
        providers={providers}
        repository={repository}
      />

      <RenameEmbeddingSetDialog
        embeddingSet={selectedSet}
        onOpenChange={setRenameDialogOpen}
        onSetRenamed={handleSetAction}
        open={renameDialogOpen}
        repository={repository}
      />

      <DeleteEmbeddingSetDialog
        db={db}
        embeddingSet={selectedSet}
        onOpenChange={setDeleteDialogOpen}
        onSetDeleted={handleSetAction}
        open={deleteDialogOpen}
      />
    </>
  );
}
