import { useEffect, useMemo, useState } from 'react';
import {
  LOCAL_RUNTIME_PROVIDER_IDS,
  type LocalRuntimeModelCatalogMap,
  type LocalRuntimeStatusMap,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantLocalRuntimeCatalogArgs {
  readonly getLocalRuntimeModels: () => Promise<LocalRuntimeModelCatalogMap>;
  readonly getLocalRuntimeStatuses: () => Promise<LocalRuntimeStatusMap>;
}

interface UseAssistantLocalRuntimeCatalogResult {
  readonly localRuntimeHint: string | undefined;
  readonly localRuntimeModels: LocalRuntimeModelCatalogMap | null;
}

const labelByRuntime = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
} as const;

export function useAssistantLocalRuntimeCatalog({
  getLocalRuntimeModels,
  getLocalRuntimeStatuses,
}: UseAssistantLocalRuntimeCatalogArgs): UseAssistantLocalRuntimeCatalogResult {
  const [localRuntimeStatuses, setLocalRuntimeStatuses] = useState<LocalRuntimeStatusMap | null>(
    null
  );
  const [localRuntimeModels, setLocalRuntimeModels] = useState<LocalRuntimeModelCatalogMap | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    setLocalRuntimeStatuses({
      ollama: { state: 'checking' },
      lmstudio: { state: 'checking' },
    });

    void getLocalRuntimeStatuses()
      .then((statuses) => {
        if (!cancelled) {
          setLocalRuntimeStatuses(statuses);
        }
      })
      .catch(() => {
        if (!cancelled) {
          const fallback = {
            state: 'unavailable' as const,
            checkedAt: Date.now(),
            message: 'Local runtime probe failed',
          };
          setLocalRuntimeStatuses({
            ollama: fallback,
            lmstudio: fallback,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [getLocalRuntimeStatuses]);

  useEffect(() => {
    if (!localRuntimeStatuses) {
      return;
    }
    const isCheckingStatuses = LOCAL_RUNTIME_PROVIDER_IDS.some(
      (runtimeId) => localRuntimeStatuses[runtimeId].state === 'checking'
    );
    if (isCheckingStatuses) {
      return;
    }
    const hasReachableRuntime = LOCAL_RUNTIME_PROVIDER_IDS.some((runtimeId) => {
      const state = localRuntimeStatuses[runtimeId].state;
      return state === 'available' || state === 'stale';
    });
    if (!hasReachableRuntime) {
      setLocalRuntimeModels(null);
      return;
    }

    let cancelled = false;

    void getLocalRuntimeModels()
      .then((catalog) => {
        if (!cancelled) {
          setLocalRuntimeModels(catalog);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocalRuntimeModels(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [getLocalRuntimeModels, localRuntimeStatuses]);

  const localRuntimeHint = useMemo(() => {
    if (!localRuntimeStatuses) {
      return;
    }

    const detected = (Object.keys(labelByRuntime) as Array<keyof typeof labelByRuntime>)
      .filter((runtimeId) => {
        const status = localRuntimeStatuses[runtimeId];
        return status.state === 'available' || status.state === 'stale';
      })
      .map((runtimeId) => {
        const modelState = localRuntimeModels?.[runtimeId];
        if (modelState?.state === 'loaded_non_empty' || modelState?.state === 'stale_cached') {
          return `${labelByRuntime[runtimeId]} (${modelState.models.length} models)`;
        }
        if (modelState?.state === 'loaded_empty') {
          return `${labelByRuntime[runtimeId]} (no models)`;
        }
        return labelByRuntime[runtimeId];
      });

    if (detected.length > 0) {
      return `Detected local runtime: ${detected.join(' + ')} on localhost.`;
    }

    const blockedRuntime = (Object.keys(labelByRuntime) as Array<keyof typeof labelByRuntime>).find(
      (runtimeId) => localRuntimeStatuses[runtimeId].state === 'blocked_web'
    );
    if (blockedRuntime) {
      return `${labelByRuntime[blockedRuntime]} probe was blocked by browser networking policy.`;
    }

    const checking = (Object.keys(labelByRuntime) as Array<keyof typeof labelByRuntime>).some(
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
