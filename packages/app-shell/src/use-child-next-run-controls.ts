import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import {
  type AssistantChildInput,
  type AssistantPersonaDefinition,
  childNextRunSchema,
  normalizeAssistantChildInput,
} from '@brainstrike/assistant-contract';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import type { AssistantConversationPanelProps } from '@brainstrike/assistant-ui';
import {
  type AssistantProviderSettingsMap,
  type AssistantProviderSettingsUpdate,
  mergeAssistantProviderSettings,
} from '@brainstrike/types';
import { useCallback, useMemo, useState } from 'react';
import {
  buildModelSettings,
  buildProviderOptionsWhenReady,
  getRuntimeProviderLlmModels,
  reconcileProviderSettingsForModel,
  resolveModelNameFromComposite,
  resolveProviderFromComposite,
  toRuntimeProviderModels,
} from './assistant-ui-panel-wrapper-runtime';
import { useAssistantLocalRuntimeCatalog } from './hooks/use-assistant-local-runtime-catalog';
import { useAssistantModelPickerConfig } from './hooks/use-assistant-model-picker-config';
import { useConfiguredAssistantProviders } from './hooks/use-configured-assistant-providers';
import { useEnableModel } from './hooks/use-enable-model';
import { useOpenRouterModelMetadata } from './hooks/use-openrouter-model-metadata';

interface Inputs {
  readonly inheritedModel: string | null;
  readonly inheritedPlanMode: boolean;
  readonly inheritedProviderSettings: AssistantProviderSettingsMap;
  readonly isRunning: () => boolean;
  readonly persona: AssistantPersonaDefinition | undefined;
}

