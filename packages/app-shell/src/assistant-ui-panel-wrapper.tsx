import type {
  AnthropicProviderOptions,
  GoogleProviderOptions,
  OpenAiProviderOptions,
  RuntimeData,
} from '@brainstrike/agent';
import {
  getProviderDefaultModel,
  getProviderDefinition,
  getProviderModelDefinitions,
  isSupportedProvider,
  NATIVE_TOOL_DEFAULTS,
  type ProviderModelDefinition,
  type ProviderRuntime,
  type SupportedProvider,
  supportsStandardEmbeddingDimension,
  TOOL_DESCRIPTIONS,
} from '@brainstrike/agent/client';
import { useDbInitializing, useDbProviderError, usePGliteDatabase } from '@brainstrike/db';
import {
  useFileExplorerStoreContext,
  useOptionalTokenCacheContext,
  useSelectionManager,
} from '@brainstrike/file-explorer-ui';
import {
  useAssistantPreferencesStore,
  useEnsureModelRegistry,
  useModelRegistryStore,
  useNativeToolPreferencesStore,
  useSecretsStore,
  useVectorStatusUIStore,
} from '@brainstrike/preferences';
import {
  type AssistantContextMenuConfig,
  type AssistantProviderSettings,
  type AssistantProviderSettingsUpdate,
  type AssistantToolMenuConfig,
  type AssistantToolMenuItem,
  AssistantUiPanel,
  type ModelPickerModel,
  type ModelPickerProvider,
  type ProviderGroupConfig,
} from '@brainstrike/ui/assistant-ui-panel';
import { decodeFileSelection, encodeFileSelection } from '@brainstrike/utils';
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePanelLayoutStore } from './stores/panel-layout-store';

export interface AssistantUiPanelWrapperProps {
  className?: string;
  initialProviders?: SupportedProvider[];
}

// App-shell wrapper wires DB/preferences state into the shared UI-only AssistantUiPanel.
const RUNTIME_LABELS: Record<ProviderRuntime, string> = {
  hosted: 'Hosted',
  gateway: 'Gateway',
  local: 'Local',
  browser: 'Browser',
};

function resolveModelNameFromComposite(composite: string | null | undefined): string | undefined {
  if (!composite) {
    return;
  }
  const parts = composite.split('::');
  return parts.length === 2 ? parts[1] : composite;
}

function formatToolLabel(toolId: string): string {
  const name = toolId.split('.').pop() ?? toolId;
  const spaced = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .trim();
  return spaced.replace(/\b\w/g, (match) => match.toUpperCase());
}

function getToolDescription(toolId: string): string {
  return TOOL_DESCRIPTIONS[toolId] ?? `Tool: ${toolId}`;
}

const INCLUDE_FILE_REPORT_STORAGE_KEY = 'brainstrike.assistant.include-file-report.v1';
const TREE_CONTEXT_LINE_LIMIT = 400;
const TREE_TOKEN_ESTIMATE_PER_LINE = 4;
const FILE_REPORT_OVERHEAD_PER_FILE = 8;

interface SelectionUpdatePayload {
  folderId: string;
  filePaths: string[];
  mode: 'replace' | 'add' | 'remove';
}

interface TokenCountRow {
  path: string;
  tokenCount: number | null;
}

interface TotalFilesRow {
  count: string | number;
}

interface QueryableTokenDatabase {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

function normalizeWorkspacePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function buildPathLookupCandidates(paths: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) {
      continue;
    }
    candidates.add(normalized);
    candidates.add(`/${normalized}`);
  }
  return Array.from(candidates);
}

function loadStoredIncludeFileReport(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  const raw = window.localStorage.getItem(INCLUDE_FILE_REPORT_STORAGE_KEY);
  if (raw === null) {
    return true;
  }
  return raw === '1';
}

