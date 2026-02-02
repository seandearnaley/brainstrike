/**
 * Tool Group Accordion
 *
 * Accordion wrapper component for displaying tool groups with collapsible sections,
 * headers, stats, and dropdown menus for bulk actions.
 */

import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { Circle, MoreVertical, RefreshCw, Settings } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * MCP connection status types.
 */
export type McpConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

/**
 * Props for the ToolGroupAccordion component.
 */
export interface ToolGroupAccordionProps {
  /** Unique identifier for the accordion item */
  id: string;
  /** Display label for the group */
  label: string;
  /** Description of the tool group */
  description: string;
  /** Source of the tools ('native' or 'mcp') */
  source: 'native' | 'mcp';
  /** Number of enabled tools in the group */
  enabledCount: number;
  /** Total number of tools in the group */
  totalCount: number;
  /** Children content (tool list) */
  children: ReactNode;
  /** Callback for enabling all tools in the group */
  onEnableAll: () => void;
  /** Callback for disabling all tools in the group */
  onDisableAll: () => void;
  /** MCP connection status (only for MCP groups) */
  connectionStatus?: McpConnectionStatus;
  /** Error message (only for MCP groups with error status) */
  errorMessage?: string;
  /** Callback for refreshing MCP connection (only for MCP groups) */
  onRefreshConnection?: () => void;
  /** Callback for opening MCP config file (only for MCP groups) */
  onOpenConfigFile?: () => void;
}

/**
 * Get the CSS classes for the connection status indicator.
 */
function getStatusIndicatorClasses(status: McpConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'fill-green-500 text-green-500';
    case 'connecting':
      return 'fill-yellow-500 text-yellow-500';
    case 'disconnected':
      return 'fill-muted-foreground text-muted-foreground';
    case 'error':
      return 'fill-destructive text-destructive';
    default:
      return 'fill-muted-foreground text-muted-foreground';
  }
}

/**
 * Get the badge variant based on enabled count.
 */
function getBadgeVariant(
  enabledCount: number,
  totalCount: number
): 'default' | 'secondary' | 'outline' {
  if (enabledCount === 0) {
    return 'outline';
  }
  if (enabledCount === totalCount) {
    return 'default';
  }
  return 'secondary';
}

/**
 * Tool Group Accordion Component
 *
 * Displays a collapsible section for a group of tools with header, stats, and actions.
 */
export function ToolGroupAccordion({
  id,
  label,
  description,
  source,
  enabledCount,
  totalCount,
  children,
  onEnableAll,
  onDisableAll,
  connectionStatus,
  errorMessage,
  onRefreshConnection,
  onOpenConfigFile,
}: ToolGroupAccordionProps): ReactNode {
  const isMcp = source === 'mcp';
  const badgeVariant = getBadgeVariant(enabledCount, totalCount);

  return (
    <AccordionItem data-testid={`tool-group-${id}`} value={id}>
      <div className="flex items-center">
        <AccordionTrigger
          className="flex-1 hover:no-underline"
          data-testid={`tool-group-trigger-${id}`}
        >
          <div className="flex items-center gap-3">
            {/* MCP Connection Status Indicator */}
            {isMcp && connectionStatus && (
              <Circle
                className={`h-2 w-2 ${getStatusIndicatorClasses(connectionStatus)}`}
                data-testid="mcp-status-indicator"
              />
            )}

            {/* Group Label and Description */}
            <div className="text-left">
              <div className="flex items-center gap-2">
                <span className="font-medium">{label}</span>
                <Badge variant={badgeVariant}>
                  {enabledCount}/{totalCount} enabled
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm">{description}</p>
              {/* Error Message for MCP groups */}
              {isMcp && connectionStatus === 'error' && errorMessage && (
                <p className="text-destructive text-xs">{errorMessage}</p>
              )}
            </div>
          </div>
        </AccordionTrigger>

        {/* Dropdown Menu - Outside trigger to avoid nested buttons */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              className="mr-2 h-8 w-8 p-0"
              data-testid={`tool-group-menu-${id}`}
              size="sm"
              variant="ghost"
            >
              <MoreVertical className="h-4 w-4" />
              <span className="sr-only">Open menu</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-testid="enable-all-action" onClick={onEnableAll}>
              Enable All
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="disable-all-action" onClick={onDisableAll}>
              Disable All
            </DropdownMenuItem>

            {/* MCP-specific actions */}
            {isMcp && (onRefreshConnection || onOpenConfigFile) && (
              <>
                <DropdownMenuSeparator />
                {onRefreshConnection && (
                  <DropdownMenuItem
                    data-testid="refresh-connection-action"
                    onClick={onRefreshConnection}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Refresh Connection
                  </DropdownMenuItem>
                )}
                {onOpenConfigFile && (
                  <DropdownMenuItem data-testid="open-config-action" onClick={onOpenConfigFile}>
                    <Settings className="mr-2 h-4 w-4" />
                    Open Config File
                  </DropdownMenuItem>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AccordionContent data-testid={`tool-group-content-${id}`}>{children}</AccordionContent>
    </AccordionItem>
  );
}

export default ToolGroupAccordion;
