import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LOCAL_RUNTIME_PROVIDER_IDS,
  type LocalRuntimeModelCatalogMap,
  type LocalRuntimeStatusMap,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantLocalRuntimeCatalogArgs {
  readonly getLocalRuntimeModels: (options?: {
    readonly diagnosticLogLevel?: 'debug' | 'warn';
  }) => Promise<LocalRuntimeModelCatalogMap>;
  readonly getLocalRuntimeStatuses: (options?: {
    readonly diagnosticLogLevel?: 'debug' | 'warn';
  }) => Promise<LocalRuntimeStatusMap>;
  /**
   * Immutable settings snapshot whose identity changes when a runtime URL,
   * token, or activation setting changes.
   */
  readonly refreshKey: object;
}

interface UseAssistantLocalRuntimeCatalogResult {
  readonly localRuntimeHint: string | undefined;
  readonly localRuntimeModels: LocalRuntimeModelCatalogMap | null;
}

const labelByRuntime = {
  lmstudio: 'LM Studio',
  ollama: 'Ollama',
} as const;

async function loadLocalRuntimeStatuses(
  getLocalRuntimeStatuses: UseAssistantLocalRuntimeCatalogArgs['getLocalRuntimeStatuses']
): Promise<LocalRuntimeStatusMap | null> {
  try {
    return await getLocalRuntimeStatuses({ diagnosticLogLevel: 'debug' });
  } catch {
    return null;
  }
}

async function loadReachableRuntimeCatalog(
  statuses: LocalRuntimeStatusMap,
  getLocalRuntimeModels: UseAssistantLocalRuntimeCatalogArgs['getLocalRuntimeModels']
): Promise<LocalRuntimeModelCatalogMap | null> {
  const hasReachableRuntime = LOCAL_RUNTIME_PROVIDER_IDS.some((runtimeId) => {
    const state = statuses[runtimeId].state;
    return state === 'available' || state === 'stale';
  });
  if (!hasReachableRuntime) {
    return null;
  }
  try {
    return await getLocalRuntimeModels({ diagnosticLogLevel: 'debug' });
  } catch {
    return null;
  }
}

export function useAssistantLocalRuntimeCatalog({
  getLocalRuntimeModels,
  getLocalRuntimeStatuses,
  refreshKey,
}: UseAssistantLocalRuntimeCatalogArgs): UseAssistantLocalRuntimeCatalogResult {
  const [localRuntimeStatuses, setLocalRuntimeStatuses] = useState<LocalRuntimeStatusMap | null>(
    null
  );
  const [localRuntimeModels, setLocalRuntimeModels] = useState<LocalRuntimeModelCatalogMap | null>(
    null
  );
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const isCurrent = (): boolean => generation === requestGeneration.current;
    setLocalRuntimeStatuses({
      lmstudio: { state: 'checking' },
      ollama: { state: 'checking' },
    });
    setLocalRuntimeModels(null);

    const refresh = async (): Promise<void> => {
      const statuses = await loadLocalRuntimeStatuses(getLocalRuntimeStatuses);
      if (!isCurrent()) {
        return;
      }
      if (!statuses) {
        const fallback = {
          checkedAt: Date.now(),
          message: 'Local runtime probe failed',
          state: 'unavailable' as const,
        };
        setLocalRuntimeStatuses({
          lmstudio: fallback,
          ollama: fallback,
        });
        return;
      }
      setLocalRuntimeStatuses(statuses);

      const catalog = await loadReachableRuntimeCatalog(statuses, getLocalRuntimeModels);
      if (isCurrent()) {
        setLocalRuntimeModels(catalog);
      }
    };

    void refresh();

    return () => {
      if (isCurrent()) {
        requestGeneration.current += 1;
      }
    };
  }, [getLocalRuntimeModels, getLocalRuntimeStatuses, refreshKey]);

  const localRuntimeHint = useMemo(() => {
    if (!localRuntimeStatuses) {
      return;
    }

    const detected = LOCAL_RUNTIME_PROVIDER_IDS.filter((runtimeId) => {
      const status = localRuntimeStatuses[runtimeId];
      return status.state === 'available' || status.state === 'stale';
    }).map((runtimeId) => {
      const modelState = localRuntimeModels?.[runtimeId];
      if (modelState?.state === 'loaded_non_empty' || modelState?.state === 'stale_cached') {
        return `${labelByRuntime[runtimeId]} (${modelState.models.length} models)`;
      }
      if (modelState?.state === 'loaded_empty') {
        return `${labelByRuntime[runtimeId]} (no models)`;
      }
      if (modelState?.state === 'failed') {
        return `${labelByRuntime[runtimeId]} (model discovery failed: ${modelState.message})`;
      }
      return labelByRuntime[runtimeId];
    });

    if (detected.length > 0) {
      return `Detected local runtime: ${detected.join(' + ')} on localhost.`;
    }

    const blockedRuntime = LOCAL_RUNTIME_PROVIDER_IDS.find(
      (runtimeId) => localRuntimeStatuses[runtimeId].state === 'blocked_web'
    );
    if (blockedRuntime) {
      return `${labelByRuntime[blockedRuntime]} probe was blocked by browser networking policy.`;
    }

    const checking = LOCAL_RUNTIME_PROVIDER_IDS.some(
      (runtimeId) => localRuntimeStatuses[runtimeId].state === 'checking'
    );
    if (checking) {
      return 'Checking local runtime availability on localhost.';
    }
    return;
  }, [localRuntimeModels, localRuntimeStatuses]);

  return {
    localRuntimeHint,
    localRuntimeModels,
  };
}
