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
  useFileSystem,
  useSelectionManager,
} from '@brainstrike/file-explorer-ui/shell';
import { useEnsureModelRegistry } from '@brainstrike/preferences/hooks/use-model-registry';
import { useAssistantMemoryPreferencesStore } from '@brainstrike/preferences/stores/assistant-memory-preferences-store';
import { useAssistantPreferencesStore } from '@brainstrike/preferences/stores/assistant-preferences-store';
import { useBackgroundIndexingPreferencesStore } from '@brainstrike/preferences/stores/background-indexing-preferences-store';
import { useModelRegistryStore } from '@brainstrike/preferences/stores/model-registry-store';
import { useNativeToolPreferencesStore } from '@brainstrike/preferences/stores/native-tool-preferences-store';
import { usePanelLayoutStore } from '@brainstrike/preferences/stores/panel-layout-store';
import {
  buildPermissionToolGateSnapshotInput,
  usePermissionPolicyStore,
} from '@brainstrike/preferences/stores/permission-policy-store';
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
  EditCheckpointProvider,
  hasDesktopLlmHost,
  useContextUsageStore,
} from '@brainstrike/ui/assistant-ui-panel';
import { createLogger } from '@brainstrike/utils/logger';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils/selection-utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAssistantComposerCommandStore } from './assistant-composer-command-store';
import {
  type CumulativeUsageDisplay,
  type ModelPricingResolver,
  resolveCumulativeUsageDisplay,
} from './assistant-cumulative-usage';
import { hasDurableAssistantUsageCapability } from './assistant-durable-usage-capability';
import {
  createAssistantThreadHistoryAdapter,
  createPgliteAssistantThreadRepository,
} from './assistant-memory-repository';
import { resolveAssistantMemoryResourceId } from './assistant-memory-resource';
import { type OmMeterState, resolveOmMeterState } from './assistant-om-segment';
import { createSuspendedApprovalDiscovery } from './assistant-suspended-approvals';
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
import { resolveAssistantBaseUrl } from './hooks/use-assistant-availability';
import { useAssistantLocalRuntimeCatalog } from './hooks/use-assistant-local-runtime-catalog';
import { useAssistantMcpMenuState } from './hooks/use-assistant-mcp-menu-state';
import { useAssistantModelPickerConfig } from './hooks/use-assistant-model-picker-config';
import { useAssistantRequestLifecycle } from './hooks/use-assistant-request-lifecycle';
import { useAssistantThreadRequestData } from './hooks/use-assistant-thread-request-data';
import { useEditCheckpoints } from './hooks/use-edit-checkpoints';
import { useAssistantRunNotifications } from './use-assistant-run-notifications';
import { useAssistantSlashCommands } from './use-assistant-slash-commands';
import { useFileMentions } from './use-file-mentions';
import { useObservationalMemoryRow } from './use-om-segment-row';

export interface AssistantUiPanelWrapperProps {
  className?: string;
  initialProviders?: SupportedProvider[];
  loadLocalLlmBackend?: LocalLlmBackendFactory;
  memoryResourceId?: string;
  memoryThreadId?: string;
}

const assistantSelectionWriteBackLogger = createLogger('AssistantSelectionWriteBack');
const assistantUsageWriteBackLogger = createLogger('AssistantUsageWriteBack');

/**
 * Normalize an absolute root path for matching the server's broadcast rootPath
 * (path.resolve output) against the client's rootDescriptors[].path. Strips a
 * trailing separator so a `/foo/bar/` vs `/foo/bar` mismatch still resolves. The
 * deeper realpath/case match is desktop-only and verified live.
 */
export function normalizeRootPathForLookup(rootPath: string): string {
  return rootPath.trim().replace(/[/\\]+$/, '');
}

