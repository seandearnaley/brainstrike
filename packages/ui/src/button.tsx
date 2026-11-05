import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from './lib/utils';

const buttonVariants = cva(
  'focus-visible:border-ring focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap outline-hidden transition-[color,background-color,border-color,box-shadow,opacity,transform] focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    defaultVariants: {
      size: 'default',
      variant: 'default',
    },
    variants: {
      size: {
        default: 'h-10 px-4 py-2 has-[>svg]:px-3',
        icon: 'size-10',
        'icon-lg': 'size-11',
        'icon-sm': 'size-8',
        'icon-xs': 'size-7 rounded-md [&_svg:not([class*=size-])]:size-3',
        lg: 'h-11 rounded-md px-6 has-[>svg]:px-4',
        sm: 'h-9 rounded-md px-3 has-[>svg]:px-2.5',
        xs: 'h-7 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*=size-])]:size-3',
      },
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
        outline:
          'border-input bg-background hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:hover:bg-input/50 border shadow-xs',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      },
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * Whether to apply the kinetic depress effect on click.
   * @default true
   */
  depress?: boolean;
  /**
   * Ref forwarded to the underlying button element.
   * React 19+: ref is passed as a prop instead of using forwardRef.
   */
  ref?: React.Ref<HTMLButtonElement> | undefined;
}

/**
 * Button component with variant support and optional kinetic depress effect.
 * React 19+: Uses ref as a prop pattern instead of forwardRef.
 */
function Button({
  className,
  variant,
  size,
  asChild = false,
  depress = true,
  ref,
  ...props
}: ButtonProps): React.JSX.Element {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      className={cn(buttonVariants({ className, size, variant }), {
        'kinetic-depress': depress,
      })}
      data-size={size ?? 'default'}
      data-slot="button"
      data-variant={variant ?? 'default'}
      ref={ref}
      {...props}
    />
  );
}

export { Button, buttonVariants };
