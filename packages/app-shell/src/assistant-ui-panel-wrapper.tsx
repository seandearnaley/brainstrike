import { useEnsureModelRegistry } from '@brainstrike/app-state/hooks/use-model-registry';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/app-state/stores/assistant-memory-preferences-store';
import { useAssistantPreferencesStore } from '@brainstrike/app-state/stores/assistant-preferences-store';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/app-state/stores/background-indexing-preferences-store';
import {
  buildExperimentAssignmentRequest,
  useExperimentAssignmentPreferencesStore,
} from '@brainstrike/app-state/stores/experiment-assignment-preferences-store';
import {
  buildHookTrustRequest,
  hookTrustSelectors,
  useHookTrustStore,
} from '@brainstrike/app-state/stores/hook-trust-store';
import { useModelRegistryStore } from '@brainstrike/app-state/stores/model-registry-store';
import { useNativeToolPreferencesStore } from '@brainstrike/app-state/stores/native-tool-preferences-store';
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import { usePermissionPolicyStore } from '@brainstrike/app-state/stores/permission-policy-store';
import { useSecretsStore } from '@brainstrike/app-state/stores/secrets-store';
import { useSelfImprovementSignalPreferencesStore } from '@brainstrike/app-state/stores/self-improvement-signal-preferences-store';
import {
  buildSkillsContextRequest,
  useSkillsPreferencesStore,
} from '@brainstrike/app-state/stores/skills-preferences-store';
import { useWorkspaceCollectionSyncStatusStore } from '@brainstrike/app-state/stores/workspace-collection-sync-status-store';
import { useWorkspaceInstructionsPreferencesStore } from '@brainstrike/app-state/stores/workspace-instructions-preferences-store';
import type {
  AssistantRunEvent,
  LocalLlmBackendFactory,
  ProviderKeySource,
} from '@brainstrike/assistant-contract';
import {
  isSupportedProvider,
  type SupportedProvider,
} from '@brainstrike/assistant-contract/provider-metadata';
import { NATIVE_TOOL_DEFAULTS } from '@brainstrike/assistant-contract/tool-metadata';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
  createSuspendedRunDiscovery,
  hasDurableAssistantUsageCapability,
  resolveAssistantMemoryResourceId,
  useAssistantThreadStore,
} from '@brainstrike/assistant-data';
import {
  type AssistantProviderSettingsUpdate,
  type AssistantToolMenuItem,
  AssistantUiPanel,
  BudgetGuardrailProvider,
  DebugBundleProvider,
  EditCheckpointProvider,
  hasDesktopLlmHost,
  RunVerdictProvider,
  type ToolApprovalGrantHandlers,
  ToolApprovalGrantProvider,
} from '@brainstrike/assistant-ui';
import { useDbInitializing, useDbProviderError, usePGliteDatabase } from '@brainstrike/db/react';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/file-explorer/selection';
import { useWorkspaceContextCurationStore } from '@brainstrike/file-explorer-ui/preview';
import {
  useFileExplorerStoreSelector,
  useFileSystem,
  useSelectionManager,
} from '@brainstrike/file-explorer-ui/shell';
import type {
  AssistantSelectionUpdatePayload,
  AssistantWorkspaceContextSelectionUpdatePayload,
  AssistantWorkspaceTapestryUpdatePayload,
} from '@brainstrike/types';
import { mergeAssistantProviderSettings, normalizeWorkspaceLookupPath } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import { type OmMeterState, resolveOmMeterState } from './assistant-om-segment';
import { subscribeAssistantToolUpdates } from './assistant-panel/tool-update-subscriptions';
import { useAssistantUsageLedger } from './assistant-panel/use-assistant-usage-ledger';
import { useModelSelectionReconcile } from './assistant-panel/use-model-selection-reconcile';
import { webBodyLimitProps } from './assistant-request-body-limit';
import {
  buildTapestryRangesForUpdate,
  computeReplacedSelection,
  normalizeRootPathForLookup,
  normalizeWriteBackFilePaths,
  resolveWriteBackFolderId,
} from './assistant-selection-write-back';
import {
  addValuesToSet,
  buildAssistantMemoryOptions,
  buildDraftRuntimeForProvider,
  buildEnabledModelIdSet,
  buildModelSettings,
  buildProviderOptionsWhenReady,
  copyProviderSettingsMap,
  type FixedProviderModels,
  formatToolLabel,
  getBuiltInLocalPreferenceModelIds,
  getEnabledBuiltInLocalRegistryModelIds,
  getRuntimeProviderLlmModels,
  getToolDescription,
  isLocalRuntimeProvider,
  type LlmProviderModelDefinition,
  type LocalRuntimeProviderId,
  resolveAdvertisedNativeToolIds,
  resolveAssistantMemoryDisabledReason,
  resolveAssistantProviderDisabledReason,
  resolveComposerAttachmentsAvailability,
  resolveEffectiveObservationalMemorySettings,
  resolveHostedMemoryBackendAvailable,
  resolveModelNameFromComposite,
  resolveProviderFromComposite,
  toLocalRuntimeInputSchema,
  toRuntimeProviderModels,
  toRuntimeWorkspaceContext,
} from './assistant-ui-panel-wrapper-runtime';
import { useChangeset } from './changes/use-changeset';
import { useWrapperRewindWiring } from './changes/use-wrapper-rewind-wiring';
import { useDelegatedConversationRoot } from './delegated-conversation-root';
import { DelegatedWorkspaceNavigation } from './delegated-workspace-apps';
import { useAssistantProviderSource } from './hooks/assistant-provider-source';
import { resolveAssistantBaseUrl } from './hooks/use-assistant-availability';
import { useAssistantLocalRuntimeCatalog } from './hooks/use-assistant-local-runtime-catalog';
import { useAssistantMcpMenuState } from './hooks/use-assistant-mcp-menu-state';
import { useAssistantModelChange } from './hooks/use-assistant-model-change';
import { useAssistantModelPickerConfig } from './hooks/use-assistant-model-picker-config';
import { useAssistantRequestLifecycle } from './hooks/use-assistant-request-lifecycle';
import { useAssistantThreadRequestData } from './hooks/use-assistant-thread-request-data';
import { useAssistantThreadRootBinding } from './hooks/use-assistant-thread-root-binding';
import { useBudgetGuardrailBinding } from './hooks/use-budget-guardrail';
import { useConfiguredAssistantProviders } from './hooks/use-configured-assistant-providers';
import { useDebugBundleBinding } from './hooks/use-debug-bundle';
import { useEditCheckpoints } from './hooks/use-edit-checkpoints';
import { useForgeBranchLookupActivation, useForgeRunEvents } from './hooks/use-forge-run-events';
import { useOpenRouterModelMetadata } from './hooks/use-openrouter-model-metadata';
import { useProviderModelDefaults } from './hooks/use-provider-model-defaults';
import { useRunVerdictBinding } from './hooks/use-run-verdict';
import { useSubagentPersonasRequest } from './hooks/use-subagent-personas-request';
import { useThreadBranchByRootPath } from './hooks/use-thread-branch-by-root-path';
import { useAssistantRunNotifications } from './use-assistant-run-notifications';
import { useAssistantSlashCommands } from './use-assistant-slash-commands';
import { useAssistantThreadTitleSync } from './use-assistant-thread-title-sync';
import { useFileMentions } from './use-file-mentions';
import { useHookTrustScope } from './use-hook-trust-scope';
import { useObservationalMemoryRow } from './use-om-segment-row';
import { hasDesktopAssistantBridge, useSteerActiveRun } from './use-steer-active-run';
import { WorkspaceBarHost } from './workspace-bar/workspace-bar-host';

