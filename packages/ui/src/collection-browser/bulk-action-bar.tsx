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
  /** Unique identifier for this action */
  id: string;
  /** Label to display on the button */
  label: string;
  /** Icon component */
  icon?: React.ReactNode;
  /** Action handler - receives selected node IDs and their types */
  onAction: (selectedIds: Set<string>, nodeTypes: Map<string, CollectionNodeType>) => void;
  /** Whether the action is destructive (will be styled differently) */
  destructive?: boolean;
  /** Whether this action is disabled */
  disabled?: boolean;
  /** Tooltip for the disabled state */
  disabledReason?: string;
  /** Node types this action applies to (if not specified, applies to all) */
  applicableTypes?: CollectionNodeType[];
}

/**
 * Props for the BulkActionBar component
 */
export interface BulkActionBarProps {
  /** Set of selected node IDs */
  selectedIds: Set<string>;
  /** Map of node ID to node type */
  nodeTypes: Map<string, CollectionNodeType>;
  /** Map of node ID to node data */
  nodeData?: Map<string, BrowserNodeData>;
  /** Available actions */
  actions: BulkAction[];
  /** Called when selection is cleared */
  onClearSelection: () => void;
  /** Custom class name */
  className?: string;
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
  return `${count} ${singular}${count !== 1 ? 's' : ''}`;
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
}: BulkActionBarProps) {
  // Don't render if nothing is selected
  if (selectedIds.size === 0) {
    return null;
  }

  const counts = getSelectionCounts(selectedIds, nodeTypes);
  const summary = formatSelectionSummary(counts);

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border bg-accent/90 px-4 py-2 shadow-lg backdrop-blur-sm',
        className
      )}
    >
      {/* Selection summary */}
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{selectedIds.size} selected</span>
        <span className="text-muted-foreground">({summary})</span>
      </div>

      {/* Divider */}
      <div className="h-4 w-px bg-border" />

      {/* Action buttons */}
      <div className="flex items-center gap-1">
        {actions
          .filter((action) => isActionApplicable(action, nodeTypes, selectedIds))
          .map((action) => (
            <Button
              className="gap-1.5"
              disabled={action.disabled}
              key={action.id}
              onClick={() => action.onAction(selectedIds, nodeTypes)}
              size="sm"
              title={action.disabled ? action.disabledReason : undefined}
              variant={action.destructive ? 'destructive' : 'secondary'}
            >
              {action.icon}
              {action.label}
            </Button>
          ))}
      </div>

      {/* Clear selection button */}
      <Button
        aria-label="Clear selection"
        className="ml-auto gap-1"
        onClick={onClearSelection}
        size="sm"
        variant="ghost"
      >
        <X className="h-4 w-4" />
        Clear
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
