import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@brainstrike/ui';
import { Settings, UserRound } from 'lucide-react';
import type { ReactElement } from 'react';

export interface AccountMenuProps {
  readonly onOpenSettings: () => void;
}

export function AccountMenu({ onOpenSettings }: AccountMenuProps): ReactElement {
  return (
    <DropdownMenu>
      {/* Same size, shape, hover and tooltip as the rail's nav items. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              aria-label="Open profile menu"
              className="kinetic-depress text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring focus-visible:ring-offset-sidebar flex h-12 w-12 cursor-pointer items-center justify-center rounded-lg transition-[transform,background-color,color] duration-200 ease-out hover:shadow-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden"
              type="button"
            >
              <UserRound aria-hidden="true" className="h-5 w-5" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          <p className="font-medium">Profile</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="border-border/80 bg-popover/96 w-64 rounded-xl p-1.5 shadow-2xl backdrop-blur-xl"
        side="right"
        sideOffset={10}
      >
        <DropdownMenuLabel className="px-2.5 py-2">
          <span className="block text-sm font-medium">Local profile</span>
          <span className="text-muted-foreground mt-0.5 block text-xs font-normal">
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
