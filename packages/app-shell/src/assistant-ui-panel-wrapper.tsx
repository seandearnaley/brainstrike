import type { LocalLlmBackendFactory } from '@brainstrike/assistant-contract';
import {
  getProviderModelDefinitions,
  isSupportedProvider,
  type ProviderModelDefinition,
  type SupportedProvider,
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
  type AssistantToolMenuItem,
  AssistantUiPanel,
  hasDesktopLlmHost,
  useContextUsageStore,
} from '@brainstrike/ui/assistant-ui-panel';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from './assistant-memory-repository';
import { useAssistantThreadStore } from './assistant-thread-store';
import {
  addValuesToSet,
  buildAgentLoopSettings,
  buildAssistantMemoryOptions,
  buildAssistantTapestryRange,
  buildDraftRuntimeForProvider,
  buildEnabledModelIdSet,
  buildModelSettings,
  buildProviderOptions,
  copyProviderSettingsMap,
  findFirstProviderWithEnabledModels,
  formatToolLabel,
  getBuiltInLocalPreferenceModelIds,
  getEnabledBuiltInLocalRegistryModelIds,
  getToolDescription,
  hasValidProviderModelSelection,
  isLocalRuntimeProvider,
  type LlmProviderModelDefinition,
  type LocalRuntimeProviderId,
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
import { resolveAssistantWorkspaceResourceId } from './assistant-workspace-resource-id';
import { useAssistantLocalRuntimeCatalog } from './hooks/use-assistant-local-runtime-catalog';
import { useAssistantMcpMenuState } from './hooks/use-assistant-mcp-menu-state';
import { useAssistantModelPickerConfig } from './hooks/use-assistant-model-picker-config';
import { useAssistantRequestLifecycle } from './hooks/use-assistant-request-lifecycle';
import { useAssistantThreadRequestData } from './hooks/use-assistant-thread-request-data';

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
  if (!hasElectronRendererBridge()) {
    return false;
  }
  return Boolean(window.assistant?.url || window.assistant?.getUrl);
}

function hasElectronRendererBridge(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return Boolean((window as Window & { electronAPI?: unknown }).electronAPI);
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
  const { localRuntimeHint, localRuntimeModels } = useAssistantLocalRuntimeCatalog({
    getLocalRuntimeModels,
    getLocalRuntimeStatuses,
  });
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
  const effectiveInputBudget = agentLoopSettings?.inputTokenLimit;
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
  const activeRootIds = useFileExplorerStoreSelector((s) => s.activeRootIds);
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
    // MULTI-ROOT PARTITION: the assistant's file tools are single-root —
    // every path resolves against ONE workspaceRootPath (the focused root).
    // Mixing other roots' paths into the list misattributes same-relative
    // paths to the wrong root (or dangles). Only the FOCUSED root's
    // selections are addressable; the rest are COUNTED so the assistant can
    // say "N selected files are outside this workspace" instead of silently
    // ignoring them.
    const filePaths = new Set<string>();
    const folderIds = new Set<string>();
    let otherRootsCount = 0;
    for (const compositeKey of effectiveSelection) {
      try {
        const decoded = decodeFileSelection(compositeKey);
        if (currentFolderId !== null && decoded.folderId !== currentFolderId) {
          otherRootsCount += 1;
          continue;
        }
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
      otherRootsCount,
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
  const handleOpenToolSettings = useCallback(() => {
    setActiveTab('settings');
    if (typeof window !== 'undefined') {
      window.location.hash = '#settings/ai-tools';
    }
  }, [setActiveTab]);

  const { enabledNativeToolIds, toolMenu } = useAssistantMcpMenuState({
    nativeToolItems,
    onOpenToolSettings: handleOpenToolSettings,
    setNativeToolEnabled,
  });

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
  const defaultMemoryResourceId = resolveAssistantWorkspaceResourceId({
    activeRootIds,
    rootDirectoryPath: workspaceRootPath,
  });
  const memoryResourceId = memoryResourceIdOverride ?? defaultMemoryResourceId ?? undefined;
  const selectedMemoryThreadId = memoryResourceId
    ? (memoryThreadId ?? selectedThreadByResourceId[memoryResourceId])
    : undefined;
  const memoryLoadState = memoryResourceId
    ? (loadStateByResourceId[memoryResourceId] ?? { status: 'idle' as const })
    : null;
  const desktopAssistantBackendAvailable = hasDesktopAssistantBackend();
  const hostedMemoryBackendAvailable =
    selectedProvider === 'local' ? true : desktopAssistantBackendAvailable;
  // Desktop routes built-in local chat through the assistant server (real
  // Mastra loop with persistence/run events; inference proxied to the hidden
  // llm-host). Web has neither bridge and keeps the in-renderer local runtime.
  const localChatTransport: 'data-stream' | 'local-runtime' =
    desktopAssistantBackendAvailable && hasDesktopLlmHost() ? 'data-stream' : 'local-runtime';

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

  const { requestData, runtimeMemorySettings } = useAssistantThreadRequestData({
    agentLoopSettings,
    enabledNativeToolIds,
    hostedMemoryBackendAvailable,
    memoryOptions: assistantMemoryOptions,
    memoryResourceId,
    modelSettings,
    observationalMemorySettings,
    providerOptions,
    runtimeWorkspaceContext,
    selectedMemoryThreadId,
    selectionData,
    semanticRecallSettings,
    workspaceIndex,
    workspaceRootPath,
  });

  const { completePreparedRequest, prepareRequestData, renewActiveAssistantForegroundActivity } =
    useAssistantRequestLifecycle({
      assistantThreadRepository,
      memoryResourceId,
      modelSettings,
      providerOptions,
      requestData,
      resolvedModelName,
      selectedMemoryThreadId,
      selectedProvider,
    });

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

  const { pickerModels, pickerProviders, providerGroups } = useAssistantModelPickerConfig({
    configuredProviders,
    getProviderLlmModels,
    isModelEnabled,
  });

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
      contextWindow={selectedModelBudgetDef?.contextWindow}
      effectiveInputBudget={effectiveInputBudget}
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
      localChatTransport={localChatTransport}
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
