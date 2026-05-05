import type * as React from 'react';

import { cn } from './lib/utils';

const Card = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { ref?: React.RefObject<HTMLDivElement | null> }) => (
  <div
    className={cn('rounded-lg border bg-card text-card-foreground shadow-sm', className)}
    data-slot="card"
    ref={ref}
    {...props}
  />
);
Card.displayName = 'Card';

const CardHeader = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { ref?: React.RefObject<HTMLDivElement | null> }) => (
  <div
    className={cn('flex flex-col gap-1.5 p-6', className)}
    data-slot="card-header"
    ref={ref}
    {...props}
  />
);
CardHeader.displayName = 'CardHeader';

const CardTitle = ({
  children,
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement> & {
  ref?: React.RefObject<HTMLHeadingElement | null>;
}) => (
  <h3
    className={cn('font-semibold text-2xl leading-none tracking-tight', className)}
    data-slot="card-title"
    ref={ref}
    {...props}
  >
    {children}
  </h3>
);
CardTitle.displayName = 'CardTitle';

const CardDescription = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement> & {
  ref?: React.RefObject<HTMLParagraphElement | null>;
}) => (
  <p
    className={cn('text-muted-foreground text-sm', className)}
    data-slot="card-description"
    ref={ref}
    {...props}
  />
);
CardDescription.displayName = 'CardDescription';

const CardContent = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { ref?: React.RefObject<HTMLDivElement | null> }) => (
  <div className={cn('p-6 pt-0', className)} data-slot="card-content" ref={ref} {...props} />
);
CardContent.displayName = 'CardContent';

const CardFooter = ({
  className,
  ref,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { ref?: React.RefObject<HTMLDivElement | null> }) => (
  <div
    className={cn('flex items-center p-6 pt-0', className)}
    data-slot="card-footer"
    ref={ref}
    {...props}
  />
);
CardFooter.displayName = 'CardFooter';

export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle };
