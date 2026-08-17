import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  formatShortcut,
} from '@brainstrike/ui';
import { Plus } from 'lucide-react';
import type { ReactElement } from 'react';
import { workspaceAddMenuItems } from './workspace-add-menu';
import type { WorkspaceApp } from './workspace-app';

/**
 * The "+" add-tab menu (BST-1270). Lives OUTSIDE the tablist (APG
 * composition: it is not a tab) and lists one entry per REGISTERED app —
 * registration is the capability gate, so web shows Files only while desktop
 * adds Changes/Canvas/Terminal. Picking an entry activates the app through
 * the singleton open-or-focus contract.
 */
export interface WorkspaceAddTabMenuProps {
  readonly apps: readonly WorkspaceApp[];
  readonly onOpenApp: (appId: string) => void;
}

export function WorkspaceAddTabMenu({ apps, onOpenApp }: WorkspaceAddTabMenuProps): ReactElement {
  const items = workspaceAddMenuItems(apps);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Add workspace tab"
          className="my-auto h-6 w-6 flex-shrink-0 rounded-sm"
          data-testid="workspace-add-tab"
          size="icon"
          title="Add workspace tab"
          variant="ghost"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem
              data-testid={`workspace-add-tab-${item.id}`}
              key={item.id}
              onSelect={() => onOpenApp(item.id)}
            >
              <Icon className="mr-2 h-4 w-4" />
              {item.label}
              {item.shortcut ? (
                <DropdownMenuShortcut>{formatShortcut(item.shortcut)}</DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
