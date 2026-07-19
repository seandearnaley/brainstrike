import type { SupportedProvider } from '@brainstrike/assistant-contract';
import { useCallback } from 'react';
import type { AssistantThreadDraftRuntime } from '../assistant-thread-store';
import {
  type LlmProviderModelDefinition,
  resolveProviderModelSelection,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseProviderModelSelectorOptions {
  enabledBuiltInLocalModelIds: readonly string[];
  getProviderLlmModels: (provider: SupportedProvider) => readonly LlmProviderModelDefinition[];
  isModelEnabled: (providerId: SupportedProvider, modelId: string) => boolean;
  memoryThreadId: string | undefined;
  selectedThreadDraftRuntime: AssistantThreadDraftRuntime | undefined;
  setModel: (model: string) => void;
  setThreadDraftRuntime: (threadId: string, config: AssistantThreadDraftRuntime) => void;
}

export function useProviderModelSelector(
  options: UseProviderModelSelectorOptions
): (provider: SupportedProvider) => void {
  const {
    enabledBuiltInLocalModelIds,
    getProviderLlmModels,
    isModelEnabled,
    memoryThreadId,
    selectedThreadDraftRuntime,
    setModel,
    setThreadDraftRuntime,
  } = options;
  return useCallback(
    (provider: SupportedProvider): void => {
      const model =
        resolveProviderModelSelection({
          getProviderLlmModels,
          isModelEnabled,
          provider,
        }) ?? (provider === 'local' ? enabledBuiltInLocalModelIds[0] : undefined);
      if (!model) {
        return;
      }
      setModel(`${provider}::${model}`);
      if (!(memoryThreadId && selectedThreadDraftRuntime)) {
        return;
      }
      setThreadDraftRuntime(memoryThreadId, {
        ...selectedThreadDraftRuntime,
        model,
        provider,
      });
    },
    [
      enabledBuiltInLocalModelIds,
      getProviderLlmModels,
      isModelEnabled,
      memoryThreadId,
      selectedThreadDraftRuntime,
      setModel,
      setThreadDraftRuntime,
    ]
  );
}
