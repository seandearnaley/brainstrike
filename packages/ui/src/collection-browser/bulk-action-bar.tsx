/**
 * BulkActionBar Component
 *
 * A floating action bar that appears when multiple items are selected
 * in the Collection Browser. Provides bulk operations like delete,
 * embed, export, etc.
 */

import { FileText, Sparkles, Trash2, X } from 'lucide-react';
import type * as React from 'react';
import { Button } from '../button';
import { cn } from '../lib/utils';
import type { BrowserNodeData, CollectionNodeType } from './types';

/**
 * Bulk action definition
 */
export interface BulkAction {
  /** Node types this action applies to (if not specified, applies to all) */
  applicableTypes?: CollectionNodeType[];
  /** Short label for compact/responsive display (falls back to label) */
  compactLabel?: string;
  /** Whether the action is destructive (will be styled differently) */
  destructive?: boolean;
  /** Whether this action is disabled */
  disabled?: boolean;
  /** Tooltip for the disabled state */
  disabledReason?: string;
  /** Icon component */
  icon?: React.ReactNode;
  /** Unique identifier for this action */
  id: string;
  /** Label to display on the button */
  label: string;
  /** Action handler - receives selected node IDs and their types */
  onAction: (selectedIds: Set<string>, nodeTypes: Map<string, CollectionNodeType>) => void;
}

/**
 * Props for the BulkActionBar component
 */
export interface BulkActionBarProps {
  /** Available actions */
  actions: BulkAction[];
  /** Custom class name */
  className?: string;
  /** Custom clear button aria label */
  clearButtonAriaLabel?: string;
  /** Custom clear button text */
  clearButtonLabel?: string;
  /** Enable responsive compact mode — labels collapse to icon-only at narrow widths */
  compact?: boolean;
  /** Map of node ID to node data */
  nodeData?: Map<string, BrowserNodeData>;
  /** Map of node ID to node type */
  nodeTypes: Map<string, CollectionNodeType>;
  /** Called when selection is cleared */
  onClearSelection: () => void;
  /** Set of selected node IDs */
  selectedIds: Set<string>;
  /** Optional custom summary text shown before actions */
  summarySubtext?: string | null;
  /** Optional title shown when hovering over summary subtext */
  summarySubtextTitle?: string;
  /** Optional custom primary summary text */
  summaryText?: string;
}

/**
 * Get counts of selected items by type
 */
function getSelectionCounts(
  selectedIds: Set<string>,
  nodeTypes: Map<string, CollectionNodeType>
): Map<CollectionNodeType, number> {
  const counts = new Map<CollectionNodeType, number>();

  for (const id of selectedIds) {
    const type = nodeTypes.get(id);
    if (type) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }

  return counts;
}

/**
 * Format a count with proper pluralization
 */