async function estimateSelectionTokenCountFromDb(
  db: QueryableTokenDatabase,
  filePaths: readonly string[]
): Promise<number> {
  const candidates = buildPathLookupCandidates(filePaths);
  if (candidates.length === 0) {
    return 0;
  }

  const result = await db.query<TokenCountRow>(
    `SELECT path, token_count AS "tokenCount"
     FROM file_records
     WHERE path = ANY($1::text[])`,
    [candidates]
  );

  const byPath = new Map<string, number>();
  for (const row of result.rows) {
    const normalized = normalizeWorkspacePath(row.path);
    if (typeof row.tokenCount === 'number') {
      byPath.set(normalized, row.tokenCount);
    }
  }

  let total = 0;
  for (const path of filePaths) {
    const normalized = normalizeWorkspacePath(path);
    const tokenCount = byPath.get(normalized);
    if (typeof tokenCount === 'number') {
      total += tokenCount;
    }
  }
  return total;
}

interface McpToolDescriptor {
  id: string;
  description?: string;
  enabled: boolean;
}

type McpToolMap = Record<string, McpToolDescriptor[]>;

function buildMcpMenuItems(toolsByServer: McpToolMap): AssistantToolMenuItem[] {
  const items: AssistantToolMenuItem[] = [];
  for (const [serverName, serverTools] of Object.entries(toolsByServer)) {
    for (const tool of serverTools) {
      items.push({
        id: tool.id,
        label: formatToolLabel(tool.id),
        enabled: tool.enabled,
        source: 'mcp',
        group: serverName,
        description: tool.description ?? `MCP tool: ${tool.id}`,
        category: 'action',
      });
    }
  }
  return items;
}

function returnIfNotEmpty<T extends Record<string, unknown>>(options: T): T | undefined {
  return Object.keys(options).length > 0 ? options : undefined;
}

function buildOptionalOptions<T extends Record<string, unknown>>(
  entries: [keyof T, unknown][]
): T | undefined {
  const options = {} as T;
  for (const [key, value] of entries) {
    if (value !== undefined) {
      options[key] = value as T[keyof T];
    }
  }
  return returnIfNotEmpty(options);
}

function buildModelSettings(
  settings: AssistantProviderSettings | undefined
): RuntimeData['modelSettings'] | undefined {
  if (!settings || typeof settings.maxOutputTokens !== 'number') {
    return;
  }
  const value = Math.max(1, Math.floor(settings.maxOutputTokens));
  return Number.isFinite(value) ? { maxOutputTokens: value } : undefined;
}

function resolveGoogleThinkingLevel(
  modelName: string | undefined,
  value: AssistantProviderSettings['googleThinkingLevel']
): AssistantProviderSettings['googleThinkingLevel'] {
  if (!value) {
    return;
  }
  const isPro = Boolean(modelName?.includes('gemini-3-pro-preview'));
  const allowed: readonly NonNullable<AssistantProviderSettings['googleThinkingLevel']>[] = isPro
    ? ['low', 'high']
    : ['minimal', 'low', 'medium', 'high'];
  return allowed.includes(value) ? value : undefined;
}

function buildOpenAiOptions(
  settings: AssistantProviderSettings
): OpenAiProviderOptions | undefined {
  return buildOptionalOptions<OpenAiProviderOptions>([
    ['reasoningEffort', settings.reasoningEffort || undefined],
    ['reasoningSummary', settings.reasoningSummary || undefined],
  ]);
}

function buildAnthropicOptions(
  settings: AssistantProviderSettings
): AnthropicProviderOptions | undefined {
  const thinking =
    typeof settings.anthropicThinkingBudgetTokens === 'number'
      ? {
          type: 'enabled' as const,
          budgetTokens: Math.floor(settings.anthropicThinkingBudgetTokens),
        }
      : undefined;
  return buildOptionalOptions<AnthropicProviderOptions>([
    ['effort', settings.anthropicEffort || undefined],
    ['thinking', thinking],
  ]);
}

