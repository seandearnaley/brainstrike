import {
  getProviderDefaultModel,
  getProviderDefinition,
  getProviderModelDefinitions,
  isSupportedProvider,
  type ProviderModelDefinition,
  type ProviderRuntime,
  type SupportedProvider,
  supportsStandardEmbeddingDimension,
} from '@brainstrike/agent/client';
import { usePGliteDatabase } from '@brainstrike/db';
import { useFileExplorerStoreContext, useSelectionManager } from '@brainstrike/file-explorer-ui';
import {
  useAssistantPreferencesStore,
  useEnsureModelRegistry,
  useModelRegistryStore,
  useSecretsStore,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import {
  AssistantUiPanel,
  type ModelPickerModel,
  type ModelPickerProvider,
  type ProviderGroupConfig,
} from '@brainstrike/ui/assistant-ui-panel';
import { decodeFileSelection } from '@brainstrike/utils';
import { type FC, useCallback, useEffect, useMemo, useState } from 'react';

export type AssistantUiPanelWrapperProps = {
  className?: string;
  initialProviders?: SupportedProvider[];
};

const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
};

// Providers whose models are managed via the DB (model-registry-store)
// instead of localStorage (assistant-preferences-store)
const DB_MANAGED_PROVIDERS = new Set<SupportedProvider>(['local']);

