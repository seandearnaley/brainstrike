/**
 * Tool Row Expanded Component
 *
 * Displays the expanded details view for a tool row, including:
 * - Full tool description (no truncation)
 * - Server name for MCP tools
 * - "Requires Approval" badge when applicable
 * - Tool playground for testing (when callback provided)
 */

import { Badge, cn } from '@brainstrike/ui';
import type { ReactNode } from 'react';
import { ToolPlayground } from './tool-playground';
import type { ToolDisplayMetadata, ToolExecutionResult } from './types';

/**
 * Props for the ToolRowExpanded component.
 */
export interface ToolRowExpandedProps {
  /** Tool metadata to display */
  tool: ToolDisplayMetadata;
  /** Optional callback to execute tool tests (shows playground when provided) */
  onExecuteTest?: (toolId: string, input: unknown) => Promise<ToolExecutionResult>;
}

/**
 * Tool Row Expanded Component
 *
 * Renders the expanded details panel that appears below a tool row when expanded.
 * Shows full description, metadata, and optionally a playground for testing.
 */
export function ToolRowExpanded({ tool, onExecuteTest }: ToolRowExpandedProps): ReactNode {
  return (
    <div
      className={cn(
        'mt-1 ml-6 rounded-md border border-border/50 bg-muted/20 p-3',
        'slide-in-from-top-1 fade-in animate-in duration-200'
      )}
      data-testid={`tool-row-expanded-${tool.id}`}
    >
      {/* Description */}
      <p className="mb-3 text-sm">{tool.description}</p>

      {/* Metadata */}
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-xs">
        {tool.source === 'mcp' && tool.serverName && (
          <div className="flex items-center gap-1.5">
            <span className="font-medium">Server:</span>
            <span>{tool.serverName}</span>
          </div>
        )}
        {tool.requiresApproval && (
          <Badge className="text-[10px]" variant="outline">
            Requires Approval
          </Badge>
        )}
      </div>

      {/* Playground - only when onExecuteTest provided */}
      {onExecuteTest && (
        <ToolPlayground
          inputSchema={tool.inputSchema}
          onExecute={(input: unknown) => onExecuteTest(tool.id, input)}
          toolId={tool.id}
        />
      )}
    </div>
  );
}

export default ToolRowExpanded;
