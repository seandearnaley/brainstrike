import {
  buildDraftRuntimeForProvider,
  buildModelSettings,
  buildProviderOptionsWhenReady,
  getRuntimeProviderLlmModels,
  type LlmProviderModelDefinition,
  toRuntimeProviderModels,
  useAssistantLocalRuntimeCatalog,
  useAssistantModelChange,
  useAssistantModelPickerConfig,
  useAssistantSlashCommands,
  useComposerDraftChannel,
  useConfiguredAssistantProviders,
  useEnableModel,
  useFileMentions,
  useOpenRouterModelMetadata,
} from '@brainstrike/app-shell';
import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { isSupportedProvider, type SupportedProvider } from '@brainstrike/assistant-contract';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import type { CommittedAssistantConversationProps } from '@brainstrike/assistant-ui';
import {
  type AssistantProviderSettingsUpdate,
  mergeAssistantProviderSettings,
} from '@brainstrike/types';
import { useCallback, useMemo, useState } from 'react';
import { readDesktopHostConfiguration } from './desktop-host-configuration';

type Presentation = Pick<
  CommittedAssistantConversationProps,
  | 'onEnableModel'
  | 'onModelChange'
  | 'onProviderSettingsChange'
  | 'onProviderSettingsValidationChange'
  | 'pickerModels'
  | 'providerGroups'
  | 'providerSettings'
  | 'recentModels'
  | 'selectedModel'
  | 'selectedProvider'
  | 'contextWindow'
  | 'composerDraftCommand'
  | 'onComposerDraftCommandApplied'
  | 'onComposerTextChange'
  | 'fileMentions'
  | 'onFileMentionQueryChange'
  | 'slashCommands'
  | 'isComposerDisabled'
  | 'disabledReason'
  | 'openRouterModelMetadataLookup'
  | 'effectiveInputBudget'
>;

interface DesktopHostPresentation extends Presentation {
  readConfiguration(selectionFolderId: string | null): Record<string, unknown>;
}

