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

type McpTool = {
  id: string;
  serverName: string;
  description?: string;
  inputSchema?: unknown;
  enabled: boolean;
  discoveredAt: number;
};

type McpToolsByServer = {
  [serverName: string]: McpTool[];
};

type ToolStats = {
  total: number;
  enabled: number;
  disabled: number;
  servers: number;
};

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
              className="h-8 text-xs"
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search tools..."
              type="text"
              value={searchQuery}
            />
            <Button disabled={loading} onClick={handleResetAll} size="sm" variant="outline">
              Reset All
            </Button>
          </div>
        )}

        {!(hasTools || loading) && (
          <div className="py-4 text-center text-muted-foreground text-xs">
            No MCP tools discovered. Configure MCP servers to enable tools.
          </div>
        )}

        {loading && (
          <div className="py-4 text-center text-muted-foreground text-xs">Loading tools...</div>
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
                  <div className="space-y-2" key={serverName}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-xs">{serverName}</h3>
                        <Badge className="px-1 py-0 text-[9px]" variant="outline">
                          {serverStats.enabled}/{serverStats.total}
                        </Badge>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          className="h-6 px-2 text-[10px]"
                          onClick={() => handleEnableAllServer(serverName)}
                          size="sm"
                          variant="ghost"
                        >
                          Enable All
                        </Button>
                        <Button
                          className="h-6 px-2 text-[10px]"
                          onClick={() => handleDisableAllServer(serverName)}
                          size="sm"
                          variant="ghost"
                        >
                          Disable All
                        </Button>
                      </div>
                    </div>

                    <div className="space-y-1">
                      {serverTools.map((tool) => (
                        <div
                          className="flex items-center justify-between gap-2 rounded border border-border/50 p-2 transition-colors hover:border-border"
                          key={tool.id}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <code className="font-mono text-[10px]">{tool.id}</code>
                              <Badge
                                className="px-1 py-0 text-[8px]"
                                variant={tool.enabled ? 'default' : 'secondary'}
                              >
                                {tool.enabled ? 'enabled' : 'disabled'}
                              </Badge>
                            </div>
                            {tool.description && (
                              <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                                {tool.description}
                              </p>
                            )}
                          </div>
                          <Switch
                            checked={tool.enabled}
                            className="data-[state=checked]:bg-primary"
                            onCheckedChange={() => handleToggleTool(tool.id, tool.enabled)}
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
