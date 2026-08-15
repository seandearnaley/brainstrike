import type { ActionShortcut } from '@brainstrike/context-actions';
import { CONTEXT_EXPLORER_APP_ID, TERMINAL_APP_ID, type WorkspaceApp } from './workspace-app';

/**
 * "+" add-tab menu model (BST-1270). Items derive 1:1 from the REGISTERED app
 * list — registration is the capability gate (web registers Files only;
 * desktop adds Changes/Canvas/Terminal), so an unregistered app never yields
 * a disabled or stubbed item. Known apps carry their keyboard shortcut
 * descriptor for the menu's shortcut chip.
 */
export interface WorkspaceAddMenuItem {
  readonly icon: WorkspaceApp['icon'];
  readonly id: string;
  readonly label: string;
  readonly shortcut?: ActionShortcut;
}

const APP_SHORTCUTS: Readonly<Record<string, ActionShortcut>> = {
  [CONTEXT_EXPLORER_APP_ID]: { key: 'p', modifiers: ['primary'] },
  [TERMINAL_APP_ID]: { key: 't', modifiers: ['primary'] },
};

export function workspaceAddMenuItems(apps: readonly WorkspaceApp[]): WorkspaceAddMenuItem[] {
  return apps.map((app) => {
    const shortcut = APP_SHORTCUTS[app.id];
    return {
      icon: app.icon,
      id: app.id,
      label: app.label,
      ...(shortcut ? { shortcut } : {}),
    };
  });
}
