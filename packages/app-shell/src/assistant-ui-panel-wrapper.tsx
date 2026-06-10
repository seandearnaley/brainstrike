import type { LocalLlmBackendFactory } from '@brainstrike/assistant-contract';
import {
  getProviderDefinition,
  getProviderModelDefinitions,
  isSupportedProvider,
  type ProviderModelDefinition,
  type ProviderRuntime,
  type SupportedProvider,
  supportsStandardEmbeddingDimension,
} from '@brainstrike/assistant-contract/provider-metadata';
import { NATIVE_TOOL_DEFAULTS } from '@brainstrike/assistant-contract/tool-metadata';
import { useDbInitializing, useDbProviderError, usePGliteDatabase } from '@brainstrike/db';
import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import {
  useFileExplorerStoreSelector,
  useSelectionManager,
} from '@brainstrike/file-explorer-ui/shell';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/preferences/stores/assistant-memory-preferences-store';
import { useAssistantPreferencesStore } from '@brainstrike/preferences/stores/assistant-preferences-store';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useNativeToolPreferencesStore } from '@brainstrike/preferences/stores/native-tool-preferences-store';
import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import { useSecretsStore } from '@brainstrike/preferences/stores/secrets-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/preferences/stores/workspace-collection-sync-status-store';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';
import { mergeAssistantProviderSettings, normalizeWorkspaceLookupPath } from '@brainstrike/types';
import {
  type AssistantProviderSettingsUpdate,
  type AssistantToolMenuConfig,
  type AssistantToolMenuItem,
  AssistantUiPanel,
  type ModelPickerModel,
  type ModelPickerProvider,
  type ProviderGroupConfig,
  useContextUsageStore,
} from '@brainstrike/ui/assistant-ui-panel';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  type AssistantForegroundActivityLease,
  acquireAssistantForegroundActivity,
} from './assistant-foreground-activity';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from './assistant-memory-repository';
import { useAssistantThreadStore } from './assistant-thread-store';
import {
  addValuesToSet,
  buildAgentLoopSettings,
  buildAssistantMemoryOptions,
  buildAssistantRequestData,
  buildAssistantTapestryRange,
  buildDraftRuntimeForProvider,
  buildEnabledModelIdSet,
  buildMcpMenuItems,
  buildModelSettings,
  buildProviderOptions,
  copyProviderSettingsMap,
  createAssistantThreadRunPromise,
  extractPreparedRunId,
  findFirstProviderWithEnabledModels,
  formatToolLabel,
  getBuiltInLocalPreferenceModelIds,
  getEnabledBuiltInLocalRegistryModelIds,
  getToolDescription,
  hasValidProviderModelSelection,
  isLocalRuntimeProvider,
  type LlmProviderModelDefinition,
  LOCAL_RUNTIME_PROVIDER_IDS,
  type LocalRuntimeModelCatalogMap,
  type LocalRuntimeProviderId,
  type LocalRuntimeStatusMap,
  type McpAction,
  type McpToolMap,
  mcpReducer,
  resolveAssistantMemoryDisabledReason,
  resolveAssistantProviderDisabledReason,
  resolveLocalRuntimeSelection,
  resolveModelNameFromComposite,
  resolveProviderModelSelection,
  type SelectedModelBudgetDef,
  toLocalRuntimeInputSchema,
  toRuntimeProviderModels,
  toRuntimeWorkspaceContext,
} from './assistant-ui-panel-wrapper-runtime';

export interface AssistantUiPanelWrapperProps {
  className?: string;
  initialProviders?: SupportedProvider[];
  loadLocalLlmBackend?: LocalLlmBackendFactory;
  memoryResourceId?: string;
  memoryThreadId?: string;
}

declare global {
  interface Window {
    __brainstrikeAssistantRuntimeTestHooks__:
      | {
          setCurrentThreadModel: (compositeKey: string) => void;
        }
      | undefined;
  }
}

// App-shell wrapper wires DB/preferences state into the shared UI-only AssistantUiPanel.
const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
};

function resolveProviderFromComposite(
  composite: string | null | undefined
): SupportedProvider | null {
  if (!composite) {
    return null;
  }
  const parts = composite.split('::');
  const candidate = parts.length === 2 ? parts[0] : null;
  return candidate && isSupportedProvider(candidate) ? candidate : null;
}