function useChildModelPicker() {
  const { providers, discoveryError } = useConfiguredAssistantProviders();
  const models = useModelRegistryStore((state) => state.models);
  const getLocalRuntimeModels = useAssistantPreferencesStore(
    (state) => state.getLocalRuntimeModels
  );
  const getLocalRuntimeStatuses = useAssistantPreferencesStore(
    (state) => state.getLocalRuntimeStatuses
  );
  const { localRuntimeModels, localRuntimeHint } = useAssistantLocalRuntimeCatalog({
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
    (provider: SupportedProvider) =>
      getRuntimeProviderLlmModels(provider, runtimeModels, undefined),
    [runtimeModels]
  );
  const isModelEnabled = useCallback(
    (provider: SupportedProvider, modelId: string) =>
      models.some(
        (model) =>
          model.providerId === provider &&
          model.id === modelId &&
          model.isEnabled &&
          model.capabilities.type === 'llm'
      ),
    [models]
  );
  const picker = useAssistantModelPickerConfig({
    configuredProviders: providers,
    getProviderLlmModels,
    isModelEnabled,
  });
  return { ...picker, discoveryError, getProviderLlmModels, localRuntimeHint };
}

/** Child-local drafts feed the main composer's existing dock and the admitted input envelope. */
export function useChildNextRunControls({
  inheritedModel,
  inheritedProviderSettings,
  inheritedPlanMode,
  persona,
  isRunning,
}: Inputs) {
  const onEnableModel = useEnableModel();
  const [modelOverride, setModelOverride] = useState<string>();
  const [settingsOverrides, setSettingsOverrides] = useState<AssistantProviderSettingsMap>({});
  const [disabledTools, setDisabledTools] = useState<readonly string[]>([]);
  const [planMode, setPlanMode] = useState(false);
  const allowedToolIds = persona?.allowedToolIds ?? [];
  const disabledToolIds = useMemo(() => new Set(disabledTools), [disabledTools]);
  const inherited = persona?.model
    ? `${persona.model.provider}::${persona.model.modelId}`
    : inheritedModel;
  const selectedModel = modelOverride ?? inherited ?? undefined;
  const selectedProvider = resolveProviderFromComposite(selectedModel);
  const modelId = resolveModelNameFromComposite(selectedModel);
  const providerSettings = useMemo(
    () => ({ ...inheritedProviderSettings, ...settingsOverrides }),
    [inheritedProviderSettings, settingsOverrides]
  );
  const settings = selectedProvider ? providerSettings[selectedProvider] : undefined;
  const picker = useChildModelPicker();
  const selectedModelDef = selectedProvider
    ? picker.getProviderLlmModels(selectedProvider).find((model) => model.id === modelId)
    : undefined;
  const metadata = useOpenRouterModelMetadata({
    modelId,
    modelSettings: buildModelSettings(settings),
    providerId: selectedProvider,
    selectedModelDef,
    settings,
  });
  const onModelChange = useCallback(
    (selection: string) => {
      const provider = resolveProviderFromComposite(selection);
      const model = resolveModelNameFromComposite(selection);
      if (!(provider && model)) {
        throw new Error('Select a configured child model.');
      }
      setModelOverride(selection);
      const compatible = reconcileProviderSettingsForModel(
        provider,
        model,
        providerSettings[provider]
      );
      setSettingsOverrides((current) => ({ ...current, [provider]: compatible ?? {} }));
    },
    [providerSettings]
  );
  const onProviderSettingsChange = useCallback(
    (provider: string, updates: AssistantProviderSettingsUpdate) => {
      setSettingsOverrides((current) => ({
        ...current,
        [provider]: mergeAssistantProviderSettings(providerSettings[provider], updates),
      }));
    },
    [providerSettings]
  );
  const prepareInput = useCallback(
    (input: AssistantChildInput): AssistantChildInput => {
      if (isRunning()) {
        return input;
      }
      if (!persona) {
        throw new Error('The admitted child configuration is unavailable or invalid.');
      }
      if (!(selectedProvider && modelId)) {
        throw new Error(
          'The next child run needs its current root model or an explicit model selection.'
        );
      }
      if (metadata.reason) {
        throw new Error(metadata.reason);
      }
      const options = buildProviderOptionsWhenReady(
        metadata.reason,
        selectedProvider,
        modelId,
        settings,
        metadata.lookup
      );
      // Local endpoint/token options are transport configuration resolved by the
      // authenticated host, never child-authored generation settings or receipts.
      const { ollama: _ollama, lmstudio: _lmstudio, ...providerOptions } = options ?? {};
      const nextRun = childNextRunSchema.parse({
        disabledToolIds: disabledTools,
        model: { modelId, provider: selectedProvider },
        modelSettings: metadata.modelSettings ?? {},
        planMode: inheritedPlanMode || planMode,
        providerOptions,
        requestedReasoningEffort: settings?.reasoningEffort,
      });
      return normalizeAssistantChildInput({ ...input, nextRun });
    },
    [
      disabledTools,
      inheritedPlanMode,
      isRunning,
      metadata,
      modelId,
      planMode,
      persona,
      selectedProvider,
      settings,
    ]
  );
  const panelProps: Partial<AssistantConversationPanelProps> = {
    onEnableModel,
    onModelChange,
    onProviderSettingsChange,
    openRouterModelMetadataLookup: metadata.lookup,
    pickerModels: picker.pickerModels,
    planMode: {
      enabled: inheritedPlanMode || planMode,
      onToggle: () => setPlanMode((current) => inheritedPlanMode || !current),
    },
    providerGroups: picker.providerGroups,
    providerSettings,
    selectedModel,
    selectedProvider: selectedProvider ?? undefined,
    toolMenu: {
      items: allowedToolIds.map((id) => ({
        disabled: !disabledToolIds.has(id) && disabledTools.length === allowedToolIds.length - 1,
        enabled: !disabledToolIds.has(id),
        group: 'Admitted child tools',
        id,
        label: id.replace(/^brainstrike\./u, ''),
        source: id.startsWith('brainstrike.') ? 'native' : 'mcp',
      })),
      onToggleTool: (id, enabled) =>
        setDisabledTools((current) =>
          enabled ? current.filter((item) => item !== id) : [...new Set([...current, id])]
        ),
      summary: 'Next idle run; limited by the admitted child and current root permissions',
    },
  };
  return {
    error: picker.discoveryError ?? metadata.reason,
    panelProps,
    prepareInput,
    selectedModel,
  };
}
