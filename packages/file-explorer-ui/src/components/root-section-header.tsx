import { ChevronDown, ChevronRight } from 'lucide-react';
import type * as React from 'react';

export interface RootSectionHeaderProps {
  /** Display name for the root folder (e.g. handle.name). */
  displayName: string;
  /** Whether the section content is currently collapsed. */
  isCollapsed: boolean;
  /** Called when the header row is clicked to toggle collapse state. */
  onToggleCollapse: () => void;
}

/**
 * Header row for a single root in the forest sidebar.
 * Shows the root's display name and a chevron indicating expand/collapse state.
 * No Remove button in phase 4.
 */
export const RootSectionHeader: React.FC<RootSectionHeaderProps> = ({
  displayName,
  isCollapsed,
  onToggleCollapse,
}) => {
  const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;
  const chevronLabel = isCollapsed ? 'Expand section' : 'Collapse section';

  return (
    <button
      aria-expanded={!isCollapsed}
      className="flex w-full cursor-pointer items-center gap-1 px-2 py-1 text-left font-medium text-muted-foreground text-xs uppercase tracking-wider hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      data-testid="root-section-header"
      onClick={onToggleCollapse}
      type="button"
    >
      <ChevronIcon aria-label={chevronLabel} className="h-3 w-3 shrink-0" />
      <span className="truncate">{displayName}</span>
    </button>
  );
};

RootSectionHeader.displayName = 'RootSectionHeader';
