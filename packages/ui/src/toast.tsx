import * as ToastPrimitives from '@radix-ui/react-toast';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import type * as React from 'react';

import { TOAST_LAYER_CLASS } from './layers';
import { cn } from './lib/utils';

const ToastProvider = ToastPrimitives.Provider;

const ToastViewport = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport> & {
  ref?: React.RefObject<React.ComponentRef<typeof ToastPrimitives.Viewport> | null>;
}) => (
  <ToastPrimitives.Viewport
    className={cn(
      'fixed right-0 bottom-0 flex max-h-screen w-full flex-col-reverse gap-2 p-4 sm:max-w-[420px]',
      TOAST_LAYER_CLASS,
      className
    )}
    ref={ref}
    {...props}
  />
);
ToastViewport.displayName = ToastPrimitives.Viewport.displayName;

const toastVariants = cva(
  'group data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full sm:data-[state=open]:slide-in-from-bottom-full pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-4 pr-6 shadow-lg transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[state=closed]:animate-out data-[state=open]:animate-in data-[swipe=end]:animate-out data-[swipe=move]:transition-none',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        default: 'border bg-background text-foreground',
        destructive:
          'destructive group border-destructive bg-destructive text-destructive-foreground',
      },
    },
  }
);

const Toast = ({
  className,
  variant,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
  VariantProps<typeof toastVariants> & {
    ref?: React.RefObject<React.ComponentRef<typeof ToastPrimitives.Root> | null>;
  }) => (
  <ToastPrimitives.Root
    className={cn(toastVariants({ variant }), className)}
    ref={ref}
    {...props}
  />
);
Toast.displayName = ToastPrimitives.Root.displayName;

const ToastAction = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action> & {
  ref?: React.RefObject<React.ComponentRef<typeof ToastPrimitives.Action> | null>;
}) => (
  <ToastPrimitives.Action
    className={cn(
      'inline-flex h-8 shrink-0 items-center justify-center rounded-md border bg-transparent px-3 font-medium text-sm ring-offset-background transition-colors hover:bg-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-muted/40 focus-visible:group-[.destructive]:ring-destructive hover:group-[.destructive]:border-destructive/30 hover:group-[.destructive]:bg-destructive hover:group-[.destructive]:text-destructive-foreground',
      className
    )}
    ref={ref}
    {...props}
  />
);
ToastAction.displayName = ToastPrimitives.Action.displayName;

const ToastClose = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close> & {
  ref?: React.RefObject<React.ComponentRef<typeof ToastPrimitives.Close> | null>;
}) => (
  <ToastPrimitives.Close
    className={cn(
      // Always visible (brightening on hover/focus): a hover-only close reads
      // as "cannot be dismissed", especially on sticky/error toasts.
      'absolute top-2 right-2 rounded-md p-1 text-foreground/50 opacity-70 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 group-hover:opacity-100 group-[.destructive]:text-destructive-foreground focus-visible:group-[.destructive]:ring-red-400 focus-visible:group-[.destructive]:ring-offset-red-600 hover:group-[.destructive]:text-destructive-foreground',
      className
    )}
    ref={ref}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitives.Close>
);
ToastClose.displayName = ToastPrimitives.Close.displayName;

const ToastTitle = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title> & {
  ref?: React.RefObject<React.ComponentRef<typeof ToastPrimitives.Title> | null>;
}) => (
  <ToastPrimitives.Title className={cn('font-semibold text-sm', className)} ref={ref} {...props} />
);
ToastTitle.displayName = ToastPrimitives.Title.displayName;

const ToastDescription = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description> & {
  ref?: React.RefObject<React.ComponentRef<typeof ToastPrimitives.Description> | null>;
}) => (
  <ToastPrimitives.Description
    className={cn('text-sm opacity-90', className)}
    ref={ref}
    {...props}
  />
);
ToastDescription.displayName = ToastPrimitives.Description.displayName;

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>;

type ToastActionElement = React.ReactElement<typeof ToastAction>;

export {
  Toast,
  ToastAction,
  type ToastActionElement,
  ToastClose,
  ToastDescription,
  type ToastProps,
  ToastProvider,
  ToastTitle,
  ToastViewport,
};