function formatTypeCount(count: number, singular: string): string | null {
  if (count === 0) {
    return null;
  }
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/**
 * Format selection summary text
 */
function formatSelectionSummary(counts: Map<CollectionNodeType, number>): string {
  const typeLabels: [CollectionNodeType, string][] = [
    ['collection', 'collection'],
    ['file', 'file'],
    ['chunk', 'chunk'],
    ['embedding', 'embedding'],
  ];

  return typeLabels
    .map(([type, label]) => formatTypeCount(counts.get(type) ?? 0, label))
    .filter((part): part is string => part !== null)
    .join(', ');
}

/**
 * Check if an action is applicable to the current selection
 */
function isActionApplicable(
  action: BulkAction,
  nodeTypes: Map<string, CollectionNodeType>,
  selectedIds: Set<string>
): boolean {
  if (!action.applicableTypes || action.applicableTypes.length === 0) {
    return true;
  }

  // Action is applicable if at least one selected item matches an applicable type
  for (const id of selectedIds) {
    const type = nodeTypes.get(id);
    if (type && action.applicableTypes.includes(type)) {
      return true;
    }
  }

  return false;
}

/**
 * BulkActionBar - Floating action bar for bulk operations
 */
export function BulkActionBar({
  selectedIds,
  nodeTypes,
  actions,
  onClearSelection,
  className,
  clearButtonAriaLabel,
  clearButtonLabel,
  compact = false,
  summarySubtext,
  summarySubtextTitle,
  summaryText,
}: BulkActionBarProps) {
  // Don't render if nothing is selected
  if (selectedIds.size === 0) {
    return null;
  }

  const counts = getSelectionCounts(selectedIds, nodeTypes);
  const defaultSummarySubtext = formatSelectionSummary(counts);
  const resolvedSummaryText = summaryText ?? `${selectedIds.size} selected`;
  const resolvedSummarySubtext =
    summarySubtext === undefined ? defaultSummarySubtext : summarySubtext;
  const resolvedSummarySubtextTitle = summarySubtextTitle ?? resolvedSummarySubtext;
  const applicableActions = actions.filter((action) =>
    isActionApplicable(action, nodeTypes, selectedIds)
  );

  return (
    <div
      className={cn(
        'flex max-w-[min(96vw,920px)] items-center gap-2 rounded-xl',
        'border border-border/80 bg-muted px-3 py-2',
        'md:gap-3 md:px-4',
        className
      )}
      style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.15), 0 2px 6px rgba(0,0,0,0.1)' }}
    >
      {/* Selection summary */}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        <span className="whitespace-nowrap font-medium">{resolvedSummaryText}</span>
        {resolvedSummarySubtext && (
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={resolvedSummarySubtextTitle ?? undefined}
          >
            ({resolvedSummarySubtext})
          </span>
        )}
      </div>

      {applicableActions.length > 0 && (
        <>
          {/* Divider */}
          <div className="hidden h-4 w-px bg-border md:block" />

          {/* Action buttons */}
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {applicableActions.map((action) => (
              <Button
                className="gap-1.5 whitespace-nowrap"
                disabled={action.disabled}
                key={action.id}
                onClick={() => action.onAction(selectedIds, nodeTypes)}
                size="sm"
                title={action.disabled ? action.disabledReason : action.label}
                variant={action.destructive ? 'destructive' : 'secondary'}
              >
                {action.icon}
                <span className={compact ? '@[350px]:inline hidden' : undefined}>
                  {(compact ? action.compactLabel : undefined) ?? action.label}
                </span>
              </Button>
            ))}
          </div>
        </>
      )}

      {/* Clear selection button */}
      <Button
        aria-label={clearButtonAriaLabel ?? 'Clear selection'}
        className="ml-auto gap-1 whitespace-nowrap"
        onClick={onClearSelection}
        size="sm"
        title={clearButtonLabel ?? 'Clear'}
        variant="ghost"
      >
        <X className="h-4 w-4" />
        <span className={compact ? '@[350px]:inline hidden' : undefined}>
          {clearButtonLabel ?? 'Clear'}
        </span>
      </Button>
    </div>
  );
}

/**
 * Default bulk actions for common operations
 */
export const DEFAULT_BULK_ACTIONS: BulkAction[] = [
  {
    id: 'embed',
    label: 'Embed',
    icon: <Sparkles className="h-4 w-4" />,
    onAction: () => {
      // Placeholder - will be overridden by consumer
    },
    applicableTypes: ['file', 'chunk'],
  },
  {
    id: 'export',
    label: 'Export',
    icon: <FileText className="h-4 w-4" />,
    onAction: () => {
      // Placeholder - will be overridden by consumer
    },
  },
  {
    id: 'delete',
    label: 'Delete',
    icon: <Trash2 className="h-4 w-4" />,
    onAction: () => {
      // Placeholder - will be overridden by consumer
    },
    destructive: true,
    applicableTypes: ['file', 'chunk'],
  },
];

BulkActionBar.displayName = 'BulkActionBar';

export default BulkActionBar;
