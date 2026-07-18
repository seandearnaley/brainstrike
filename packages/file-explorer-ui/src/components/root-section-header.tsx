import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@brainstrike/ui';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type * as React from 'react';

export interface RootSectionHeaderProps {
  /** Display name for the root folder (e.g. handle.name). */
  displayName: string;
  /** Whether the section content is currently collapsed. */
  isCollapsed: boolean;
  /**
   * Whether this root is the FOCUSED root (selection state,
   * `currentFolderId`). Rendered as a persistent app-state affordance
   * (left accent + row tint via `data-focused`) — deliberately NOT the
   * `:focus-visible` keyboard-focus treatment, which stays untouched.
   */
  isFocused?: boolean | undefined;
  /**
   * Whether this root is the MAIN root (`activeRootIds[0]` — the
   * assistant's operating root). Renders a small "Main" badge after the
   * name. Independent of `isFocused`.
   */
  isMain?: boolean | undefined;
  /**
   * Called when the disconnect (X) button is clicked. The button is only
   * rendered when this is provided (phase 5 disconnect flow); confirmation is
   * the caller's responsibility (see DisconnectRootDialog).
   */
  onDisconnect?: (() => void) | undefined;
  /** Called when the header row is clicked to toggle collapse state. */
  onToggleCollapse: () => void;
  /**
   * Absolute filesystem path of the root, shown as a tooltip on the name.
   * Omit for roots without a meaningful path (web FSA folders show the
   * folder name only).
   */
  path?: string | undefined;
  /**
   * Optional selection control (the root's tristate select-all checkbox)
   * rendered as a SIBLING of the toggle button so checkbox clicks never
   * collapse the section (and buttons never nest — invalid HTML).
   */
  selectionControl?: React.ReactNode | undefined;
}

/**
 * Header row for a single root in the forest sidebar.
 * Shows an optional per-root select-all control, the root's display name
 * (with the full path as a tooltip when provided), a "Main" badge when this
 * root is the assistant's operating root, a chevron indicating
 * expand/collapse state, and (when onDisconnect is provided) a disconnect
 * button. A focused root gets a persistent left accent + row tint.
 *
 * The toggle area, the selection control, and the disconnect button are
 * SIBLINGS (nesting interactive elements inside a button is invalid HTML and
 * breaks assistive tech). The Main badge is a plain span INSIDE the toggle
 * button (phrasing content — the shared Badge renders a div, which is not
 * valid button content).
 */
export const RootSectionHeader = ({
  displayName,
  isCollapsed,
  isFocused,
  isMain,
  onDisconnect,
  onToggleCollapse,
  path,
  selectionControl,
}: RootSectionHeaderProps) => {
  const ChevronIcon = isCollapsed ? ChevronRight : ChevronDown;
  const chevronLabel = isCollapsed ? 'Expand section' : 'Collapse section';

  const name = <span className="truncate">{displayName}</span>;

  return (
    <div
      className={`group relative flex w-full items-center hover:bg-muted/40 ${
        isFocused ? 'bg-muted/40' : ''
      }`}
      data-focused={isFocused ? 'true' : undefined}
      data-testid="root-section-header-row"
    >
      {isFocused && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-0.5 bg-primary"
          data-testid="root-focused-accent"
        />
      )}
      {selectionControl && (
        <span className="flex shrink-0 items-center pl-2">{selectionControl}</span>
      )}
      <button
        aria-expanded={!isCollapsed}
        className={`flex min-w-0 flex-1 cursor-pointer items-center gap-1 px-2 py-1 text-left font-medium text-xs uppercase tracking-wider focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
          isFocused ? 'text-foreground' : 'text-muted-foreground'
        }`}
        data-testid="root-section-header"
        onClick={onToggleCollapse}
        type="button"
      >
        <ChevronIcon aria-label={chevronLabel} className="h-3 w-3 shrink-0" />
        {path ? (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>{name}</TooltipTrigger>
              <TooltipContent side="bottom">{path}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          name
        )}
        {isMain && (
          <span
            className="ml-1 inline-flex shrink-0 items-center rounded-full bg-secondary px-1.5 font-medium text-[9px] text-secondary-foreground normal-case leading-4 tracking-normal"
            data-testid="root-main-badge"
          >
            Main
          </span>
        )}
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
