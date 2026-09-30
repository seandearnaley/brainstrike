import type React from 'react';
import { cn } from '../lib/utils';

export type StatusBarItemStatus = 'connected' | 'disconnected' | 'loading' | 'warning';

export interface StatusBarItemProps {
  /** Announce value changes as a polite, atomic live status */
  announce?: boolean;
  /** Explicit screen-reader text when the compact visual label omits state */
  announcement?: string;
  /** Additional CSS classes */
  className?: string;
  /** Icon component to display */
  icon?: React.ComponentType<{ className?: string }>;
  /** Label text */
  label?: string;
  /** Status determines the color styling */
  status?: StatusBarItemStatus;
  /** Test ID for testing */
  testId?: string;
  /** Value text (displayed after label) */
  value?: string;
}

const statusClasses: Record<StatusBarItemStatus, string> = {
  connected: 'text-success',
  disconnected: 'text-destructive',
  loading: 'text-muted-foreground',
  warning: 'text-warning',
};

/**
 * Individual status item for the status bar.
 * Displays an optional icon, label, and value with color based on status.
 */
export function StatusBarItem({
  announce = false,
  announcement,
  icon: Icon,
  label,
  value,
  status = 'connected',
  className,
  testId,
}: StatusBarItemProps): React.ReactElement {
  const visualContent = (
    <>
      {Icon && (
        <Icon
          className={cn(
            'h-3 w-3 shrink-0',
            status === 'loading' && 'animate-pulse motion-reduce:animate-none'
          )}
        />
      )}
      {label && <span className="min-w-0 flex-1 truncate whitespace-nowrap">{label}</span>}
      {value && <span className="shrink-0 whitespace-nowrap tabular-nums">{value}</span>}
    </>
  );

  return (
    <span
      aria-atomic={announce ? true : undefined}
      className={cn(
        'flex h-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap px-1.5 leading-none',
        statusClasses[status],
        className
      )}
      data-testid={testId}
      role={announce ? 'status' : undefined}
    >
      {announcement ? (
        <>
          <span aria-hidden="true" className="contents">
            {visualContent}
          </span>
          <span className="sr-only">{announcement}</span>
        </>
      ) : (
        visualContent
      )}
    </span>
  );
}
