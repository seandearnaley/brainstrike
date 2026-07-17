/**
 * Unified Tools Settings
 *
 * Main container component for managing all agent tools (native + MCP).
 * Features accordion-based layout with collapsible tool groups,
 * dense tool rows, and integrated MCP status display.
 */

import type { ToolCategory, ToolLoadingTier } from '@brainstrike/assistant-contract/tool-metadata';
import { type UsePGliteLiveQueryOptions, usePGliteLiveQuery } from '@brainstrike/db';
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
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { groupTools } from './group-tools';
import { McpConfigAlert } from './mcp-config-alert';
import { McpConfigPanel } from './mcp-config-panel';
import { TokenBudgetSummary } from './token-budget-summary';
import type { McpConnectionStatus } from './tool-group-accordion';
import { ToolGroupAccordion } from './tool-group-accordion';
import { ToolRow } from './tool-row';
import { ToolRowExpanded } from './tool-row-expanded';
import { ToolsFilterBar } from './tools-filter-bar';
import type {
  McpConfigInfo,
  McpServerInfo,
  ToolDisplayMetadata,
  ToolGroup,
  ToolStats,
  UnifiedToolsSettingsProps,
} from './types';

const EMPTY_LIVE_QUERY = 'SELECT 1 WHERE 1 = 0';

function areToolsEqual(
  nextTools: ToolDisplayMetadata[],
  previousTools: ToolDisplayMetadata[]
): boolean {
  if (nextTools.length !== previousTools.length) {
    return false;
  }

  for (let index = 0; index < nextTools.length; index += 1) {
    const nextTool = nextTools[index];
    const previousTool = previousTools[index];
    if (!(nextTool && previousTool)) {
      return false;
    }
    if (
      nextTool.id !== previousTool.id ||
      nextTool.source !== previousTool.source ||
      nextTool.category !== previousTool.category ||
      nextTool.loadingTier !== previousTool.loadingTier ||
      nextTool.description !== previousTool.description ||
      nextTool.enabled !== previousTool.enabled ||
      nextTool.estimatedTokens !== previousTool.estimatedTokens ||
      nextTool.requiresApproval !== previousTool.requiresApproval ||
      nextTool.serverName !== previousTool.serverName
    ) {
      return false;
    }
  }

  return true;
}

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

interface ToolsDataState {
  error: string | null;
  errorBoundaryKey: number;
  loading: boolean;
  mcpConfigInfo: McpConfigInfo | null;
  mcpServers: McpServerInfo[];
  tools: ToolDisplayMetadata[];
}

type ToolsDataAction =
  | { type: 'SET_TOOLS'; tools: ToolDisplayMetadata[] }
  | { type: 'SET_MCP_SERVERS'; servers: McpServerInfo[] }
  | { type: 'SET_MCP_CONFIG_INFO'; info: McpConfigInfo | null }
  | { type: 'SET_LOADING'; loading: boolean }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'RESET'; loading: boolean }
  | { type: 'INCREMENT_BOUNDARY_KEY' };

const initialToolsDataState: ToolsDataState = {
  error: null,
  errorBoundaryKey: 0,
  loading: true,
  mcpConfigInfo: null,
  mcpServers: [],
  tools: [],
};

function toolsDataReducer(state: ToolsDataState, action: ToolsDataAction): ToolsDataState {
  switch (action.type) {
    case 'SET_TOOLS':
      return {
        ...state,
        tools: areToolsEqual(action.tools, state.tools) ? state.tools : action.tools,
      };
    case 'SET_MCP_SERVERS':
      return { ...state, mcpServers: action.servers };
    case 'SET_MCP_CONFIG_INFO':
      return { ...state, mcpConfigInfo: action.info };
    case 'SET_LOADING':
      return { ...state, loading: action.loading };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'RESET':
      return {
        ...initialToolsDataState,
        errorBoundaryKey: state.errorBoundaryKey,
        loading: action.loading,
      };
    case 'INCREMENT_BOUNDARY_KEY':
      return { ...state, errorBoundaryKey: state.errorBoundaryKey + 1 };
    default:
      return state;
  }
}

interface ToolsUiState {
  activeTab: 'tools' | 'mcp-config';
  categoryFilter: ToolCategory | 'all';
  configAlertDismissed: boolean;
  expandedToolId: string | null;
  searchQuery: string;
  tierFilter: ToolLoadingTier | 'all';
}

type ToolsUiAction =
  | { type: 'SET_SEARCH_QUERY'; query: string }
  | { type: 'SET_CATEGORY_FILTER'; category: ToolCategory | 'all' }
  | { type: 'SET_TIER_FILTER'; tier: ToolLoadingTier | 'all' }
  | { type: 'SET_EXPANDED_TOOL_ID'; toolId: string | null }
  | { type: 'SET_CONFIG_ALERT_DISMISSED' }
  | { type: 'SET_ACTIVE_TAB'; tab: 'tools' | 'mcp-config' }
  | { type: 'RESET_FILTERS' };

