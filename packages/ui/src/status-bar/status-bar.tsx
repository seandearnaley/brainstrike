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
}: StatusBarProps): React.ReactElement {
  return (
    <output
      aria-live="polite"
      className={cn(
        'h-6 flex items-center justify-between px-2',
        'bg-muted/50 border-t border-border',
        'text-xs text-muted-foreground',
        className
      )}
      data-testid="status-bar"
    >
      <div className="flex items-center gap-2" data-testid="status-bar-left">
        {leftContent}
      </div>
      {centerContent && (
        <div className="flex items-center gap-2" data-testid="status-bar-center">
          {centerContent}
        </div>
      )}
      <div className="flex items-center gap-2" data-testid="status-bar-right">
        {rightContent}
      </div>
    </output>
  );
}
