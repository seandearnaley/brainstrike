/**
 * MCP Server Status
 *
 * Displays MCP server connection status and controls.
 */

import { Button, Card, CardContent, CardHeader, CardTitle } from '@brainstrike/ui';
import { Circle, RefreshCw, Settings } from 'lucide-react';
import type { McpServerStatusProps } from './types';

/**
 * MCP Server Status Component
 */
export function McpServerStatus({
  servers,
  onRefresh,
  onOpenConfig,
  onEnableServer,
  onDisableServer,
  loading = false,
}: McpServerStatusProps) {
  if (servers.length === 0) {
    return null;
  }

  return (
    <Card data-testid="mcp-server-status">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">MCP Servers</CardTitle>
          <div className="flex gap-2">
            <Button
              data-testid="refresh-mcp"
              disabled={loading}
              onClick={onRefresh}
              size="sm"
              variant="outline"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            {onOpenConfig && (
              <Button data-testid="open-config" onClick={onOpenConfig} size="sm" variant="outline">
                <Settings className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {servers.map((server) => (
            <div
              className="flex items-center justify-between rounded-md border border-border/50 p-2"
              data-testid={`server-${server.name}`}
              key={server.name}
            >
              <div className="flex items-center gap-2">
                <Circle
                  className={`h-2 w-2 ${
                    server.status === 'connected'
                      ? 'fill-green-500 text-green-500'
                      : server.status === 'error'
                        ? 'fill-destructive text-destructive'
                        : 'fill-muted-foreground text-muted-foreground'
                  }`}
                />
                <span className="font-medium text-sm">{server.name}</span>
                <span className="text-muted-foreground text-xs">{server.toolCount} tools</span>
              </div>
              <div className="flex gap-1">
                <Button
                  className="h-6 px-2 text-[10px]"
                  onClick={() => onEnableServer(server.name)}
                  size="sm"
                  variant="ghost"
                >
                  Enable All
                </Button>
                <Button
                  className="h-6 px-2 text-[10px]"
                  onClick={() => onDisableServer(server.name)}
                  size="sm"
                  variant="ghost"
                >
                  Disable All
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export default McpServerStatus;
