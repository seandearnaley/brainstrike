import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import { Settings, UserRound } from 'lucide-react';
import type { ReactElement } from 'react';

export interface AccountMenuProps {
  readonly onOpenSettings: () => void;
}

export function AccountMenu({ onOpenSettings }: AccountMenuProps): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Open profile menu"
          className="group kinetic-depress grid size-10 place-items-center rounded-xl border border-sidebar-border bg-sidebar-accent/70 text-sidebar-foreground shadow-sm transition-[background-color,border-color,transform] duration-150 hover:border-sidebar-ring/40 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          type="button"
        >
          <span className="grid size-7 place-items-center rounded-lg bg-primary/12 text-primary transition-transform group-hover:scale-105">
            <UserRound aria-hidden="true" className="size-4" />
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-64 rounded-xl border-border/80 bg-popover/96 p-1.5 shadow-2xl backdrop-blur-xl"
        side="right"
        sideOffset={10}
      >
        <DropdownMenuLabel className="px-2.5 py-2">
          <span className="block font-medium text-sm">Local profile</span>
          <span className="mt-0.5 block font-normal text-muted-foreground text-xs">
            Stored on this device
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2.5 rounded-lg px-2.5 py-2.5" onSelect={onOpenSettings}>
          <Settings aria-hidden="true" className="size-4" />
          <span>Settings…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