function buildGoogleOptions(
  modelName: string | undefined,
  settings: AssistantProviderSettings
): GoogleProviderOptions | undefined {
  const resolvedLevel = resolveGoogleThinkingLevel(modelName, settings.googleThinkingLevel);
  const includeThoughts =
    typeof settings.googleIncludeThoughts === 'boolean'
      ? settings.googleIncludeThoughts
      : undefined;
  const thinkingConfig = buildOptionalOptions<NonNullable<GoogleProviderOptions['thinkingConfig']>>(
    [
      ['thinkingLevel', resolvedLevel],
      ['includeThoughts', includeThoughts],
    ]
  );
  return thinkingConfig ? { thinkingConfig } : undefined;
}

function buildProviderOptions(
  providerId: SupportedProvider | null,
  modelName: string | undefined,
  settings: AssistantProviderSettings | undefined
): RuntimeData['providerOptions'] | undefined {
  if (!(providerId && settings)) {
    return;
  }

  switch (providerId) {
    case 'openai':
    case 'openrouter': {
      const openai = buildOpenAiOptions(settings);
      return openai ? { openai } : undefined;
    }
    case 'anthropic': {
      const anthropic = buildAnthropicOptions(settings);
      return anthropic ? { anthropic } : undefined;
    }
    case 'google': {
      const google = buildGoogleOptions(modelName, settings);
      return google ? { google } : undefined;
    }
    default:
      return;
  }
}

