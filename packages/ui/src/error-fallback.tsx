import type { ReactNode } from 'react';
import { cn } from './lib/utils';

export interface ErrorFallbackProps {
  /** The error message or component to display */
  message?: ReactNode;
}

/**
 * A simple error message display with red text styling.
 */
export function ErrorFallback({ message = 'Something went wrong.' }: ErrorFallbackProps) {
  return <div className={cn('p-4 text-destructive')}>{message}</div>;
}
