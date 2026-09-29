import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  formatShortcut,
  TAB_STRIP_ICON_BUTTON_CLASS_NAME,
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
          className={TAB_STRIP_ICON_BUTTON_CLASS_NAME}
          data-testid="workspace-add-tab"
          size="icon-xs"
          title="Add workspace tab"
          type="button"
          variant="ghost"
        >
          <Plus className="size-3.5" />
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