const initialToolsUiState: ToolsUiState = {
  activeTab: 'tools',
  categoryFilter: 'all',
  configAlertDismissed: false,
  expandedToolId: null,
  searchQuery: '',
  tierFilter: 'all',
};

function toolsUiReducer(state: ToolsUiState, action: ToolsUiAction): ToolsUiState {
  switch (action.type) {
    case 'SET_SEARCH_QUERY':
      return { ...state, searchQuery: action.query };
    case 'SET_CATEGORY_FILTER':
      return { ...state, categoryFilter: action.category };
    case 'SET_TIER_FILTER':
      return { ...state, tierFilter: action.tier };
    case 'SET_EXPANDED_TOOL_ID':
      return { ...state, expandedToolId: action.toolId };
    case 'SET_CONFIG_ALERT_DISMISSED':
      return { ...state, configAlertDismissed: true };
    case 'SET_ACTIVE_TAB':
      return { ...state, activeTab: action.tab };
    case 'RESET_FILTERS':
      return { ...state, categoryFilter: 'all', searchQuery: '', tierFilter: 'all' };
    default:
      return state;
  }
}

interface UseToolsDataManagerParams {
  dispatch: (action: ToolsDataAction) => void;
  lastMcpErrorRef: { current: string | null };
  liveQuery: ReturnType<typeof usePGliteLiveQuery<ToolDisplayMetadata>>;
  liveQueryEnabled: boolean;
  mcpAvailable: boolean;
  operations: UnifiedToolsSettingsProps['operations'];
  statsRef: { current: ToolStats | null };
}

