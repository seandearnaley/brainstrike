import { isLocalModelProviderId } from '@brainstrike/app-state/models/local-model-utils';
import {
  type DbModel,
  useModelRegistryStore,
} from '@brainstrike/app-state/stores/model-registry-store';
import {
  type CatalogEmbeddingModel,
  decodeCatalogEmbeddingModel,
} from '@brainstrike/indexing-contract';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useMemo } from 'react';
import { getModelRuntimeServices } from './model-runtime-services';

const logger = createLogger('DownloadedModelsRead');

/** The catalog's on-device embedding rows, decoded; a malformed row is logged and skipped. */
export function decodeLocalEmbeddingModels(
  models: readonly DbModel[]
): readonly CatalogEmbeddingModel[] {
  return models.flatMap((model) => {
    if (!isLocalModelProviderId(model.providerId) || model.capabilities?.type !== 'embedding') {
      return [];
    }
    try {
      return [
        decodeCatalogEmbeddingModel({
          capabilities: model.capabilities,
          id: model.id,
          parameters: model.parameters,
        }),
      ];
    } catch (error) {
      logger.warn('Skipping a malformed on-device catalog row', { error, modelId: model.id });
      return [];
    }
  });
}

/**
 * BST-2241: which on-device models are downloaded, read from the embedding
 * realm's model cache whenever the catalog's local models change. Only the
 * latest read applies, and it keeps downloads completed while it ran. A
 * failed read leaves no earlier answer standing, and says why in the log.
 */
export function useDownloadedModelsRead(): void {
  const hasLoaded = useModelRegistryStore((state) => state.hasLoaded);
  const models = useModelRegistryStore((state) => state.models);
  const applyDownloadedModelsRead = useModelRegistryStore(
    (state) => state.applyDownloadedModelsRead
  );
  const local = useMemo(() => decodeLocalEmbeddingModels(models), [models]);

  useEffect(() => {
    if (!hasLoaded || local.length === 0) {
      return;
    }
    let current = true;
    // Downloads that complete while this read runs are kept when it applies.
    const readStartedAt = useModelRegistryStore.getState().downloadSequence;
    void (async () => {
      let downloaded: readonly string[] = [];
      try {
        downloaded = await getModelRuntimeServices().readDownloadedEmbeddingModels(local);
      } catch (error) {
        // The realm cannot tell now, so no earlier answer stands either.
        logger.warn('Could not read which on-device models are downloaded', { error });
      }
      if (current) {
        applyDownloadedModelsRead(downloaded, readStartedAt);
      }
    })();
    return () => {
      current = false;
    };
  }, [applyDownloadedModelsRead, hasLoaded, local]);
}
