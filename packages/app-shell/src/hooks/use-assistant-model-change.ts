import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import type {
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
} from '@brainstrike/types';
import { useCallback } from 'react';
import type { AssistantThreadDraftRuntime } from '../assistant-thread-store';
import {
  buildDraftRuntimeForProvider,
  copyProviderSettingsMap,
  reconcileProviderSettingsForModel,
  resolveModelNameFromComposite,
  resolveProviderFromComposite,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantModelChangeOptions {
  readonly draftRuntimeByThreadId: Record<string, AssistantThreadDraftRuntime>;
  readonly memoryThreadId: string | undefined;
  readonly providerSettings: Record<string, AssistantProviderSettings>;
  readonly setModel: (compositeKey: string) => void;
  readonly setProviderSettings: (
    provider: SupportedProvider,
    updates: AssistantProviderSettingsUpdate
  ) => void;
  readonly setThreadDraftRuntime: (threadId: string, runtime: AssistantThreadDraftRuntime) => void;
}

export function useAssistantModelChange({
  draftRuntimeByThreadId,
  memoryThreadId,
  providerSettings,
  setModel,
  setProviderSettings,
  setThreadDraftRuntime,
}: UseAssistantModelChangeOptions): (compositeKey: string) => void {
  return useCallback(
    (compositeKey: string) => {
      const provider = resolveProviderFromComposite(compositeKey);
      const model = resolveModelNameFromComposite(compositeKey);
      if (memoryThreadId && provider && model) {
        setModel(compositeKey);
        const draftProviderSettings = draftRuntimeByThreadId[memoryThreadId]?.providerSettings;
        const providerSettingsMap =
          copyProviderSettingsMap(draftProviderSettings) ??
          (providerSettings[provider] ? { [provider]: { ...providerSettings[provider] } } : {});
        const currentSettings = providerSettingsMap[provider];
        const compatibleSettings = reconcileProviderSettingsForModel(
          provider,
          model,
          currentSettings
        );
        if (compatibleSettings !== currentSettings && compatibleSettings) {
          providerSettingsMap[provider] = compatibleSettings;
        }
        setThreadDraftRuntime(
          memoryThreadId,
          buildDraftRuntimeForProvider({ model, provider, providerSettingsMap })
        );
        return;
      }
      if (provider && model) {
        const currentSettings = providerSettings[provider];
        if (
          reconcileProviderSettingsForModel(provider, model, currentSettings) !== currentSettings
        ) {
          setProviderSettings(provider, { reasoningEffort: undefined });
        }
      }
      setModel(compositeKey);
    },
    [
      draftRuntimeByThreadId,
      memoryThreadId,
      providerSettings,
      setModel,
      setProviderSettings,
      setThreadDraftRuntime,
    ]
  );
}
