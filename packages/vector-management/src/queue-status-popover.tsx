/**
 * QueueStatusPopover - Expandable status bar component (BST-166)
 *
 * Shows compact queue stats in the status bar with an expandable popover
 * containing the full QueueDiagnosticsPanel for detailed metrics.
 */

import {
  Badge,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Activity, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Zap } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { QueueDiagnosticsPanel } from './queue-diagnostics-panel';
import { useQueueHealthMetrics } from './use-queue-health-metrics';

interface StatusIndicatorIconProps {
  readonly hasErrors: boolean;
  readonly isActive: boolean;
}

function StatusIndicatorIcon({ hasErrors, isActive }: StatusIndicatorIconProps): ReactElement {
  if (hasErrors) {
    return <AlertTriangle className="h-3 w-3 text-warning" />;
  }
  if (isActive) {
    return <Zap className="h-3 w-3 animate-pulse text-info" />;
  }
  return <CheckCircle2 className="h-3 w-3 text-success" />;
}

interface MetricBadgeProps {
  readonly label: string;
  readonly value: number;
  readonly variant?: 'default' | 'error' | 'active';
}

function MetricBadge({ label, value, variant = 'default' }: MetricBadgeProps): ReactElement {
  const colorClass =
    variant === 'error'
      ? 'text-destructive'
      : variant === 'active'
        ? 'text-info'
        : 'text-foreground';

  return (
    <span className="flex items-center gap-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold ${colorClass}`}>{value}</span>
    </span>
  );
}

interface CompactStatusProps {
  readonly hasErrors: boolean;
  readonly isActive: boolean;
  readonly isOpen: boolean;
  readonly totalFailed: number;
  readonly totalQueued: number;
  readonly totalRunning: number;
}

function CompactStatus({
  totalQueued,
  totalRunning,
  totalFailed,
  hasErrors,
  isActive,
  isOpen,
}: CompactStatusProps): ReactElement {
  const ChevronIcon = isOpen ? ChevronUp : ChevronDown;

  // This is presentational content - Radix PopoverTrigger handles accessibility
  return (
    <>
      <StatusIndicatorIcon hasErrors={hasErrors} isActive={isActive} />
      <Activity className="h-3 w-3 text-muted-foreground" />
      <MetricBadge label="Q" value={totalQueued} />
      <MetricBadge
        label="R"
        value={totalRunning}
        variant={totalRunning > 0 ? 'active' : 'default'}
      />
      <MetricBadge label="F" value={totalFailed} variant={totalFailed > 0 ? 'error' : 'default'} />
      <ChevronIcon className="h-3 w-3 text-muted-foreground" />
    </>
  );
}

interface PopoverHeaderProps {
  readonly hasErrors: boolean;
  readonly isActive: boolean;
}

function PopoverHeader({ hasErrors, isActive }: PopoverHeaderProps): ReactElement {
  const statusText = hasErrors
    ? 'Issues detected'
    : isActive
      ? 'Processing active'
      : 'All systems operational';

  const statusVariant = hasErrors ? 'destructive' : isActive ? 'default' : 'secondary';

  return (
    <div className="flex items-center justify-between border-b px-3 py-2">
      <div className="flex items-center gap-2">
        <StatusIndicatorIcon hasErrors={hasErrors} isActive={isActive} />
        <span className="font-medium text-sm">Queue Status</span>
      </div>
      <Badge className="text-[9px]" variant={statusVariant}>
        {statusText}
      </Badge>
    </div>
  );
}

interface QueueStatusPopoverProps {
  /** Custom CSS class for the trigger */
  readonly className?: string;
  /** Tooltip content for the trigger */
  readonly tooltipContent?: ReactNode;
}

/**
 * Expandable queue status component for the status bar.
 *
 * Displays a compact view of queue metrics that expands into a full
 * diagnostics panel when clicked.
 *
 * @example
 * ```tsx
 * // In status bar
 * <QueueStatusPopover />
 *
 * // With custom tooltip
 * <QueueStatusPopover tooltipContent="Click for queue details" />
 * ```
 */
export function QueueStatusPopover({
  className,
  tooltipContent = 'Click for queue diagnostics',
}: QueueStatusPopoverProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const { metrics } = useQueueHealthMetrics();

  const handleOpenChange = useCallback((open: boolean) => {
    setIsOpen(open);
  }, []);

  // Calculate combined stats
  const { durableQueue, ephemeralQueue } = metrics;
  const totalQueued = durableQueue?.queued ?? 0;
  const totalRunning = (durableQueue?.running ?? 0) + (ephemeralQueue?.active ?? 0);
  const totalFailed = (durableQueue?.failed ?? 0) + (ephemeralQueue?.failed ?? 0);
  const hasErrors = totalFailed > 0 || Boolean(ephemeralQueue?.lastError);
  const isActive = totalRunning > 0;

  const ariaLabel = `Queue status: ${totalQueued} queued, ${totalRunning} running, ${totalFailed} failed`;

  return (
    <Popover modal={false} onOpenChange={handleOpenChange} open={isOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label={ariaLabel}
              className={`flex cursor-pointer items-center gap-1.5 rounded border-none bg-transparent px-1.5 py-0.5 text-[10px] transition-colors hover:bg-muted ${className ?? ''}`}
              data-testid="queue-status-popover-trigger"
              type="button"
            >
              <CompactStatus
                hasErrors={hasErrors}
                isActive={isActive}
                isOpen={isOpen}
                totalFailed={totalFailed}
                totalQueued={totalQueued}
                totalRunning={totalRunning}
              />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        {!isOpen && (
          <TooltipContent side="top" sideOffset={6}>
            <span className="text-xs">{tooltipContent}</span>
          </TooltipContent>
        )}
      </Tooltip>

      <PopoverContent align="end" className="w-[420px] p-0" side="top" sideOffset={8}>
        <PopoverHeader hasErrors={hasErrors} isActive={isActive} />
        <div className="max-h-[70vh] overflow-y-auto">
          <QueueDiagnosticsPanel compact={false} showRefresh={false} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
