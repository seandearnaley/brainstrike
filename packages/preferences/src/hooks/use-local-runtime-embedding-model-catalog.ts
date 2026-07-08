import type {
  LocalRuntimeId,
  LocalRuntimeModelCatalogState,
} from '@brainstrike/assistant-contract/local-runtime';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAssistantPreferencesStore } from '../stores/assistant-preferences-store';

type LocalRuntimeModelCatalogMap = Partial<Record<LocalRuntimeId, LocalRuntimeModelCatalogState>>;

export interface UseLocalRuntimeEmbeddingModelCatalogOptions {
  readonly enabled?: boolean;
  readonly maxVerificationModels?: number;
  readonly verifyEmbeddingDimensions?: boolean;
}

export interface UseLocalRuntimeEmbeddingModelCatalogResult {
  readonly catalog: LocalRuntimeModelCatalogMap | null;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly refresh: (options?: { force?: boolean }) => Promise<void>;
}

interface RuntimeCatalogRequestState {
  readonly catalog: LocalRuntimeModelCatalogMap | null;
  readonly error: string | null;
  readonly isLoading: boolean;
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
    error: null,
    isLoading: false,
  });

  const verifyEmbeddingDimensions = options.verifyEmbeddingDimensions ?? false;
  const maxVerificationModels = options.maxVerificationModels;
  const enabled = options.enabled ?? true;
  const modelCatalogOptions = useMemo(
    () => ({
      ...(verifyEmbeddingDimensions ? { verifyEmbeddingDimensions: true } : {}),
      ...(typeof maxVerificationModels === 'number' ? { maxVerificationModels } : {}),
    }),
    [maxVerificationModels, verifyEmbeddingDimensions]
  );

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
          diagnosticLogLevel: refreshOptions?.force ? 'warn' : 'debug',
          ...(refreshOptions?.force ? { force: true } : {}),
          ...modelCatalogOptions,
        });
        setRequestState({
          catalog: runtimeCatalog,
          error: null,
          isLoading: false,
        });
      } catch (cause) {
        setRequestState((previousState) => ({
          ...previousState,
          error: toErrorMessage(cause),
          isLoading: false,
        }));
      }
    },
    [enabled, getLocalRuntimeModels, modelCatalogOptions]
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return {
    catalog: requestState.catalog,
    error: requestState.error,
    isLoading: requestState.isLoading,
    refresh,
  };
}
