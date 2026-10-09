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
import {
  findProviderDefinition,
  isSupportedProvider,
  type OpenRouterModelMetadataLookup,
  type SupportedProvider,
} from '@brainstrike/assistant-contract';
import { useAssistantThreadStore } from '@brainstrike/assistant-data';
import {
  type CommittedAssistantConversationProps,
  useLocalModelLoading,
} from '@brainstrike/assistant-ui';
import {
  type AssistantProviderSettingsUpdate,
  mergeAssistantProviderSettings,
} from '@brainstrike/types';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { readDesktopHostConfiguration } from './desktop-host-configuration';
import { type EnabledCatalogModels, useEnabledCatalogModels } from './use-enabled-catalog-models';
import type { HostThreadSelectionBinding } from './use-host-thread-selection';

type Presentation = Pick<
  CommittedAssistantConversationProps,
  | 'attachmentsAvailability'
  | 'localLoadingState'
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
  /** The enabled catalog models admission reads, as one comparable key. */
  readonly catalogKey: string;
  readConfiguration(selectionFolderId: string | null): Record<string, unknown>;
  /** The composer's `provider::model`: a pick, else the thread's selection (ADR-0019). */
  readModelId(): string;
  /** Whether the next run starts in plan mode. */
  readPlanMode(): boolean;
}

