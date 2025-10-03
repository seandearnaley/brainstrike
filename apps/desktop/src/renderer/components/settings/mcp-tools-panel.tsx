import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  ScrollArea,
  Switch,
  useToast,
} from '@brainstrike/ui';
import { useCallback, useEffect, useState } from 'react';

interface McpTool {
  id: string;
  serverName: string;
  description?: string;
  inputSchema?: unknown;
  enabled: boolean;
  discoveredAt: number;
}

interface McpToolsByServer {
  [serverName: string]: McpTool[];
}

interface ToolStats {
  total: number;
  enabled: number;
  disabled: number;
  servers: number;
}

export function McpToolsPanel() {
  const [tools, setTools] = useState<McpToolsByServer>({});
  const [stats, setStats] = useState<ToolStats | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const loadTools = useCallback(async () => {
    setLoading(true);
    try {
      const [toolsData, statsData] = await Promise.all([
        window.mcp?.listTools?.(),
        window.mcp?.getToolStats?.(),
      ]);

      if (toolsData) {
        setTools(toolsData);
      }
      if (statsData) {
        setStats(statsData);
      }
    } catch (error) {
      toast({
        title: 'Failed to load tools',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadTools();
  }, [loadTools]);

  const handleToggleTool = useCallback(
    async (toolId: string, currentlyEnabled: boolean) => {
      try {
        if (currentlyEnabled) {
          await window.mcp?.disableTools?.([toolId]);
        } else {
          await window.mcp?.enableTools?.([toolId]);
        }
        await loadTools();
        toast({
          title: currentlyEnabled ? 'Tool disabled' : 'Tool enabled',
          description: toolId,
        });
      } catch (error) {
        toast({
          title: 'Failed to toggle tool',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        });
      }
    },
    [loadTools, toast]
  );

  const handleEnableAllServer = useCallback(
    async (serverName: string) => {
      try {
        await window.mcp?.enableServerTools?.(serverName);
        await loadTools();
        toast({
          title: 'Server tools enabled',
          description: `All tools from ${serverName} are now enabled`,
        });
      } catch (error) {
        toast({
          title: 'Failed to enable server tools',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        });
      }
    },
    [loadTools, toast]
  );

  const handleDisableAllServer = useCallback(
    async (serverName: string) => {
      try {
        await window.mcp?.disableServerTools?.(serverName);
        await loadTools();
        toast({
          title: 'Server tools disabled',
          description: `All tools from ${serverName} are now disabled`,
        });
      } catch (error) {
        toast({
          title: 'Failed to disable server tools',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        });
      }
    },
    [loadTools, toast]
  );

  const handleResetAll = useCallback(async () => {
    try {
      await window.mcp?.resetTools?.();
      await loadTools();
      toast({
        title: 'Tools reset',
        description: 'All tools have been reset to their default state',
      });
    } catch (error) {
      toast({
        title: 'Failed to reset tools',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    }
  }, [loadTools, toast]);

  const filteredTools = Object.entries(tools).reduce((acc, [serverName, serverTools]) => {
    const filtered = serverTools.filter(
      (tool) =>
        tool.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
        tool.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        serverName.toLowerCase().includes(searchQuery.toLowerCase())
    );
    if (filtered.length > 0) {
      acc[serverName] = filtered;
    }
    return acc;
  }, {} as McpToolsByServer);

  const hasTools = Object.keys(tools).length > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm">MCP Tools</CardTitle>
            <CardDescription className="text-xs">Manage tools from MCP servers</CardDescription>
          </div>
          {stats && (
            <div className="flex gap-2 text-[10px]">
              <Badge variant="secondary">{stats.total} total</Badge>
              <Badge variant="default">{stats.enabled} enabled</Badge>
              <Badge variant="outline">{stats.disabled} disabled</Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasTools && (
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="Search tools..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="text-xs h-8"
            />
            <Button size="sm" variant="outline" onClick={handleResetAll} disabled={loading}>
              Reset All
            </Button>
          </div>
        )}

        {!hasTools && !loading && (
          <div className="text-xs text-muted-foreground py-4 text-center">
            No MCP tools discovered. Configure MCP servers to enable tools.
          </div>
        )}

        {loading && (
          <div className="text-xs text-muted-foreground py-4 text-center">Loading tools...</div>
        )}

        {hasTools && (
          <ScrollArea className="h-[400px]">
            <div className="space-y-4 pr-4">
              {Object.entries(filteredTools).map(([serverName, serverTools]) => {
                const serverStats = {
                  total: serverTools.length,
                  enabled: serverTools.filter((t) => t.enabled).length,
                };

                return (
                  <div key={serverName} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <h3 className="text-xs font-semibold">{serverName}</h3>
                        <Badge variant="outline" className="text-[9px] px-1 py-0">
                          {serverStats.enabled}/{serverStats.total}
                        </Badge>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[10px] px-2"
                          onClick={() => handleEnableAllServer(serverName)}
                        >
                          Enable All
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-[10px] px-2"
                          onClick={() => handleDisableAllServer(serverName)}
                        >
                          Disable All
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-1">
                      {serverTools.map((tool) => (
                        <div
                          key={tool.id}
                          className="flex items-center justify-between gap-2 p-2 rounded border border-border/50 hover:border-border transition-colors"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <code className="text-[10px] font-mono">{tool.id}</code>
                              <Badge
                                variant={tool.enabled ? 'default' : 'secondary'}
                                className="text-[8px] px-1 py-0"
                              >
                                {tool.enabled ? 'enabled' : 'disabled'}
                              </Badge>
                            </div>
                            {tool.description && (
                              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                                {tool.description}
                              </p>
                            )}
                          </div>
                          <Switch
                            checked={tool.enabled}
                            onCheckedChange={() => handleToggleTool(tool.id, tool.enabled)}
                            className="data-[state=checked]:bg-primary"
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}

export default McpToolsPanel;
