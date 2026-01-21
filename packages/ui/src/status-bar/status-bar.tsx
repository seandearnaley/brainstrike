import type React from 'react';
import { cn } from '../lib/utils';

export interface StatusBarProps {
  /** Content to display on the left side of the status bar */
  leftContent?: React.ReactNode;
  /** Content to display in the center of the status bar */
  centerContent?: React.ReactNode;
  /** Content to display on the right side of the status bar */
  rightContent?: React.ReactNode;
  /** Additional CSS classes */
  className?: string;
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
    <output
      aria-live="polite"
      className={cn(
        'flex h-6 items-center justify-between px-2',
        'border-border border-t bg-muted/50',
        'text-muted-foreground text-xs',
        className
      )}
      data-testid={testId}
    >
      <div className="flex items-center gap-2" data-testid={`${testId}-left`}>
        {leftContent}
      </div>
      {centerContent && (
        <div className="flex items-center gap-2" data-testid={`${testId}-center`}>
          {centerContent}
        </div>
      )}
      <div className="flex items-center gap-2" data-testid={`${testId}-right`}>
        {rightContent}
      </div>
    </output>
  );
}