/**
 * Resolve which client folder a multi-root selection write-back targets. When the
 * payload carries a `rootPath` (the assistant targeted a specific open folder),
 * map it to the client RootId via rootDescriptors. Returns null (and logs) when
 * the path matches no open client root — the caller MUST skip rather than write
 * to the wrong/focused folder. Without a rootPath, route by the legacy folderId.
 */
export function resolveWriteBackFolderId(
  payload: { folderId?: string; rootPath?: string; rootId?: string },
  pathToClientRootId: ReadonlyMap<string, string>
): string | null {
  if (payload.rootPath === undefined) {
    return payload.folderId ?? null;
  }
  const clientRootId = pathToClientRootId.get(normalizeRootPathForLookup(payload.rootPath));
  if (!clientRootId) {
    assistantSelectionWriteBackLogger.warn(
      'Selection write-back targets a root not open in this window; dropping (no client folder).',
      { rootId: payload.rootId, rootPath: payload.rootPath }
    );
    return null;
  }
  return clientRootId;
}

/** Normalize, dedupe, and root-anchor write-back file paths to leading-slash form. */
function normalizeWriteBackFilePaths(filePaths: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      filePaths
        .map((filePath) => normalizeWorkspaceLookupPath(String(filePath)))
        .filter((filePath) => filePath.length > 0)
        .map((filePath) => (filePath.startsWith('/') ? filePath : `/${filePath}`))
    )
  );
}

/**
 * Compute the next selection for 'replace' mode: keep selections from OTHER
 * folders, drop the target folder's, then add the requested paths under it.
 */
function computeReplacedSelection(
  currentSelection: Iterable<string>,
  targetFolderId: string,
  normalizedPaths: readonly string[]
): Set<string> {
  const next = new Set<string>();
  for (const compositeKey of currentSelection) {
    try {
      if (decodeFileSelection(compositeKey).folderId !== targetFolderId) {
        next.add(compositeKey);
      }
    } catch {
      next.add(compositeKey);
    }
  }
  for (const filePath of normalizedPaths) {
    next.add(encodeFileSelection(targetFolderId, filePath));
  }
  return next;
}

