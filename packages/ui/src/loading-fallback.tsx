import type { ReactNode } from 'react';
import { cn } from './lib/utils';

export interface LoadingFallbackProps {
  /** The message to display while loading */
  message?: ReactNode;
}

/**
 * A centered loading placeholder with pulse animation. It is a status region,
 * so a screen reader announces what is loading.
 */
export function LoadingFallback({ message = 'Loading…' }: LoadingFallbackProps) {
  return (
    <div className={cn('flex h-full items-center justify-center')} role="status">
      <div className="animate-pulse">{message}</div>
    </div>
  );
}
