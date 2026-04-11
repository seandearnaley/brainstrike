import { LocalLlmBackend } from '@brainstrike/agent/local-llm';
import { hasEnabledLocalLlmModels } from '@brainstrike/preferences/models/local-model-utils';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useMemo } from 'react';
import {
  type AssistantAvailabilityStatus,
  type AssistantStatusFetcher,
  useAssistantAvailability,
} from './use-assistant-availability';

/**
 * Extended assistant availability hook that also considers local LLM models.
 *
 * This hook combines:
 * 1. Server-side status check (for hosted providers like OpenAI, Anthropic)
 * 2. Client-side model registry check (for local browser-based models)
 *
 * Returns 'enabled' if EITHER:
 * - Server reports enabled (hosted providers have API keys configured), OR
 * - Local LLM models are enabled in the database (browser-based inference)
 */
export function useAssistantAvailabilityWithLocal(
  fetcher?: AssistantStatusFetcher
): AssistantAvailabilityStatus {
  const serverStatus = useAssistantAvailability(fetcher);
  const { models, hasLoaded } = useModelRegistryStore();

  const hasLocalModels = useMemo(() => hasEnabledLocalLlmModels(models), [models]);
  const canRunLocalGemma = useMemo(() => LocalLlmBackend.getBestDevice() === 'webgpu', []);

  // If server says enabled, use that immediately (hosted providers work)
  if (serverStatus.state === 'enabled') {
    return serverStatus;
  }

  // If model registry has loaded and has local models, enable
  // This overrides a 'disabled' server status when browser-based models are available
  if (hasLoaded && hasLocalModels && canRunLocalGemma) {
    return { state: 'enabled' };
  }

  // If server is still loading, show loading
  if (serverStatus.state === 'loading') {
    return { state: 'loading' };
  }

  // Server is disabled and either no local models or not loaded yet
  // Show disabled status immediately - will reactively update if local models become available
  return serverStatus;
}
