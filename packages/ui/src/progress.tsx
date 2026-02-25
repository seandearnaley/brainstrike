import type * as React from 'react';
// import * as ProgressPrimitive from '@radix-ui/react-progress'; // Removed: Unused
import { cn } from './lib/utils';

const Progress = ({
  className,
  value,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  value?: number;
} & { ref?: React.RefObject<HTMLDivElement | null> }) => (
  <div
    className={cn('relative h-2 w-full overflow-hidden rounded-full bg-secondary', className)}
    ref={ref}
    {...props}
  >
    <div
      className="h-full w-full flex-1 bg-primary transition-[width]"
      style={{
        transform: `translateX(-${100 - (value || 0)}%)`,
      }}
    />
  </div>
);
Progress.displayName = 'Progress';

export { Progress };
