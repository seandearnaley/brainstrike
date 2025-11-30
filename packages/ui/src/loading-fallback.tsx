import type { ReactNode } from 'react';
import { cn } from './lib/utils';

export type LoadingFallbackProps = {
  /** The message to display while loading */
  message?: ReactNode;
};

/**
 * A centered loading placeholder with pulse animation.
 */
export function LoadingFallback({ message = 'Loading...' }: LoadingFallbackProps) {
  return (
    <div className={cn('flex h-full items-center justify-center')}>
      <div className="animate-pulse">{message}</div>
    </div>
  );
}
