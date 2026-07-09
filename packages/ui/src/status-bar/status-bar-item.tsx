import type React from 'react';
import { cn } from '../lib/utils';

export type StatusBarItemStatus = 'connected' | 'disconnected' | 'loading' | 'warning';

export interface StatusBarItemProps {
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
  connected: 'text-green-600',
  disconnected: 'text-red-600',
  loading: 'text-muted-foreground',
  warning: 'text-yellow-600',
};

/**
 * Individual status item for the status bar.
 * Displays an optional icon, label, and value with color based on status.
 */
export function StatusBarItem({
  icon: Icon,
  label,
  value,
  status = 'connected',
  className,
  testId,
}: StatusBarItemProps): React.ReactElement {
  return (
    <span
      className={cn('flex items-center gap-1', statusClasses[status], className)}
      data-testid={testId}
    >
      {Icon && (
        <Icon
          className={cn(
            'h-3 w-3 shrink-0',
            status === 'loading' && 'animate-pulse motion-reduce:animate-none'
          )}
        />
      )}
      {label && <span>{label}</span>}
      {value && <span>{value}</span>}
    </span>
  );
}
