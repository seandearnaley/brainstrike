/**
 * Tool Card
 *
 * Individual tool display with expandable details and playground.
 *
 * @deprecated Use ToolRow for dense display, ToolRowExpanded for details.
 * This component will be removed in a future version.
 */

import { TOOL_CATEGORIES, TOOL_LOADING_TIERS } from '@brainstrike/assistant-contract/tool-metadata';
import { Badge, Switch } from '@brainstrike/ui';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ToolPlayground } from './tool-playground';
import type { ToolCardProps } from './types';

/**
 * Get badge variant based on loading tier.
 */
function getTierBadgeVariant(tier: string): 'default' | 'secondary' | 'outline' {
  switch (tier) {
    case 'critical':
      return 'default';
    case 'conditional':
      return 'secondary';
    case 'deferred':
      return 'outline';
    default:
      return 'outline';
  }
}

/**
 * Tool Card Component
 */
export function ToolCard({
  tool,
  onToggle,
  onExecuteTest,
  expanded = false,
  onExpandChange,
}: ToolCardProps) {
  const tierInfo = TOOL_LOADING_TIERS[tool.loadingTier];
  const categoryInfo = TOOL_CATEGORIES[tool.category];

  return (
    <div
      className="rounded-lg border border-border/50 transition-colors hover:border-border"
      data-testid={`tool-card-${tool.id}`}
    >
      {/* Header - Always Visible */}
      <div className="flex items-center justify-between gap-3 p-3">
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onExpandChange?.(!expanded)}
          type="button"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono text-sm">{tool.id}</code>
              <Badge className="text-[10px]" variant={getTierBadgeVariant(tool.loadingTier)}>
                {tierInfo?.label ?? tool.loadingTier}
              </Badge>
              <Badge className="text-[10px]" variant="outline">
                {categoryInfo?.label ?? tool.category}
              </Badge>
              {tool.requiresApproval && (
                <Badge className="text-[10px]" variant="outline">
                  Requires Approval
                </Badge>
              )}
            </div>
            <p className="mt-1 truncate text-muted-foreground text-sm">{tool.description}</p>
          </div>
        </button>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs">~{tool.estimatedTokens} tokens</span>
          <Switch
            checked={tool.enabled}
            data-testid={`toggle-${tool.id}`}
            onCheckedChange={() => onToggle(tool.id, tool.enabled)}
          />
        </div>
      </div>

      {/* Expanded Content */}
      {expanded && (
        <div className="border-border/50 border-t p-3">
          <p className="mb-3 text-muted-foreground text-sm">{tool.description}</p>

          {onExecuteTest && (
            <ToolPlayground
              inputSchema={tool.inputSchema}
              onExecute={(input: unknown) => onExecuteTest(tool.id, input)}
              toolId={tool.id}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default ToolCard;