/** A composer pick the host has not yet committed as the thread's selection (ADR-0019). */
interface ComposerPick {
  readonly error?: string;
  readonly modelId: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The send's gate, else a pick the host refused (ADR-0019). */
function composerDisabledReason(
  gate: string | undefined,
  pickError: string | undefined
): string | undefined {
  if (gate !== undefined || pickError === undefined) {
    return gate;
  }
  return `Could not save the model choice: ${pickError}`;
}

/** A pick is saved once nothing gates the send and the model's metadata is not loading. */
function isPickSaveReady(
  gate: string | undefined,
  lookupState: OpenRouterModelMetadataLookup['state'] | undefined
): boolean {
  return gate === undefined && lookupState !== 'loading';
}

/**
 * ADR-0019: saves a composer pick as the thread's selection once nothing gates
 * the send, one save per pick. A newer pick replaces it; that save then
 * settles nothing. State changes only in the save's own callbacks.
 */
function useSaveComposerPick({
  pick,
  readConfiguration,
  readSelectionFolderId,
  ready,
  set,
  setPick,
}: {
  readonly pick: ComposerPick | undefined;
  readonly readConfiguration: (selectionFolderId: string | null) => Record<string, unknown>;
  readonly readSelectionFolderId: () => string | null;
  readonly ready: boolean;
  readonly set: HostThreadSelectionBinding['set'];
  readonly setPick: Dispatch<SetStateAction<ComposerPick | undefined>>;
}): void {
  const saving = useRef<ComposerPick | undefined>(undefined);
  useEffect(() => {
    if (!(pick && ready) || pick.error || saving.current === pick) {
      return;
    }
    saving.current = pick;
    Promise.resolve()
      .then(() => set(pick.modelId, readConfiguration(readSelectionFolderId())))
      .then(
        () => setPick((current) => (current === pick ? undefined : current)),
        (error: unknown) =>
          setPick((current) =>
            current === pick ? { error: errorText(error), modelId: pick.modelId } : current
          )
      );
  }, [pick, readConfiguration, readSelectionFolderId, ready, set, setPick]);
}

/** The host status's per-provider credential read failures, keyed by provider. */
export type ProviderReadErrors = Partial<Record<SupportedProvider, string>>;

/**
 * Admission's rule: a provider whose runtime is `local` (Ollama, LM Studio)
 * serves whatever model its server lists, with no catalog row; every other
 * selection needs an enabled `models` row.
 */
function isDynamicLocalRuntime(provider: SupportedProvider): boolean {
  return findProviderDefinition(provider)?.runtime === 'local';
}

/**
 * The legacy panel's pre-send provider notice, gating only what admission
 * refuses. A failed provider refresh gates a send only while nothing is
 * connected; beside a ready provider it is shown without gating it. A notice
 * about a local runtime's discovery is shown without gating: admission admits
 * that selection without the renderer's probe.
 */
function useProviderNotice({
  catalog,
  configuredProviders,
  discoveryError,
  getProviderLlmModels,
  isModelEnabled,
  localRuntimeHint,
  providerReadErrors,
  selectedModel,
  selectedProvider,
}: {
  readonly catalog: EnabledCatalogModels;
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
}): { readonly advisory: string | undefined; readonly blocking: string | undefined } {
  // Enablement is read through the picker's own predicate. Until the catalog
  // is read, no catalog provider is claimed to have nothing enabled.
  const providerHasEnabledModels = useCallback(
    (provider: SupportedProvider): boolean =>
      (catalog.state !== 'ready' && !isDynamicLocalRuntime(provider)) ||
      getProviderLlmModels(provider).some((definition) => isModelEnabled(provider, definition.id)),
    [catalog.state, getProviderLlmModels, isModelEnabled]
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
  if (selectedProvider && isDynamicLocalRuntime(selectedProvider)) {
    return { advisory: provider ?? refresh, blocking: blockingRefresh };
  }
  const catalogError =
    catalog.state === 'error' ? `Could not read the enabled models: ${catalog.message}` : undefined;
  return { advisory: refresh, blocking: blockingRefresh ?? provider ?? catalogError };
}

/** The panel shows the reason a send is gated, else a notice that gates nothing. */
function noticeProps(
  gating: string | undefined,
  advisory: string | undefined
): Pick<Presentation, 'disabledReason' | 'isComposerDisabled'> {
  if (gating) {
    return { disabledReason: gating, isComposerDisabled: true };
  }
  return advisory ? { disabledReason: advisory } : {};
}

/** Existing picker/settings owners project controls; they own no assistant execution. */
export function useDesktopHostPresentation(
  threadId: string,
  /** ADR-0019: the host thread's run selection, the source of the composer's model. */
  host: HostThreadSelectionBinding,
  readSelectionFolderId: () => string | null,
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
  const draft = drafts[threadId];
  // A pick waits here until the host commits it as the thread's selection.
  const [pick, setPick] = useState<ComposerPick>();
  // ADR-0019: the host's selection, not renderer storage, names a host thread's
  // model; a thread with none yet starts from the global default.
  const selectedModel = pick?.modelId ?? host.selection?.modelId ?? globalModel;
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
  // The catalog host admission reads, not the Settings registry cache.
  const catalog = useEnabledCatalogModels();
  const isModelEnabled = useCallback(
    (provider: SupportedProvider, modelId: string): boolean =>
      isDynamicLocalRuntime(provider)
        ? getProviderLlmModels(provider).some((definition) => definition.id === modelId)
        : catalog.state === 'ready' && catalog.keys.has(`${provider}::${modelId}`),
    [catalog, getProviderLlmModels]
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
  // The legacy composer's gate: the selected model's vision decides. Derived
  // here, before anything memoizes what `selectedDefinition` came from: the
  // React Compiler treats a plain call's arguments as possibly mutated, and a
  // later call made it skip compiling this hook (preserve-manual-memoization).
  const attachmentsAvailability = resolveComposerAttachmentsAvailability({
    providerGateAvailable: selectedProvider !== 'local',
    selectedModel: selectedDefinition,
  });
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
    catalog,
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
  // then an invalid settings draft; then the thread's own selection. A pick
  // waits while one of these gates the send.
  const gate = providerNotice.blocking ?? metadata.reason ?? providerDraft.reason ?? host.error;
  const disabledReason = composerDisabledReason(gate, pick?.error);
  const readModelId = useCallback((): string => {
    if (!selectedModel) {
      throw new Error('Select a provider and model before sending');
    }
    return selectedModel;
  }, [selectedModel]);
  const readConfiguration = useCallback(
    (selectionFolderId: string | null): Record<string, unknown> => {
      if (disabledReason) {
        throw new Error(disabledReason);
      }
      return readDesktopHostConfiguration(
        threadId,
        readModelId(),
        selectionFolderId,
        {
          agentLoop: metadata.agentLoopSettings,
          model,
          modelSettings: metadata.modelSettings,
          provider: selectedProvider,
          providerOptions,
        },
        metadata.lookup
      );
    },
    [
      disabledReason,
      metadata.agentLoopSettings,
      metadata.lookup,
      metadata.modelSettings,
      model,
      providerOptions,
      readModelId,
      selectedProvider,
      threadId,
    ]
  );
  // ADR-0019: a pick becomes the thread's selection once its settings resolve,
  // so the CLI and a wake read the same choice the composer shows.
  useSaveComposerPick({
    pick,
    readConfiguration,
    readSelectionFolderId,
    ready: isPickSaveReady(gate, metadata.lookup?.state),
    set: host.set,
    setPick,
  });
  const onModelChange = useCallback(
    (compositeKey: string): void => {
      handleModelChange(compositeKey);
      setPick({ modelId: compositeKey });
    },
    [handleModelChange]
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
      const active = selectedProvider ?? current.provider ?? provider;
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
          model: model ?? current.model,
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
  // The built-in local model's load progress: Main broadcasts the llm-host's
  // loading reports for loads it starts itself, which a host thread's are.
  const { localLoadingState } = useLocalModelLoading({
    localViaDataStream: false,
    modelName: undefined,
  });
  return {
    ...picker,
    catalogKey: catalog.state === 'ready' ? [...catalog.keys].sort().join('\n') : catalog.state,
    composerDraftCommand: composerDraft.command,
    fileMentions,
    ...(localLoadingState ? { localLoadingState } : {}),
    onComposerDraftCommandApplied: composerDraft.onApplied,
    onComposerTextChange: composerDraft.onTextChange,
    onEnableModel,
    onFileMentionQueryChange: setFileMentionQuery,
    onModelChange,
    onProviderSettingsChange,
    onProviderSettingsValidationChange: providerDraft.report,
    openRouterModelMetadataLookup: metadata.lookup,
    providerSettings: effective,
    ...(planMode ? { planMode } : {}),
    readConfiguration,
    readModelId,
    readPlanMode,
    recentModels: recentModels.filter((recent) =>
      picker.pickerModels.some((entry) => `${entry.providerId}::${entry.id}` === recent)
    ),
    slashCommands,
    toolMenu,
    ...(metadata.agentLoopSettings?.inputTokenLimit
      ? { effectiveInputBudget: metadata.agentLoopSettings.inputTokenLimit }
      : {}),
    ...noticeProps(disabledReason, providerNotice.advisory),
    ...(selectedModel ? { selectedModel } : {}),
    ...(selectedProvider ? { selectedProvider } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(attachmentsAvailability ? { attachmentsAvailability } : {}),
  };
}
