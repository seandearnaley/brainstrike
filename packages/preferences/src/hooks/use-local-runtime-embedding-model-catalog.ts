import type { LocalRuntimeId, LocalRuntimeModelCatalogState } from '@brainstrike/agent/client';
import { useCallback, useEffect, useState } from 'react';
import { useAssistantPreferencesStore } from '../stores/assistant-preferences-store';

type LocalRuntimeModelCatalogMap = Record<LocalRuntimeId, LocalRuntimeModelCatalogState>;

export interface UseLocalRuntimeEmbeddingModelCatalogOptions {
  readonly verifyEmbeddingDimensions?: boolean;
  readonly maxVerificationModels?: number;
  readonly enabled?: boolean;
}

export interface UseLocalRuntimeEmbeddingModelCatalogResult {
  readonly catalog: LocalRuntimeModelCatalogMap | null;
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly refresh: (options?: { force?: boolean }) => Promise<void>;
}

interface RuntimeCatalogRequestState {
  readonly catalog: LocalRuntimeModelCatalogMap | null;
  readonly isLoading: boolean;
  readonly error: string | null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function useLocalRuntimeEmbeddingModelCatalog(
  options: UseLocalRuntimeEmbeddingModelCatalogOptions = {}
): UseLocalRuntimeEmbeddingModelCatalogResult {
  const getLocalRuntimeModels = useAssistantPreferencesStore(
    (state) => state.getLocalRuntimeModels
  );
  const [requestState, setRequestState] = useState<RuntimeCatalogRequestState>({
    catalog: null,
    isLoading: false,
    error: null,
  });

  const verifyEmbeddingDimensions = options.verifyEmbeddingDimensions ?? false;
  const maxVerificationModels = options.maxVerificationModels;
  const enabled = options.enabled ?? true;

  const refresh = useCallback(
    async (refreshOptions?: { force?: boolean }) => {
      if (!enabled) {
        return;
      }

      setRequestState((previousState) => ({
        ...previousState,
        isLoading: true,
      }));
      try {
        const runtimeCatalog = await getLocalRuntimeModels({
          ...(refreshOptions?.force ? { force: true } : {}),
          ...(verifyEmbeddingDimensions ? { verifyEmbeddingDimensions: true } : {}),
          ...(typeof maxVerificationModels === 'number' ? { maxVerificationModels } : {}),
        });
        setRequestState({
          catalog: runtimeCatalog,
          isLoading: false,
          error: null,
        });
      } catch (cause) {
        setRequestState((previousState) => ({
          ...previousState,
          isLoading: false,
          error: toErrorMessage(cause),
        }));
      }
    },
    [enabled, getLocalRuntimeModels, maxVerificationModels, verifyEmbeddingDimensions]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return {
    catalog: requestState.catalog,
    isLoading: requestState.isLoading,
    error: requestState.error,
    refresh,
  };
}
