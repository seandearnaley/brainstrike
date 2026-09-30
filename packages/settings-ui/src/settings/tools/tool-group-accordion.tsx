/**
 * Tool Group Accordion
 *
 * Accordion wrapper component for displaying tool groups with collapsible sections,
 * headers, stats, and dropdown menus for bulk actions.
 */

import type { McpConnectionState } from '@brainstrike/assistant-contract';
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
import { describeMcpToolsAvailability, type McpToolsAvailability } from './mcp-tools-availability';

/**
 * MCP connection status types.
 */
export type McpConnectionStatus = McpConnectionState;

/**
 * Props for the ToolGroupAccordion component.
 */
export interface ToolGroupAccordionProps {
  /** Children content (tool list) */
  children: ReactNode;
  /** MCP connection status (only for MCP groups) */
  connectionStatus?: McpConnectionStatus;
  /** Description of the tool group */
  description: string;
  /** Number of enabled tools in the group */
  enabledCount: number;
  /** Error message (only for MCP groups with error status) */
  errorMessage?: string;
  /** Unique identifier for the accordion item */
  id: string;
  /** Display label for the group */
  label: string;
  /** Callback for disabling all tools in the group */
  onDisableAll: () => void;
  /** Callback for enabling all tools in the group */
  onEnableAll: () => void;
  /** Callback for opening MCP config file (only for MCP groups) */
  onOpenConfigFile?: () => void;
  /** Callback for refreshing MCP connection (only for MCP groups) */
  onRefreshConnection?: () => void;
  /** Source of the tools ('native' or 'mcp') */
  source: 'native' | 'mcp';
  /**
   * Whether a CONNECTED server's tool list actually loaded (BST-1603). A
   * connected server that enumerated nothing gets the same warning colour as a
   * connecting one, because it is in the same position from the user's seat:
   * present, but contributing no tools to a run.
   */
  toolsAvailability?: McpToolsAvailability;
  /** Total number of tools in the group */
  totalCount: number;
}

/**
 * Get the CSS classes for the connection status indicator.
 */
function getStatusIndicatorClasses(
  status: McpConnectionStatus,
  toolsAvailability: McpToolsAvailability | undefined
): string {
  switch (status) {
    case 'connected':
      // Green means "this server is contributing tools", NOT merely "the
      // handshake succeeded" (BST-1603). Those two came apart silently before:
      // a server that connected and failed to enumerate showed the same green
      // dot as a healthy one, which is why the row could not be trusted.
      //
      // A settled enumeration failure is warning; a connection still in
      // progress is info. Keep these distinct, with the accessible status
      // label carrying the meaning independently of the color.
      return toolsAvailability === 'tools-unavailable'
        ? 'fill-warning text-warning'
        : 'fill-success text-success';
    case 'connecting':
    case 'authorizing':
      return 'fill-info text-info';
    case 'authentication-required':
      return 'fill-warning text-warning';
    case 'disconnected':
    case 'closing':
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
  toolsAvailability,
  errorMessage,
  onRefreshConnection,
  onOpenConfigFile,
}: ToolGroupAccordionProps): ReactNode {
  const isMcp = source === 'mcp';
  const badgeVariant = getBadgeVariant(enabledCount, totalCount);
  // Colour alone is not a signal — invisible to screen readers and to anyone
  // with a colour-vision deficiency. It also gives E2E a non-colour hook, which
  // matters here: asserting a fill class is exactly as fragile as the "row says
  // Connected" signal this change exists to replace (PR #2945 review).
  const toolsAvailabilityLabel = toolsAvailability
    ? describeMcpToolsAvailability(toolsAvailability)
    : undefined;

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
                aria-hidden={toolsAvailabilityLabel ? undefined : true}
                aria-label={
                  toolsAvailabilityLabel ? `Connected, ${toolsAvailabilityLabel}` : undefined
                }
                className={`h-2 w-2 ${getStatusIndicatorClasses(connectionStatus, toolsAvailability)}`}
                data-testid="mcp-status-indicator"
                data-tools-availability={toolsAvailability ?? 'unknown'}
                role={toolsAvailabilityLabel ? 'img' : undefined}
              >
                <title>
                  {toolsAvailabilityLabel ? `Connected, ${toolsAvailabilityLabel}` : ''}
                </title>
              </Circle>
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