export interface AssistantUiPanelWrapperProps {
  className?: string;
  fixedProviderModels?: FixedProviderModels;
  loadLocalLlmBackend?: LocalLlmBackendFactory;
  memoryResourceId?: string;
  memoryThreadId?: string;
  providerKeySources?: readonly ProviderKeySource<SupportedProvider>[];
  providerReadErrors?: Partial<Record<SupportedProvider, string>>;
}
const EMPTY_MEMORY_THREADS = [] as const;

declare global {
  interface Window {
    __brainstrikeAssistantRuntimeTestHooks__:
      | {
          setCurrentThreadModel: (compositeKey: string) => void;
        }
      | undefined;
  }
}

function hasDesktopRuntimeBridge(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const desktopWindow = window as Window & {
    desktopLifecycle?: unknown;
  };
  return (
    typeof desktopWindow.desktopLifecycle === 'object' && desktopWindow.desktopLifecycle !== null
  );
}

function hasDesktopAssistantBackend(): boolean {
  // Single source of truth for "durable assistant usage is recorded here"
  // (shared with the cost panel's read-side gate) — see
  // assistant-durable-usage-capability.ts.
  return hasDurableAssistantUsageCapability();
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This integration wrapper coordinates multiple stores, runtime probes, and transport paths in one place.
export function AssistantUiPanelWrapper({
  fixedProviderModels,
  loadLocalLlmBackend,
  memoryResourceId: memoryResourceIdOverride,
  memoryThreadId,
  providerReadErrors,
  providerKeySources,
}: AssistantUiPanelWrapperProps) {
  const providerSource = useAssistantProviderSource();
  const setModel = useAssistantPreferencesStore((state) => state.setModel);
  const clearModel = useAssistantPreferencesStore((state) => state.clearModel);
  const getLocalRuntimeStatuses = useAssistantPreferencesStore(
    (state) => state.getLocalRuntimeStatuses
  );
  const getLocalRuntimeModels = useAssistantPreferencesStore(
    (state) => state.getLocalRuntimeModels
  );
  const getSelectedModel = useAssistantPreferencesStore((state) => state.getSelectedModel);
  const getSelectedProvider = useAssistantPreferencesStore((state) => state.getSelectedProvider);
  const setProviderSettings = useAssistantPreferencesStore((state) => state.setProviderSettings);
  const { localRuntimeHint, localRuntimeModels } = useAssistantLocalRuntimeCatalog({
    getLocalRuntimeModels,
    getLocalRuntimeStatuses,
  });
  const selectedModel = useAssistantPreferencesStore((state) => state.selectedModel);
  const recentModels = useAssistantPreferencesStore((state) => state.recentModels);
  const draftRuntimeByThreadId = useAssistantThreadStore((state) => state.draftRuntimeByThreadId);
  const setThreadDraftRuntime = useAssistantThreadStore((state) => state.setThreadDraftRuntime);
  const enabledModelsByProvider = useAssistantPreferencesStore(
    (state) => state.enabledModelsByProvider
  );
  const providerSettings = useAssistantPreferencesStore((state) => state.providerSettings);
  const storedObservationalMemorySettings = useAssistantMemoryPreferencesStore(
    (state) => state.observationalMemory
  );
  const semanticRecallSettings = useAssistantMemoryPreferencesStore(
    (state) => state.semanticRecall
  );
  const nativeToolStates = useNativeToolPreferencesStore((state) => state.toolStates);
  const setNativeToolEnabled = useNativeToolPreferencesStore((state) => state.setToolEnabled);

  // OpenRouter default initialization still keys its durable attempt on the
  // same credential revision as provider discovery.
  const secretsVersion = useSecretsStore((state) => state.secretsVersion);
  const {
    discoveryError: providerDiscoveryError,
    discoveryState: providerDiscoveryState,
    providers: configuredProviders,
  } = useConfiguredAssistantProviders();

  // Load model registry from DB for local provider models
  useEnsureModelRegistry();
  const registryModels = useModelRegistryStore((state) => state.models);
  const registryProviders = useModelRegistryStore((state) => state.providers);
  const registryHasLoaded = useModelRegistryStore((state) => state.hasLoaded);
  const downloadedModels = useModelRegistryStore((state) => state.downloadedModels);
  const registryError = useModelRegistryStore((state) => state.error);
  const toggleModelInDb = useModelRegistryStore((state) => state.toggleModel);
  const db = usePGliteDatabase();
  const dbInitializing = useDbInitializing();
  const dbError = useDbProviderError();
  const openSettings = usePanelLayoutStore((state) => state.openSettings);

  useProviderModelDefaults(
    configuredProviders,
    db,
    secretsVersion,
    providerSource.kind === 'discovery',
    providerReadErrors
  );

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
        configuredProviders,
        enabledModelsByProvider,
        fixedProviderModels,
        localRuntimeModels,
        registryEnabledModelIds,
        shouldFallbackToPreferences,
      }),
    [
      configuredProviders,
      enabledModelsByProvider,
      fixedProviderModels,
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
      lmstudio: toRuntimeProviderModels('lmstudio', localRuntimeModels),
      ollama: toRuntimeProviderModels('ollama', localRuntimeModels),
    }),
    [localRuntimeModels]
  );

  const getProviderLlmModels = useCallback(
    (provider: SupportedProvider): readonly LlmProviderModelDefinition[] =>
      getRuntimeProviderLlmModels(
        provider,
        runtimeLlmModelsByProvider,
        fixedProviderModels?.[provider]
      ),
    [fixedProviderModels, runtimeLlmModelsByProvider]
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
  const selectedLlmModelDef =
    selectedProvider && resolvedModelName
      ? getProviderLlmModels(selectedProvider).find((model) => model.id === resolvedModelName)
      : undefined;
  const openRouterMetadata = useOpenRouterModelMetadata({
    modelId: resolvedModelName,
    modelSettings,
    providerId: selectedProvider,
    selectedModelDef: selectedLlmModelDef,
    settings: selectedProviderSettings,
  });
  const {
    agentLoopSettings,
    modelDef: openRouterModelDef,
    modelSettings: effectiveModelSettings,
    reason: openRouterDisabledReason,
  } = openRouterMetadata;
  const effectiveInputBudget = agentLoopSettings?.inputTokenLimit;
  const assistantMemoryOptions = useMemo(
    () => buildAssistantMemoryOptions(selectedProviderSettings),
    [selectedProviderSettings]
  );
  const providerOptions = useMemo(
    () =>
      selectedThreadDraftRuntime?.providerOptions ??
      buildProviderOptionsWhenReady(
        openRouterDisabledReason,
        selectedProvider,
        resolvedModelName,
        selectedProviderSettings,
        openRouterMetadata.lookup
      ),
    [
      openRouterDisabledReason,
      openRouterMetadata.lookup,
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
      model: resolvedModelName,
      provider: selectedProvider,
    });
  }, [
    draftRuntimeByThreadId,
    memoryThreadId,
    resolvedModelName,
    selectedProvider,
    setThreadDraftRuntime,
  ]);
  const currentFolderId = useFileExplorerStoreSelector((s) => s.currentFolderId);
  const rootDescriptors = useFileExplorerStoreSelector((s) => s.rootDescriptors);
  // MAIN = request-start operating root; FOCUSED = currentFolderId.
  const mainRootId = useFileExplorerStoreSelector((s) => s.activeRootIds?.[0]);
  const mainRootPath = mainRootId ? rootDescriptors?.[mainRootId]?.path : undefined;
  // Multi-root write-back maps each open path to its client RootId so assistant
  // updates route correctly; the two id spaces share only the path.
  const pathToClientRootId = useMemo(() => {
    const map = new Map<string, string>();
    for (const descriptor of Object.values(rootDescriptors ?? {})) {
      if (descriptor.path) {
        map.set(normalizeRootPathForLookup(descriptor.path), descriptor.rootId);
      }
    }
    return map;
  }, [rootDescriptors]);
  // Focused root handle — reducer-sourced via the FileSystemProvider context.
  const { rootDirectoryHandle } = useFileSystem();
  const setSelectedFiles = useFileExplorerStoreSelector((s) => s.setSelectedFiles);
  const addMultipleSelectedFiles = useFileExplorerStoreSelector((s) => s.addMultipleSelectedFiles);
  const removeMultipleSelectedFiles = useFileExplorerStoreSelector(
    (s) => s.removeMultipleSelectedFiles
  );
  const resetSelectionToExplicit = useFileExplorerStoreSelector((s) => s.resetSelectionToExplicit);
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
    // MULTI-ROOT PARTITION — two distinct root concepts ride each request:
    // - MAIN root (mainRootId/mainRootPath above, activeRootIds[0]): the
    //   assistant's OPERATING root — hooks cwd + model-facing "main root
    //   path". Stable; only "Set as main" or disconnecting the main root
    //   changes it.
    // - FOCUSED root (currentFolderId → workspaceRootPath): SELECTION scope.
    //   Flips on incidental clicks, so it must never drive hooks/model cwd.
    // The selection legs stay focused-root-scoped: every path resolves
    // against ONE workspaceRootPath (the focused root). Mixing other roots'
    // paths into the list misattributes same-relative paths to the wrong
    // root (or dangles). Only the FOCUSED root's selections are addressable;
    // the rest are COUNTED so the assistant can say "N selected files are
    // outside this workspace" instead of silently ignoring them.
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
      // Multi-root: route to the folder the assistant targeted (payload.rootPath
      // → client RootId). Null = the root is not open here; skip, never misroute.
      const targetFolderId = resolveWriteBackFolderId(payload, pathToClientRootId);
      if (!targetFolderId) {
        return;
      }
      const mode = payload.mode ?? 'add';
      const normalizedPaths = normalizeWriteBackFilePaths(payload.filePaths);
      if (normalizedPaths.length === 0) {
        return;
      }

      if (mode === 'add') {
        addMultipleSelectedFiles(targetFolderId, normalizedPaths);
        return;
      }
      if (mode === 'remove') {
        removeMultipleSelectedFiles(targetFolderId, normalizedPaths);
        return;
      }

      resetSelectionToExplicit();
      setSelectedFiles(
        computeReplacedSelection(effectiveSelectionRef.current, targetFolderId, normalizedPaths)
      );
    },
    [
      addMultipleSelectedFiles,
      pathToClientRootId,
      removeMultipleSelectedFiles,
      resetSelectionToExplicit,
      setSelectedFiles,
    ]
  );

  const handleTapestryUpdate = useCallback(
    (payload: AssistantWorkspaceTapestryUpdatePayload) => {
      if (!(payload.folderId && Array.isArray(payload.updates) && payload.updates.length > 0)) {
        return;
      }
      const targetFolderId = resolveWriteBackFolderId(payload, pathToClientRootId);
      if (!targetFolderId) {
        return;
      }
      const mode = payload.mode ?? 'replace';
      for (const update of payload.updates) {
        const normalizedPath = normalizeWorkspaceLookupPath(String(update.path));
        if (normalizedPath.length === 0) {
          continue;
        }
        const path = normalizedPath.startsWith('/') ? normalizedPath : `/${normalizedPath}`;
        const compositeKey = encodeFileSelection(targetFolderId, path);
        const nextRanges = buildTapestryRangesForUpdate(
          update.ranges,
          compositeKey,
          mode === 'clear'
        );
        const existingRanges =
          useWorkspaceContextCurationStore.getState().tapestryRangesByKey[compositeKey] ?? [];
        setTapestryRangesForKey(
          compositeKey,
          mode === 'add' ? [...existingRanges, ...nextRanges] : nextRanges
        );
      }
    },
    [pathToClientRootId, setTapestryRangesForKey]
  );

  // Selection write-back bridge (BST-1652): one subscription over every
  // available channel instead of four copy-pasted effects. See
  // `assistant-panel/tool-update-subscriptions.ts`.
  useEffect(
    () =>
      subscribeAssistantToolUpdates({
        onSelectionUpdate: handleSelectionUpdate,
        onTapestryUpdate: handleTapestryUpdate,
      }),
    [handleSelectionUpdate, handleTapestryUpdate]
  );

  const nativeToolIds = resolveAdvertisedNativeToolIds({
    desktopBridgeAvailable: hasDesktopRuntimeBridge(),
    selectedProvider,
  });
  const nativeToolItems = useMemo<AssistantToolMenuItem[]>(
    () =>
      nativeToolIds.map((toolId) => {
        const metadata = NATIVE_TOOL_DEFAULTS[toolId];
        const category =
          typeof (metadata as { category?: unknown }).category === 'string'
            ? (metadata as { category: string }).category
            : undefined;
        const inputSchema = toLocalRuntimeInputSchema(toolId);

        return {
          description: getToolDescription(toolId),
          enabled: typeof nativeToolStates[toolId] === 'boolean' ? nativeToolStates[toolId] : true,
          group: 'Native Tools',
          id: toolId,
          label: formatToolLabel(toolId),
          source: 'native',
          ...(inputSchema ? { inputSchema } : {}),
          isLocalRuntimeRunnable: true,
          ...(category ? { category } : {}),
        };
      }),
    [nativeToolIds, nativeToolStates]
  );
  const handleOpenToolSettings = useCallback(() => {
    openSettings();
    if (typeof window !== 'undefined') {
      window.location.hash = '#settings/ai-tools';
    }
  }, [openSettings]);

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
  // queueProgress is deliberately NOT live-subscribed: during initial indexing
  // it gets a fresh identity per processed file, and threading it through this
  // memo re-rendered the entire (un-memoized) assistant panel per file. The
  // value baked here is only a render-time snapshot for the initial
  // runtimeData; prepareRequestData re-reads the store FRESH at send time
  // (use-assistant-request-lifecycle), so outgoing requests never see a stale
  // value. state/blockedReason/lastError stay subscribed — they change on
  // state transitions, not per file.
  const workspaceIndex = useMemo(
    () => ({
      blockedReason: workspaceIndexBlockedReason,
      embeddingSetId: workspaceIndexEmbeddingSetId,
      enabled: workspaceIndexingEnabled,
      lastError: workspaceIndexLastError,
      mode: workspaceIndexingMode,
      paused: workspaceIndexingPaused,
      queueProgress: useWorkspaceCollectionSyncStatusStore.getState().queueProgress,
      statusState: workspaceIndexStatusState,
    }),
    [
      workspaceIndexBlockedReason,
      workspaceIndexEmbeddingSetId,
      workspaceIndexLastError,
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
  const refreshResourceThreads = useAssistantThreadStore((state) => state.refreshResourceThreads);
  const memoryResourceId = resolveAssistantMemoryResourceId(memoryResourceIdOverride);
  const memoryThreads = useAssistantThreadStore(
    (state) => state.threadsByResourceId[memoryResourceId] ?? EMPTY_MEMORY_THREADS
  );
  const selectedMemoryThreadId = memoryThreadId ?? selectedThreadByResourceId[memoryResourceId];
  const delegatedRoot = useDelegatedConversationRoot(memoryResourceId, selectedMemoryThreadId);
  const resourceThreadsReady = loadStateByResourceId[memoryResourceId]?.status === 'ready';
  const refreshThreadsAfterRun = useAssistantThreadTitleSync({
    enabled: Boolean(db && !dbInitializing && resourceThreadsReady),
    refreshResourceThreads,
    repository: assistantThreadRepository,
    resourceId: memoryResourceId,
  });
  const { persistThreadRootBinding, resolveThreadRootBinding, threadRootBinding } =
    useAssistantThreadRootBinding({
      assistantThreadRepository,
      ...(mainRootId && rootDescriptors?.[mainRootId]
        ? { currentMainRoot: rootDescriptors[mainRootId] }
        : {}),
      database: db,
      memoryResourceId,
      selectedMemoryThreadId,
    });
  const composerDraftCommand = useAssistantComposerCommandStore((state) =>
    selectedMemoryThreadId ? state.commandsByThreadId[selectedMemoryThreadId]?.[0] : undefined
  );
  const acknowledgeComposerCommand = useAssistantComposerCommandStore((state) => state.acknowledge);
  const recordComposerDraft = useAssistantComposerCommandStore((state) => state.recordDraft);
  const handleComposerCommandApplied = useCallback(
    (commandId: string) => {
      if (!composerDraftCommand || composerDraftCommand.id !== commandId) {
        throw new Error(`Cannot acknowledge unknown composer command: ${commandId}`);
      }
      acknowledgeComposerCommand(composerDraftCommand.threadId, commandId);
    },
    [acknowledgeComposerCommand, composerDraftCommand]
  );
  const handleComposerTextChange = useCallback(
    (text: string) => {
      if (!selectedMemoryThreadId) {
        throw new Error('Cannot record composer text without an active assistant thread.');
      }
      recordComposerDraft(selectedMemoryThreadId, text);
    },
    [recordComposerDraft, selectedMemoryThreadId]
  );
  const memoryLoadState = loadStateByResourceId[memoryResourceId] ?? { status: 'idle' as const };
  const desktopAssistantBackendAvailable = hasDesktopAssistantBackend();
  const hostedMemoryBackendAvailable = resolveHostedMemoryBackendAvailable({
    desktopAssistantBackendAvailable,
    selectedProvider,
  });
  // Resolve the 'auto' observer sentinel into CONCRETE settings once, here —
  // request data, memory validation, and the OM meter all consume the same
  // effective settings, so 'auto' never reaches the provider/model validator
  // and an unresolved auto can never disable thread memory (BST-940). The
  // selected CHAT provider gates hosted-observer resolution (privacy ruling:
  // no new data egress) and the loaded model catalog gates candidate
  // eligibility exactly like the settings dropdown.
  const { autoResolution: omAutoResolution, settings: observationalMemorySettings } = useMemo(
    () =>
      resolveEffectiveObservationalMemorySettings({
        desktopAssistantBackendAvailable,
        ...(registryHasLoaded
          ? {
              isTargetEligible: ({ modelId, provider }: { modelId: string; provider: string }) => {
                const providerRow = registryProviders.find((row) => row.id === provider);
                // OpenRouter targets nest the upstream id ('google/gemini-…')
                // as the registry model id — direct string match covers both.
                const modelRow = registryModels.find(
                  (row) => row.providerId === provider && row.id === modelId
                );
                return (
                  providerRow?.isEnabled === true &&
                  modelRow?.isEnabled === true &&
                  modelRow.capabilities.type === 'llm'
                );
              },
            }
          : {}),
        providerKeySources,
        selectedChatProvider: selectedProvider,
        settings: storedObservationalMemorySettings,
      }),
    [
      desktopAssistantBackendAvailable,
      providerKeySources,
      registryHasLoaded,
      registryModels,
      registryProviders,
      selectedProvider,
      storedObservationalMemorySettings,
    ]
  );
  // Desktop routes built-in local chat through the assistant server (real
  // Mastra loop with persistence/run events; inference proxied to the hidden
  // llm-host). Web has neither bridge and keeps the in-renderer local runtime.
  const localChatTransport: 'data-stream' | 'local-runtime' =
    hasDesktopRuntimeBridge() && desktopAssistantBackendAvailable && hasDesktopLlmHost()
      ? 'data-stream'
      : 'local-runtime';
  // Permission enforcement (OPT-IN) is deliberately NOT read during render.
  // `prepareRequestData` (hooks/use-assistant-request-lifecycle.ts) is the SOLE
  // producer of `permissionPolicyRequest`: it reads the live store at
  // request-composition time and sets the field unconditionally (to the
  // snapshot, or to `undefined` when the posture is off or the transport is not
  // the desktop data-stream server that runs the gate). A render-time snapshot
  // could therefore never reach the wire — it would be overwritten — while a
  // subscription to `sessionGrants`/`perToolOverrides` re-rendered the whole
  // panel on exactly the interaction that must stay responsive: granting
  // "Always allow" / "Allow <category> this session" to unblock a suspended
  // run. See `assistant-ui-panel-wrapper-store-subscription.test.tsx` and the
  // "permission-policy freshness at the request-composition seam" suite.

  // Hook-trust attestation (desktop hooks). Subscribe to the persisted approvals
  // so the wire snapshot stays in sync; the server independently re-hashes disk.
  // Scoped to the desktop data-stream transport (web has no hook runner). The
  // renderer never runs hooks — it only ATTESTS approved hashes.
  //
  // The store is keyed by DB `roots.id`; the attestation is SCOPED to the
  // currently-mounted roots' DB ids (resolved in main from the mounted paths) so
  // a DISCONNECTED root's grant is never presented to the server. Until the scope
  // resolves — or if the resolver bridge is absent — we attest NOTHING (fail
  // closed): a stale grant must never leak, and a brief scope-resolution window
  // is the safe direction.
  const hookApprovalsByRootId = useHookTrustStore(hookTrustSelectors.approvalsByRootId);
  const mountedTrustRootIds = useHookTrustScope({
    enabled: localChatTransport === 'data-stream',
    rootDescriptors,
  });
  const hookTrustRequest = useMemo(() => {
    if (localChatTransport !== 'data-stream') {
      return;
    }
    return buildHookTrustRequest(
      { approvalsByRootId: hookApprovalsByRootId },
      { mountedRootIds: mountedTrustRootIds ?? new Set<string>() }
    );
  }, [localChatTransport, hookApprovalsByRootId, mountedTrustRootIds]);

  // Plan mode (OPT-IN, persisted). Desktop-hosted-first: only the data-stream
  // transport reaches the assistant server that enforces the plan-mode tool gate
  // (web's in-renderer local runtime has no server). Presence-means-on downstream.
  const planModeEnabledPref = useAssistantPreferencesStore((state) => state.planModeEnabled);
  const togglePlanMode = useAssistantPreferencesStore((state) => state.togglePlanMode);
  const setPlanModeEnabled = useAssistantPreferencesStore((state) => state.setPlanModeEnabled);
  // Plan mode is never offered for the built-in local provider (its server gate
  // ignores planMode — see O3), so the composer toggle is hidden there rather
  // than silently no-opping.
  const planModeAvailable = localChatTransport === 'data-stream' && selectedProvider !== 'local';
  const planMode = planModeEnabledPref && planModeAvailable;
  // Image attachments: every HOSTED provider routes through the data-stream
  // server path (desktop assistant server AND the web /api/assistant route
  // share the same image-aware conversion), so only the text-only built-in
  // local provider is excluded — localChatTransport describes the LOCAL
  // provider's transport and must not gate hosted providers on web (review
  // fix). The SELECTED MODEL's vision capability then layers on top: a
  // vision-less model renders a visibly disabled attach button with the
  // reason (never a silent hide).
  const attachmentsAvailability = useMemo(
    () =>
      resolveComposerAttachmentsAvailability({
        providerGateAvailable: selectedProvider !== 'local',
        selectedModel: selectedLlmModelDef,
      }),
    [selectedProvider, selectedLlmModelDef]
  );
  const exitPlanMode = useCallback(() => setPlanModeEnabled(false), [setPlanModeEnabled]);

  // Workspace instructions context-file injection (AGENTS.md/AGENT.md/CLAUDE.md).
  // Desktop-hosted-first: only the data-stream transport reaches the assistant
  // server that performs the fs scan + injection (web's in-renderer local
  // runtime has no server). Attach the persisted preference snapshot as plain
  // JSON; the server reads it directly (a preference, not a security boundary).
  const workspaceInstructionsMasterEnabled = useWorkspaceInstructionsPreferencesStore(
    (state) => state.masterEnabled
  );
  const workspaceInstructionsOversizedOptIns = useWorkspaceInstructionsPreferencesStore(
    (state) => state.oversizedOptInByRootId
  );
  // Subagent persona availability (desktop data-stream only; undefined at defaults).
  const subagentPersonasRequest = useSubagentPersonasRequest(localChatTransport);

  const workspaceInstructionsPreference = useMemo(() => {
    if (localChatTransport !== 'data-stream') {
      return;
    }
    return {
      masterEnabled: workspaceInstructionsMasterEnabled,
      oversizedOptInByRootId: workspaceInstructionsOversizedOptIns,
    };
  }, [
    localChatTransport,
    workspaceInstructionsMasterEnabled,
    workspaceInstructionsOversizedOptIns,
  ]);

  // Opt-in self-improvement signal (desktop data-stream only). The renderer
  // attaches a plain-JSON snapshot; the server strictly parses it and owns the
  // telemetry query and prompt construction.
  const selfImprovementSignalEnabled = useSelfImprovementSignalPreferencesStore(
    (state) => state.enabled
  );
  const selfImprovementSignalPreference = useMemo(() => {
    if (localChatTransport !== 'data-stream') {
      return;
    }
    return { enabled: selfImprovementSignalEnabled };
  }, [localChatTransport, selfImprovementSignalEnabled]);

  // Experiment enrollment (desktop data-stream only, BST-1251): attribution
  // metadata on the treatment row; only a COMPLETE pair rides the wire.
  const enrolledExperimentId = useExperimentAssignmentPreferencesStore(
    (state) => state.experimentId
  );
  const enrolledVariant = useExperimentAssignmentPreferencesStore((state) => state.variant);
  const experimentAssignment = useMemo(() => {
    if (localChatTransport !== 'data-stream') {
      return;
    }
    return buildExperimentAssignmentRequest(enrolledExperimentId, enrolledVariant);
  }, [localChatTransport, enrolledExperimentId, enrolledVariant]);

  // Agent Skills preference (desktop data-stream only — the server builds the
  // skills engine; web has no scan path). A plain-JSON snapshot the server
  // parses strictly; it can only REDUCE the skill set.
  const skillsMasterEnabled = useSkillsPreferencesStore((state) => state.masterEnabled);
  const skillsDisabledKeys = useSkillsPreferencesStore((state) => state.disabledSkillKeys);
  const skillsPreference = useMemo(() => {
    if (localChatTransport !== 'data-stream') {
      return;
    }
    return buildSkillsContextRequest({
      disabledSkillKeys: skillsDisabledKeys,
      masterEnabled: skillsMasterEnabled,
    });
  }, [localChatTransport, skillsDisabledKeys, skillsMasterEnabled]);

  useEffect(() => {
    if (!assistantThreadRepository) {
      return;
    }
    ensureResourceThreads(assistantThreadRepository, memoryResourceId).catch(() => {
      // The store records the explicit error state; the assistant remains unavailable.
    });
  }, [assistantThreadRepository, ensureResourceThreads, memoryResourceId]);

  const historyAdapter = useMemo(() => {
    if (!(assistantThreadRepository && selectedMemoryThreadId)) {
      return;
    }
    // Restart-safe approval rediscovery is desktop-only (web never suspends —
    // no assistant server/storage). Capability gating, no isElectron() check.
    return createAssistantThreadHistoryAdapter({
      repository: assistantThreadRepository,
      resourceId: memoryResourceId,
      threadId: selectedMemoryThreadId,
      ...(desktopAssistantBackendAvailable
        ? { discoverSuspendedRuns: createSuspendedRunDiscovery(resolveAssistantBaseUrl) }
        : {}),
    });
  }, [
    assistantThreadRepository,
    desktopAssistantBackendAvailable,
    memoryResourceId,
    selectedMemoryThreadId,
  ]);

  const { requestData, runtimeMemorySettings } = useAssistantThreadRequestData({
    agentLoopSettings,
    ...(localChatTransport === 'data-stream' && threadRootBinding
      ? { boundWorkspaceRootId: threadRootBinding.rootId }
      : {}),
    enabledNativeToolIds,
    experimentAssignment,
    hookTrustRequest,
    hostedMemoryBackendAvailable,
    mainRootId,
    mainRootPath,
    memoryOptions: assistantMemoryOptions,
    memoryResourceId,
    modelSettings: effectiveModelSettings,
    observationalMemorySettings,
    planMode,
    providerOptions,
    requestedReasoningEffort: selectedProviderSettings?.reasoningEffort,
    runtimeWorkspaceContext,
    selectedMemoryThreadId,
    selectionData,
    selfImprovementSignalPreference,
    semanticRecallSettings,
    skillsPreference,
    subagentPersonasRequest,
    workspaceIndex,
    workspaceInstructionsPreference,
    workspaceRootPath,
  });

  const {
    completePreparedRequest,
    getActiveRunUsageContext,
    getActiveSteerableRunId,
    prepareRequestData,
    renewActiveAssistantForegroundActivity,
  } = useAssistantRequestLifecycle({
    assistantThreadRepository,
    // The focused root id (file-explorer store; same identity space as the DB
    // roots.id). Snapshotted at request start for durable per-root cost.
    focusedRootId: currentFolderId,
    memoryResourceId,
    modelSettings: effectiveModelSettings,
    // Only the desktop data-stream server runs the runtime permission gate;
    // mirrors the `permissionPolicyRequest` useMemo transport gate above.
    permissionEnforceable: localChatTransport === 'data-stream',
    ...(localChatTransport === 'data-stream'
      ? {
          persistThreadRootBinding,
          resolveThreadRootBinding,
          threadRootBinding,
        }
      : {}),
    planModeAvailable,
    providerOptions,
    requestData,
    resolvedModelName,
    selectedMemoryThreadId,
    selectedProvider,
  });
  // Mid-run steer transport (BST-588); the panel receives it only when the
  // desktop repo (and thus the steer control endpoint) exists.
  const steerActiveRun = useSteerActiveRun(getActiveSteerableRunId);

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

  // Model reconcile (BST-1652). The DECISION is a pure function in
  // `assistant-panel/model-selection-reconcile.ts` — every branch unit-tested
  // without React — and this hook only applies it. Previously this was ~115
  // lines of `useCallback` helpers plus an effect whose only observation seam
  // was mounting the whole panel.
  useModelSelectionReconcile({
    clearModel,
    configuredProviders,
    discoveryState: providerDiscoveryState,
    enabledBuiltInLocalModelIds,
    enabledModelIds,
    getProviderLlmModels,
    getSelectedModel,
    getSelectedProvider,
    renderedSelectedModel: selectedModel,
    setModel,
  });

  const { handleModelChange, providerDraft } = useAssistantModelChange({
    currentModel,
    draftRuntimeByThreadId,
    fixedProviderModels,
    memoryThreadId,
    providerSettings,
    setModel,
    setProviderSettings,
    setThreadDraftRuntime,
  });

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
            openRouterLookup: openRouterMetadata.lookup,
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
      openRouterMetadata.lookup,
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

  // Recents include only valid selections (configured provider + enabled model), so
  // a disabled/retired model never renders as a pickable recent.
  const validRecentModels = useMemo(() => {
    const validKeys = new Set(pickerModels.map((model) => `${model.providerId}::${model.id}`));
    return recentModels.filter((key) => validKeys.has(key));
  }, [pickerModels, recentModels]);

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
        ...(providerKeySources ? { providerKeySources } : {}),
        ...(providerReadErrors ? { providerReadErrors } : {}),
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
      providerKeySources,
      providerReadErrors,
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
        ...(providerReadErrors ? { providerReadErrors } : {}),
        selectedProvider,
      }),
    [
      configuredProviders,
      currentModel,
      getProviderLlmModels,
      localRuntimeHint,
      providerHasEnabledModels,
      providerReadErrors,
      selectedProvider,
    ]
  );
  const providerDiscoveryReason = providerDiscoveryError
    ? `Could not refresh available providers: ${providerDiscoveryError}`
    : undefined;
  const runtimeDisabledReason =
    (configuredProviders.length === 0 ? providerDiscoveryReason : undefined) ??
    memoryDisabledReason ??
    providerDisabledReason ??
    openRouterDisabledReason;
  const disabledReason = runtimeDisabledReason ?? providerDraft.reason;
  const panelNotice = disabledReason ?? providerDiscoveryReason;
  // Conversation Rewind wiring (BST-1115), extracted whole into
  // `changes/use-wrapper-rewind-wiring.ts`: finalization composed around the
  // run-creation seam, the re-hydration generation, the standing "Last Turn"
  // identity, and the live mid-run refresh. The wrapper only forwards seams.
  const {
    handleRunEditActivity,
    markUserAuthoredSend,
    prepareRequestData: prepareRequestDataWithFinalization,
    publishTerminalRunIdentity,
    rewindGeneration,
  } = useWrapperRewindWiring({ prepareRequestData, threadId: selectedMemoryThreadId });
  // Thread usage ledger (BST-1652), extracted whole into
  // `assistant-panel/use-assistant-usage-ledger.ts`: every write into the
  // session context-usage store, the durable run-usage rows, the cumulative
  // re-read behind the meter's thread-total headline, and the live-sum settle
  // paths. The wrapper only supplies the seams and forwards the handlers.
  const {
    completeRequestAndSettleLiveUsage,
    cumulativeUsage,
    handleChildRunUsage,
    handleContextBreakdown,
    handleStepUsage,
    handleUsage,
    prepareRequestAndResetLiveUsage,
  } = useAssistantUsageLedger({
    assistantThreadRepository,
    completePreparedRequest,
    getActiveRunUsageContext,
    getProviderLlmModels,
    localChatTransport,
    memoryResourceId,
    prepareRequestData: prepareRequestDataWithFinalization,
    refreshThreadsAfterRun,
    selectedMemoryThreadId,
    selectedProvider,
  });

  // OM informational stats (observed tokens + compaction saved). Desktop-only:
  // gated on the durable-assistant capability (NOT raw PGlite presence — web has
  // a PGlite handle but no durable OM rows). The observation is NOT a budget
  // segment (it does not consume this turn's input budget), so this derivation
  // takes no budget/chat input. The live query is the ONLY async state; omSegment
  // is DERIVED during render (no setState-in-effect, per the react-doctor
  // no-adjust-state-on-prop-change rule). Scope selects the lookup key shape:
  // thread → thread:{threadId}, Workspace(resource) → resource:{resourceId}.
  const hasDurableOmCapability = hasDurableAssistantUsageCapability();
  const omRowResult = useObservationalMemoryRow({
    hasDurableCapability: hasDurableOmCapability,
    resourceId: memoryResourceId,
    scope: observationalMemorySettings.scope,
    threadId: selectedMemoryThreadId,
  });
  const omAwaitingObserverReason =
    storedObservationalMemorySettings.enabled && omAutoResolution?.kind === 'unresolved'
      ? omAutoResolution.reason
      : undefined;
  const omSegment = useMemo<OmMeterState>(
    () =>
      resolveOmMeterState({
        hasDurableCapability: hasDurableOmCapability,
        loading: omRowResult.loading,
        ...(omAwaitingObserverReason ? { omAwaitingObserverReason } : {}),
        omEnabled: observationalMemorySettings.enabled,
        queryError: omRowResult.error,
        row: omRowResult.row,
      }),
    [
      hasDurableOmCapability,
      omAwaitingObserverReason,
      observationalMemorySettings.enabled,
      omRowResult.error,
      omRowResult.loading,
      omRowResult.row,
    ]
  );

  // Capability-gated "/" slash commands, projected from the SAME command
  // registry the ⌘K palette uses (danger group excluded; execute pre-bound to
  // the command's run + outcome handling). Desktop-only commands are absent on
  // web automatically via registry.available(ctx).
  const slashCommands = useAssistantSlashCommands(selectedMemoryThreadId);

  // "@" file mentions: only meaningful when the desktop assistant server is
  // present to PARSE the inserted directive and inject the referenced file's
  // content (web has no server to resolve it). This is a capability gate, not an
  // isElectron check — when the backend is absent we omit the query seam, so the
  // panel never mounts the "@" feature. The app-shell owns the query state and
  // loads matches from the file index via `useFileMentions` (async-via-state).
  const [fileMentionQuery, setFileMentionQuery] = useState('');
  const { fileMentions } = useFileMentions(fileMentionQuery);

  // Run-lifecycle OS notifications (run finished/failed, tool approval
  // required) — see docs/agents/assistant-persistence.md "ASSISTANT RUN NOTIFICATIONS". Only ever fires
  // for the Mastra-loop transport; the settings/permission/focus gates live
  // entirely inside the hook.
  const notificationCallbacks = useAssistantRunNotifications();
  const { onRunFailed, onRunFinished, onToolApprovalRequired } = notificationCallbacks;
  // Deferred activation (BST-1116 W6 finding 4) — see `useForgeBranchLookupActivation`'s doc.
  const forgeBranchLookupEnabled = useForgeBranchLookupActivation();
  const {
    available: forgeBranchLookupAvailable,
    byRootId,
    byRootIdAndPath,
    byRootPath,
    loaded: forgeBranchLookupLoaded,
  } = useThreadBranchByRootPath({
    enabled: forgeBranchLookupEnabled,
  });
  // `available`/`loaded` are threaded through (BST-1391 M2), not discarded:
  // `useForgeRunEvents` needs them to tell "still loading" apart from "no
  // match" so a push that races the lookup's first load gets buffered
  // instead of silently dropped — see `ForgeBranchLookup`'s doc.
  const forgeBranchLookup = useMemo(
    () => ({
      available: forgeBranchLookupAvailable,
      byRootId,
      byRootIdAndPath,
      byRootPath,
      loaded: forgeBranchLookupLoaded,
    }),
    [forgeBranchLookupAvailable, byRootId, byRootIdAndPath, byRootPath, forgeBranchLookupLoaded]
  );

  // Forge observations arrive out of band from main, so they need their own
  // trigger source alongside the stream-scanning one — same decision layer.
  useForgeRunEvents({
    assistantThreadRepository,
    branchLookup: forgeBranchLookup,
    memoryResourceId,
    notifications: notificationCallbacks,
    threads: memoryThreads,
  });

  // Edit checkpoint (undo of agent file edits) context for the mutation tool
  // cards. Null on web / when no thread is selected (capability gating).
  const { checkpoints: editCheckpoints, refetch: refetchCheckpoints } = useEditCheckpoints(
    assistantThreadRepository,
    selectedMemoryThreadId
  );

  // Per-run 👍/👎 verdict binding (Task Ledger, source 'user'). Gated on the
  // repository capability — not desktop-only like the checkpoint bridge.
  const runVerdictBinding = useRunVerdictBinding(
    assistantThreadRepository,
    memoryResourceId,
    selectedMemoryThreadId
  );

  // Flight Recorder capstone: "Copy debug bundle" binding (Task 9). Gates on
  // the renderer's own PGlite db handle + the active thread — see the hook's
  // doc for why this differs from the repository-parameter pattern above.
  const debugBundleBinding = useDebugBundleBinding(selectedMemoryThreadId);

  // Last-24h budget guardrail binding (composer burn-down + send gate). Null
  // when no cap is configured or the durable spend capability is absent (web);
  // the gate/notice logic lives in packages/ui, the spend derivation in
  // cost-tracking/use-daily-spend.ts — this is wiring only.
  const budgetGuardrailBinding = useBudgetGuardrailBinding(memoryResourceId);

  // Changeset lifecycle refresh (BST-1113 Task 4): no changeset SELECTION UI
  // exists yet (W4 wires it), so `changeset` is hardcoded null here — the
  // hook's own inertness (no bridge call for a null changeset) makes
  // `refreshChangeset` a no-op today by construction, not by a branch here.
  // `mainRootId` is the assistant's OPERATING root (see the MULTI-ROOT
  // PARTITION comment above `selectionData`), matching the git IPC domain's
  // own rootId-scoped cwd concept.
  const { refresh: refreshChangeset } = useChangeset(mainRootId ?? null, null);

  // Re-read the checkpoint journal when a run reaches a terminal state — the
  // journal rows are written in main during tool execution, after the last
  // thread-open read, so the turn-level "Revert all edits" footer would
  // otherwise stay empty for the turn that JUST ran until a thread switch.
  // `publishTerminalRunIdentity` advances the standing "Last Turn" identity
  // (BST-1115) — policy in `changes/use-wrapper-rewind-wiring.ts`.
  const handleRunFinished = useCallback(
    (event: AssistantRunEvent) => {
      onRunFinished(event);
      void refetchCheckpoints();
      void refreshChangeset();
      publishTerminalRunIdentity(event);
    },
    [onRunFinished, publishTerminalRunIdentity, refetchCheckpoints, refreshChangeset]
  );
  const handleRunFailed = useCallback(
    (event: AssistantRunEvent) => {
      onRunFailed(event);
      void refetchCheckpoints();
      void refreshChangeset();
      publishTerminalRunIdentity(event);
    },
    [onRunFailed, publishTerminalRunIdentity, refetchCheckpoints, refreshChangeset]
  );

  // Grant actions for the tool-approval notice ("Always allow" / "Allow
  // <category> this session"). Store-backed and stable: the wrapper already
  // subscribes to perToolOverrides/sessionGrants for the request snapshot, so a
  // grant recorded here reaches the very next request without extra plumbing.
  const toolApprovalGrants = useMemo<ToolApprovalGrantHandlers>(
    () => ({
      grantAllToolsForSession: () =>
        usePermissionPolicyStore.getState().grantAllSessionCategories(),
      grantCategoryForSession: (category) =>
        usePermissionPolicyStore.getState().grantSessionCategory(category),
      grantToolAlways: (toolId) =>
        usePermissionPolicyStore.getState().setToolOverride(toolId, 'allow'),
    }),
    []
  );

  return (
    <DelegatedWorkspaceNavigation
      ownerResourceId={memoryResourceId}
      rootThreadId={selectedMemoryThreadId}
    >
      <ToolApprovalGrantProvider handlers={toolApprovalGrants}>
        <EditCheckpointProvider value={editCheckpoints}>
          <RunVerdictProvider value={runVerdictBinding}>
            <DebugBundleProvider value={debugBundleBinding}>
              <BudgetGuardrailProvider value={budgetGuardrailBinding}>
                <AssistantUiPanel
                  {...(delegatedRoot
                    ? {
                        onDelegatedConversation: delegatedRoot.onDelegatedConversation,
                        onRuntimeReady: delegatedRoot.onRuntimeReady,
                      }
                    : {})}
                  {...(composerDraftCommand ? { composerDraftCommand } : {})}
                  {...(attachmentsAvailability ? { attachmentsAvailability } : {})}
                  {...(hasDesktopAssistantBridge() ? { onSteerActiveRun: steerActiveRun } : {})}
                  completePreparedRequest={completeRequestAndSettleLiveUsage}
                  contextWindow={openRouterModelDef?.contextWindow}
                  {...(cumulativeUsage ? { cumulativeUsage } : {})}
                  effectiveInputBudget={effectiveInputBudget}
                  omSegment={omSegment}
                  openRouterModelMetadataLookup={openRouterMetadata.lookup}
                  {...(selectedMemoryThreadId
                    ? {
                        onComposerDraftCommandApplied: handleComposerCommandApplied,
                        onComposerTextChange: handleComposerTextChange,
                      }
                    : {})}
                  onChildRunUsage={handleChildRunUsage}
                  onContextBreakdown={handleContextBreakdown}
                  onProviderSettingsChange={handleProviderSettingsChange}
                  onProviderSettingsValidationChange={providerDraft.report}
                  onRunEditActivity={handleRunEditActivity}
                  onRunFailed={handleRunFailed}
                  onRunFinished={handleRunFinished}
                  onStepUsage={handleStepUsage}
                  onStreamActivity={renewActiveAssistantForegroundActivity}
                  onThreadRunStart={markUserAuthoredSend}
                  onToolApprovalRequired={onToolApprovalRequired}
                  onUsage={handleUsage}
                  pickerModels={pickerModels}
                  pickerProviders={pickerProviders}
                  prepareRequestData={prepareRequestAndResetLiveUsage}
                  providerGroups={providerGroups}
                  providerSettings={effectiveProviderSettings}
                  recentModels={validRecentModels}
                  workspaceBar={
                    // The host owns the bar's live-refresh subscriptions.
                    <WorkspaceBarHost
                      assistantThreadRepository={assistantThreadRepository}
                      {...(mainRootId && rootDescriptors?.[mainRootId]
                        ? { currentMainRoot: rootDescriptors[mainRootId] }
                        : {})}
                      database={db}
                      memoryResourceId={memoryResourceId}
                      rootDescriptors={rootDescriptors}
                      selectedMemoryThreadId={selectedMemoryThreadId}
                    />
                  }
                  {...webBodyLimitProps(desktopAssistantBackendAvailable)}
                  requestData={requestData}
                  slashCommands={slashCommands}
                  {...(desktopAssistantBackendAvailable
                    ? { fileMentions, onFileMentionQueryChange: setFileMentionQuery }
                    : {})}
                  toolMenu={toolMenu}
                  {...(historyAdapter ? { historyAdapter } : {})}
                  historyGeneration={rewindGeneration}
                  {...(loadLocalLlmBackend ? { loadLocalLlmBackend } : {})}
                  localChatTransport={localChatTransport}
                  {...(selectedMemoryThreadId ? { threadKey: selectedMemoryThreadId } : {})}
                  {...(selectedProvider ? { selectedProvider } : {})}
                  {...(currentModel ? { selectedModel: currentModel } : {})}
                  disabled={!isProviderReady || Boolean(disabledReason)}
                  onModelChange={handleModelChange}
                  onModelToggle={handleModelToggle}
                  {...(panelNotice ? { disabledReason: panelNotice } : {})}
                  {...(planModeAvailable
                    ? {
                        onExitPlanMode: exitPlanMode,
                        onTogglePlanMode: togglePlanMode,
                        planModeEnabled: planModeEnabledPref,
                      }
                    : {})}
                />
              </BudgetGuardrailProvider>
            </DebugBundleProvider>
          </RunVerdictProvider>
        </EditCheckpointProvider>
      </ToolApprovalGrantProvider>
    </DelegatedWorkspaceNavigation>
  );
}

AssistantUiPanelWrapper.displayName = 'AssistantUiPanelWrapper';
