/**
 * Unified Tools Settings
 *
 * Main container component for managing all agent tools (native + MCP).
 * Features accordion-based layout with collapsible tool groups,
 * dense tool rows, and integrated MCP status display.
 */

import type { ToolCategory, ToolLoadingTier } from '@brainstrike/agent/client';
import { Accordion, Button, Card, CardContent, ErrorBoundary, ScrollArea } from '@brainstrike/ui';
import { createLogger } from '@brainstrike/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { groupTools } from './group-tools';
import { McpConfigAlert } from './mcp-config-alert';
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

const logger = createLogger('UnifiedToolsSettings');

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
  const [tools, setTools] = useState<ToolDisplayMetadata[]>([]);
  // Stats are loaded for future use but not currently displayed
  const [, setStats] = useState<ToolStats | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [mcpConfigInfo, setMcpConfigInfo] = useState<McpConfigInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorBoundaryKey, setErrorBoundaryKey] = useState(0);
  const serverStatusRef = useRef<
    Map<string, { status: McpConnectionStatus; error: string | null }>
  >(new Map());

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ToolCategory | 'all'>('all');
  const [tierFilter, setTierFilter] = useState<ToolLoadingTier | 'all'>('all');

  // Expanded tool state
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);

  // MCP config alert dismissed state
  const [configAlertDismissed, setConfigAlertDismissed] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [toolsData, statsData] = await Promise.all([
        operations.getTools(),
        operations.getStats(),
      ]);
      setTools(toolsData);
      setStats(statsData);

      if (mcpAvailable && operations.getMcpServerStatus) {
        const servers = await operations.getMcpServerStatus();
        setMcpServers(servers);
      }

      if (mcpAvailable && operations.getMcpConfigInfo) {
        const configInfo = await operations.getMcpConfigInfo();
        setMcpConfigInfo(configInfo);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tools');
    } finally {
      setLoading(false);
    }
  }, [operations, mcpAvailable]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleErrorBoundaryReset = useCallback(() => {
    setErrorBoundaryKey((prev) => prev + 1);
    void loadData();
  }, [loadData]);

  const handleToggleTool = useCallback(
    async (toolId: string, currentlyEnabled: boolean) => {
      try {
        if (currentlyEnabled) {
          await operations.disableTools([toolId]);
        } else {
          await operations.enableTools([toolId]);
        }
        await loadData();
        onToolsChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to toggle tool');
      }
    },
    [operations, loadData, onToolsChanged]
  );

  const handleResetFilters = useCallback(() => {
    setSearchQuery('');
    setCategoryFilter('all');
    setTierFilter('all');
  }, []);

  const handleRefreshMcp = useCallback(async () => {
    if (operations.refreshMcpServers) {
      await operations.refreshMcpServers();
      await loadData();
    }
  }, [operations, loadData]);

  const handleResetMcpConfig = useCallback(async () => {
    if (operations.resetMcpConfig) {
      await operations.resetMcpConfig();
      await loadData();
    }
  }, [operations, loadData]);

  const handleSelectMcpConfig = useCallback(async () => {
    if (operations.openMcpConfig) {
      await operations.openMcpConfig();
      await loadData();
    }
  }, [operations, loadData]);

  const handleCreateSampleConfig = useCallback(async () => {
    if (operations.createSampleConfig) {
      const result = await operations.createSampleConfig();
      if (result.success) {
        await loadData();
      } else if (result.error) {
        setError(`Failed to create sample config: ${result.error}`);
      }
    }
  }, [operations, loadData]);

  const handleEnableGroup = useCallback(
    async (group: ToolGroup) => {
      const toolIds = group.tools.map((t) => t.id);
      await operations.enableTools(toolIds);
      await loadData();
      onToolsChanged?.();
    },
    [operations, loadData, onToolsChanged]
  );

  const handleDisableGroup = useCallback(
    async (group: ToolGroup) => {
      const toolIds = group.tools.map((t) => t.id);
      await operations.disableTools(toolIds);
      await loadData();
      onToolsChanged?.();
    },
    [operations, loadData, onToolsChanged]
  );

  const handleExpandTool = useCallback(
    (toolId: string) => {
      setExpandedToolId(expandedToolId === toolId ? null : toolId);
    },
    [expandedToolId]
  );

  const handleDismissConfigAlert = useCallback(() => {
    setConfigAlertDismissed(true);
  }, []);

  const serverStatusMap = useMemo(() => {
    const statusMap = new Map<string, { status: McpConnectionStatus; error: string | null }>();
    for (const server of mcpServers) {
      let status: McpConnectionStatus = 'disconnected';
      if (server.status === 'connected') {
        status = 'connected';
      } else if (server.status === 'error') {
        status = 'error';
      }
      statusMap.set(server.name, { status, error: server.error ?? null });
    }
    return statusMap;
  }, [mcpServers]);

  // biome-ignore lint/plugin: Status change logging with refs is intentional and not data fetching.
  useEffect(() => {
    const previousStatuses = serverStatusRef.current;
    for (const [serverName, nextStatus] of serverStatusMap) {
      const previous = previousStatuses.get(serverName);
      if (
        !previous ||
        previous.status !== nextStatus.status ||
        previous.error !== nextStatus.error
      ) {
        logger.info('MCP server status updated', {
          serverName,
          status: nextStatus.status,
          error: nextStatus.error ?? undefined,
        });
      }
    }

    for (const serverName of previousStatuses.keys()) {
      if (!serverStatusMap.has(serverName)) {
        logger.info('MCP server removed', { serverName });
      }
    }

    serverStatusRef.current = new Map(serverStatusMap);
  }, [serverStatusMap]);

  // Get MCP server status for a given server name
  const getServerStatus = useCallback(
    (serverName: string): McpConnectionStatus => {
      return serverStatusMap.get(serverName)?.status ?? 'disconnected';
    },
    [serverStatusMap]
  );

  const getServerError = useCallback(
    (serverName: string): string | undefined => {
      return serverStatusMap.get(serverName)?.error ?? undefined;
    },
    [serverStatusMap]
  );

  // Filter tools
  const filteredTools = useMemo(() => {
    const queryLower = searchQuery.trim().toLowerCase();
    const hasQuery = queryLower.length > 0;

    return tools.filter((tool) => {
      if (categoryFilter !== 'all' && tool.category !== categoryFilter) {
        return false;
      }

      if (tierFilter !== 'all' && tool.loadingTier !== tierFilter) {
        return false;
      }

      if (!hasQuery) {
        return true;
      }

      const idLower = tool.id.toLowerCase();
      const descriptionLower = tool.description.toLowerCase();
      const serverLower = tool.serverName?.toLowerCase() ?? '';

      return (
        idLower.includes(queryLower) ||
        descriptionLower.includes(queryLower) ||
        serverLower.includes(queryLower)
      );
    });
  }, [tools, searchQuery, categoryFilter, tierFilter]);

  // Group filtered tools
  const toolGroups = useMemo(() => groupTools(filteredTools), [filteredTools]);

  // Calculate token budget
  const budgetData = useMemo(() => {
    if (!budgetManager) {
      return null;
    }

    const enabledTools = tools.filter((t) => t.enabled);
    const criticalTokens = enabledTools
      .filter((t) => t.loadingTier === 'critical')
      .reduce((sum, t) => sum + t.estimatedTokens, 0);
    const conditionalTokens = enabledTools
      .filter((t) => t.loadingTier === 'conditional')
      .reduce((sum, t) => sum + t.estimatedTokens, 0);

    return {
      criticalTokens,
      conditionalTokens,
      totalBudget:
        budgetManager.getCriticalToolsBudget() + budgetManager.getConditionalToolsBudget(),
      contextWindowSize: budgetManager.getContextResultsBudget() * 4, // Approximate
    };
  }, [tools, budgetManager]);

  const hasTools = tools.length > 0;
  const showConfigAlert =
    mcpAvailable && mcpConfigInfo && !mcpConfigInfo.exists && !configAlertDismissed;

  // Default expanded accordion items - expand all groups by default
  const defaultExpandedGroups = useMemo(() => toolGroups.map((g) => g.id), [toolGroups]);

  return (
    <div className="space-y-4" data-testid="unified-tools-settings">
      {/* Token Budget Summary */}
      {budgetData && (
        <TokenBudgetSummary
          conditionalTokens={budgetData.conditionalTokens}
          contextWindowSize={budgetData.contextWindowSize}
          criticalTokens={budgetData.criticalTokens}
          totalBudget={budgetData.totalBudget}
        />
      )}

      {/* MCP Config Alert (when missing) */}
      {showConfigAlert && (
        <McpConfigAlert
          configInfo={mcpConfigInfo}
          onCreateSample={operations.createSampleConfig ? handleCreateSampleConfig : undefined}
          onDismiss={handleDismissConfigAlert}
          onResetConfig={handleResetMcpConfig}
          onSelectConfig={handleSelectMcpConfig}
        />
      )}

      {/* Filter Bar */}
      {hasTools && (
        <ToolsFilterBar
          categoryFilter={categoryFilter}
          onCategoryChange={setCategoryFilter}
          onReset={handleResetFilters}
          onSearchChange={setSearchQuery}
          onTierChange={setTierFilter}
          searchQuery={searchQuery}
          tierFilter={tierFilter}
          totalCount={tools.length}
        />
      )}

      {/* Error Display */}
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-destructive text-sm">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="py-8 text-center text-muted-foreground text-sm">Loading tools...</div>
      )}

      {/* Empty State */}
      {!(loading || hasTools) && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No tools registered. Tools will appear here when the agent runtime initializes.
          </CardContent>
        </Card>
      )}

      {/* Tool Groups - Accordion Layout */}
      {!loading && hasTools && (
        <ErrorBoundary
          fallback={<ToolsErrorFallback onRetry={handleErrorBoundaryReset} />}
          key={errorBoundaryKey}
          onReset={handleErrorBoundaryReset}
        >
          <ScrollArea className="max-h-[600px]">
            <Accordion defaultValue={defaultExpandedGroups} type="multiple">
              {toolGroups.map((group) => {
                const connectionStatus =
                  group.source === 'mcp' && group.serverName
                    ? getServerStatus(group.serverName)
                    : undefined;
                const errorMessage =
                  group.source === 'mcp' && group.serverName
                    ? getServerError(group.serverName)
                    : undefined;
                const onOpenConfigFile =
                  group.source === 'mcp' && operations.openMcpConfig
                    ? () => operations.openMcpConfig?.()
                    : undefined;
                const onRefreshConnection =
                  group.source === 'mcp' && operations.refreshMcpServers
                    ? handleRefreshMcp
                    : undefined;

                return (
                  <ToolGroupAccordion
                    description={
                      group.source === 'native'
                        ? 'Built-in BrainStrike tools'
                        : `MCP server: ${group.serverName}`
                    }
                    enabledCount={group.enabledCount}
                    id={group.id}
                    key={group.id}
                    label={group.label}
                    onDisableAll={() => handleDisableGroup(group)}
                    onEnableAll={() => handleEnableGroup(group)}
                    source={group.source}
                    totalCount={group.tools.length}
                    {...(connectionStatus !== undefined && { connectionStatus })}
                    {...(errorMessage !== undefined && { errorMessage })}
                    {...(onOpenConfigFile !== undefined && { onOpenConfigFile })}
                    {...(onRefreshConnection !== undefined && { onRefreshConnection })}
                  >
                    <div className="space-y-1">
                      {group.tools.map((tool) => (
                        <div key={tool.id}>
                          <ToolRow
                            expanded={expandedToolId === tool.id}
                            onExpand={handleExpandTool}
                            onToggle={handleToggleTool}
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
      )}
    </div>
  );
}

export default UnifiedToolsSettings;
