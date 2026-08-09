/**
 * BulkActionBar Component
 *
 * A floating action bar that appears when multiple items are selected in a
 * tree surface. Shared primitive: the file explorer's context-preview panel
 * renders it over its selection overlay to offer bulk operations on the
 * current selection.
 */

import type * as React from 'react';
import { SelectionActionBar } from '../selection-action-bar';

/**
 * Kinds of item a bulk action can apply to. Actions declare the subset they
 * handle via {@link BulkAction.applicableTypes}; the bar hides an action when
 * nothing in the selection matches.
 */
export type CollectionNodeType = 'collection' | 'file' | 'chunk' | 'embedding';

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
    <SelectionActionBar
      actions={applicableActions.map((action) => ({
        id: action.id,
        label: action.label,
        onAction: () => action.onAction(selectedIds, nodeTypes),
        ...(action.compactLabel === undefined ? {} : { compactLabel: action.compactLabel }),
        ...(action.destructive === undefined ? {} : { destructive: action.destructive }),
        ...(action.disabled === undefined ? {} : { disabled: action.disabled }),
        ...(action.disabledReason === undefined ? {} : { disabledReason: action.disabledReason }),
        ...(action.icon === undefined ? {} : { icon: action.icon }),
      }))}
      compact={compact}
      onClear={onClearSelection}
      summary={resolvedSummaryText}
      summaryDetail={resolvedSummarySubtext ? `(${resolvedSummarySubtext})` : undefined}
      {...(className === undefined ? {} : { className })}
      {...(clearButtonAriaLabel === undefined ? {} : { clearButtonAriaLabel })}
      {...(clearButtonLabel === undefined ? {} : { clearButtonLabel })}
      {...(resolvedSummarySubtextTitle === undefined || resolvedSummarySubtextTitle === null
        ? {}
        : { summaryDetailTitle: resolvedSummarySubtextTitle })}
    />
  );
}

BulkActionBar.displayName = 'BulkActionBar';

export default BulkActionBar;
