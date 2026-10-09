import {
  buildDraftRuntimeForProvider,
  buildModelSettings,
  buildProviderOptionsWhenReady,
  getRuntimeProviderLlmModels,
  type LlmProviderModelDefinition,
  resolveComposerAttachmentsAvailability,
  toRuntimeProviderModels,
  useAssistantLocalRuntimeCatalog,
  useAssistantModelChange,
  useAssistantModelPickerConfig,
  useAssistantProviderDisabledReason,
  useAssistantSlashCommands,
  useAssistantToolMenu,
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
  | 'attachmentsAvailability'
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
  | 'planMode'
  | 'toolMenu'
>;

interface DesktopHostPresentation extends Presentation {
  readConfiguration(selectionFolderId: string | null): Record<string, unknown>;
  /** Whether the next run starts in plan mode. */
  readPlanMode(): boolean;
}

/** The host status's per-provider credential read failures, keyed by provider. */
export type ProviderReadErrors = Partial<Record<SupportedProvider, string>>;

/**
 * The legacy panel's pre-send provider notice. A failed provider refresh gates
 * a send only while nothing is connected; beside a ready provider it is shown
 * without gating it.
 */
function useProviderNotice({
  configuredProviders,
  discoveryError,
  getProviderLlmModels,
  isModelEnabled,
  localRuntimeHint,
  providerReadErrors,
  selectedModel,
  selectedProvider,
}: {
  readonly configuredProviders: readonly SupportedProvider[];
  readonly discoveryError: string | undefined;
  readonly getProviderLlmModels: (
    provider: SupportedProvider
  ) => readonly LlmProviderModelDefinition[];
  readonly isModelEnabled: (provider: SupportedProvider, modelId: string) => boolean;
  readonly localRuntimeHint: string | undefined;
  readonly providerReadErrors: ProviderReadErrors | undefined;
  readonly selectedModel: string | null | undefined;
  readonly selectedProvider: SupportedProvider | undefined;
}): { readonly blocking: string | undefined; readonly refresh: string | undefined } {
  // Enablement is read through the picker's own predicate.
  const providerHasEnabledModels = useCallback(
    (provider: SupportedProvider): boolean =>
      getProviderLlmModels(provider).some((definition) => isModelEnabled(provider, definition.id)),
    [getProviderLlmModels, isModelEnabled]
  );
  const refresh = discoveryError
    ? `Could not refresh available providers: ${discoveryError}`
    : undefined;
  const blockingRefresh = configuredProviders.length === 0 ? refresh : undefined;
  const provider = useAssistantProviderDisabledReason(
    {
      configuredProviders,
      currentModel: selectedModel,
      getProviderLlmModels,
      localRuntimeHint,
      providerHasEnabledModels,
      ...(providerReadErrors ? { providerReadErrors } : {}),
      selectedProvider: selectedProvider ?? null,
    },
    blockingRefresh !== undefined
  );
  return { blocking: blockingRefresh ?? provider, refresh };
}

/** The panel shows the reason a send is gated, else a refresh failure that gates nothing. */
function noticeProps(
  gating: string | undefined,
  refresh: string | undefined
): Pick<Presentation, 'disabledReason' | 'isComposerDisabled'> {
  if (gating) {
    return { disabledReason: gating, isComposerDisabled: true };
  }
  return refresh ? { disabledReason: refresh } : {};
}

/** Existing picker/settings owners project controls; they own no assistant execution. */
export function useDesktopHostPresentation(
  threadId: string,
  providerReadErrors?: ProviderReadErrors
): DesktopHostPresentation {
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
  const planModeEnabled = useAssistantPreferencesStore((state) => state.planModeEnabled);
  const togglePlanMode = useAssistantPreferencesStore((state) => state.togglePlanMode);
  const setPlanModeEnabled = useAssistantPreferencesStore((state) => state.setPlanModeEnabled);
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
  const { discoveryError, providers: configuredProviders } = useConfiguredAssistantProviders();
  const { localRuntimeHint, localRuntimeModels } = useAssistantLocalRuntimeCatalog({
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
  const providerNotice = useProviderNotice({
    configuredProviders,
    discoveryError,
    getProviderLlmModels,
    isModelEnabled,
    localRuntimeHint,
    providerReadErrors,
    selectedModel,
    selectedProvider,
  });
  // The legacy panel's order: the provider notice, then OpenRouter metadata,
  // then an invalid settings draft.
  const disabledReason = providerNotice.blocking ?? metadata.reason ?? providerDraft.reason;
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
  // Plan mode is never offered for the built-in local provider: its toggle is hidden.
  const planModeAvailable = selectedProvider !== undefined && selectedProvider !== 'local';
  const planMode = useMemo(
    () =>
      planModeAvailable
        ? {
            enabled: planModeEnabled,
            onExit: () => setPlanModeEnabled(false),
            onToggle: togglePlanMode,
          }
        : undefined,
    [planModeAvailable, planModeEnabled, setPlanModeEnabled, togglePlanMode]
  );
  const readPlanMode = useCallback(
    () => planModeAvailable && useAssistantPreferencesStore.getState().planModeEnabled,
    [planModeAvailable]
  );
  const onEnableModel = useEnableModel();
  // Toggles write the native and MCP tool preferences the next send captures.
  const { toolMenu } = useAssistantToolMenu({
    runsMcpTools: true,
    selectedProvider: selectedProvider ?? null,
  });
  const contextWindow = metadata.modelDef?.contextWindow;
  // The legacy composer's gate: the selected model's vision decides.
  const attachmentsAvailability = resolveComposerAttachmentsAvailability({
    providerGateAvailable: selectedProvider !== 'local',
    selectedModel: selectedDefinition,
  });
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
    ...(planMode ? { planMode } : {}),
    readConfiguration,
    readPlanMode,
    recentModels: recentModels.filter((recent) =>
      picker.pickerModels.some((entry) => `${entry.providerId}::${entry.id}` === recent)
    ),
    slashCommands,
    toolMenu,
    ...(metadata.agentLoopSettings?.inputTokenLimit
      ? { effectiveInputBudget: metadata.agentLoopSettings.inputTokenLimit }
      : {}),
    ...noticeProps(disabledReason, providerNotice.refresh),
    ...(selectedModel ? { selectedModel } : {}),
    ...(selectedProvider ? { selectedProvider } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(attachmentsAvailability ? { attachmentsAvailability } : {}),
  };
}
