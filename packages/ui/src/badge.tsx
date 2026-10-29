import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from './lib/utils';

const badgeVariants = cva(
  'focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 inline-flex w-fit items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-[3px] [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 border-transparent',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 border-transparent',
        ghost: 'hover:bg-accent hover:text-accent-foreground border-transparent',
        link: 'text-primary border-transparent underline-offset-4 hover:underline',
        outline: 'border-border text-foreground',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/90 border-transparent',
      },
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div
      className={cn(badgeVariants({ variant }), className)}
      data-slot="badge"
      data-variant={variant ?? 'default'}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
