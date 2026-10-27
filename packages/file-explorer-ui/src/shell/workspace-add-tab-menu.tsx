import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  formatShortcut,
  TAB_STRIP_ICON_BUTTON_CLASS_NAME,
  useMenuOpenReporter,
} from '@brainstrike/ui';
import { Plus } from 'lucide-react';
import type { ReactElement } from 'react';
import { workspaceAddMenuItems } from './workspace-add-menu';
import type { WorkspaceApp, WorkspaceLaunchAction } from './workspace-app';

/**
 * The "+" add-tab menu (BST-1270). Lives OUTSIDE the tablist (APG
 * composition: it is not a tab) and lists one entry per REGISTERED pinned app —
 * registration is the capability gate, so web shows Files only while desktop
 * adds Changes/Terminal. Picking an entry activates the app through
 * the singleton open-or-focus contract. The shell's launch actions (New
 * browser tab) follow the apps.
 */
export interface WorkspaceAddTabMenuProps {
  readonly apps: readonly WorkspaceApp[];
  readonly launchActions: readonly WorkspaceLaunchAction[];
  /** The menu drops over the panel body: a native view there hides while it is open. */
  readonly onMenuOpenChange: (open: boolean) => void;
  readonly onOpenApp: (appId: string) => void;
}

export function WorkspaceAddTabMenu({
  apps,
  launchActions,
  onMenuOpenChange,
  onOpenApp,
}: WorkspaceAddTabMenuProps): ReactElement {
  const items = workspaceAddMenuItems(apps);
  const reportOpenChange = useMenuOpenReporter(onMenuOpenChange);
  return (
    <DropdownMenu onOpenChange={reportOpenChange}>
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
        {launchActions.length > 0 ? <DropdownMenuSeparator /> : null}
        {launchActions.map((action) => {
          const Icon = action.icon;
          return (
            <DropdownMenuItem
              data-testid={`workspace-add-tab-${action.id}`}
              key={action.id}
              onSelect={action.run}
            >
              <Icon className="mr-2 h-4 w-4" />
              {action.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
