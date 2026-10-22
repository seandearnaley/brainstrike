import { useLocalRuntimeEmbeddingModelCatalog } from '@brainstrike/app-state/hooks/use-local-runtime-embedding-model-catalog';
import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import type { EmbeddingSet } from '@brainstrike/db';
import type { useEmbeddingSetsRepository } from '@brainstrike/db/react';
import { CreateEmbeddingSetDialog } from '@brainstrike/vector-management';
import type { ReactElement } from 'react';
import { useAvailableModels, useAvailableProviders } from '../hooks/use-available-models';

export interface CreateCollectionDialogProps {
  readonly onClose: () => void;
  readonly onCreated: (newSetId: string, newSet: EmbeddingSet) => void;
  readonly repository: ReturnType<typeof useEmbeddingSetsRepository>;
}

/**
 * Create-collection dialog wired to the model registry and the local runtime
 * embedding catalog. Mount it only while the dialog is open — it resolves the
 * registry and verifies runtime embedding dimensions on mount.
 */
export function CreateCollectionDialog({
  onClose,
  onCreated,
  repository,
}: CreateCollectionDialogProps): ReactElement {
  const models = useModelRegistryStore((state) => state.models);
  const providers = useModelRegistryStore((state) => state.providers);
  const isRegistryLoading = useModelRegistryStore((state) => state.isLoading);
  useEnsureModelRegistry();
  const { catalog: runtimeEmbeddingCatalog, isLoading: isRuntimeCatalogLoading } =
    useLocalRuntimeEmbeddingModelCatalog({
      maxVerificationModels: 8,
      verifyEmbeddingDimensions: true,
    });
  const availableModels = useAvailableModels(models, runtimeEmbeddingCatalog);
  const availableProviders = useAvailableProviders(providers, runtimeEmbeddingCatalog);

  return (
    <CreateEmbeddingSetDialog
      isLoading={isRegistryLoading || isRuntimeCatalogLoading}
      models={availableModels}
      onOpenChange={(open: boolean) => {
        if (!open) {
          onClose();
        }
      }}
      onSetCreated={onCreated}
      open
      providers={availableProviders}
      repository={repository}
    />
  );
}
