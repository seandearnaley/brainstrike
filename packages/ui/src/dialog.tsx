import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type * as React from 'react';
import { createContext, use } from 'react';

import { dialogLayerClasses } from './layers';
import { cn } from './lib/utils';

/**
 * How many `Dialog`s enclose this subtree. React context crosses portals, so a
 * dialog rendered from inside another dialog's content sees its parent's depth
 * even though the two panels are sibling portals under `document.body`.
 *
 * This is LEXICAL nesting, not open-order stacking, and the distinction has
 * teeth: a dialog only lifts onto a higher tier if it is rendered INSIDE the
 * subtree of the dialog it opens over. `LogRecordDetailDialog` qualifies (it
 * renders inside the Settings panel's content), but a modal hoisted to a
 * sibling of the Settings `Dialog` — or owned by a provider above it — stays on
 * tier 1 and its scrim paints under the Settings panel again. Keep a dialog
 * co-located with the surface it covers. See docs/agents/ui-conventions.md.
 */
const DialogDepthContext = createContext(0);

/**
 * Resolves the stacking tier for the dialog currently being rendered.
 *
 * Depth 0 means the component was used outside any `Dialog`, which Radix
 * already rejects — `dialogLayerClasses` throws on it rather than guessing a
 * tier.
 */
function useDialogLayerClasses() {
  return dialogLayerClasses(use(DialogDepthContext));
}

const Dialog = ({ children, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) => {
  const enclosingDepth = use(DialogDepthContext);
  return (
    <DialogPrimitive.Root {...props}>
      <DialogDepthContext.Provider value={enclosingDepth + 1}>
        {children}
      </DialogDepthContext.Provider>
    </DialogPrimitive.Root>
  );
};
Dialog.displayName = 'Dialog';

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

const DialogOverlay = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay> & {
  ref?: React.RefObject<React.ElementRef<typeof DialogPrimitive.Overlay> | null>;
}) => {
  const layer = useDialogLayerClasses();
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 bg-black/80 data-[state=closed]:animate-out data-[state=open]:animate-in',
        layer.overlay,
        className
      )}
      data-slot="dialog-overlay"
      ref={ref}
      {...props}
    />
  );
};
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = ({
  className,
  children,
  hideCloseButton = false,
  overlayClassName,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  /**
   * Omit the corner close control for consent dialogs whose every exit must be
   * an explicit decision (the caller also owns Escape/outside-click handling).
   */
  hideCloseButton?: boolean;
  overlayClassName?: string;
  ref?: React.RefObject<React.ElementRef<typeof DialogPrimitive.Content> | null>;
}) => {
  const layer = useDialogLayerClasses();
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        className={cn(
          // The panel sits one step above its own scrim (#831: at an equal
          // z-index RemoveScroll's wrapper steals hits from the panel), and the
          // whole tier moves up with nesting depth. Popups must stay above every
          // tier — see POPUP_LAYER_CLASS in ./layers.
          'data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg outline-hidden duration-200 data-[state=closed]:animate-out data-[state=open]:animate-in sm:max-w-lg',
          layer.content,
          className
        )}
        data-slot="dialog-content"
        ref={ref}
        {...props}
      >
        {children}
        {hideCloseButton ? null : (
          <DialogPrimitive.Close
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg:not([class*=size-])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
            data-slot="dialog-close"
          >
            <X />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
};
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
    data-slot="dialog-header"
    {...props}
  />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
    data-slot="dialog-footer"
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title> & {
  ref?: React.RefObject<React.ElementRef<typeof DialogPrimitive.Title> | null>;
}) => (
  <DialogPrimitive.Title
    className={cn('font-semibold text-lg leading-none tracking-tight', className)}
    data-slot="dialog-title"
    ref={ref}
    {...props}
  />
);
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description> & {
  ref?: React.RefObject<React.ElementRef<typeof DialogPrimitive.Description> | null>;
}) => (
  <DialogPrimitive.Description
    className={cn('text-muted-foreground text-sm', className)}
    data-slot="dialog-description"
    ref={ref}
    {...props}
  />
);
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