/** Existing picker/settings owners project controls; they own no assistant execution. */
export function useDesktopHostPresentation(threadId: string): DesktopHostPresentation {
  useEnsureModelRegistry();
  const composerDraft = useComposerDraftChannel(threadId);
  const slashCommands = useAssistantSlashCommands(threadId);
  const [fileMentionQuery, setFileMentionQuery] = useState('');
  const { fileMentions } = useFileMentions(fileMentionQuery);
  const globalModel = useAssistantPreferencesStore((state) => state.selectedModel);
  const providerSettings = useAssistantPreferencesStore((state) => state.providerSettings);
  const setModel = useAssistantPreferencesStore((state) => state.setModel);
  const setProviderSettings = useAssistantPreferencesStore((state) => state.setProviderSettings);
  const recentModels = useAssistantPreferencesStore((state) => state.recentModels);
  const getLocalRuntimeModels = useAssistantPreferencesStore(
    (state) => state.getLocalRuntimeModels
  );
  const getLocalRuntimeStatuses = useAssistantPreferencesStore(
    (state) => state.getLocalRuntimeStatuses
  );
  const drafts = useAssistantThreadStore((state) => state.draftRuntimeByThreadId);
  const setThreadDraftRuntime = useAssistantThreadStore((state) => state.setThreadDraftRuntime);
  const registry = useModelRegistryStore((state) => state.models);
  const downloaded = useModelRegistryStore((state) => state.downloadedModels);
  const draft = drafts[threadId];
  const selectedModel =
    draft?.model && draft.provider ? `${draft.provider}::${draft.model}` : globalModel;
  const providerId = selectedModel?.split('::')[0];
  const selectedProvider = providerId && isSupportedProvider(providerId) ? providerId : undefined;
  const model = selectedModel?.slice((selectedModel.indexOf('::') ?? -1) + 2);
  const { providers: configuredProviders } = useConfiguredAssistantProviders();
  const { localRuntimeModels } = useAssistantLocalRuntimeCatalog({
    getLocalRuntimeModels,
    getLocalRuntimeStatuses,
  });
  const runtimeModels = useMemo(
    () => ({
      lmstudio: toRuntimeProviderModels('lmstudio', localRuntimeModels),
      ollama: toRuntimeProviderModels('ollama', localRuntimeModels),
    }),
    [localRuntimeModels]
  );
  const getProviderLlmModels = useCallback(
    (provider: SupportedProvider): readonly LlmProviderModelDefinition[] =>
      getRuntimeProviderLlmModels(provider, runtimeModels, undefined),
    [runtimeModels]
  );
  const isModelEnabled = useCallback(
    (provider: SupportedProvider, modelId: string): boolean =>
      provider === 'ollama' || provider === 'lmstudio'
        ? getProviderLlmModels(provider).some((definition) => definition.id === modelId)
        : provider === 'local'
          ? downloaded[modelId] === true
          : registry.some(
              (entry) => entry.providerId === provider && entry.id === modelId && entry.isEnabled
            ),
    [downloaded, getProviderLlmModels, registry]
  );
  const picker = useAssistantModelPickerConfig({
    configuredProviders,
    getProviderLlmModels,
    isModelEnabled,
  });
  const { handleModelChange, providerDraft } = useAssistantModelChange({
    currentModel: selectedModel,
    draftRuntimeByThreadId: drafts,
    fixedProviderModels: undefined,
    memoryThreadId: threadId,
    providerSettings,
    setModel,
    setProviderSettings,
    setThreadDraftRuntime,
  });
  const effective = useMemo(
    () => ({ ...providerSettings, ...draft?.providerSettings }),
    [draft?.providerSettings, providerSettings]
  );
  const settings = selectedProvider ? effective[selectedProvider] : undefined;
  const selectedDefinition = selectedProvider
    ? getProviderLlmModels(selectedProvider).find((definition) => definition.id === model)
    : undefined;
  const metadata = useOpenRouterModelMetadata({
    modelId: model,
    modelSettings: draft?.modelSettings ?? buildModelSettings(settings),
    providerId: selectedProvider,
    selectedModelDef: selectedDefinition,
    settings,
  });
  const providerOptions =
    draft?.providerOptions ??
    buildProviderOptionsWhenReady(
      metadata.reason,
      selectedProvider ?? null,
      model,
      settings,
      metadata.lookup
    );
  const disabledReason = metadata.reason ?? providerDraft.reason;
  const readConfiguration = useCallback(
    (selectionFolderId: string | null): Record<string, unknown> => {
      if (disabledReason) {
        throw new Error(disabledReason);
      }
      return readDesktopHostConfiguration(threadId, selectionFolderId, {
        agentLoop: metadata.agentLoopSettings,
        model,
        modelSettings: metadata.modelSettings,
        provider: selectedProvider,
        providerOptions,
      });
    },
    [
      disabledReason,
      metadata.agentLoopSettings,
      metadata.modelSettings,
      model,
      providerOptions,
      selectedProvider,
      threadId,
    ]
  );
  const onProviderSettingsChange = useCallback(
    (providerId: string, updates: AssistantProviderSettingsUpdate): void => {
      if (!isSupportedProvider(providerId)) {
        throw new Error('Unsupported settings provider');
      }
      const provider = providerId;
      const current = useAssistantThreadStore.getState().draftRuntimeByThreadId[threadId] ?? {};
      const settings = { ...providerSettings, ...current.providerSettings };
      settings[provider] = mergeAssistantProviderSettings(settings[provider], updates);
      const active = current.provider ?? selectedProvider ?? provider;
      if (!isSupportedProvider(active)) {
        throw new Error('Unsupported thread provider');
      }
      const {
        modelSettings: _modelSettings,
        providerOptions: _providerOptions,
        ...identity
      } = current;
      setThreadDraftRuntime(threadId, {
        ...identity,
        ...buildDraftRuntimeForProvider({
          model: current.model ?? model,
          openRouterLookup: metadata.lookup,
          provider: active,
          providerSettingsMap: settings,
        }),
      });
    },
    [metadata.lookup, model, providerSettings, selectedProvider, setThreadDraftRuntime, threadId]
  );
  const onEnableModel = useEnableModel();
  const contextWindow = metadata.modelDef?.contextWindow;
  return {
    ...picker,
    composerDraftCommand: composerDraft.command,
    fileMentions,
    onComposerDraftCommandApplied: composerDraft.onApplied,
    onComposerTextChange: composerDraft.onTextChange,
    onEnableModel,
    onFileMentionQueryChange: setFileMentionQuery,
    onModelChange: handleModelChange,
    onProviderSettingsChange,
    onProviderSettingsValidationChange: providerDraft.report,
    openRouterModelMetadataLookup: metadata.lookup,
    providerSettings: effective,
    readConfiguration,
    recentModels: recentModels.filter((recent) =>
      picker.pickerModels.some((entry) => `${entry.providerId}::${entry.id}` === recent)
    ),
    slashCommands,
    ...(metadata.agentLoopSettings?.inputTokenLimit
      ? { effectiveInputBudget: metadata.agentLoopSettings.inputTokenLimit }
      : {}),
    ...(disabledReason ? { disabledReason, isComposerDisabled: true } : {}),
    ...(selectedModel ? { selectedModel } : {}),
    ...(selectedProvider ? { selectedProvider } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
}
