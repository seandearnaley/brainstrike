/**
 * Unified Tools Settings
 *
 * Main container component for managing all agent tools (native + MCP).
 * Provides tool listing, filtering, enable/disable, and playground testing.
 */

import type { ToolCategory, ToolLoadingTier } from '@brainstrike/agent/client';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ScrollArea,
} from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { McpConfigAlert } from './mcp-config-alert';
import { McpServerStatus } from './mcp-server-status';
import { TokenBudgetSummary } from './token-budget-summary';
import { ToolCard } from './tool-card';
import { ToolsFilterBar } from './tools-filter-bar';
import type {
  McpConfigInfo,
  McpServerInfo,
  ToolDisplayMetadata,
  ToolGroup,
  ToolStats,
  UnifiedToolsSettingsProps,
} from './types';

/**
 * Group tools by source and server.
 */
function groupTools(tools: ToolDisplayMetadata[]): ToolGroup[] {
  const groups: ToolGroup[] = [];

  // Native tools group
  const nativeTools = tools.filter((t) => t.source === 'native');
  if (nativeTools.length > 0) {
    groups.push({
      id: 'native',
      label: 'Native Tools',
      source: 'native',
      tools: nativeTools,
      enabledCount: nativeTools.filter((t) => t.enabled).length,
    });
  }

  // MCP tools grouped by server
  const mcpTools = tools.filter((t) => t.source === 'mcp');
  const byServer = new Map<string, ToolDisplayMetadata[]>();
  for (const tool of mcpTools) {
    const server = tool.serverName ?? 'unknown';
    const existing = byServer.get(server) ?? [];
    existing.push(tool);
    byServer.set(server, existing);
  }

  for (const [serverName, serverTools] of byServer) {
    groups.push({
      id: `mcp-${serverName}`,
      label: serverName,
      source: 'mcp',
      serverName,
      tools: serverTools,
      enabledCount: serverTools.filter((t) => t.enabled).length,
    });
  }

  return groups;
}

/**
 * Unified Tools Settings Component
 */
export function UnifiedToolsSettings({
  operations,
  mcpAvailable = false,
  budgetManager,
  onToolsChanged,
}: UnifiedToolsSettingsProps) {
  const [tools, setTools] = useState<ToolDisplayMetadata[]>([]);
  const [stats, setStats] = useState<ToolStats | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
  const [mcpConfigInfo, setMcpConfigInfo] = useState<McpConfigInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ToolCategory | 'all'>('all');
  const [tierFilter, setTierFilter] = useState<ToolLoadingTier | 'all'>('all');

  // Expanded tool state
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);

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

  const handleEnableServer = useCallback(
    async (serverName: string) => {
      const toolIds = tools
        .filter((t) => t.source === 'mcp' && t.serverName === serverName)
        .map((t) => t.id);
      await operations.enableTools(toolIds);
      await loadData();
      onToolsChanged?.();
    },
    [tools, operations, loadData, onToolsChanged]
  );

  const handleDisableServer = useCallback(
    async (serverName: string) => {
      const toolIds = tools
        .filter((t) => t.source === 'mcp' && t.serverName === serverName)
        .map((t) => t.id);
      await operations.disableTools(toolIds);
      await loadData();
      onToolsChanged?.();
    },
    [tools, operations, loadData, onToolsChanged]
  );

  // Filter tools
  const filteredTools = useMemo(() => {
    return tools.filter((tool) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matches =
          tool.id.toLowerCase().includes(query) ||
          tool.description.toLowerCase().includes(query) ||
          tool.serverName?.toLowerCase().includes(query);
        if (!matches) {
          return false;
        }
      }

      // Category filter
      if (categoryFilter !== 'all' && tool.category !== categoryFilter) {
        return false;
      }

      // Tier filter
      if (tierFilter !== 'all' && tool.loadingTier !== tierFilter) {
        return false;
      }

      return true;
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
      {mcpAvailable && mcpConfigInfo && !mcpConfigInfo.exists && (
        <McpConfigAlert
          configInfo={mcpConfigInfo}
          onCreateSample={operations.createSampleConfig ? handleCreateSampleConfig : undefined}
          onResetConfig={handleResetMcpConfig}
          onSelectConfig={handleSelectMcpConfig}
        />
      )}

      {/* MCP Server Status (desktop only) */}
      {mcpAvailable && (mcpServers.length > 0 || mcpConfigInfo) && (
        <McpServerStatus
          configInfo={mcpConfigInfo ?? undefined}
          loading={loading}
          onDisableServer={handleDisableServer}
          onEnableServer={handleEnableServer}
          onOpenConfig={operations.openMcpConfig}
          onRefresh={handleRefreshMcp}
          onResetConfig={operations.resetMcpConfig ? handleResetMcpConfig : undefined}
          servers={mcpServers}
        />
      )}

      {/* Stats Bar */}
      {stats && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{stats.total} total</Badge>
          <Badge variant="default">{stats.enabled} enabled</Badge>
          <Badge variant="outline">{stats.disabled} disabled</Badge>
          {stats.mcpServers > 0 && <Badge variant="outline">{stats.mcpServers} MCP servers</Badge>}
        </div>
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

      {/* Tool Groups */}
      {!loading && hasTools && (
        <ScrollArea className="h-[500px]">
          <div className="space-y-4 pr-4">
            {toolGroups.map((group) => (
              <Card key={group.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{group.label}</CardTitle>
                      <CardDescription>
                        {group.enabledCount}/{group.tools.length} enabled
                      </CardDescription>
                    </div>
                    {operations.enableBySource && (
                      <div className="flex gap-2">
                        <button
                          className="text-primary text-xs hover:underline"
                          onClick={() => {
                            if (group.source === 'native') {
                              void operations.enableBySource?.('native');
                            } else if (group.serverName) {
                              void handleEnableServer(group.serverName);
                            }
                          }}
                          type="button"
                        >
                          Enable All
                        </button>
                        <button
                          className="text-muted-foreground text-xs hover:underline"
                          onClick={() => {
                            if (group.source === 'native') {
                              void operations.disableBySource?.('native');
                            } else if (group.serverName) {
                              void handleDisableServer(group.serverName);
                            }
                          }}
                          type="button"
                        >
                          Disable All
                        </button>
                      </div>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {group.tools.map((tool) => (
                      <ToolCard
                        expanded={expandedToolId === tool.id}
                        key={tool.id}
                        onExecuteTest={operations.executeToolTest}
                        onExpandChange={(expanded) => setExpandedToolId(expanded ? tool.id : null)}
                        onToggle={handleToggleTool}
                        tool={tool}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

export default UnifiedToolsSettings;
