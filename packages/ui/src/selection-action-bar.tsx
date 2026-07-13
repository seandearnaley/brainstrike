import { X } from 'lucide-react';
import type * as React from 'react';
import { Button } from './button';
import { cn } from './lib/utils';

export interface SelectionAction {
  /** Shorter visible label used when the bar is in compact mode. */
  compactLabel?: string;
  /** Whether to use the destructive button treatment. */
  destructive?: boolean;
  /** Whether the action is currently unavailable. */
  disabled?: boolean;
  /** Explanation exposed through the disabled action's title. */
  disabledReason?: string;
  /** Optional leading icon. */
  icon?: React.ReactNode;
  /** Stable action identifier. */
  id: string;
  /** Human-readable action label. */
  label: string;
  /** Runs the action against state owned by the consumer. */
  onAction: () => void;
}

export interface SelectionActionBarProps {
  /** Actions available for the current selection. */
  actions: SelectionAction[];
  /** Accessible name for the toolbar. */
  ariaLabel?: string;
  /** Optional custom class name. */
  className?: string;
  /** Accessible label for the clear button. */
  clearButtonAriaLabel?: string;
  /** Visible label for the clear button. */
  clearButtonLabel?: string;
  /** Use compact labels and reveal text based on the bar's own width. */
  compact?: boolean;
  /** Clear the current selection. */
  onClear: () => void;
  /** Primary selection status. Strings and composed React content are supported. */
  summary: React.ReactNode;
  /** Optional secondary status content. */
  summaryDetail?: React.ReactNode;
  /** Native title for truncated secondary status content. */
  summaryDetailTitle?: string;
}

/**
 * A collection-agnostic floating toolbar for actions against an ephemeral selection.
 */
export function SelectionActionBar({
  actions,
  ariaLabel = 'Selection actions',
  className,
  clearButtonAriaLabel = 'Clear selection',
  clearButtonLabel = 'Clear',
  compact = false,
  onClear,
  summary,
  summaryDetail,
  summaryDetailTitle,
}: SelectionActionBarProps): React.JSX.Element {
  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    if (event.defaultPrevented || event.key !== 'Escape') {
      return;
    }

    event.preventDefault();
    onClear();
  }

  return (
    <div
      aria-label={ariaLabel}
      className={cn(
        '@container/selection-actions flex max-w-full items-center gap-2 rounded-xl',
        'border border-border/80 bg-popover/95 p-2 shadow-lg backdrop-blur-sm',
        'transition-[border-color,background-color,box-shadow] motion-reduce:transition-none',
        className
      )}
      role="toolbar"
    >
      <div
        aria-atomic="true"
        aria-live="polite"
        className="flex min-w-0 flex-1 items-baseline gap-2 text-sm"
        role="status"
      >
        <span className="min-w-0 truncate font-medium">{summary}</span>
        {summaryDetail ? (
          <span className="min-w-0 truncate text-muted-foreground" title={summaryDetailTitle}>
            {summaryDetail}
          </span>
        ) : null}
      </div>

      {actions.length > 0 ? (
        <>
          <div
            aria-hidden="true"
            className="@[420px]/selection-actions:block hidden h-4 w-px shrink-0 bg-border"
          />
          <div className="flex min-w-0 items-center gap-1">
            {actions.map((action) => {
              const visibleLabel = (compact ? action.compactLabel : undefined) ?? action.label;
              const collapseLabel = compact && action.icon !== undefined;

              return (
                <Button
                  aria-label={visibleLabel}
                  className="gap-1.5 whitespace-nowrap motion-reduce:transition-none"
                  disabled={action.disabled}
                  key={action.id}
                  onClick={() => action.onAction()}
                  onKeyDown={handleKeyDown}
                  size="sm"
                  title={action.disabled ? action.disabledReason : action.label}
                  type="button"
                  variant={action.destructive ? 'destructive' : 'secondary'}
                >
                  {action.icon}
                  <span
                    className={
                      collapseLabel ? '@[360px]/selection-actions:inline hidden' : undefined
                    }
                  >
                    {visibleLabel}
                  </span>
                </Button>
              );
            })}
          </div>
        </>
      ) : null}

      <Button
        aria-label={clearButtonAriaLabel}
        className="ml-auto gap-1 whitespace-nowrap motion-reduce:transition-none"
        onClick={onClear}
        onKeyDown={handleKeyDown}
        size="sm"
        title={clearButtonLabel}
        type="button"
        variant="ghost"
      >
        <X aria-hidden="true" className="h-4 w-4" />
        <span className={compact ? '@[360px]/selection-actions:inline hidden' : undefined}>
          {clearButtonLabel}
        </span>
      </Button>
    </div>
  );
}

SelectionActionBar.displayName = 'SelectionActionBar';
