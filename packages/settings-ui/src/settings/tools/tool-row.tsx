/**
 * Tool Row Component
 *
 * A dense, table-like row component for displaying individual tools.
 * Replaces the card-based ToolCard with a more compact design.
 */

import { TOOL_CATEGORIES, TOOL_LOADING_TIERS } from '@brainstrike/assistant-contract/tool-metadata';
import { Badge, cn, Switch, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ToolDisplayMetadata } from './types';

/**
 * Props for the ToolRow component.
 */
export interface ToolRowProps {
  /** Whether the row is currently expanded */
  expanded?: boolean;
  /** Callback when the row is clicked to expand/collapse */
  onExpand?: (toolId: string) => void;
  /** Callback when the tool enable/disable toggle is clicked */
  onToggle: (toolId: string, currentlyEnabled: boolean) => Promise<void>;
  /** Tool metadata to display */
  tool: ToolDisplayMetadata;
}

/**
 * Get abbreviated tier label for display.
 * - "conditional" -> "Cond."
 * - "deferred" -> "Defer."
 * - "critical" -> "Critical"
 */
function getAbbreviatedTierLabel(tier: ToolDisplayMetadata['loadingTier']): string {
  switch (tier) {
    case 'conditional':
      return 'Cond.';
    case 'deferred':
      return 'Defer.';
    default:
      return TOOL_LOADING_TIERS[tier].label;
  }
}

/**
 * Tool Row Component
 *
 * Displays a single tool in a dense, table-like row format with:
 * - Tool name in monospace font
 * - Category and tier badges
 * - Token count
 * - Enable/disable toggle
 * - Expand/collapse chevron
 * - Warning icon for tools requiring approval
 */
export function ToolRow({ tool, expanded = false, onToggle, onExpand }: ToolRowProps): ReactNode {
  const categoryLabel = TOOL_CATEGORIES[tool.category].label;
  const tierLabel = getAbbreviatedTierLabel(tool.loadingTier);

  const handleRowClick = (): void => {
    onExpand?.(tool.id);
  };

  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onExpand?.(tool.id);
    }
  };

  const handleToggleClick = (event: React.MouseEvent): void => {
    // Stop propagation to prevent row click handler from firing
    event.stopPropagation();
  };

  const handleCheckedChange = (): void => {
    void onToggle(tool.id, tool.enabled);
  };

  return (
    /* biome-ignore lint/a11y/useSemanticElements: role="row" used for accessible table-like structure in non-table context */
    <div
      className={cn(
        'flex cursor-pointer items-center gap-3 border-border/50 border-b px-3 py-2 transition-colors hover:bg-muted/50',
        !tool.enabled && 'opacity-70'
      )}
      data-testid={`tool-row-${tool.id}`}
      onClick={handleRowClick}
      onKeyDown={handleRowKeyDown}
      role="row"
      tabIndex={0}
    >
      {/* Expand/Collapse Chevron */}
      <span className="w-4 flex-shrink-0" data-testid={expanded ? 'chevron-down' : 'chevron-right'}>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
      </span>

      {/* Tool Name (monospace) */}
      <code className="flex-1 truncate font-mono text-sm">{tool.id}</code>

      {/* Warning Icon for tools requiring approval */}
      {tool.requiresApproval && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="flex-shrink-0 rounded p-0.5 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              data-testid="requires-approval-icon"
              onClick={(e) => e.stopPropagation()}
              type="button"
            >
              <AlertTriangle className="h-4 w-4 text-warning" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Requires user approval before execution</TooltipContent>
        </Tooltip>
      )}

      {/* Category Badge */}
      <Badge className="flex-shrink-0 text-xs" variant="outline">
        {categoryLabel}
      </Badge>

      {/* Tier Badge */}
      <Badge className="flex-shrink-0 text-xs" variant="secondary">
        {tierLabel}
      </Badge>

      {/* Token Count */}
      <span className="w-12 flex-shrink-0 text-right text-muted-foreground text-xs">
        ~{tool.estimatedTokens}
      </span>

      {/* Enable/Disable Toggle */}
      <Switch
        checked={tool.enabled}
        className="flex-shrink-0"
        data-testid={`tool-toggle-${tool.id}`}
        onCheckedChange={handleCheckedChange}
        onClick={handleToggleClick}
      />
    </div>
  );
}

export default ToolRow;