function hasDesktopAssistantBackend(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return Boolean(window.assistant?.url || window.assistant?.getUrl);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This integration wrapper coordinates multiple stores, runtime probes, and transport paths in one place.
export function AssistantUiPanelWrapper({
  initialProviders,
  loadLocalLlmBackend,
  memoryResourceId: memoryResourceIdOverride,
  memoryThreadId,
}: AssistantUiPanelWrapperProps) {
  const [configuredProviders, setConfiguredProviders] = useState<SupportedProvider[]>(
    () => initialProviders ?? []
  );
  const [localRuntimeStatuses, setLocalRuntimeStatuses] = useState<LocalRuntimeStatusMap | null>(
    null
  );
  const [localRuntimeModels, setLocalRuntimeModels] = useState<LocalRuntimeModelCatalogMap | null>(
    null
  );

  const {
    setModel,
    clearModel,
    getAvailableProviders,
    getLocalRuntimeStatuses,
    getLocalRuntimeModels,
    getSelectedModel,
    getSelectedProvider,
    setProviderSettings,
  } = useAssistantPreferencesStore();
  const selectedModel = useAssistantPreferencesStore((state) => state.selectedModel);
  const draftRuntimeByThreadId = useAssistantThreadStore((state) => state.draftRuntimeByThreadId);
  const setThreadDraftRuntime = useAssistantThreadStore((state) => state.setThreadDraftRuntime);
  const enabledModelsByProvider = useAssistantPreferencesStore(
    (state) => state.enabledModelsByProvider
  );
  const providerSettings = useAssistantPreferencesStore((state) => state.providerSettings);
  const observationalMemorySettings = useAssistantMemoryPreferencesStore(
    (state) => state.observationalMemory
  );
  const semanticRecallSettings = useAssistantMemoryPreferencesStore(
    (state) => state.semanticRecall
  );
  const nativeToolStates = useNativeToolPreferencesStore((state) => state.toolStates);
  const setNativeToolEnabled = useNativeToolPreferencesStore((state) => state.setToolEnabled);

  // Subscribe to secrets changes to re-check available providers when API keys change
  const secretsVersion = useSecretsStore((state) => state.secretsVersion);

  // Load model registry from DB for local provider models
  useEnsureModelRegistry();
  const registryModels = useModelRegistryStore((state) => state.models);
  const downloadedModels = useModelRegistryStore((state) => state.downloadedModels);
  const registryError = useModelRegistryStore((state) => state.error);
  const toggleModelInDb = useModelRegistryStore((state) => state.toggleModel);
  const db = usePGliteDatabase();
  const dbInitializing = useDbInitializing();
  const dbError = useDbProviderError();
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const [mcpState, dispatchMcp] = useReducer(mcpReducer, { tools: [], loading: false });
  const mcpTools = mcpState.tools;
  const mcpLoading = mcpState.loading;
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const dispatchMcpIfMounted = useCallback((action: McpAction) => {
    if (isMountedRef.current) {
      dispatchMcp(action);
    }
  }, []);

  // Create a set of DB-enabled model IDs for quick lookup
  const registryEnabledModelIds = useMemo(() => {
    const enabledIds = new Set<string>();
    for (const model of registryModels) {
      if (model.isEnabled && model.capabilities.type === 'llm') {
        enabledIds.add(model.id);
      }
    }
    return enabledIds;
  }, [registryModels]);

  const shouldFallbackToPreferences = useMemo(() => {
    if (dbError || registryError) {
      return true;
    }
    if (!db) {
      return !dbInitializing;
    }
    return false;
  }, [db, dbError, dbInitializing, registryError]);

  const enabledModelIds = useMemo(
    () =>
      buildEnabledModelIdSet({
        shouldFallbackToPreferences,
        configuredProviders,
        enabledModelsByProvider,
        registryEnabledModelIds,
        localRuntimeModels,
      }),
    [
      configuredProviders,
      enabledModelsByProvider,
      localRuntimeModels,
      registryEnabledModelIds,
      shouldFallbackToPreferences,
    ]
  );
  const enabledBuiltInLocalModelIds = useMemo(() => {
    const modelIds = new Set<string>();
    addValuesToSet(
      modelIds,
      getBuiltInLocalPreferenceModelIds(enabledModelsByProvider).filter(
        (modelId) => downloadedModels[modelId] === true
      )
    );
    addValuesToSet(
      modelIds,
      getEnabledBuiltInLocalRegistryModelIds(downloadedModels, registryModels)
    );
    return [...modelIds];
  }, [downloadedModels, enabledModelsByProvider, registryModels]);

  const runtimeLlmModelsByProvider = useMemo<
    Partial<Record<LocalRuntimeProviderId, readonly LlmProviderModelDefinition[]>>
  >(
    () => ({
      ollama: toRuntimeProviderModels('ollama', localRuntimeModels),
      lmstudio: toRuntimeProviderModels('lmstudio', localRuntimeModels),
    }),
    [localRuntimeModels]
  );

  const getProviderLlmModels = useCallback(
    (provider: SupportedProvider): readonly LlmProviderModelDefinition[] => {
      if (isLocalRuntimeProvider(provider)) {
        return runtimeLlmModelsByProvider[provider] ?? [];
      }
      return getProviderModelDefinitions(provider).filter(
        (model: ProviderModelDefinition): model is LlmProviderModelDefinition =>
          model.type === 'llm'
      );
    },
    [runtimeLlmModelsByProvider]
  );

  const selectedThreadDraftRuntime = memoryThreadId
    ? draftRuntimeByThreadId[memoryThreadId]
    : undefined;
  const selectedDraftModel =
    selectedThreadDraftRuntime?.provider && selectedThreadDraftRuntime.model
      ? `${selectedThreadDraftRuntime.provider}::${selectedThreadDraftRuntime.model}`
      : undefined;
  const currentModel = selectedDraftModel ?? selectedModel;
  const selectedProvider = useMemo(
    () => resolveProviderFromComposite(currentModel),
    [currentModel]
  );
  const resolvedModelName = useMemo(
    () => resolveModelNameFromComposite(currentModel),
    [currentModel]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const desktopWindow = window as Window & {
      desktopLifecycle?: {
        isTestMode?: boolean;
      };
    };
    if (!desktopWindow.desktopLifecycle?.isTestMode) {
      return;
    }

    const hooks = {
      setCurrentThreadModel: (compositeKey: string): void => {
        const provider = resolveProviderFromComposite(compositeKey);
        const model = resolveModelNameFromComposite(compositeKey);
        if (!(provider && model)) {
          throw new Error(`Invalid assistant model key: ${compositeKey}`);
        }

        setModel(compositeKey);
        if (memoryThreadId) {
          setThreadDraftRuntime(memoryThreadId, { model, provider });
        }
      },
    };

    window.__brainstrikeAssistantRuntimeTestHooks__ = hooks;
    return () => {
      if (window.__brainstrikeAssistantRuntimeTestHooks__ === hooks) {
        window.__brainstrikeAssistantRuntimeTestHooks__ = undefined;
      }
    };
  }, [memoryThreadId, setModel, setThreadDraftRuntime]);

  const effectiveProviderSettings = useMemo(() => {
    const draftProviderSettings = selectedThreadDraftRuntime?.providerSettings;
    if (!draftProviderSettings) {
      return providerSettings;
    }
    return {
      ...providerSettings,
      ...copyProviderSettingsMap(draftProviderSettings),
    };
  }, [providerSettings, selectedThreadDraftRuntime?.providerSettings]);
  const selectedProviderSettings = selectedProvider
    ? effectiveProviderSettings[selectedProvider]
    : undefined;
  const modelSettings = useMemo(
    () => selectedThreadDraftRuntime?.modelSettings ?? buildModelSettings(selectedProviderSettings),
    [selectedProviderSettings, selectedThreadDraftRuntime?.modelSettings]
  );
  // Resolve the selected model's budget definition from the runtime model list.
  // Using the runtime list (not getLlmModelDefinition) covers both static registry
  // models AND dynamically-discovered ollama/lmstudio models, which have a conservative
  // contextWindow floor set by toRuntimeProviderModels.
  const selectedModelBudgetDef = useMemo<SelectedModelBudgetDef | undefined>(() => {
    if (!(selectedProvider && resolvedModelName)) {
      return;
    }
    const modelDef = getProviderLlmModels(selectedProvider).find(
      (m: LlmProviderModelDefinition) => m.id === resolvedModelName
    );
    if (!modelDef) {
      return;
    }
    return {
      contextWindow: modelDef.contextWindow,
      ...(modelDef.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: modelDef.maxOutputTokens }),
    };
  }, [getProviderLlmModels, resolvedModelName, selectedProvider]);

  const agentLoopSettings = useMemo(
    () => buildAgentLoopSettings(selectedProviderSettings, selectedModelBudgetDef),
    [selectedModelBudgetDef, selectedProviderSettings]
  );
  const assistantMemoryOptions = useMemo(
    () => buildAssistantMemoryOptions(selectedProviderSettings),
    [selectedProviderSettings]
  );
  const providerOptions = useMemo(
    () =>
      selectedThreadDraftRuntime?.providerOptions ??
      buildProviderOptions(selectedProvider, resolvedModelName, selectedProviderSettings),
    [
      selectedProvider,
      resolvedModelName,
      selectedProviderSettings,
      selectedThreadDraftRuntime?.providerOptions,
    ]
  );

  useEffect(() => {
    if (!(memoryThreadId && selectedProvider && resolvedModelName)) {
      return;
    }
    if (draftRuntimeByThreadId[memoryThreadId]) {
      return;
    }
    setThreadDraftRuntime(memoryThreadId, {
      provider: selectedProvider,
      model: resolvedModelName,
    });
  }, [
    draftRuntimeByThreadId,
    memoryThreadId,
    resolvedModelName,
    selectedProvider,
    setThreadDraftRuntime,
  ]);

  const currentFolderId = useFileExplorerStoreSelector((s) => s.currentFolderId);
  const rootDirectoryHandle = useFileExplorerStoreSelector((s) => s.rootDirectoryHandle);
  const setSelectedFiles = useFileExplorerStoreSelector((s) => s.setSelectedFiles);
  const addMultipleSelectedFiles = useFileExplorerStoreSelector((s) => s.addMultipleSelectedFiles);
  const removeMultipleSelectedFiles = useFileExplorerStoreSelector(
    (s) => s.removeMultipleSelectedFiles
  );
  const clearSelectionRules = useFileExplorerStoreSelector((s) => s.clearSelectionRules);
  const { effectiveSelection } = useSelectionManager();
  const effectiveSelectionRef = useRef(effectiveSelection);
  const workspaceContextSnapshot = useWorkspaceContextCurationStore(
    (state) => state.contextSnapshot
  );
  const runtimeWorkspaceContext = useMemo(
    () => toRuntimeWorkspaceContext(workspaceContextSnapshot, currentFolderId),
    [currentFolderId, workspaceContextSnapshot]
  );
  const setTapestryRangesForKey = useWorkspaceContextCurationStore(
    (state) => state.setTapestryRangesForKey
  );

  useEffect(() => {
    effectiveSelectionRef.current = effectiveSelection;
  }, [effectiveSelection]);

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

  const handleSelectionUpdate = useCallback(
    (
      payload: AssistantSelectionUpdatePayload | AssistantWorkspaceContextSelectionUpdatePayload
    ) => {
      if (!(payload.folderId && Array.isArray(payload.filePaths) && payload.filePaths.length > 0)) {
        return;
      }
      const mode = payload.mode ?? 'add';
      const normalizedPaths: string[] = Array.from(
        new Set(
          payload.filePaths
            .map((filePath: unknown) => normalizeWorkspaceLookupPath(String(filePath)))
            .filter((path: string) => path.length > 0)
            .map((path: string) => (path.startsWith('/') ? path : `/${path}`))
        )
      );
      if (normalizedPaths.length === 0) {
        return;
      }

      if (mode === 'add') {
        addMultipleSelectedFiles(payload.folderId, normalizedPaths);
        return;
      }
      if (mode === 'remove') {
        removeMultipleSelectedFiles(payload.folderId, normalizedPaths);
        return;
      }

      clearSelectionRules();
      const next = new Set<string>();
      for (const compositeKey of effectiveSelectionRef.current) {
        try {
          const decoded = decodeFileSelection(compositeKey);
          if (decoded.folderId !== payload.folderId) {
            next.add(compositeKey);
          }
        } catch {
          next.add(compositeKey);
        }
      }
      for (const path of normalizedPaths) {
        next.add(encodeFileSelection(payload.folderId, path));
      }
      setSelectedFiles(next);
    },
    [addMultipleSelectedFiles, clearSelectionRules, removeMultipleSelectedFiles, setSelectedFiles]
  );

  const handleTapestryUpdate = useCallback(
    (payload: AssistantWorkspaceTapestryUpdatePayload) => {
      if (!(payload.folderId && Array.isArray(payload.updates) && payload.updates.length > 0)) {
        return;
      }
      const mode = payload.mode ?? 'replace';
      for (const update of payload.updates) {
        const normalizedPath = normalizeWorkspaceLookupPath(String(update.path));
        if (normalizedPath.length === 0) {
          continue;
        }
        const path = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
        const compositeKey = encodeFileSelection(payload.folderId, path);
        const nextRanges =
          mode === 'clear'
            ? []
            : update.ranges.map((range, index) =>
                buildAssistantTapestryRange({
                  ...(range.color ? { color: range.color } : {}),
                  compositeKey,
                  endLine: range.endLine,
                  index,
                  isActive: range.isActive,
                  startLine: range.startLine,
                })
              );
        const existingRanges =
          useWorkspaceContextCurationStore.getState().tapestryRangesByKey[compositeKey] ?? [];
        setTapestryRangesForKey(
          compositeKey,
          mode === 'add' ? [...existingRanges, ...nextRanges] : nextRanges
        );
      }
    },
    [setTapestryRangesForKey]
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.tools?.onRootTreeSelectionUpdate) {
      return;
    }

    const unsubscribe = window.tools.onRootTreeSelectionUpdate(
      (payload: AssistantSelectionUpdatePayload) => {
        handleSelectionUpdate(payload);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [handleSelectionUpdate]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.tools?.onPreviewContextSelectionUpdate) {
      return;
    }

    const unsubscribe = window.tools.onPreviewContextSelectionUpdate(
      (payload: AssistantSelectionUpdatePayload) => {
        handleSelectionUpdate(payload);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [handleSelectionUpdate]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.tools?.onWorkspaceContextSelectionUpdate) {
      return;
    }

    const unsubscribe = window.tools.onWorkspaceContextSelectionUpdate(
      (payload: AssistantWorkspaceContextSelectionUpdatePayload) => {
        handleSelectionUpdate(payload);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [handleSelectionUpdate]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.tools?.onWorkspaceContextTapestryUpdate) {
      return;
    }

    const unsubscribe = window.tools.onWorkspaceContextTapestryUpdate(
      (payload: AssistantWorkspaceTapestryUpdatePayload) => {
        handleTapestryUpdate(payload);
      }
    );

    return () => {
      unsubscribe?.();
    };
  }, [handleTapestryUpdate]);

  const nativeToolItems = useMemo<AssistantToolMenuItem[]>(
    () =>
      Object.entries(NATIVE_TOOL_DEFAULTS).map(([toolId, metadata]) => {
        const category =
          typeof (metadata as { category?: unknown }).category === 'string'
            ? (metadata as { category: string }).category
            : undefined;
        const inputSchema = toLocalRuntimeInputSchema(toolId);

        return {
          id: toolId,
          label: formatToolLabel(toolId),
          enabled: typeof nativeToolStates[toolId] === 'boolean' ? nativeToolStates[toolId] : true,
          source: 'native',
          group: 'Native Tools',
          description: getToolDescription(toolId),
          ...(inputSchema ? { inputSchema } : {}),
          isLocalRuntimeRunnable: true,
          ...(category ? { category } : {}),
        };
      }),
    [nativeToolStates]
  );
  const enabledNativeToolIds = useMemo(
    () => nativeToolItems.filter((tool) => tool.enabled !== false).map((tool) => tool.id),
    [nativeToolItems]
  );

  const loadMcpTools = useCallback(async () => {
    if (typeof window === 'undefined' || !window.mcp?.listTools) {
      dispatchMcpIfMounted({ type: 'LOADED', tools: [] });
      return;
    }

    dispatchMcpIfMounted({ type: 'LOADING' });
    try {
      const toolsByServer = (await window.mcp.listTools()) as McpToolMap;
      dispatchMcpIfMounted({ type: 'LOADED', tools: buildMcpMenuItems(toolsByServer) });
    } catch {
      dispatchMcpIfMounted({ type: 'ERROR' });
    }
  }, [dispatchMcpIfMounted]);

  useEffect(() => {
    void loadMcpTools();
  }, [loadMcpTools]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.mcp?.onToolsUpdated) {
      return;
    }

    return window.mcp.onToolsUpdated((toolsByServer: McpToolMap) => {
      dispatchMcpIfMounted({ type: 'LOADED', tools: buildMcpMenuItems(toolsByServer) });
    });
  }, [dispatchMcpIfMounted]);

  const toolMenuItems = useMemo(
    () => [...nativeToolItems, ...mcpTools],
    [nativeToolItems, mcpTools]
  );

  const toolSourceById = useMemo(() => {
    const entries = toolMenuItems.map((tool) => [tool.id, tool.source] as const);
    return new Map(entries);
  }, [toolMenuItems]);

  const handleToggleTool = useCallback(
    async (toolId: string, enabled: boolean) => {
      const source = toolSourceById.get(toolId);
      if (!source) {
        return;
      }
      if (source === 'native') {
        setNativeToolEnabled(toolId, enabled);
        return;
      }

      if (enabled) {
        await window.mcp?.enableTools?.([toolId]);
      } else {
        await window.mcp?.disableTools?.([toolId]);
      }
      await loadMcpTools();
    },
    [toolSourceById, setNativeToolEnabled, loadMcpTools]
  );

  const handleOpenToolSettings = useCallback(() => {
    setActiveTab('settings');
    if (typeof window !== 'undefined') {
      window.location.hash = '#settings/ai-tools';
    }
  }, [setActiveTab]);

  const canRefreshMcp =
    typeof window !== 'undefined' && typeof window.mcp?.listTools === 'function';

  const toolMenu = useMemo<AssistantToolMenuConfig>(() => {
    const summary = toolMenuItems.length
      ? `${toolMenuItems.filter((tool) => tool.enabled).length} of ${toolMenuItems.length} enabled`
      : undefined;

    return {
      items: toolMenuItems,
      isLoading: mcpLoading,
      onToggleTool: handleToggleTool,
      onOpenSettings: handleOpenToolSettings,
      ...(summary ? { summary } : {}),
      ...(canRefreshMcp ? { onRefresh: loadMcpTools } : {}),
    };
  }, [
    canRefreshMcp,
    handleOpenToolSettings,
    handleToggleTool,
    loadMcpTools,
    mcpLoading,
    toolMenuItems,
  ]);

  const workspaceRootPath = rootDirectoryHandle?.path ?? null;
  const workspaceIndexEmbeddingSetId = useBackgroundIndexingPreferencesStore(
    (state) => state.managedCollectionId
  );
  const workspaceIndexingEnabled = useBackgroundIndexingPreferencesStore((state) => state.enabled);
  const workspaceIndexingMode = useBackgroundIndexingPreferencesStore((state) => state.mode);
  const workspaceIndexingPaused = useBackgroundIndexingPreferencesStore((state) => state.paused);
  const workspaceIndexStatusState = useWorkspaceCollectionSyncStatusStore((state) => state.state);
  const workspaceIndexBlockedReason = useWorkspaceCollectionSyncStatusStore(
    (state) => state.blockedReason
  );
  const workspaceIndexLastError = useWorkspaceCollectionSyncStatusStore((state) => state.lastError);
  const workspaceIndexQueueProgress = useWorkspaceCollectionSyncStatusStore(
    (state) => state.queueProgress
  );
  const workspaceIndex = useMemo(
    () => ({
      blockedReason: workspaceIndexBlockedReason,
      enabled: workspaceIndexingEnabled,
      embeddingSetId: workspaceIndexEmbeddingSetId,
      lastError: workspaceIndexLastError,
      mode: workspaceIndexingMode,
      paused: workspaceIndexingPaused,
      queueProgress: workspaceIndexQueueProgress,
      statusState: workspaceIndexStatusState,
    }),
    [
      workspaceIndexBlockedReason,
      workspaceIndexEmbeddingSetId,
      workspaceIndexLastError,
      workspaceIndexQueueProgress,
      workspaceIndexStatusState,
      workspaceIndexingEnabled,
      workspaceIndexingMode,
      workspaceIndexingPaused,
    ]
  );
  const assistantThreadRepository = useMemo(
    () => (db ? createPgliteAssistantThreadRepository(db) : null),
    [db]
  );
  const selectedThreadByResourceId = useAssistantThreadStore(
    (state) => state.selectedThreadByResourceId
  );
  const loadStateByResourceId = useAssistantThreadStore((state) => state.loadStateByResourceId);
  const ensureResourceThreads = useAssistantThreadStore((state) => state.ensureResourceThreads);
  const memoryResourceId = memoryResourceIdOverride ?? workspaceRootPath ?? undefined;
  const selectedMemoryThreadId = memoryResourceId
    ? (memoryThreadId ?? selectedThreadByResourceId[memoryResourceId])
    : undefined;
  const memoryLoadState = memoryResourceId
    ? (loadStateByResourceId[memoryResourceId] ?? { status: 'idle' as const })
    : null;
  const desktopAssistantBackendAvailable = hasDesktopAssistantBackend();
  const hostedMemoryBackendAvailable =
    selectedProvider === 'local' ? true : desktopAssistantBackendAvailable;

  useEffect(() => {
    if (!(assistantThreadRepository && memoryResourceId)) {
      return;
    }
    ensureResourceThreads(assistantThreadRepository, memoryResourceId).catch(() => {
      // The store records the explicit error state; the assistant remains unavailable.
    });
  }, [assistantThreadRepository, ensureResourceThreads, memoryResourceId]);

  const historyAdapter = useMemo(() => {
    if (!(assistantThreadRepository && memoryResourceId && selectedMemoryThreadId)) {
      return;
    }
    return createAssistantThreadHistoryAdapter({
      repository: assistantThreadRepository,
      resourceId: memoryResourceId,
      threadId: selectedMemoryThreadId,
    });
  }, [assistantThreadRepository, memoryResourceId, selectedMemoryThreadId]);

  const runtimeMemorySettings = useMemo(
    () => ({
      observationalMemory: observationalMemorySettings,
      semanticRecall: semanticRecallSettings,
    }),
    [observationalMemorySettings, semanticRecallSettings]
  );

  const requestData = useMemo(
    () =>
      buildAssistantRequestData({
        agentLoopSettings,
        enabledNativeToolIds,
        hostedMemoryBackendAvailable,
        memoryOptions: assistantMemoryOptions,
        memoryResourceId,
        memorySettings: runtimeMemorySettings,
        modelSettings,
        providerOptions,
        selectedMemoryThreadId,
        selectionData,
        workspaceContext: runtimeWorkspaceContext,
        workspaceIndex,
        workspaceRootPath,
      }),
    [
      agentLoopSettings,
      assistantMemoryOptions,
      enabledNativeToolIds,
      hostedMemoryBackendAvailable,
      memoryResourceId,
      modelSettings,
      providerOptions,
      runtimeMemorySettings,
      selectedMemoryThreadId,
      selectionData,
      runtimeWorkspaceContext,
      workspaceIndex,
      workspaceRootPath,
    ]
  );

  const assistantForegroundActivityLeaseByRunIdRef = useRef(
    new Map<string, AssistantForegroundActivityLease>()
  );
  // The run currently streaming (runs are serialized per panel). Stream
  // activity renews ONLY this run's lease — renewing all leases would let an
  // unrelated active run keep a leaked sibling lease alive indefinitely.
  const activeAssistantForegroundRunIdRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      for (const lease of assistantForegroundActivityLeaseByRunIdRef.current.values()) {
        lease.release();
      }
      assistantForegroundActivityLeaseByRunIdRef.current.clear();
      activeAssistantForegroundRunIdRef.current = null;
    },
    []
  );
  const renewActiveAssistantForegroundActivity = useCallback(() => {
    const runId = activeAssistantForegroundRunIdRef.current;
    if (!runId) {
      return;
    }
    assistantForegroundActivityLeaseByRunIdRef.current.get(runId)?.renew();
  }, []);

  const prepareRequestData = useCallback(async (): Promise<Record<string, unknown>> => {
    const runId = await createAssistantThreadRunPromise({
      assistantThreadRepository,
      memoryResourceId,
      modelSettings,
      providerOptions,
      resolvedModelName,
      selectedMemoryThreadId,
      selectedProvider,
    });
    const memoryContext = requestData['memory'];
    if (!(memoryContext && typeof memoryContext === 'object' && !Array.isArray(memoryContext))) {
      throw new Error('Assistant request preparation requires Mastra memory context.');
    }
    if (runId) {
      assistantForegroundActivityLeaseByRunIdRef.current.get(runId)?.release();
      assistantForegroundActivityLeaseByRunIdRef.current.set(
        runId,
        acquireAssistantForegroundActivity({
          onExpired: () => {
            assistantForegroundActivityLeaseByRunIdRef.current.delete(runId);
            if (activeAssistantForegroundRunIdRef.current === runId) {
              activeAssistantForegroundRunIdRef.current = null;
            }
          },
        })
      );
      activeAssistantForegroundRunIdRef.current = runId;
    }

    return {
      ...requestData,
      memory: {
        ...memoryContext,
        ...(runId ? { runId } : {}),
      },
    };
  }, [
    assistantThreadRepository,
    memoryResourceId,
    modelSettings,
    providerOptions,
    requestData,
    resolvedModelName,
    selectedMemoryThreadId,
    selectedProvider,
  ]);

  const completePreparedRequest = useCallback(
    async (
      preparedRequestData: Record<string, unknown> | undefined,
      status: 'cancelled' | 'completed' | 'failed',
      error?: string
    ): Promise<void> => {
      const runId = extractPreparedRunId(preparedRequestData);
      if (!runId) {
        return;
      }
      if (!assistantThreadRepository) {
        throw new Error('Assistant run completion requires an active thread repository.');
      }
      try {
        await assistantThreadRepository.completeThreadRun(runId, {
          status,
          ...(error ? { error } : {}),
        });
      } finally {
        assistantForegroundActivityLeaseByRunIdRef.current.get(runId)?.release();
        assistantForegroundActivityLeaseByRunIdRef.current.delete(runId);
        if (activeAssistantForegroundRunIdRef.current === runId) {
          activeAssistantForegroundRunIdRef.current = null;
        }
      }
    },
    [assistantThreadRepository]
  );

  // Check if a model is enabled - always use DB as source of truth
  const isModelEnabled = useCallback(
    (_providerId: SupportedProvider, modelId: string): boolean => enabledModelIds.has(modelId),
    [enabledModelIds]
  );

  const providerHasEnabledModels = useCallback(
    (provider: SupportedProvider) => {
      if (provider === 'local' && enabledBuiltInLocalModelIds.length > 0) {
        return true;
      }
      const modelDefinitions = getProviderLlmModels(provider);
      return modelDefinitions.some((model: LlmProviderModelDefinition) =>
        enabledModelIds.has(model.id)
      );
    },
    [enabledBuiltInLocalModelIds, enabledModelIds, getProviderLlmModels]
  );

  const selectModelForProvider = useCallback(
    (provider: SupportedProvider) => {
      const modelToSelect =
        resolveProviderModelSelection({
          getProviderLlmModels,
          isModelEnabled,
          provider,
        }) ?? (provider === 'local' ? enabledBuiltInLocalModelIds[0] : undefined);
      if (!modelToSelect) {
        return;
      }
      setModel(`${provider}::${modelToSelect}`);
    },
    [enabledBuiltInLocalModelIds, getProviderLlmModels, isModelEnabled, setModel]
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

    const labelByRuntime = {
      ollama: 'Ollama',
      lmstudio: 'LM Studio',
    } as const;

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
  }, [localRuntimeStatuses, localRuntimeModels]);

  const shouldSkipSelectionReconcile = useCallback(
    (currentProvider: SupportedProvider | null) =>
      configuredProviders.length === 0 && !isLocalRuntimeProvider(currentProvider),
    [configuredProviders]
  );

  const hasValidCurrentModelSelection = useCallback(
    (currentProvider: SupportedProvider) =>
      hasValidProviderModelSelection({
        currentProvider,
        currentSelectedModel: getSelectedModel(),
        isModelEnabled,
      }),
    [getSelectedModel, isModelEnabled]
  );

  const handleLocalRuntimeSelection = useCallback(
    (currentProvider: SupportedProvider): boolean =>
      resolveLocalRuntimeSelection({
        currentProvider,
        currentSelectedModel: getSelectedModel(),
        isModelEnabled,
        providerHasEnabledModels,
        selectModelForProvider,
      }),
    [getSelectedModel, isModelEnabled, providerHasEnabledModels, selectModelForProvider]
  );

  const seedBuiltInLocalModelSelection = useCallback((): boolean => {
    if (selectedModel !== null || !configuredProviders.includes('local')) {
      return false;
    }
    const localModel = enabledBuiltInLocalModelIds[0];
    if (!(localModel && enabledModelIds.has(localModel))) {
      return false;
    }
    setModel(`local::${localModel}`);
    return true;
  }, [configuredProviders, enabledBuiltInLocalModelIds, enabledModelIds, selectedModel, setModel]);

  // Reconcile selection whenever providers or enabled models change.
  // Using useEffect (not useLayoutEffect) because we're mutating external state (Zustand store)
  // React will properly batch these updates and handle them in the commit phase
  useEffect(() => {
    if (seedBuiltInLocalModelSelection()) {
      return;
    }

    const currentProvider = getSelectedProvider();
    if (shouldSkipSelectionReconcile(currentProvider)) {
      return;
    }

    // Case 1: Current provider is no longer available
    if (currentProvider && !configuredProviders.includes(currentProvider)) {
      if (isLocalRuntimeProvider(currentProvider)) {
        return;
      }
      clearModel();
      return;
    }

    if (currentProvider && handleLocalRuntimeSelection(currentProvider)) {
      return;
    }

    // Case 2: Current provider exists and has enabled models - nothing to do
    if (
      currentProvider &&
      providerHasEnabledModels(currentProvider) &&
      hasValidCurrentModelSelection(currentProvider)
    ) {
      return;
    }

    // Case 3: Find the first provider with enabled models
    const next = findFirstProviderWithEnabledModels(configuredProviders, providerHasEnabledModels);
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
    enabledModelIds,
    handleLocalRuntimeSelection,
    hasValidCurrentModelSelection,
    getSelectedProvider,
    clearModel,
    providerHasEnabledModels,
    seedBuiltInLocalModelSelection,
    selectModelForProvider,
    shouldSkipSelectionReconcile,
  ]);

  const handleModelChange = useCallback(
    (compositeKey: string) => {
      const provider = resolveProviderFromComposite(compositeKey);
      const model = resolveModelNameFromComposite(compositeKey);
      if (memoryThreadId && provider && model) {
        const draftProviderSettings = draftRuntimeByThreadId[memoryThreadId]?.providerSettings;
        const providerSettingsMap =
          copyProviderSettingsMap(draftProviderSettings) ??
          (providerSettings[provider] ? { [provider]: { ...providerSettings[provider] } } : {});
        setThreadDraftRuntime(memoryThreadId, {
          ...buildDraftRuntimeForProvider({
            model,
            provider,
            providerSettingsMap,
          }),
        });
        return;
      }
      setModel(compositeKey);
    },
    [draftRuntimeByThreadId, memoryThreadId, providerSettings, setModel, setThreadDraftRuntime]
  );

  const handleModelToggle = useCallback(
    (providerId: string, modelId: string, enabled: boolean) => {
      if (!isSupportedProvider(providerId)) {
        return;
      }

      if (isLocalRuntimeProvider(providerId)) {
        return;
      }

      // Always use database as the source of truth for model enabled state
      if (db) {
        void toggleModelInDb(db, modelId, enabled);
      }
    },
    [db, toggleModelInDb]
  );

  const handleProviderSettingsChange = useCallback(
    (providerId: string, updates: AssistantProviderSettingsUpdate) => {
      if (!isSupportedProvider(providerId)) {
        return;
      }
      if (memoryThreadId) {
        const currentDraft = draftRuntimeByThreadId[memoryThreadId] ?? {};
        const nextProviderSettings = copyProviderSettingsMap(currentDraft.providerSettings) ?? {};
        nextProviderSettings[providerId] = mergeAssistantProviderSettings(
          currentDraft.providerSettings?.[providerId] ?? providerSettings[providerId],
          updates
        );
        const draftProviderCandidate = currentDraft.provider ?? selectedProvider ?? providerId;
        const draftProvider = isSupportedProvider(draftProviderCandidate)
          ? draftProviderCandidate
          : providerId;
        const draftModel = currentDraft.model ?? resolvedModelName;
        setThreadDraftRuntime(memoryThreadId, {
          ...currentDraft,
          ...buildDraftRuntimeForProvider({
            model: draftModel,
            provider: draftProvider,
            providerSettingsMap: nextProviderSettings,
          }),
        });
        return;
      }
      setProviderSettings(providerId, updates);
    },
    [
      draftRuntimeByThreadId,
      memoryThreadId,
      providerSettings,
      resolvedModelName,
      selectedProvider,
      setProviderSettings,
      setThreadDraftRuntime,
    ]
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
      const modelDefinitions = getProviderLlmModels(providerId);

      const models = modelDefinitions.map((model: LlmProviderModelDefinition) => ({
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
  }, [configuredProviders, getProviderLlmModels, isModelEnabled]);

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
      const modelDefinitions = getProviderLlmModels(providerId);

      for (const model of modelDefinitions) {
        // Check enabled status using the unified helper
        if (!isModelEnabled(providerId, model.id)) {
          continue;
        }

        models.push({
          capabilities: {
            streaming: model.supportsStreaming ?? false,
            type: 'llm',
          },
          contextWindow: model.contextWindow,
          description: null, // LLM models don't have descriptions in the agent definitions
          id: model.id,
          name: model.label ?? model.id,
          providerId,
        });
      }
    }

    return models;
  }, [configuredProviders, getProviderLlmModels, isModelEnabled]);

  const isProviderReady = Boolean(
    selectedProvider && currentModel && configuredProviders.includes(selectedProvider)
  );
  const memoryDisabledReason = useMemo(
    () =>
      resolveAssistantMemoryDisabledReason({
        assistantThreadRepository,
        dbError,
        dbInitializing,
        desktopAssistantBackendAvailable,
        memoryLoadState,
        memorySettings: runtimeMemorySettings,
        selectedMemoryThreadId,
        selectedProvider,
        workspaceRootPath,
      }),
    [
      assistantThreadRepository,
      dbError,
      dbInitializing,
      desktopAssistantBackendAvailable,
      memoryLoadState,
      runtimeMemorySettings,
      selectedMemoryThreadId,
      selectedProvider,
      workspaceRootPath,
    ]
  );

  const providerDisabledReason = useMemo(
    () =>
      resolveAssistantProviderDisabledReason({
        configuredProviders,
        currentModel,
        getProviderLlmModels,
        localRuntimeHint,
        providerHasEnabledModels,
        selectedProvider,
      }),
    [
      configuredProviders,
      currentModel,
      getProviderLlmModels,
      localRuntimeHint,
      providerHasEnabledModels,
      selectedProvider,
    ]
  );
  const disabledReason = memoryDisabledReason ?? providerDisabledReason;

  // Record provider token usage keyed by the active memory thread id.
  // Falls back to a stable per-panel constant when no thread is identified
  // (non-memory-backed sessions) so usage is still captured for the current
  // panel and cleared on the next turn or session.
  const handleUsage = useCallback(
    (usage: { inputTokens: number; outputTokens: number }) => {
      const threadId = selectedMemoryThreadId ?? 'active';
      useContextUsageStore.getState().recordUsage(threadId, usage);
    },
    [selectedMemoryThreadId]
  );

  return (
    <AssistantUiPanel
      completePreparedRequest={completePreparedRequest}
      onProviderSettingsChange={handleProviderSettingsChange}
      onStreamActivity={renewActiveAssistantForegroundActivity}
      onUsage={handleUsage}
      pickerModels={pickerModels}
      pickerProviders={pickerProviders}
      prepareRequestData={prepareRequestData}
      providerGroups={providerGroups}
      providerSettings={effectiveProviderSettings}
      requestData={requestData}
      toolMenu={toolMenu}
      {...(historyAdapter ? { historyAdapter } : {})}
      {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})}
      {...(selectedMemoryThreadId ? { threadKey: selectedMemoryThreadId } : {})}
      {...(selectedProvider ? { selectedProvider } : {})}
      {...(currentModel ? { selectedModel: currentModel } : {})}
      disabled={!isProviderReady || Boolean(memoryDisabledReason)}
      onModelChange={handleModelChange}
      onModelToggle={handleModelToggle}
      {...(disabledReason ? { disabledReason } : {})}
    />
  );
}

AssistantUiPanelWrapper.displayName = 'AssistantUiPanelWrapper';