function useToolsDataManager({
  dispatch,
  lastMcpErrorRef,
  liveQuery,
  liveQueryEnabled,
  mcpAvailable,
  operations,
  statsRef,
}: UseToolsDataManagerParams) {
  const fetchAndApplyTools = useCallback(async () => {
    try {
      const [toolsData, stats] = await Promise.all([operations.getTools(), operations.getStats()]);
      statsRef.current = stats;
      dispatch({ tools: toolsData, type: 'SET_TOOLS' });
    } catch (err) {
      dispatch({
        error: err instanceof Error ? err.message : 'Failed to load tools',
        type: 'SET_ERROR',
      });
    }
    dispatch({ loading: false, type: 'SET_LOADING' });
  }, [operations, statsRef, dispatch]);

  const loadToolsData = useCallback(async () => {
    dispatch({ loading: true, type: 'SET_LOADING' });
    dispatch({ error: null, type: 'SET_ERROR' });
    await fetchAndApplyTools();
  }, [fetchAndApplyTools, dispatch]);

  const loadMcpData = useCallback(async () => {
    if (!mcpAvailable) {
      return;
    }
    await Promise.resolve();
    try {
      if (operations.getMcpServerStatus) {
        const servers = await operations.getMcpServerStatus();
        dispatch({ servers, type: 'SET_MCP_SERVERS' });
      }
      if (operations.getMcpConfigInfo) {
        const configInfo = await operations.getMcpConfigInfo();
        dispatch({ info: configInfo, type: 'SET_MCP_CONFIG_INFO' });
        if (configInfo) {
          const configError = configInfo.error;
          if (configError) {
            lastMcpErrorRef.current = configError;
            dispatch({ error: configError, type: 'SET_ERROR' });
            return;
          }
        }
      }
      if (lastMcpErrorRef.current) {
        lastMcpErrorRef.current = null;
        dispatch({ error: null, type: 'SET_ERROR' });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load MCP tools';
      lastMcpErrorRef.current = message;
      dispatch({ error: message, type: 'SET_ERROR' });
    }
  }, [operations, mcpAvailable, dispatch, lastMcpErrorRef]);

  useEffect(() => {
    if (liveQueryEnabled) {
      return;
    }
    void fetchAndApplyTools();
  }, [fetchAndApplyTools, liveQueryEnabled]);

  useEffect(() => {
    void loadMcpData();
  }, [loadMcpData]);

  const refreshTools = useCallback(async () => {
    if (liveQueryEnabled) {
      try {
        await liveQuery.refresh();
      } catch (err) {
        dispatch({
          error: err instanceof Error ? err.message : 'Failed to refresh tools',
          type: 'SET_ERROR',
        });
      }
      return;
    }
    await loadToolsData();
  }, [liveQueryEnabled, liveQuery, loadToolsData, dispatch]);

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
  const lastMcpErrorRef = useRef<string | null>(null);
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
  const error = dataState.error ?? (liveQueryEnabled ? (liveQuery.error?.message ?? null) : null);
  const { mcpServers, mcpConfigInfo, errorBoundaryKey } = dataState;

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
    lastMcpErrorRef,
    liveQuery,
    liveQueryEnabled,
    mcpAvailable,
    operations,
    statsRef: _statsStateRef,
  });

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
      try {
        if (currentlyEnabled) {
          await operations.disableTools([toolId]);
        } else {
          await operations.enableTools([toolId]);
        }
        await refreshTools();
      } catch (err) {
        dispatch({
          error: err instanceof Error ? err.message : 'Failed to toggle tool',
          type: 'SET_ERROR',
        });
        return;
      }
      if (onToolsChanged) {
        onToolsChanged();
      }
    },
    [operations, onToolsChanged, refreshTools]
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
        await handleMcpConfigUpdated();
      } else if (result.error) {
        dispatch({ error: `Failed to create sample config: ${result.error}`, type: 'SET_ERROR' });
      }
    }
  }, [handleMcpConfigUpdated, operations]);

  const handleEnableGroup = useCallback(
    async (group: ToolGroup) => {
      await operations.enableTools(group.tools.map((t) => t.id));
      await refreshTools();
      onToolsChanged?.();
    },
    [operations, onToolsChanged, refreshTools]
  );

  const handleDisableGroup = useCallback(
    async (group: ToolGroup) => {
      await operations.disableTools(group.tools.map((t) => t.id));
      await refreshTools();
      onToolsChanged?.();
    },
    [operations, onToolsChanged, refreshTools]
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
    const statusMap = new Map<string, { status: McpConnectionStatus; error: string | null }>();
    for (const server of mcpServers) {
      const status: McpConnectionStatus =
        server.status === 'connected'
          ? 'connected'
          : server.status === 'error'
            ? 'error'
            : 'disconnected';
      statusMap.set(server.name, { error: server.error ?? null, status });
    }
    return statusMap;
  }, [mcpServers]);

  const getServerStatus = useCallback(
    (serverName: string): McpConnectionStatus =>
      serverStatusMap.get(serverName)?.status ?? 'disconnected',
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
      error={error}
      errorBoundaryKey={errorBoundaryKey}
      expandedToolId={expandedToolId}
      getServerError={getServerError}
      getServerStatus={getServerStatus}
      hasTools={hasTools}
      loading={loading}
      mcpConfigInfo={mcpConfigInfo}
      onCategoryChange={(category) => uiDispatch({ category, type: 'SET_CATEGORY_FILTER' })}
      onCreateSample={operations.createSampleConfig ? handleCreateSampleConfig : undefined}
      onDisableGroup={handleDisableGroup}
      onDismissConfigAlert={handleDismissConfigAlert}
      onEnableGroup={handleEnableGroup}
      onErrorBoundaryReset={handleErrorBoundaryReset}
      onExpandTool={handleExpandTool}
      onRefreshMcp={handleRefreshMcp}
      onResetConfig={handleResetMcpConfig}
      onResetFilters={handleResetFilters}
      onSearchChange={(query) => uiDispatch({ query, type: 'SET_SEARCH_QUERY' })}
      onSelectConfig={handleSelectMcpConfig}
      onTierChange={(tier) => uiDispatch({ tier, type: 'SET_TIER_FILTER' })}
      onToggleTool={handleToggleTool}
      operations={operations}
      searchQuery={searchQuery}
      showConfigAlert={Boolean(showConfigAlert)}
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
          <TabsList className="h-9">
            <TabsTrigger className="px-4 text-sm" value="tools">
              Tools
            </TabsTrigger>
            <TabsTrigger className="px-4 text-sm" value="mcp-config">
              MCP Config
            </TabsTrigger>
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
  getServerStatus: (serverName: string) => McpConnectionStatus;
  hasTools: boolean;
  loading: boolean;
  mcpConfigInfo: McpConfigInfo | null;
  onCategoryChange: (category: ToolCategory | 'all') => void;
  onCreateSample: (() => Promise<void>) | undefined;
  onDisableGroup: (group: ToolGroup) => void;
  onDismissConfigAlert: () => void;
  onEnableGroup: (group: ToolGroup) => void;
  onErrorBoundaryReset: () => void;
  onExpandTool: (toolId: string) => void;
  onRefreshMcp: () => Promise<void>;
  onResetConfig: () => Promise<void>;
  onResetFilters: () => void;
  onSearchChange: (query: string) => void;
  onSelectConfig: () => Promise<void>;
  onTierChange: (tier: ToolLoadingTier | 'all') => void;
  onToggleTool: (toolId: string, currentlyEnabled: boolean) => Promise<void>;
  operations: UnifiedToolsSettingsProps['operations'];
  searchQuery: string;
  showConfigAlert: boolean;
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
  hasTools,
  loading,
  mcpConfigInfo,
  onCategoryChange,
  onCreateSample,
  onDisableGroup,
  onDismissConfigAlert,
  onEnableGroup,
  onErrorBoundaryReset,
  onExpandTool,
  onRefreshMcp,
  onResetConfig,
  onResetFilters,
  onSearchChange,
  onSelectConfig,
  onTierChange,
  onToggleTool,
  operations,
  searchQuery,
  showConfigAlert,
  tierFilter,
  toolGroups,
  totalCount,
}: ToolsPanelContentProps) {
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

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
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
  getServerStatus: (serverName: string) => McpConnectionStatus;
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
      <ScrollArea className="max-h-[600px]">
        <Accordion defaultValue={defaultExpandedGroups} type="multiple">
          {toolGroups.map((group) => {
            const serverName = group.source === 'mcp' ? group.serverName : undefined;
            const mcpProps =
              serverName === undefined
                ? {}
                : {
                    connectionStatus: getServerStatus(serverName),
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