export const AssistantUiPanelWrapper: FC<AssistantUiPanelWrapperProps> = ({ initialProviders }) => {
  const [configuredProviders, setConfiguredProviders] = useState<SupportedProvider[]>(
    () => initialProviders ?? []
  );

  const {
    enabledModelsByProvider,
    setModel,
    clearModel,
    setModelEnabled,
    getAvailableProviders,
    getSelectedModel,
    getSelectedProvider,
    getEnabledModels,
  } = useAssistantPreferencesStore();

  // Subscribe to secrets changes to re-check available providers when API keys change
  const secretsVersion = useSecretsStore((state) => state.secretsVersion);

  // Load model registry from DB for local provider models
  useEnsureModelRegistry();
  const registryModels = useModelRegistryStore((state) => state.models);
  const toggleModelInDb = useModelRegistryStore((state) => state.toggleModel);
  const db = usePGliteDatabase();

  // Create a set of DB-enabled model IDs for quick lookup
  const dbEnabledModelIds = useMemo(() => {
    const enabledIds = new Set<string>();
    for (const model of registryModels) {
      if (model.isEnabled && model.capabilities.type === 'llm') {
        enabledIds.add(model.id);
      }
    }
    return enabledIds;
  }, [registryModels]);

  const selectedProvider = getSelectedProvider();
  const activeEmbeddingSetId = useVectorStatusUIStore((s) => s.activeEmbeddingSetId);
  const store = useFileExplorerStoreContext();
  const [tokenBudget, currentFolderId] = store((s) => [s.tokenBudget, s.currentFolderId] as const);
  const handleSelectionLimitExceeded = useCallback(() => {}, []);
  const { effectiveSelection } = useSelectionManager({
    onSelectionLimitExceeded: handleSelectionLimitExceeded,
  });

  const selectionData = useMemo(() => {
    const filePaths = new Set<string>();
    const folderIds = new Set<string>();
    for (const compositeKey of effectiveSelection) {
      try {
        const decoded = decodeFileSelection(compositeKey);
        filePaths.add(decoded.path);
        folderIds.add(decoded.folderId);
      } catch {
        // Ignore invalid selection keys
      }
    }

    const resolvedFolderId =
      folderIds.size === 1
        ? Array.from(folderIds)[0]
        : folderIds.size === 0
          ? (currentFolderId ?? undefined)
          : undefined;

    return {
      filePaths: Array.from(filePaths),
      folderId: resolvedFolderId,
    };
  }, [effectiveSelection, currentFolderId]);

  const requestData = useMemo(() => {
    const data: Record<string, unknown> = {};
    if (activeEmbeddingSetId) {
      data['embeddingSetId'] = activeEmbeddingSetId;
    }
    if (selectionData.filePaths.length > 0) {
      data['selectionFilePaths'] = selectionData.filePaths;
    }
    if (selectionData.folderId) {
      data['selectionFolderId'] = selectionData.folderId;
    }
    if (typeof tokenBudget === 'number') {
      data['tokenBudget'] = tokenBudget;
    }
    return data;
  }, [activeEmbeddingSetId, selectionData, tokenBudget]);

  // Check if a model is enabled, using DB for local providers, localStorage for others
  const isModelEnabled = useCallback(
    (providerId: SupportedProvider, modelId: string): boolean => {
      if (DB_MANAGED_PROVIDERS.has(providerId)) {
        return dbEnabledModelIds.has(modelId);
      }
      return getEnabledModels(providerId).includes(modelId);
    },
    [dbEnabledModelIds, getEnabledModels]
  );

  const providerHasEnabledModels = useCallback(
    (provider: SupportedProvider) => {
      if (DB_MANAGED_PROVIDERS.has(provider)) {
        // For DB-managed providers, check the registry
        const modelDefinitions = getProviderModelDefinitions(provider).filter(
          (model) => model.type === 'llm'
        );
        return modelDefinitions.some((model) => dbEnabledModelIds.has(model.id));
      }
      return getEnabledModels(provider).length > 0;
    },
    [dbEnabledModelIds, getEnabledModels]
  );

  const selectModelForProvider = useCallback(
    (provider: SupportedProvider) => {
      const modelDefinitions = getProviderModelDefinitions(provider).filter(
        (model) => model.type === 'llm'
      );
      const enabledModels = modelDefinitions
        .filter((model) => isModelEnabled(provider, model.id))
        .map((model) => model.id);

      if (enabledModels.length === 0) {
        return;
      }

      const defaultModel = getProviderDefaultModel(provider);
      const modelToSelect =
        defaultModel && enabledModels.includes(defaultModel) ? defaultModel : enabledModels[0];
      setModel(`${provider}::${modelToSelect}`);
    },
    [isModelEnabled, setModel]
  );

  useEffect(() => {
    let cancelled = false;

    const loadProviders = async () => {
      if (initialProviders !== undefined) {
        setConfiguredProviders(initialProviders);
        return;
      }

      const providers = await getAvailableProviders();
      if (cancelled) {
        return;
      }
      setConfiguredProviders(providers);
    };

    void loadProviders();

    return () => {
      cancelled = true;
    };
    // secretsVersion triggers re-check when API keys are added/removed
  }, [initialProviders, getAvailableProviders, secretsVersion]);

  // Reconcile selection whenever providers or enabled models change
  // Using useEffect (not useLayoutEffect) because we're mutating external state (Zustand store)
  // React will properly batch these updates and handle them in the commit phase
  useEffect(() => {
    if (configuredProviders.length === 0) {
      return;
    }

    const currentProvider = getSelectedProvider();

    // Case 1: Current provider is no longer available
    if (currentProvider && !configuredProviders.includes(currentProvider)) {
      clearModel();
      return;
    }

    // Case 2: Current provider exists and has enabled models - nothing to do
    if (currentProvider && providerHasEnabledModels(currentProvider)) {
      return;
    }

    // Case 3: Find the first provider with enabled models
    const next = configuredProviders.find((providerId) => providerHasEnabledModels(providerId));
    if (next) {
      selectModelForProvider(next);
      return;
    }

    // Case 4: No providers with enabled models, clear selection
    if (currentProvider) {
      clearModel();
    }
  }, [
    configuredProviders,
    enabledModelsByProvider,
    dbEnabledModelIds,
    getSelectedProvider,
    clearModel,
    providerHasEnabledModels,
    selectModelForProvider,
  ]);

  const currentModel = getSelectedModel();

  const handleModelChange = useCallback(
    (compositeKey: string) => {
      // Composite key format: "provider::model"
      setModel(compositeKey);
    },
    [setModel]
  );

  const handleModelToggle = useCallback(
    (providerId: string, modelId: string, enabled: boolean) => {
      if (!isSupportedProvider(providerId)) {
        return;
      }

      // For DB-managed providers (e.g., 'local'), update the database
      if (DB_MANAGED_PROVIDERS.has(providerId) && db) {
        void toggleModelInDb(db, modelId, enabled);
        return;
      }

      // For localStorage-managed providers, use the preferences store
      setModelEnabled(providerId, modelId, enabled);
    },
    [db, toggleModelInDb, setModelEnabled]
  );

  const providerGroups = useMemo<ProviderGroupConfig[]>(() => {
    const runtimeOrder: ProviderRuntime[] = ['hosted', 'gateway', 'local', 'browser'];
    const groups = new Map<ProviderRuntime, ProviderGroupConfig>();

    runtimeOrder.forEach((runtime) => {
      groups.set(runtime, {
        runtime,
        label: RUNTIME_LABELS[runtime] ?? runtime,
        providers: [],
      });
    });

    for (const providerId of configuredProviders) {
      const definition = getProviderDefinition(providerId);
      const runtime = definition.runtime;
      const modelDefinitions = getProviderModelDefinitions(providerId).filter(
        (model): model is ProviderModelDefinition & { type: 'llm' } => model.type === 'llm'
      );

      const models = modelDefinitions.map((model) => ({
        id: model.id,
        label: model.label ?? model.id,
        type: 'llm' as const,
        enabled: isModelEnabled(providerId, model.id),
        default: Boolean(model.default),
        supportsStreaming: Boolean(model.supportsStreaming),
      }));

      const group = groups.get(runtime);
      if (!group) {
        continue;
      }

      group.providers.push({
        id: providerId,
        name: definition.displayName,
        runtime,
        capabilities: {
          ...definition.capabilities,
          supportsStandardEmbeddingDimension: supportsStandardEmbeddingDimension(providerId),
        },
        models,
      });
    }

    return runtimeOrder
      .map((runtime) => groups.get(runtime))
      .filter((group): group is ProviderGroupConfig =>
        Boolean(group && group.providers.length > 0)
      );
  }, [configuredProviders, isModelEnabled]);

  // Transform provider groups to ModelPicker-compatible format
  const pickerProviders = useMemo<ModelPickerProvider[]>(() => {
    return configuredProviders.map((providerId) => {
      const definition = getProviderDefinition(providerId);
      return {
        id: providerId,
        name: definition.displayName,
        icon: null, // Icons are handled by the ModelPicker's internal icon mapping
      };
    });
  }, [configuredProviders]);

  // Transform models to ModelPicker-compatible format (only enabled LLM models)
  const pickerModels = useMemo<ModelPickerModel[]>(() => {
    const models: ModelPickerModel[] = [];

    for (const providerId of configuredProviders) {
      const modelDefinitions = getProviderModelDefinitions(providerId).filter(
        (model): model is ProviderModelDefinition & { type: 'llm' } => model.type === 'llm'
      );

      for (const model of modelDefinitions) {
        // Check enabled status using the unified helper
        if (!isModelEnabled(providerId, model.id)) {
          continue;
        }

        models.push({
          id: model.id,
          providerId,
          name: model.label ?? model.id,
          description: null, // LLM models don't have descriptions in the agent definitions
          capabilities: {
            type: 'llm',
            streaming: model.supportsStreaming ?? false,
          },
        });
      }
    }

    return models;
  }, [configuredProviders, isModelEnabled]);

  const isProviderReady = Boolean(
    selectedProvider && currentModel && configuredProviders.includes(selectedProvider)
  );

  const disabledReason = useMemo(() => {
    if (configuredProviders.length === 0) {
      return 'Connect an AI provider in Settings → LLM Provider Keys to enable the assistant.';
    }
    if (!selectedProvider) {
      return 'Select an AI provider to start chatting.';
    }
    if (!configuredProviders.includes(selectedProvider)) {
      return 'The selected provider is no longer configured.';
    }
    if (!providerHasEnabledModels(selectedProvider)) {
      const definition = getProviderDefinition(selectedProvider);
      return `Enable at least one model for ${definition.displayName} to continue.`;
    }
    if (!currentModel) {
      return 'Select a model for the chosen provider to continue.';
    }
    return;
  }, [configuredProviders, selectedProvider, providerHasEnabledModels, currentModel]);

  return (
    <AssistantUiPanel
      pickerModels={pickerModels}
      pickerProviders={pickerProviders}
      providerGroups={providerGroups}
      requestData={requestData}
      {...(selectedProvider ? { selectedProvider } : {})}
      {...(currentModel ? { selectedModel: currentModel } : {})}
      disabled={!isProviderReady}
      onModelChange={handleModelChange}
      onModelToggle={handleModelToggle}
      {...(disabledReason ? { disabledReason } : {})}
    />
  );
};

AssistantUiPanelWrapper.displayName = 'AssistantUiPanelWrapper';
