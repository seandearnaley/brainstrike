import type React from 'react';
import { cn } from '../lib/utils';

export interface StatusBarProps {
  /** Content to display in the center of the status bar */
  centerContent?: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
  /** Content to display on the left side of the status bar */
  leftContent?: React.ReactNode;
  /** Content to display on the right side of the status bar */
  rightContent?: React.ReactNode;
  /** Custom test ID for distinguishing multiple status bars (default: "status-bar") */
  testId?: string;
}

/**
 * A VS Code-style status bar that displays at the bottom of the application.
 * Provides left, center, and right slots for status items.
 */
export function StatusBar({
  leftContent,
  centerContent,
  rightContent,
  className,
  testId = 'status-bar',
}: StatusBarProps): React.ReactElement {
  return (
    <footer
      className={cn(
        'grid h-6 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-2',
        'border-border border-t bg-muted/50',
        'text-muted-foreground text-xs',
        className
      )}
      data-testid={testId}
    >
      <div
        className="col-start-1 flex w-full min-w-0 items-center gap-2 justify-self-start overflow-hidden"
        data-testid={`${testId}-left`}
      >
        {leftContent}
      </div>
      {centerContent && (
        <div
          className="col-start-2 flex min-w-0 items-center gap-2 justify-self-center"
          data-testid={`${testId}-center`}
        >
          {centerContent}
        </div>
      )}
      <div
        className="col-start-3 flex w-full min-w-0 items-center justify-end gap-2 justify-self-end overflow-hidden"
        data-testid={`${testId}-right`}
      >
        {rightContent}
      </div>
    </footer>
  );
}
