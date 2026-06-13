import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type * as React from 'react';

export interface RootSectionHeaderProps {
  /** Display name for the root folder (e.g. handle.name). */
  displayName: string;
  /** Whether the section content is currently collapsed. */
  isCollapsed: boolean;
  /**
   * Called when the disconnect (X) button is clicked. The button is only
   * rendered when this is provided (phase 5 disconnect flow); confirmation is
   * the caller's responsibility (see DisconnectRootDialog).
   */
  onDisconnect?: (() => void) | undefined;
  /** Called when the header row is clicked to toggle collapse state. */
  onToggleCollapse: () => void;
  /**
   * Optional selection control (the root's tristate select-all checkbox)
   * rendered as a SIBLING of the toggle button so checkbox clicks never
   * collapse the section (and buttons never nest — invalid HTML).
   */
  selectionControl?: React.ReactNode | undefined;
}

/**
 * Header row for a single root in the forest sidebar.
 * Shows an optional per-root select-all control, the root's display name, a
 * chevron indicating expand/collapse state, and (when onDisconnect is
 * provided) a disconnect button.
 *
 * The toggle area, the selection control, and the disconnect button are
 * SIBLINGS (nesting interactive elements inside a button is invalid HTML and
 * breaks assistive tech).
 */
export const RootSectionHeader: React.FC<RootSectionHeaderProps> = ({
  displayName,
  isCollapsed,
  onDisconnect,
  onToggleCollapse,
  selectionControl,
}) => {
  const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;
  const chevronLabel = isCollapsed ? 'Expand section' : 'Collapse section';

  return (
    <div className="group flex w-full items-center hover:bg-muted/40">
      {selectionControl && (
        <span className="flex shrink-0 items-center pl-2">{selectionControl}</span>
      )}
      <button
        aria-expanded={!isCollapsed}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 px-2 py-1 text-left font-medium text-muted-foreground text-xs uppercase tracking-wider focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="root-section-header"
        onClick={onToggleCollapse}
        type="button"
      >
        <ChevronIcon aria-label={chevronLabel} className="h-3 w-3 shrink-0" />
        <span className="truncate">{displayName}</span>
      </button>
      {onDisconnect && (
        <button
          aria-label="Disconnect folder"
          className="mr-1 shrink-0 cursor-pointer rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
          data-testid="root-section-disconnect"
          onClick={onDisconnect}
          type="button"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
};

RootSectionHeader.displayName = 'RootSectionHeader';