export const AssistantUiPanelWrapper: FC<AssistantUiPanelWrapperProps> = ({ initialProviders }) => {
  const [configuredProviders, setConfiguredProviders] = useState<SupportedProvider[]>(
    () => initialProviders ?? []
  );

  const {
    setModel,
    clearModel,
    getAvailableProviders,
    getSelectedModel,
    getSelectedProvider,
    setProviderSettings,
  } = useAssistantPreferencesStore();
  const enabledModelsByProvider = useAssistantPreferencesStore(
    (state) => state.enabledModelsByProvider
  );
  const providerSettings = useAssistantPreferencesStore((state) => state.providerSettings);
  const [nativeToolStates, setNativeToolEnabled] = useNativeToolPreferencesStore(
    (state) => [state.toolStates, state.setToolEnabled] as const
  );

  // Subscribe to secrets changes to re-check available providers when API keys change
  const secretsVersion = useSecretsStore((state) => state.secretsVersion);

  // Load model registry from DB for local provider models
  useEnsureModelRegistry();
  const registryModels = useModelRegistryStore((state) => state.models);
  const registryError = useModelRegistryStore((state) => state.error);
  const toggleModelInDb = useModelRegistryStore((state) => state.toggleModel);
  const db = usePGliteDatabase();
  const tokenCache = useOptionalTokenCacheContext();
  const dbInitializing = useDbInitializing();
  const dbError = useDbProviderError();
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const [mcpTools, setMcpTools] = useState<AssistantToolMenuItem[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const setMcpToolsIfMounted = useCallback((items: AssistantToolMenuItem[]) => {
    if (isMountedRef.current) {
      setMcpTools(items);
    }
  }, []);

  const setMcpLoadingIfMounted = useCallback((value: boolean) => {
    if (isMountedRef.current) {
      setMcpLoading(value);
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

  const enabledModelIds = useMemo(() => {
    if (!shouldFallbackToPreferences) {
      return registryEnabledModelIds;
    }

    const enabledIds = new Set<string>();
    for (const providerId of configuredProviders) {
      const enabledModels = enabledModelsByProvider[providerId] ?? [];
      for (const modelId of enabledModels) {
        enabledIds.add(modelId);
      }
    }
    return enabledIds;
  }, [
    configuredProviders,
    enabledModelsByProvider,
    registryEnabledModelIds,
    shouldFallbackToPreferences,
  ]);

  const selectedProvider = getSelectedProvider();
  const currentModel = getSelectedModel();
  const resolvedModelName = useMemo(
    () => resolveModelNameFromComposite(currentModel),
    [currentModel]
  );
  const selectedProviderSettings = selectedProvider
    ? providerSettings[selectedProvider]
    : undefined;
  const modelSettings = useMemo(
    () => buildModelSettings(selectedProviderSettings),
    [selectedProviderSettings]
  );
  const providerOptions = useMemo(
    () => buildProviderOptions(selectedProvider, resolvedModelName, selectedProviderSettings),
    [selectedProvider, resolvedModelName, selectedProviderSettings]
  );
  const activeEmbeddingSetId = useVectorStatusUIStore((s) => s.activeEmbeddingSetId);
  const store = useFileExplorerStoreContext();
  const [
    tokenBudget,
    currentFolderId,
    rootDirectoryHandle,
    includeProjectTree,
    setTokenBudget,
    setIncludeProjectTree,
    setSelectedFiles,
    addMultipleSelectedFiles,
    removeMultipleSelectedFiles,
    clearSelectionRules,
  ] = store(
    (s) =>
      [
        s.tokenBudget,
        s.currentFolderId,
        s.rootDirectoryHandle,
        s.includeProjectTree,
        s.setTokenBudget,
        s.setIncludeProjectTree,
        s.setSelectedFiles,
        s.addMultipleSelectedFiles,
        s.removeMultipleSelectedFiles,
        s.clearSelectionRules,
      ] as const
  );
  const [includeFileReport, setIncludeFileReport] = useState<boolean>(() =>
    loadStoredIncludeFileReport()
  );
  const [selectionTokensFromDb, setSelectionTokensFromDb] = useState<number>(0);
  const [projectTreeTokensEstimate, setProjectTreeTokensEstimate] = useState<number>(0);
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

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(INCLUDE_FILE_REPORT_STORAGE_KEY, includeFileReport ? '1' : '0');
  }, [includeFileReport]);

  useEffect(() => {
    const folderId = selectionData.folderId;
    if (!(db && folderId && selectionData.filePaths.length > 0)) {
      setSelectionTokensFromDb(0);
      return;
    }

    let cancelled = false;
    void estimateSelectionTokenCountFromDb(db as QueryableTokenDatabase, selectionData.filePaths)
      .then((total) => {
        if (!cancelled) {
          setSelectionTokensFromDb(total);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectionTokensFromDb(0);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [db, selectionData.filePaths, selectionData.folderId]);

  useEffect(() => {
    if (!(db && includeProjectTree)) {
      setProjectTreeTokensEstimate(0);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const result = await db.query<TotalFilesRow>('SELECT COUNT(*) AS count FROM file_records');
        if (cancelled) {
          return;
        }
        const countValue = result.rows[0]?.count;
        const totalFiles =
          typeof countValue === 'number'
            ? countValue
            : Number.parseInt(String(countValue ?? '0'), 10) || 0;
        const estimatedLines =
          Math.min(totalFiles, TREE_CONTEXT_LINE_LIMIT) + (totalFiles > 0 ? 1 : 0);
        setProjectTreeTokensEstimate(estimatedLines * TREE_TOKEN_ESTIMATE_PER_LINE);
      } catch {
        if (!cancelled) {
          setProjectTreeTokensEstimate(0);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db, includeProjectTree]);

  const tokensFromCache = useMemo(() => {
    if (!(tokenCache && selectionData.folderId && selectionData.filePaths.length > 0)) {
      return 0;
    }
    let total = 0;
    for (const path of selectionData.filePaths) {
      const count = tokenCache.getTokenCount(selectionData.folderId, path);
      if (typeof count === 'number' && Number.isFinite(count)) {
        total += count;
      }
    }
    return total;
  }, [tokenCache, tokenCache?.cacheVersion, selectionData.filePaths, selectionData.folderId]);

  const contextTokenCount = useMemo(() => {
    const selectedTokens = Math.max(tokensFromCache, selectionTokensFromDb);
    const reportOverhead = includeFileReport
      ? selectionData.filePaths.length * FILE_REPORT_OVERHEAD_PER_FILE
      : 0;
    const treeTokens = includeProjectTree ? projectTreeTokensEstimate : 0;
    return selectedTokens + reportOverhead + treeTokens;
  }, [
    includeFileReport,
    includeProjectTree,
    projectTreeTokensEstimate,
    selectionData.filePaths.length,
    selectionTokensFromDb,
    tokensFromCache,
  ]);

  const handleSelectionUpdate = useCallback(
    (payload: SelectionUpdatePayload) => {
      if (!(payload.folderId && Array.isArray(payload.filePaths) && payload.filePaths.length > 0)) {
        return;
      }
      const normalizedPaths = Array.from(
        new Set(
          payload.filePaths
            .map((path) => normalizeWorkspacePath(String(path)))
            .filter((path) => path.length > 0)
            .map((path) => (path.startsWith('/') ? path : `/${path}`))
        )
      );
      if (normalizedPaths.length === 0) {
        return;
      }

      clearSelectionRules();
      if (payload.mode === 'add') {
        addMultipleSelectedFiles(payload.folderId, normalizedPaths);
        return;
      }
      if (payload.mode === 'remove') {
        removeMultipleSelectedFiles(payload.folderId, normalizedPaths);
        return;
      }

      const next = new Set<string>();
      for (const path of normalizedPaths) {
        next.add(encodeFileSelection(payload.folderId, path));
      }
      setSelectedFiles(next);
    },
    [addMultipleSelectedFiles, clearSelectionRules, removeMultipleSelectedFiles, setSelectedFiles]
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.tools?.onRootTreeSelectionUpdate) {
      return;
    }

    const unsubscribe = window.tools.onRootTreeSelectionUpdate((payload) => {
      handleSelectionUpdate(payload);
    });

    return () => {
      unsubscribe?.();
    };
  }, [handleSelectionUpdate]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.tools?.onPreviewContextSelectionUpdate) {
      return;
    }

    const unsubscribe = window.tools.onPreviewContextSelectionUpdate((payload) => {
      handleSelectionUpdate(payload);
    });

    return () => {
      unsubscribe?.();
    };
  }, [handleSelectionUpdate]);

  const nativeToolItems = useMemo<AssistantToolMenuItem[]>(() => {
    return Object.entries(NATIVE_TOOL_DEFAULTS).map(([toolId, metadata]) => ({
      id: toolId,
      label: formatToolLabel(toolId),
      enabled: typeof nativeToolStates[toolId] === 'boolean' ? nativeToolStates[toolId] : true,
      source: 'native',
      group: 'Native Tools',
      description: getToolDescription(toolId),
      category: metadata.category,
    }));
  }, [nativeToolStates]);

  const loadMcpTools = useCallback(async () => {
    if (typeof window === 'undefined' || !window.mcp?.listTools) {
      setMcpToolsIfMounted([]);
      return;
    }

    setMcpLoadingIfMounted(true);
    try {
      const toolsByServer = (await window.mcp.listTools()) as McpToolMap;
      setMcpToolsIfMounted(buildMcpMenuItems(toolsByServer));
    } catch {
      setMcpToolsIfMounted([]);
    } finally {
      setMcpLoadingIfMounted(false);
    }
  }, [setMcpLoadingIfMounted, setMcpToolsIfMounted]);

  useEffect(() => {
    void loadMcpTools();
  }, [loadMcpTools]);

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

  const selectionCount = selectionData.filePaths.length;
  const contextMenu = useMemo<AssistantContextMenuConfig>(() => {
    const selectionLabel = selectionCount > 0 ? `${selectionCount} files selected` : undefined;

    return {
      selectionCount,
      includeFileReport,
      includeProjectTree,
      contextTokenCount,
      onIncludeFileReportChange: setIncludeFileReport,
      onIncludeProjectTreeChange: setIncludeProjectTree,
      onTokenBudgetChange: setTokenBudget,
      ...(selectionLabel ? { selectionLabel } : {}),
      ...(typeof activeEmbeddingSetId === 'string' ? { embeddingSetId: activeEmbeddingSetId } : {}),
      ...(typeof tokenBudget === 'number' ? { tokenBudget } : {}),
    };
  }, [
    activeEmbeddingSetId,
    contextTokenCount,
    includeFileReport,
    includeProjectTree,
    selectionCount,
    setIncludeProjectTree,
    setTokenBudget,
    tokenBudget,
  ]);

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
    if (rootDirectoryHandle?.path) {
      data['workspaceRootPath'] = rootDirectoryHandle.path;
    }
    if (typeof tokenBudget === 'number') {
      data['tokenBudget'] = tokenBudget;
    }
    data['includeFileReport'] = includeFileReport;
    data['includeProjectTree'] = includeProjectTree;
    data['contextTokenCount'] = contextTokenCount;
    if (modelSettings) {
      data['modelSettings'] = modelSettings;
    }
    if (providerOptions) {
      data['providerOptions'] = providerOptions;
    }
    return data;
  }, [
    activeEmbeddingSetId,
    contextTokenCount,
    includeFileReport,
    includeProjectTree,
    modelSettings,
    providerOptions,
    rootDirectoryHandle?.path,
    selectionData,
    tokenBudget,
  ]);

  // Check if a model is enabled - always use DB as source of truth
  const isModelEnabled = useCallback(
    (_providerId: SupportedProvider, modelId: string): boolean => enabledModelIds.has(modelId),
    [enabledModelIds]
  );

  const providerHasEnabledModels = useCallback(
    (provider: SupportedProvider) => {
      const modelDefinitions = getProviderModelDefinitions(provider).filter(
        (model: ProviderModelDefinition) => model.type === 'llm'
      );
      return modelDefinitions.some((model: ProviderModelDefinition) =>
        enabledModelIds.has(model.id)
      );
    },
    [enabledModelIds]
  );

  const selectModelForProvider = useCallback(
    (provider: SupportedProvider) => {
      const modelDefinitions = getProviderModelDefinitions(provider).filter(
        (model: ProviderModelDefinition) => model.type === 'llm'
      );
      const enabledModels = modelDefinitions
        .filter((model: ProviderModelDefinition) => isModelEnabled(provider, model.id))
        .map((model: ProviderModelDefinition) => model.id);

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
      const currentComposite = getSelectedModel();
      const currentModelName = resolveModelNameFromComposite(currentComposite);
      if (currentModelName && isModelEnabled(currentProvider, currentModelName)) {
        return;
      }
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
    enabledModelIds,
    getSelectedProvider,
    getSelectedModel,
    clearModel,
    isModelEnabled,
    providerHasEnabledModels,
    selectModelForProvider,
  ]);

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
      setProviderSettings(providerId, updates);
    },
    [setProviderSettings]
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
        (model: ProviderModelDefinition): model is ProviderModelDefinition & { type: 'llm' } =>
          model.type === 'llm'
      );

      const models = modelDefinitions.map((model: ProviderModelDefinition & { type: 'llm' }) => ({
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
        (model: ProviderModelDefinition): model is ProviderModelDefinition & { type: 'llm' } =>
          model.type === 'llm'
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
      contextMenu={contextMenu}
      onProviderSettingsChange={handleProviderSettingsChange}
      pickerModels={pickerModels}
      pickerProviders={pickerProviders}
      providerGroups={providerGroups}
      providerSettings={providerSettings}
      requestData={requestData}
      toolMenu={toolMenu}
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
