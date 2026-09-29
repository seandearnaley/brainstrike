import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import type * as React from 'react';

import { POPUP_LAYER_CLASS } from './layers';
import { cn } from './lib/utils';

const Select = SelectPrimitive.Root;

const SelectGroup = SelectPrimitive.Group;

const SelectValue = SelectPrimitive.Value;

const SelectTrigger = ({
  className,
  size = 'default',
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> & {
  size?: 'default' | 'sm';
  ref?: React.RefObject<HTMLButtonElement | null>;
}) => (
  <SelectPrimitive.Trigger
    className={cn(
      'kinetic-depress flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[size=default]:h-10 data-[size=sm]:h-8 data-[placeholder]:text-muted-foreground *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:hover:bg-input/50 [&_svg:not([class*=size-])]:size-4 [&_svg:not([class*=text-])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0',
      className
    )}
    data-size={size}
    data-slot="select-trigger"
    ref={ref}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="size-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
);
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

/**
 * Listbox surface. Defaults to `position="popper"` — anchored under the
 * trigger and at least as wide as it — rather than Radix's `item-aligned`.
 *
 * `item-aligned` is the macOS-native behavior: it paints the SELECTED option
 * on top of the trigger and derives the listbox box from item-text alignment
 * math, so the surface matches neither the trigger's width nor its edges and
 * `--radix-select-trigger-width` is not exposed at all. Measured in the
 * Settings modal at 1440x900 with a 718px-wide trigger: the listbox came out
 * 696.8px wide, inset 10.4px from the trigger's left edge, and covered the
 * field plus its label. Inside a modal — where the surrounding form is the
 * context the user is reading — that reads as an unanchored popup rather than
 * a combo box. shadcn shipped `popper` as its own default until Dec 2025 and
 * still ships every popper style rule below; only the default flipped.
 *
 * The CONTENT min-width is Radix's documented "constrain the content size"
 * recipe (their example uses `width`; `min-width` keeps long option labels
 * from truncating in narrow triggers). It replaces shadcn's `min-w` on the
 * Viewport, which sizes the inner box and therefore overhangs the trigger by
 * the content's 2px border. Do not also set it on the Viewport — the two fight
 * and clip the right edge of every item.
 *
 * It is `max(8rem, …)` rather than the bare variable because `cn` is
 * `twMerge`: a second `min-w-*` in the same call REPLACES the base
 * `min-w-[8rem]` rather than stacking with it, which would have handed every
 * narrow trigger a listbox narrower than the 8rem floor its sibling primitives
 * keep (`dropdown-menu.tsx`, `context-menu.tsx`). Measured case: db-explorer's
 * `w-[5.5rem]` token-cap preset trigger, 88px.
 *
 * The Viewport's `h-[var(--radix-select-trigger-height)]` from shadcn is
 * dropped: Radix sets `flex: 1` inline on the Viewport and popper content is a
 * flex column, so the class never applied (measured 72px for two 32px rows,
 * not the 40px it asks for). It is a no-op that becomes a one-row listbox the
 * moment that flex context changes.
 */
const SelectContent = ({
  className,
  children,
  position = 'popper',
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      className={cn(
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 relative max-h-(--radix-select-content-available-height) min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-y-auto overflow-x-hidden rounded-md border bg-popover text-popover-foreground shadow-md data-[state=closed]:animate-out data-[state=open]:animate-in',
        POPUP_LAYER_CLASS,
        position === 'popper' &&
          'min-w-[max(8rem,var(--radix-select-trigger-width))] data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
        className
      )}
      data-slot="select-content"
      position={position}
      ref={ref}
      {...props}
    >
      <SelectScrollUpButton />
      <SelectPrimitive.Viewport
        className={cn('p-1', position === 'popper' && 'w-full scroll-my-1')}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectScrollDownButton />
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
);
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectLabel = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <SelectPrimitive.Label
    className={cn('px-2 py-1.5 text-muted-foreground text-xs', className)}
    data-slot="select-label"
    ref={ref}
    {...props}
  />
);
SelectLabel.displayName = SelectPrimitive.Label.displayName;

const SelectItem = ({
  className,
  children,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <SelectPrimitive.Item
    className={cn(
      'relative flex w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg:not([class*=size-])]:size-4 [&_svg:not([class*=text-])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2',
      className
    )}
    data-slot="select-item"
    ref={ref}
    {...props}
  >
    <span
      className="absolute right-2 flex size-3.5 items-center justify-center"
      data-slot="select-item-indicator"
    >
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </span>

    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
);
SelectItem.displayName = SelectPrimitive.Item.displayName;

const SelectSeparator = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <SelectPrimitive.Separator
    className={cn('pointer-events-none -mx-1 my-1 h-px bg-border', className)}
    data-slot="select-separator"
    ref={ref}
    {...props}
  />
);
SelectSeparator.displayName = SelectPrimitive.Separator.displayName;

const SelectScrollUpButton = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollUpButton> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <SelectPrimitive.ScrollUpButton
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    data-slot="select-scroll-up-button"
    ref={ref}
    {...props}
  >
    <ChevronUp className="size-4" />
  </SelectPrimitive.ScrollUpButton>
);
SelectScrollUpButton.displayName = SelectPrimitive.ScrollUpButton.displayName;

const SelectScrollDownButton = ({
  className,
  ref,
  ...props
}: React.ComponentPropsWithoutRef<typeof SelectPrimitive.ScrollDownButton> & {
  ref?: React.RefObject<HTMLDivElement | null>;
}) => (
  <SelectPrimitive.ScrollDownButton
    className={cn('flex cursor-default items-center justify-center py-1', className)}
    data-slot="select-scroll-down-button"
    ref={ref}
    {...props}
  >
    <ChevronDown className="size-4" />
  </SelectPrimitive.ScrollDownButton>
);
SelectScrollDownButton.displayName = SelectPrimitive.ScrollDownButton.displayName;

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
