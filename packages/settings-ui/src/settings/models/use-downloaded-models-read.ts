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
 * latest read applies. A failed read leaves no model marked downloaded, and
 * says why in the log.
 */
export function useDownloadedModelsRead(): void {
  const hasLoaded = useModelRegistryStore((state) => state.hasLoaded);
  const models = useModelRegistryStore((state) => state.models);
  const setDownloadedModels = useModelRegistryStore((state) => state.setDownloadedModels);
  const local = useMemo(() => decodeLocalEmbeddingModels(models), [models]);

  useEffect(() => {
    if (!hasLoaded || local.length === 0) {
      return;
    }
    let current = true;
    void (async () => {
      try {
        const downloaded = await getModelRuntimeServices().readDownloadedEmbeddingModels(local);
        if (current) {
          setDownloadedModels(downloaded);
        }
      } catch (error) {
        logger.warn('Could not read which on-device models are downloaded', { error });
      }
    })();
    return () => {
      current = false;
    };
  }, [hasLoaded, local, setDownloadedModels]);
}
