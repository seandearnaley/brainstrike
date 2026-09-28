import { Content, Overlay, Portal, Root } from '@radix-ui/react-dialog';
import { Command as Cmdk } from 'cmdk';
import type * as React from 'react';
import { COMMAND_PALETTE_CONTENT_CLASS, COMMAND_PALETTE_OVERLAY_CLASS } from '../layers';
import { cn } from '../lib/utils';

export interface ModalCommandDialogProps {
  readonly children: React.ReactNode;
  readonly label: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

/**
 * cmdk's `Command.Dialog`, composed from the same Radix Dialog parts so the
 * content can declare `aria-modal="true"`: cmdk forwards no attributes to it.
 * The declaration is what tells the tab chord router that keys typed in a
 * palette belong to the palette, not to a tab behind it. Filtering is the
 * caller's (`shouldFilter` is off), as it was.
 */
export function ModalCommandDialog({
  children,
  label,
  onOpenChange,
  open,
}: ModalCommandDialogProps): React.ReactElement {
  return (
    <Root onOpenChange={onOpenChange} open={open}>
      <Portal>
        <Overlay
          className={cn('fixed inset-0 bg-black/50', COMMAND_PALETTE_OVERLAY_CLASS)}
          cmdk-overlay=""
        />
        <Content
          aria-label={label}
          aria-modal="true"
          className={cn(
            'fixed top-[20%] left-1/2 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2',
            COMMAND_PALETTE_CONTENT_CLASS,
            'overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-2xl'
          )}
          cmdk-dialog=""
        >
          <Cmdk label={label} shouldFilter={false}>
            {children}
          </Cmdk>
        </Content>
      </Portal>
    </Root>
  );
}