/** Build the Tapestry ranges for one file update (empty for 'clear' mode). */
function buildTapestryRangesForUpdate(
  ranges: AssistantWorkspaceTapestryUpdatePayload['updates'][number]['ranges'],
  compositeKey: string,
  clear: boolean
): ReturnType<typeof buildAssistantTapestryRange>[] {
  if (clear) {
    return [];
  }
  return ranges.map((range, index) =>
    buildAssistantTapestryRange({
      ...(range.color ? { color: range.color } : {}),
      compositeKey,
      endLine: range.endLine,
      index,
      isActive: range.isActive,
      startLine: range.startLine,
    })
  );
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
        configuredProviders,
        enabledModelsByProvider,
        localRuntimeModels,
        registryEnabledModelIds,
        shouldFallbackToPreferences,
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
      lmstudio: toRuntimeProviderModels('lmstudio', localRuntimeModels),
      ollama: toRuntimeProviderModels('ollama', localRuntimeModels),
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
  // Multi-root write-back: map each open root's absolute path -> its client
  // RootId so an assistant update carrying a server rootPath can route to the
  // right folder (the two id spaces share only the path). Recomputed only when
  // the open roots change.
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

      clearSelectionRules();
      setSelectedFiles(
        computeReplacedSelection(effectiveSelectionRef.current, targetFolderId, normalizedPaths)
      );
    },
    [
      addMultipleSelectedFiles,
      clearSelectionRules,
      pathToClientRootId,
      removeMultipleSelectedFiles,
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
      embeddingSetId: workspaceIndexEmbeddingSetId,
      enabled: workspaceIndexingEnabled,
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
  const refreshResourceThreads = useAssistantThreadStore((state) => state.refreshResourceThreads);
  // Workspace-global assistant memory: a stable resource id (or an explicit
  // override), never the focused root path. See assistant-memory-resource.ts.
  const memoryResourceId = resolveAssistantMemoryResourceId(memoryResourceIdOverride);
  const selectedMemoryThreadId = memoryThreadId ?? selectedThreadByResourceId[memoryResourceId];
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
  const hostedMemoryBackendAvailable =
    selectedProvider === 'local' ? true : desktopAssistantBackendAvailable;
  // Desktop routes built-in local chat through the assistant server (real
  // Mastra loop with persistence/run events; inference proxied to the hidden
  // llm-host). Web has neither bridge and keeps the in-renderer local runtime.
  const localChatTransport: 'data-stream' | 'local-runtime' =
    hasDesktopRuntimeBridge() && desktopAssistantBackendAvailable && hasDesktopLlmHost()
      ? 'data-stream'
      : 'local-runtime';

  // Permission enforcement (OPT-IN). Subscribe to the persisted posture so the
  // request snapshot stays in sync; the serializable input is only attached to
  // the request when the user enabled `enforce`. Scoped to the desktop
  // data-stream transport — only it POSTs to the assistant server that runs the
  // runtime permission gate (web's in-renderer local runtime has no server, so
  // there is nothing to enforce against; tracked as a follow-up).
  const permissionEnforce = usePermissionPolicyStore((state) => state.enforce);
  const permissionPolicies = usePermissionPolicyStore((state) => state.policies);
  const permissionYolo = usePermissionPolicyStore((state) => state.yolo);
  const permissionSessionGrants = usePermissionPolicyStore((state) => state.sessionGrants);
  const permissionPerToolOverrides = usePermissionPolicyStore((state) => state.perToolOverrides);
  const permissionPolicyRequest = useMemo(() => {
    if (!(permissionEnforce && localChatTransport === 'data-stream')) {
      return;
    }
    return buildPermissionToolGateSnapshotInput({
      enforce: permissionEnforce,
      perToolOverrides: permissionPerToolOverrides,
      policies: permissionPolicies,
      sessionGrants: permissionSessionGrants,
      yolo: permissionYolo,
    });
  }, [
    localChatTransport,
    permissionEnforce,
    permissionPolicies,
    permissionYolo,
    permissionSessionGrants,
    permissionPerToolOverrides,
  ]);

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
  const exitPlanMode = useCallback(() => setPlanModeEnabled(false), [setPlanModeEnabled]);

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
        ? { discoverSuspendedApprovals: createSuspendedApprovalDiscovery(resolveAssistantBaseUrl) }
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
    enabledNativeToolIds,
    hostedMemoryBackendAvailable,
    memoryOptions: assistantMemoryOptions,
    memoryResourceId,
    modelSettings,
    observationalMemorySettings,
    permissionPolicyRequest,
    planMode,
    providerOptions,
    runtimeWorkspaceContext,
    selectedMemoryThreadId,
    selectionData,
    semanticRecallSettings,
    workspaceIndex,
    workspaceRootPath,
  });

  const {
    completePreparedRequest,
    getActiveRunUsageContext,
    prepareRequestData,
    renewActiveAssistantForegroundActivity,
  } = useAssistantRequestLifecycle({
    assistantThreadRepository,
    // The focused root id (file-explorer store; same identity space as the DB
    // roots.id). Snapshotted at request start for durable per-root cost.
    focusedRootId: currentFolderId,
    memoryResourceId,
    modelSettings,
    planModeAvailable,
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

  // Bumped after each durable usage write COMMITS, so the cumulative re-read is
  // Durable CUMULATIVE usage for the active thread, hydrated from the DB (honest,
  // not a heuristic). Desktop-only: when the repo is absent (web) the cumulative
  // line is simply not shown.
  const [cumulativeUsage, setCumulativeUsage] = useState<CumulativeUsageDisplay | null>(null);
  const resolveModelPricing = useCallback<ModelPricingResolver>(
    (provider: string, model: string) => {
      if (!isSupportedProvider(provider)) {
        return;
      }
      return getProviderLlmModels(provider).find(
        (candidate: LlmProviderModelDefinition) => candidate.id === model
      )?.pricing;
    },
    [getProviderLlmModels]
  );
  // Monotonic load token: a slower in-flight load (e.g. an earlier thread) must
  // never clobber a newer one. Every loader captures the id at call time and only
  // commits state if it is still the latest — a single setState path (no
  // cascading sets, no separate cancel flag per call).
  const cumulativeUsageLoadIdRef = useRef(0);
  const refreshCumulativeUsage = useCallback(async (): Promise<void> => {
    cumulativeUsageLoadIdRef.current += 1;
    const loadId = cumulativeUsageLoadIdRef.current;
    if (!(assistantThreadRepository && selectedMemoryThreadId)) {
      setCumulativeUsage(null);
      return;
    }
    let next: CumulativeUsageDisplay | null = null;
    try {
      const usage =
        await assistantThreadRepository.getThreadCumulativeUsage(selectedMemoryThreadId);
      next = resolveCumulativeUsageDisplay(usage, resolveModelPricing);
    } catch (error: unknown) {
      assistantUsageWriteBackLogger.warn('Failed to load cumulative run usage', { error });
    }
    if (loadId === cumulativeUsageLoadIdRef.current) {
      setCumulativeUsage(next);
    }
  }, [assistantThreadRepository, resolveModelPricing, selectedMemoryThreadId]);

  // Record provider token usage. ONE usage derivation (the single tap) fans out
  // to two sinks:
  //   1. the session-lived zustand store (last-turn meter), keyed by the active
  //      memory thread id (falls back to 'active' for non-memory sessions);
  //   2. a DURABLE per-run row in brainstrike_assistant_run_usage, written only
  //      when the PGlite-backed thread repo exists (desktop). On web the repo is
  //      absent → the durable write is simply skipped (honest session-only
  //      fallback; capability-gated, never an isElectron() check and never $0).
  // model/provider are attributed from the REQUEST-START snapshot (the model that
  // produced the tokens), never the live picker selection — the picker stays
  // interactive mid-run. They are stored PER ROW so cost is attributable per
  // model when a thread switches models mid-conversation.
  const handleUsage = useCallback(
    (usage: { inputTokens: number; outputTokens: number }) => {
      const threadId = selectedMemoryThreadId ?? 'active';
      useContextUsageStore.getState().recordUsage(threadId, usage);

      // A turn just finished: re-list threads so an observer-generated title
      // (observational memory names threads as observations run) becomes
      // visible in the thread list. Lightweight, non-polling, and a no-op for
      // resources that have not finished their initial load.
      if (assistantThreadRepository) {
        refreshResourceThreads(assistantThreadRepository, memoryResourceId).catch(
          (error: unknown) => {
            assistantUsageWriteBackLogger.warn('Failed to refresh thread titles after run', {
              error,
            });
          }
        );
      }

      // Durable sink: requires a real thread id, the desktop PGlite repo, and the
      // in-flight run's request-start usage context. A missing piece means we
      // cannot attribute the row honestly, so we skip the durable write (the
      // zustand sink still ran).
      const runContext = getActiveRunUsageContext();
      if (!(assistantThreadRepository && selectedMemoryThreadId && runContext)) {
        return;
      }
      assistantThreadRepository
        .recordRunUsage({
          inputTokens: usage.inputTokens,
          model: runContext.model,
          outputTokens: usage.outputTokens,
          provider: runContext.provider,
          resourceId: memoryResourceId,
          // Request-start root (null when unattributed) — same snapshot source
          // as model/provider, so cost is attributable per workspace root.
          rootId: runContext.rootId,
          runId: runContext.runId,
          threadId: selectedMemoryThreadId,
        })
        // Re-read the cumulative total from the write's OWN completion so the
        // SELECT provably follows the INSERT (not racing it on the PGlite queue).
        .then(() => refreshCumulativeUsage())
        .catch((error: unknown) => {
          // Never swallow silently — durable usage is best-effort relative to the
          // turn, but a failure must be observable.
          assistantUsageWriteBackLogger.warn('Failed to persist durable run usage', { error });
        });
    },
    [
      assistantThreadRepository,
      getActiveRunUsageContext,
      memoryResourceId,
      refreshCumulativeUsage,
      refreshResourceThreads,
      selectedMemoryThreadId,
    ]
  );

  // Initial / thread-switch load. The post-write refresh rides handleUsage's
  // own completion, so this effect only fires on repo/thread change.
  useEffect(() => {
    void refreshCumulativeUsage();
  }, [refreshCumulativeUsage]);

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
  const omSegment = useMemo<OmMeterState>(
    () =>
      resolveOmMeterState({
        hasDurableCapability: hasDurableOmCapability,
        loading: omRowResult.loading,
        omEnabled: observationalMemorySettings.enabled,
        queryError: omRowResult.error,
        row: omRowResult.row,
      }),
    [
      hasDurableOmCapability,
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
  const slashCommands = useAssistantSlashCommands();

  // "@" file mentions: only meaningful when the desktop assistant server is
  // present to PARSE the inserted directive and inject the referenced file's
  // content (web has no server to resolve it). This is a capability gate, not an
  // isElectron check — when the backend is absent we omit the query seam, so the
  // panel never mounts the "@" feature. The app-shell owns the query state and
  // loads matches from the file index via `useFileMentions` (async-via-state).
  const [fileMentionQuery, setFileMentionQuery] = useState('');
  const { fileMentions } = useFileMentions(fileMentionQuery);

  // Run-lifecycle OS notifications (run finished/failed, tool approval
  // required) — see AGENTS.md "ASSISTANT RUN NOTIFICATIONS". Only ever fires
  // for the Mastra-loop transport; the settings/permission/focus gates live
  // entirely inside the hook.
  const { onRunFailed, onRunFinished, onToolApprovalRequired } = useAssistantRunNotifications();

  // Edit checkpoint (undo of agent file edits) context for the mutation tool
  // cards. Null on web / when no thread is selected (capability gating).
  const editCheckpoints = useEditCheckpoints(assistantThreadRepository, selectedMemoryThreadId);

  return (
    <EditCheckpointProvider value={editCheckpoints}>
      <AssistantUiPanel
        {...(composerDraftCommand ? { composerDraftCommand } : {})}
        completePreparedRequest={completePreparedRequest}
        contextWindow={selectedModelBudgetDef?.contextWindow}
        {...(cumulativeUsage ? { cumulativeUsage } : {})}
        effectiveInputBudget={effectiveInputBudget}
        omSegment={omSegment}
        {...(selectedMemoryThreadId
          ? {
              onComposerDraftCommandApplied: handleComposerCommandApplied,
              onComposerTextChange: handleComposerTextChange,
            }
          : {})}
        onProviderSettingsChange={handleProviderSettingsChange}
        onRunFailed={onRunFailed}
        onRunFinished={onRunFinished}
        onStreamActivity={renewActiveAssistantForegroundActivity}
        onToolApprovalRequired={onToolApprovalRequired}
        onUsage={handleUsage}
        pickerModels={pickerModels}
        pickerProviders={pickerProviders}
        prepareRequestData={prepareRequestData}
        providerGroups={providerGroups}
        providerSettings={effectiveProviderSettings}
        requestData={requestData}
        slashCommands={slashCommands}
        {...(desktopAssistantBackendAvailable
          ? { fileMentions, onFileMentionQueryChange: setFileMentionQuery }
          : {})}
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
        {...(planModeAvailable
          ? {
              onExitPlanMode: exitPlanMode,
              onTogglePlanMode: togglePlanMode,
              planModeEnabled: planModeEnabledPref,
            }
          : {})}
      />
    </EditCheckpointProvider>
  );
}

AssistantUiPanelWrapper.displayName = 'AssistantUiPanelWrapper';
