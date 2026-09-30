/** Manage native/MCP tool metadata, preferences and server status. */

import type {
  McpExtensionEnablement,
  McpHostControlRequest,
} from '@brainstrike/assistant-contract';
import type { ToolCategory, ToolLoadingTier } from '@brainstrike/assistant-contract/tool-metadata';
import { type UsePGliteLiveQueryOptions, usePGliteLiveQuery } from '@brainstrike/db/react';
import {
  Accordion,
  Button,
  Card,
  CardContent,
  ErrorBoundary,
  ScrollArea,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { groupTools } from './group-tools';
import { McpConfigAlert } from './mcp-config-alert';
import { McpConfigPanel } from './mcp-config-panel';
import { McpExtensionSettings } from './mcp-extension-settings';
import { McpServerStatusRow } from './mcp-server-status-row';
import { McpSupportMatrix } from './mcp-support-status';
import { type McpToolsAvailability, resolveMcpToolsAvailability } from './mcp-tools-availability';
import { TokenBudgetSummary } from './token-budget-summary';
import type { McpConnectionStatus } from './tool-group-accordion';
import { ToolGroupAccordion } from './tool-group-accordion';
import { ToolRow } from './tool-row';
import { ToolRowExpanded } from './tool-row-expanded';
import { ToolsFilterBar } from './tools-filter-bar';
import {
  initialToolsDataState,
  initialToolsUiState,
  type ToolsDataAction,
  toolsDataReducer,
  toolsUiReducer,
} from './tools-state';
import type {
  McpConfigInfo,
  McpServerInfo,
  ToolDisplayMetadata,
  ToolGroup,
  ToolStats,
  UnifiedToolsSettingsProps,
} from './types';

const EMPTY_LIVE_QUERY = 'SELECT 1 WHERE 1 = 0';
const INITIAL_TOOLS_READ = Promise.resolve(false);

interface ToolsErrorFallbackProps {
  onRetry: () => void;
}

function ToolsErrorFallback({ onRetry }: ToolsErrorFallbackProps) {
  return (
    <Card data-testid="tools-error-fallback">
      <CardContent className="space-y-3 p-4 text-muted-foreground text-sm">
        <div className="font-medium text-foreground">Something went wrong loading tools.</div>
        <div>Retry to reload tool metadata and MCP status.</div>
        <Button onClick={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}

interface UseToolsDataManagerParams {
  dispatch: (action: ToolsDataAction) => void;
  liveQuery: ReturnType<typeof usePGliteLiveQuery<ToolDisplayMetadata>>;
  liveQueryEnabled: boolean;
  mcpAvailable: boolean;
  operations: UnifiedToolsSettingsProps['operations'];
  statsRef: { current: ToolStats | null };
}

function useToolsDataManager({
  dispatch,
  liveQuery,
  liveQueryEnabled,
  mcpAvailable,
  operations,
  statsRef,
}: UseToolsDataManagerParams) {
  const mcpConfigEpochRef = useRef(0);
  const toolsReadEpochRef = useRef(0);
  const latestToolsReadRef = useRef<Promise<boolean>>(INITIAL_TOOLS_READ);
  const subscribeMcpConfig = operations.subscribeMcpConfig;
  const subscribeMcpServerStatus = operations.subscribeMcpServerStatus;
  const subscribeMcpTools = operations.subscribeMcpTools;
  const clearMcpError = useCallback(() => {
    dispatch({ error: null, type: 'SET_MCP_ERROR' });
  }, [dispatch]);
  const applyMcpConfigInfo = useCallback(
    (configInfo: McpConfigInfo | null) => {
      dispatch({ info: configInfo, type: 'SET_MCP_CONFIG_INFO' });
      dispatch({ error: configInfo?.error ?? null, type: 'SET_MCP_ERROR' });
    },
    [dispatch]
  );
  const fetchAndApplyTools = useCallback((): Promise<boolean> => {
    const readEpoch = ++toolsReadEpochRef.current;
    // Publish the pending promise before calling operations, which may notify.
    const read = Promise.resolve()
      .then(() =>
        Promise.all([liveQueryEnabled ? null : operations.getTools(), operations.getStats()])
      )
      .then(([toolsData, stats]): boolean | Promise<boolean> => {
        if (readEpoch !== toolsReadEpochRef.current) {
          return latestToolsReadRef.current;
        }
        statsRef.current = stats;
        // Live-query rows own the catalog; only preference stats need a host read.
        if (toolsData !== null) {
          dispatch({ tools: toolsData, type: 'SET_TOOLS' });
        }
        dispatch({ error: null, type: 'SET_LOAD_ERROR' });
        dispatch({ error: stats.preferencesFault?.message ?? null, type: 'SET_PREFERENCES_ERROR' });
        return true;
      })
      .catch((err: unknown): boolean | Promise<boolean> => {
        if (readEpoch !== toolsReadEpochRef.current) {
          return latestToolsReadRef.current;
        }
        dispatch({
          error: err instanceof Error ? err.message : 'Failed to load tools',
          type: 'SET_LOAD_ERROR',
        });
        return false;
      })
      .finally(() => {
        if (readEpoch === toolsReadEpochRef.current) {
          dispatch({ loading: false, type: 'SET_LOADING' });
        }
      });
    latestToolsReadRef.current = read;
    return read;
  }, [operations, statsRef, dispatch, liveQueryEnabled]);
  const loadToolsData = useCallback(async (): Promise<boolean> => {
    dispatch({ loading: true, type: 'SET_LOADING' });
    return await fetchAndApplyTools();
  }, [fetchAndApplyTools, dispatch]);
  const loadMcpData = useCallback(async () => {
    if (!mcpAvailable) {
      return;
    }
    await Promise.resolve();
    const configEpoch = mcpConfigEpochRef.current;
    try {
      if (operations.getMcpServerStatus) {
        const snapshot = await operations.getMcpServerStatus();
        dispatch({ ...snapshot, type: 'APPLY_MCP_STATUS' });
      }
      if (operations.getMcpConfigInfo) {
        const configInfo = await operations.getMcpConfigInfo();
        if (configEpoch === mcpConfigEpochRef.current) {
          applyMcpConfigInfo(configInfo);
        }
      } else if (configEpoch === mcpConfigEpochRef.current) {
        clearMcpError();
      }
    } catch (err) {
      if (configEpoch !== mcpConfigEpochRef.current) {
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to load MCP tools';
      dispatch({ error: message, type: 'SET_MCP_ERROR' });
    }
  }, [applyMcpConfigInfo, clearMcpError, operations, mcpAvailable, dispatch]);

  useEffect(() => {
    if (liveQueryEnabled) {
      return;
    }
    void fetchAndApplyTools();
  }, [fetchAndApplyTools, liveQueryEnabled]);

  useEffect(() => {
    if (!(mcpAvailable && subscribeMcpServerStatus)) {
      return;
    }
    try {
      return subscribeMcpServerStatus((snapshot) => {
        dispatch({ ...snapshot, type: 'APPLY_MCP_STATUS' });
      });
    } catch (error) {
      dispatch({
        error: error instanceof Error ? error.message : 'Failed to subscribe to MCP host status',
        type: 'SET_MCP_ERROR',
      });
      return;
    }
  }, [dispatch, mcpAvailable, subscribeMcpServerStatus]);

  useEffect(() => {
    void loadMcpData();
  }, [loadMcpData]);

  const refreshTools = useCallback(async (): Promise<boolean> => {
    if (liveQueryEnabled) {
      try {
        await liveQuery.refresh();
        return await fetchAndApplyTools();
      } catch (err) {
        dispatch({
          error: err instanceof Error ? err.message : 'Failed to refresh tools',
          type: 'SET_LOAD_ERROR',
        });
        return false;
      }
    }
    return await loadToolsData();
  }, [liveQueryEnabled, liveQuery, fetchAndApplyTools, loadToolsData, dispatch]);

  useEffect(() => {
    if (!(mcpAvailable && subscribeMcpConfig)) {
      return;
    }
    return subscribeMcpConfig((info) => {
      mcpConfigEpochRef.current += 1;
      applyMcpConfigInfo(info);
    });
  }, [applyMcpConfigInfo, mcpAvailable, subscribeMcpConfig]);

  useEffect(() => {
    if (!(mcpAvailable && subscribeMcpTools)) {
      return;
    }
    return subscribeMcpTools(() => {
      void refreshTools();
    });
  }, [mcpAvailable, refreshTools, subscribeMcpTools]);

  const handleMcpConfigUpdated = useCallback(async () => {
    await loadMcpData();
    await refreshTools();
  }, [loadMcpData, refreshTools]);

  return { handleMcpConfigUpdated, loadMcpData, loadToolsData, refreshTools };
}

/**
 * Unified Tools Settings Component
 *
 * Accordion-based layout with:
 * - Collapsible tool groups with status indicators
 * - Dense ToolRow display with expand/collapse
 * - Integrated MCP connection status in headers
 * - Compact filter bar with inline stats
 */
export function UnifiedToolsSettings({
  operations,
  mcpAvailable = false,
  budgetManager,
  onToolsChanged,
}: UnifiedToolsSettingsProps) {
  const [dataState, dispatch] = useReducer(toolsDataReducer, initialToolsDataState);
  const _statsStateRef = useRef<ToolStats | null>(null);
  const liveQueryConfig = operations.toolsLiveQuery;
  const liveQueryEnabled = Boolean(liveQueryConfig);
  const liveQueryOptions: UsePGliteLiveQueryOptions<ToolDisplayMetadata> = {
    query: liveQueryConfig?.query ?? EMPTY_LIVE_QUERY,
    ...(liveQueryConfig?.params === undefined ? {} : { params: liveQueryConfig.params }),
    ...(liveQueryConfig?.select === undefined ? {} : { select: liveQueryConfig.select }),
    enabled: liveQueryEnabled,
    ...(liveQueryConfig?.mode === 'incremental'
      ? { key: liveQueryConfig.key, mode: 'incremental' as const }
      : {}),
  };
  const liveQuery = usePGliteLiveQuery<ToolDisplayMetadata>(liveQueryOptions);
  const tools = liveQueryEnabled ? liveQuery.rows : dataState.tools;
  const loading = liveQueryEnabled ? liveQuery.loading || dataState.loading : dataState.loading;
  const error =
    dataState.error ??
    dataState.loadError ??
    dataState.mcpError ??
    (liveQueryEnabled ? (liveQuery.error?.message ?? null) : null);
  const { mcpServers, mcpConfigInfo, mcpRevision, errorBoundaryKey } = dataState;

  const [uiState, uiDispatch] = useReducer(toolsUiReducer, initialToolsUiState);
  const {
    searchQuery,
    categoryFilter,
    tierFilter,
    expandedToolId,
    configAlertDismissed,
    activeTab,
  } = uiState;

  const { handleMcpConfigUpdated, loadMcpData, loadToolsData, refreshTools } = useToolsDataManager({
    dispatch,
    liveQuery,
    liveQueryEnabled,
    mcpAvailable,
    operations,
    statsRef: _statsStateRef,
  });

  const reloadPendingRef = useRef(false);
  const [reloadPending, setReloadPending] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const handleReloadToolPreferences = useCallback(async (): Promise<void> => {
    if (!operations.reloadToolPreferences || reloadPendingRef.current) {
      return;
    }
    reloadPendingRef.current = true;
    setReloadPending(true);
    try {
      await operations.reloadToolPreferences();
      setReloadError(null);
      if (await refreshTools()) {
        onToolsChanged?.();
      }
    } catch (err) {
      setReloadError(err instanceof Error ? err.message : 'Failed to reload tool preferences');
    } finally {
      reloadPendingRef.current = false;
      setReloadPending(false);
    }
  }, [operations, refreshTools, onToolsChanged]);

  const handleErrorBoundaryReset = useCallback(() => {
    dispatch({ loading: !liveQueryEnabled, type: 'RESET' });
    dispatch({ type: 'INCREMENT_BOUNDARY_KEY' });
    uiDispatch({ toolId: null, type: 'SET_EXPANDED_TOOL_ID' });
    if (liveQueryEnabled) {
      void liveQuery.refresh();
    } else {
      void loadToolsData();
    }
    void loadMcpData();
  }, [liveQueryEnabled, liveQuery, loadMcpData, loadToolsData]);

  const handleToggleTool = useCallback(
    async (toolId: string, currentlyEnabled: boolean) => {
      const errorSource = `${currentlyEnabled ? 'disable' : 'enable'}-tool:${toolId}`;
      try {
        if (currentlyEnabled) {
          await operations.disableTools([toolId]);
        } else {
          await operations.enableTools([toolId]);
        }
        dispatch({ source: errorSource, type: 'CLEAR_OPERATION_ERROR' });
        if (!(await refreshTools())) {
          return;
        }
      } catch (err) {
        dispatch({
          error: err instanceof Error ? err.message : 'Failed to toggle tool',
          preferencesFault: dataState.preferencesError,
          source: errorSource,
          type: 'SET_ERROR',
        });
        return;
      }
      if (onToolsChanged) {
        onToolsChanged();
      }
    },
    [operations, onToolsChanged, refreshTools, dataState.preferencesError]
  );

  const handleResetFilters = useCallback(() => {
    uiDispatch({ type: 'RESET_FILTERS' });
  }, []);

  const handleRefreshMcp = useCallback(async () => {
    if (operations.refreshMcpServers) {
      await operations.refreshMcpServers();
      await Promise.all([loadMcpData(), refreshTools()]);
    }
  }, [operations, loadMcpData, refreshTools]);

  const handleControlMcpServer = useCallback(
    async (request: McpHostControlRequest) => {
      if (!operations.controlMcpServer) {
        throw new Error('MCP lifecycle control is unavailable in this runtime.');
      }
      await operations.controlMcpServer(request);
      await Promise.all([loadMcpData(), refreshTools()]);
    },
    [loadMcpData, operations, refreshTools]
  );

  const handleResetMcpConfig = useCallback(async () => {
    if (operations.resetMcpConfig) {
      await operations.resetMcpConfig();
      await handleMcpConfigUpdated();
    }
  }, [handleMcpConfigUpdated, operations]);

  const handleSelectMcpConfig = useCallback(async () => {
    if (operations.openMcpConfig) {
      await operations.openMcpConfig();
      await handleMcpConfigUpdated();
    }
  }, [handleMcpConfigUpdated, operations]);

  const handleCreateSampleConfig = useCallback(async () => {
    if (operations.createSampleConfig) {
      const result = await operations.createSampleConfig();
      if (result.success) {
        dispatch({ source: 'create-sample-config', type: 'CLEAR_OPERATION_ERROR' });
        await handleMcpConfigUpdated();
      } else if (result.error) {
        dispatch({
          error: `Failed to create sample config: ${result.error}`,
          source: 'create-sample-config',
          type: 'SET_ERROR',
        });
      }
    }
  }, [handleMcpConfigUpdated, operations]);

  // The accordion invokes these through `() => void` props, so a rejection here
  // is dropped on the floor. They must surface the same way handleToggleTool
  // does, or a failed write stays invisible for the bulk controls (BST-1615).
  const handleEnableGroup = useCallback(
    async (group: ToolGroup) => {
      const errorSource = `enable-group:${group.id}`;
      try {
        await operations.enableTools(group.tools.map((t) => t.id));
        dispatch({ source: errorSource, type: 'CLEAR_OPERATION_ERROR' });
        if (!(await refreshTools())) {
          return;
        }
      } catch (err) {
        dispatch({
          error: err instanceof Error ? err.message : 'Failed to enable tools',
          preferencesFault: dataState.preferencesError,
          source: errorSource,
          type: 'SET_ERROR',
        });
        return;
      }
      onToolsChanged?.();
    },
    [dispatch, operations, onToolsChanged, refreshTools, dataState.preferencesError]
  );

  const handleDisableGroup = useCallback(
    async (group: ToolGroup) => {
      const errorSource = `disable-group:${group.id}`;
      try {
        await operations.disableTools(group.tools.map((t) => t.id));
        dispatch({ source: errorSource, type: 'CLEAR_OPERATION_ERROR' });
        if (!(await refreshTools())) {
          return;
        }
      } catch (err) {
        dispatch({
          error: err instanceof Error ? err.message : 'Failed to disable tools',
          preferencesFault: dataState.preferencesError,
          source: errorSource,
          type: 'SET_ERROR',
        });
        return;
      }
      onToolsChanged?.();
    },
    [dispatch, operations, onToolsChanged, refreshTools, dataState.preferencesError]
  );

  const handleExpandTool = useCallback(
    (toolId: string) => {
      uiDispatch({
        toolId: expandedToolId === toolId ? null : toolId,
        type: 'SET_EXPANDED_TOOL_ID',
      });
    },
    [expandedToolId]
  );

  const handleDismissConfigAlert = useCallback(() => {
    uiDispatch({ type: 'SET_CONFIG_ALERT_DISMISSED' });
  }, []);

  const serverStatusMap = useMemo(() => {
    const statusMap = new Map<
      string,
      { status: McpConnectionStatus; error: string | null; toolsAvailability: McpToolsAvailability }
    >();
    for (const server of mcpServers) {
      statusMap.set(server.configuredServerId, {
        error: server.state === 'error' ? server.error.message : null,
        status: server.state,
        toolsAvailability: resolveMcpToolsAvailability(server),
      });
    }
    return statusMap;
  }, [mcpServers]);

  const getServerStatus = useCallback(
    (serverName: string): McpConnectionStatus | undefined =>
      serverStatusMap.get(serverName)?.status,
    [serverStatusMap]
  );

  const getServerToolsAvailability = useCallback(
    (serverName: string): McpToolsAvailability | undefined =>
      serverStatusMap.get(serverName)?.toolsAvailability,
    [serverStatusMap]
  );

  const getServerError = useCallback(
    (serverName: string): string | undefined => serverStatusMap.get(serverName)?.error ?? undefined,
    [serverStatusMap]
  );

  const searchableTools = useMemo(
    () =>
      tools.map((tool) => ({
        searchText: [tool.id, tool.description, tool.serverName ?? ''].join(' ').toLowerCase(),
        tool,
      })),
    [tools]
  );

  const filteredTools = useMemo(() => {
    const queryLower = searchQuery.trim().toLowerCase();
    return searchableTools
      .filter(
        ({ tool, searchText }) =>
          (categoryFilter === 'all' || tool.category === categoryFilter) &&
          (tierFilter === 'all' || tool.loadingTier === tierFilter) &&
          (!queryLower || searchText.includes(queryLower))
      )
      .map(({ tool }) => tool);
  }, [searchableTools, searchQuery, categoryFilter, tierFilter]);

  const toolGroups = useMemo(() => groupTools(filteredTools), [filteredTools]);
  const missingStatusSubscriptionError =
    mcpAvailable && operations.getMcpServerStatus && !operations.subscribeMcpServerStatus
      ? 'MCP live status subscription is unavailable in this runtime.'
      : null;
  const unmatchedMcpServerName =
    mcpRevision >= 0
      ? toolGroups.find(
          (group) =>
            group.source === 'mcp' &&
            group.serverName !== undefined &&
            !serverStatusMap.has(group.serverName)
        )?.serverName
      : undefined;
  const mcpProjectionIdentityError = unmatchedMcpServerName
    ? `MCP tool projection server "${unmatchedMcpServerName}" has no matching host status.`
    : null;
  const displayedError = error ?? missingStatusSubscriptionError ?? mcpProjectionIdentityError;

  const budgetData = useMemo(() => {
    if (!budgetManager) {
      return null;
    }
    const enabledTools = tools.filter((t) => t.enabled);
    const tokenSum = (tier: string) =>
      enabledTools
        .filter((t) => t.loadingTier === tier)
        .reduce((sum, t) => sum + t.estimatedTokens, 0);
    return {
      conditionalTokens: tokenSum('conditional'),
      contextWindowSize: budgetManager.getContextResultsBudget() * 4,
      criticalTokens: tokenSum('critical'),
      totalBudget:
        budgetManager.getCriticalToolsBudget() + budgetManager.getConditionalToolsBudget(),
    };
  }, [tools, budgetManager]);

  const hasTools = tools.length > 0;
  const showConfigAlert =
    mcpAvailable && mcpConfigInfo && !mcpConfigInfo.exists && !configAlertDismissed;

  const defaultExpandedGroups = useMemo(() => toolGroups.map((g) => g.id), [toolGroups]);

  const toolsPanel = (
    <ToolsPanelContent
      budgetData={budgetData}
      categoryFilter={categoryFilter}
      defaultExpandedGroups={defaultExpandedGroups}
      error={displayedError}
      errorBoundaryKey={errorBoundaryKey}
      expandedToolId={expandedToolId}
      getServerError={getServerError}
      getServerStatus={getServerStatus}
      getServerToolsAvailability={getServerToolsAvailability}
      hasTools={hasTools}
      loading={loading}
      mcpConfigInfo={mcpConfigInfo}
      mcpRevision={mcpRevision}
      mcpServers={mcpServers}
      onCategoryChange={(category) => uiDispatch({ category, type: 'SET_CATEGORY_FILTER' })}
      onControlMcpServer={handleControlMcpServer}
      onCreateSample={operations.createSampleConfig ? handleCreateSampleConfig : undefined}
      onDisableGroup={handleDisableGroup}
      onDismissConfigAlert={handleDismissConfigAlert}
      onEnableGroup={handleEnableGroup}
      onErrorBoundaryReset={handleErrorBoundaryReset}
      onExpandTool={handleExpandTool}
      onRefreshMcp={handleRefreshMcp}
      onReloadToolPreferences={handleReloadToolPreferences}
      onResetConfig={handleResetMcpConfig}
      onResetFilters={handleResetFilters}
      onSearchChange={(query) => uiDispatch({ query, type: 'SET_SEARCH_QUERY' })}
      onSelectConfig={handleSelectMcpConfig}
      onTierChange={(tier) => uiDispatch({ tier, type: 'SET_TIER_FILTER' })}
      onToggleTool={handleToggleTool}
      operations={operations}
      preferencesError={dataState.preferencesError}
      reloadError={reloadError}
      reloadPending={reloadPending}
      searchQuery={searchQuery}
      showConfigAlert={Boolean(showConfigAlert)}
      showMcpSupport={mcpAvailable}
      tierFilter={tierFilter}
      toolGroups={toolGroups}
      totalCount={tools.length}
    />
  );

  return (
    <div className="space-y-4" data-testid="unified-tools-settings">
      {mcpAvailable ? (
        <Tabs
          onValueChange={(value) =>
            uiDispatch({
              tab: value === 'mcp-config' ? 'mcp-config' : 'tools',
              type: 'SET_ACTIVE_TAB',
            })
          }
          value={activeTab}
        >
          <TabsList size="md">
            <TabsTrigger value="tools">Tools</TabsTrigger>
            <TabsTrigger value="mcp-config">MCP Config</TabsTrigger>
          </TabsList>

          <TabsContent className="mt-4" value="tools">
            {toolsPanel}
          </TabsContent>
          <TabsContent className="mt-4" value="mcp-config">
            <McpConfigPanel onConfigChanged={handleMcpConfigUpdated} operations={operations} />
          </TabsContent>
        </Tabs>
      ) : (
        toolsPanel
      )}
    </div>
  );
}

export default UnifiedToolsSettings;

interface ToolsPanelContentProps {
  budgetData: {
    criticalTokens: number;
    conditionalTokens: number;
    totalBudget: number;
    contextWindowSize: number;
  } | null;
  categoryFilter: ToolCategory | 'all';
  defaultExpandedGroups: string[];
  error: string | null;
  errorBoundaryKey: number;
  expandedToolId: string | null;
  getServerError: (serverName: string) => string | undefined;
  getServerStatus: (serverName: string) => McpConnectionStatus | undefined;
  getServerToolsAvailability: (serverName: string) => McpToolsAvailability | undefined;
  hasTools: boolean;
  loading: boolean;
  mcpConfigInfo: McpConfigInfo | null;
  mcpRevision: number;
  mcpServers: McpServerInfo[];
  onCategoryChange: (category: ToolCategory | 'all') => void;
  onControlMcpServer: (request: McpHostControlRequest) => Promise<void>;
  onCreateSample: (() => Promise<void>) | undefined;
  onDisableGroup: (group: ToolGroup) => void;
  onDismissConfigAlert: () => void;
  onEnableGroup: (group: ToolGroup) => void;
  onErrorBoundaryReset: () => void;
  onExpandTool: (toolId: string) => void;
  onRefreshMcp: () => Promise<void>;
  onReloadToolPreferences: () => Promise<void>;
  onResetConfig: () => Promise<void>;
  onResetFilters: () => void;
  onSearchChange: (query: string) => void;
  onSelectConfig: () => Promise<void>;
  onTierChange: (tier: ToolLoadingTier | 'all') => void;
  onToggleTool: (toolId: string, currentlyEnabled: boolean) => Promise<void>;
  operations: UnifiedToolsSettingsProps['operations'];
  preferencesError: string | null;
  reloadError: string | null;
  reloadPending: boolean;
  searchQuery: string;
  showConfigAlert: boolean;
  showMcpSupport: boolean;
  tierFilter: ToolLoadingTier | 'all';
  toolGroups: ToolGroup[];
  totalCount: number;
}

function ToolsPanelContent({
  budgetData,
  categoryFilter,
  defaultExpandedGroups,
  error,
  errorBoundaryKey,
  expandedToolId,
  getServerError,
  getServerStatus,
  getServerToolsAvailability,
  hasTools,
  loading,
  mcpConfigInfo,
  mcpRevision,
  mcpServers,
  onCategoryChange,
  onControlMcpServer,
  onCreateSample,
  onDisableGroup,
  onDismissConfigAlert,
  onEnableGroup,
  onErrorBoundaryReset,
  onExpandTool,
  onRefreshMcp,
  onReloadToolPreferences,
  preferencesError,
  reloadError,
  reloadPending,
  onResetConfig,
  onResetFilters,
  onSearchChange,
  onSelectConfig,
  onTierChange,
  onToggleTool,
  operations,
  searchQuery,
  showConfigAlert,
  showMcpSupport,
  tierFilter,
  toolGroups,
  totalCount,
}: ToolsPanelContentProps) {
  // The global registered-extension dials (BST-1604) are owned by the switch
  // section but mirrored here, so the support matrix above it can report the
  // EFFECTIVE state instead of the compiled-in default.
  const [mcpExtensionPreferences, applyMcpExtensionPreferences] = useState<
    McpExtensionEnablement | undefined
  >(undefined);
  const { getMcpExtensionPreferences, setMcpExtensionPreferences } = operations;
  return (
    <div className="space-y-4">
      {budgetData && (
        <TokenBudgetSummary
          conditionalTokens={budgetData.conditionalTokens}
          contextWindowSize={budgetData.contextWindowSize}
          criticalTokens={budgetData.criticalTokens}
          totalBudget={budgetData.totalBudget}
        />
      )}

      {showConfigAlert && mcpConfigInfo && (
        <McpConfigAlert
          configInfo={mcpConfigInfo}
          onCreateSample={onCreateSample}
          onDismiss={onDismissConfigAlert}
          onResetConfig={onResetConfig}
          onSelectConfig={onSelectConfig}
        />
      )}

      {hasTools && (
        <ToolsFilterBar
          categoryFilter={categoryFilter}
          onCategoryChange={onCategoryChange}
          onReset={onResetFilters}
          onSearchChange={onSearchChange}
          onTierChange={onTierChange}
          searchQuery={searchQuery}
          tierFilter={tierFilter}
          totalCount={totalCount}
        />
      )}

      {operations.reloadToolPreferences && (
        <Button
          aria-busy={reloadPending}
          disabled={reloadPending}
          onClick={() => void onReloadToolPreferences()}
          size="sm"
          variant="outline"
        >
          Reload tool preferences
        </Button>
      )}
      {preferencesError && (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm"
          role="alert"
        >
          {preferencesError}
        </div>
      )}
      {reloadError && (
        <div
          className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm"
          role="alert"
        >
          {reloadError}
        </div>
      )}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </div>
      )}

      {showMcpSupport && <McpSupportMatrix extensionPreferences={mcpExtensionPreferences} />}

      {showMcpSupport && getMcpExtensionPreferences && setMcpExtensionPreferences && (
        <McpExtensionSettings
          getPreferences={getMcpExtensionPreferences}
          onPreferencesChange={applyMcpExtensionPreferences}
          setPreferences={setMcpExtensionPreferences}
          subscribe={operations.subscribeMcpExtensionPreferences}
        />
      )}

      {mcpRevision >= 0 && mcpServers.length === 0 && !mcpConfigInfo?.error && (
        <div className="text-muted-foreground text-sm" data-testid="mcp-server-status-empty">
          No MCP servers configured.
        </div>
      )}

      {mcpServers.length > 0 && (
        <div
          className="space-y-2"
          data-mcp-revision={mcpRevision}
          data-testid="mcp-server-status-list"
        >
          {mcpServers.map((server) => (
            <McpServerStatusRow
              controlAvailable={Boolean(operations.controlMcpServer)}
              key={server.configuredServerId}
              {...(operations.completeMcpContent && {
                onComplete: operations.completeMcpContent,
              })}
              onControl={onControlMcpServer}
              {...(operations.getMcpPrompt && { onGetPrompt: operations.getMcpPrompt })}
              {...(operations.readMcpResource && { onReadResource: operations.readMcpResource })}
              server={server}
            />
          ))}
        </div>
      )}

      {loading && (
        <div className="py-8 text-center text-muted-foreground text-sm">Loading tools...</div>
      )}

      {!(loading || hasTools) && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No tools registered. Tools will appear here when the agent runtime initializes.
          </CardContent>
        </Card>
      )}

      {!loading && hasTools && (
        <ToolsAccordionList
          defaultExpandedGroups={defaultExpandedGroups}
          errorBoundaryKey={errorBoundaryKey}
          expandedToolId={expandedToolId}
          getServerError={getServerError}
          getServerStatus={getServerStatus}
          getServerToolsAvailability={getServerToolsAvailability}
          onDisableGroup={onDisableGroup}
          onEnableGroup={onEnableGroup}
          onErrorBoundaryReset={onErrorBoundaryReset}
          onExpandTool={onExpandTool}
          onRefreshMcp={onRefreshMcp}
          onToggleTool={onToggleTool}
          operations={operations}
          toolGroups={toolGroups}
        />
      )}
    </div>
  );
}

interface ToolsAccordionListProps {
  defaultExpandedGroups: string[];
  errorBoundaryKey: number;
  expandedToolId: string | null;
  getServerError: (serverName: string) => string | undefined;
  getServerStatus: (serverName: string) => McpConnectionStatus | undefined;
  getServerToolsAvailability: (serverName: string) => McpToolsAvailability | undefined;
  onDisableGroup: (group: ToolGroup) => void;
  onEnableGroup: (group: ToolGroup) => void;
  onErrorBoundaryReset: () => void;
  onExpandTool: (toolId: string) => void;
  onRefreshMcp: () => Promise<void>;
  onToggleTool: (toolId: string, currentlyEnabled: boolean) => Promise<void>;
  operations: UnifiedToolsSettingsProps['operations'];
  toolGroups: ToolGroup[];
}

function ToolsAccordionList({
  defaultExpandedGroups,
  errorBoundaryKey,
  expandedToolId,
  getServerError,
  getServerStatus,
  getServerToolsAvailability,
  onDisableGroup,
  onEnableGroup,
  onErrorBoundaryReset,
  onExpandTool,
  onRefreshMcp,
  onToggleTool,
  operations,
  toolGroups,
}: ToolsAccordionListProps) {
  return (
    <ErrorBoundary
      fallback={<ToolsErrorFallback onRetry={onErrorBoundaryReset} />}
      key={errorBoundaryKey}
      onReset={onErrorBoundaryReset}
    >
      <ScrollArea className="max-h-[600px]" contentWidth="viewport">
        <Accordion defaultValue={defaultExpandedGroups} type="multiple">
          {toolGroups.map((group) => {
            const serverName = group.source === 'mcp' ? group.serverName : undefined;
            const connectionStatus = serverName ? getServerStatus(serverName) : undefined;
            const toolsAvailability = serverName
              ? getServerToolsAvailability(serverName)
              : undefined;
            const mcpProps =
              serverName === undefined
                ? {}
                : {
                    ...(connectionStatus ? { connectionStatus } : {}),
                    ...(toolsAvailability ? { toolsAvailability } : {}),
                    errorMessage: getServerError(serverName),
                    ...(operations.openMcpConfig && {
                      onOpenConfigFile: () => operations.openMcpConfig?.(),
                    }),
                    ...(operations.refreshMcpServers && {
                      onRefreshConnection: onRefreshMcp,
                    }),
                  };
            const description =
              group.source === 'native'
                ? 'Built-in BrainStrike tools'
                : `MCP server: ${serverName ?? 'unknown'}`;

            return (
              <ToolGroupAccordion
                description={description}
                enabledCount={group.enabledCount}
                id={group.id}
                key={group.id}
                label={group.label}
                onDisableAll={() => onDisableGroup(group)}
                onEnableAll={() => onEnableGroup(group)}
                source={group.source}
                totalCount={group.tools.length}
                {...mcpProps}
              >
                <div className="space-y-1">
                  {group.tools.map((tool) => (
                    <div key={tool.id}>
                      <ToolRow
                        expanded={expandedToolId === tool.id}
                        onExpand={onExpandTool}
                        onToggle={onToggleTool}
                        tool={tool}
                      />
                      {expandedToolId === tool.id && (
                        <ToolRowExpanded
                          tool={tool}
                          {...(operations.executeToolTest !== undefined && {
                            onExecuteTest: operations.executeToolTest,
                          })}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </ToolGroupAccordion>
            );
          })}
        </Accordion>
      </ScrollArea>
    </ErrorBoundary>
  );
}
