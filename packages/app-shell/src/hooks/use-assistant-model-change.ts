import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import type { AssistantThreadDraftRuntime } from '@brainstrike/assistant-data';
import type {
  AssistantProviderSettings,
  AssistantProviderSettingsUpdate,
} from '@brainstrike/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildDraftRuntimeForProvider,
  copyProviderSettingsMap,
  type FixedProviderModels,
  reconcileProviderSettingsForModel,
  resolveFixedProviderModelSelection,
  resolveModelNameFromComposite,
  resolveProviderFromComposite,
} from '../assistant-ui-panel-wrapper-runtime';

interface UseAssistantModelChangeOptions {
  readonly currentModel: string | null | undefined;
  readonly draftRuntimeByThreadId: Record<string, AssistantThreadDraftRuntime>;
  readonly fixedProviderModels: FixedProviderModels | undefined;
  readonly memoryThreadId: string | undefined;
  readonly providerSettings: Record<string, AssistantProviderSettings>;
  readonly setModel: (compositeKey: string) => void;
  readonly setProviderSettings: (
    provider: SupportedProvider,
    updates: AssistantProviderSettingsUpdate
  ) => void;
  readonly setThreadDraftRuntime: (threadId: string, runtime: AssistantThreadDraftRuntime) => void;
}

function buildReconciledProviderSettingsUpdate(
  currentSettings: AssistantProviderSettings | undefined,
  compatibleSettings: AssistantProviderSettings | undefined
): AssistantProviderSettingsUpdate | undefined {
  if (compatibleSettings === currentSettings) {
    return;
  }
  const updates: AssistantProviderSettingsUpdate = {};
  if (compatibleSettings?.reasoningEffort !== currentSettings?.reasoningEffort) {
    updates.reasoningEffort = undefined;
  }
  if (compatibleSettings?.maxOutputTokens !== currentSettings?.maxOutputTokens) {
    updates.maxOutputTokens = undefined;
  }
  if (compatibleSettings?.googleThinkingLevel !== currentSettings?.googleThinkingLevel) {
    updates.googleThinkingLevel = undefined;
  }
  if (compatibleSettings?.anthropicEffort !== currentSettings?.anthropicEffort) {
    updates.anthropicEffort = undefined;
  }
  if (compatibleSettings?.bedrockEffort !== currentSettings?.bedrockEffort) {
    updates.bedrockEffort = undefined;
  }
  return updates;
}

export function useAssistantModelChange({
  currentModel,
  draftRuntimeByThreadId,
  fixedProviderModels,
  memoryThreadId,
  providerSettings,
  setModel,
  setProviderSettings,
  setThreadDraftRuntime,
}: UseAssistantModelChangeOptions): {
  handleModelChange: (compositeKey: string) => void;
  providerDraft: {
    reason: string | undefined;
    report: (reason: string | undefined) => void;
  };
} {
  const [providerSettingsValidationReason, reportProviderSettingsValidation] = useState<string>();
  const handleModelChange = useCallback(
    (compositeKey: string) => {
      reportProviderSettingsValidation(undefined);
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
        const compatibleSettings = reconcileProviderSettingsForModel(
          provider,
          model,
          currentSettings
        );
        const updates = buildReconciledProviderSettingsUpdate(currentSettings, compatibleSettings);
        if (updates) {
          setProviderSettings(provider, updates);
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
  const reconciledFixedSelectionsRef = useRef(new Set<string>());
  useEffect(() => {
    const fixedModel = resolveFixedProviderModelSelection({
      currentModel,
      fixedProviderModels,
    });
    if (!fixedModel) {
      return;
    }
    const reconciliationKey = JSON.stringify([memoryThreadId, currentModel, fixedModel]);
    if (reconciledFixedSelectionsRef.current.has(reconciliationKey)) {
      return;
    }
    reconciledFixedSelectionsRef.current.add(reconciliationKey);
    reconciledFixedSelectionsRef.current.add(
      JSON.stringify([memoryThreadId, fixedModel, fixedModel])
    );
    handleModelChange(fixedModel);
  }, [currentModel, fixedProviderModels, handleModelChange, memoryThreadId]);
  return {
    handleModelChange,
    providerDraft: {
      reason: providerSettingsValidationReason,
      report: reportProviderSettingsValidation,
    },
  };
}
