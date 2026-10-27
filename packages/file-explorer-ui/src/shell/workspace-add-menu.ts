import type { ActionShortcut } from '@brainstrike/context-actions';
import { TERMINAL_APP_ID, type WorkspaceApp } from './workspace-app';

/**
 * "+" add-tab menu model (BST-1270). Items derive 1:1 from the REGISTERED
 * pinned apps — registration is the capability gate (web registers Files only;
 * desktop adds Changes/Terminal/…), so an unregistered app never yields a
 * disabled or stubbed item. Dynamic tabs (a child conversation, a canvas) are
 * addresses opened from where they live, never from this menu. Known apps
 * carry their keyboard shortcut descriptor for the menu's shortcut chip.
 */
export interface WorkspaceAddMenuItem {
  readonly icon: WorkspaceApp['icon'];
  readonly id: string;
  readonly label: string;
  readonly shortcut?: ActionShortcut;
}

// Only chords that reproduce the ITEM's action decorate it. ⌘P is quick-open
// (the file-finder palette), which opens a FILE tab — not the Files app — so
// the Files item carries no chip (review finding).
const APP_SHORTCUTS: Readonly<Record<string, ActionShortcut>> = {
  [TERMINAL_APP_ID]: { key: 't', modifiers: ['primary'] },
};

export function workspaceAddMenuItems(apps: readonly WorkspaceApp[]): WorkspaceAddMenuItem[] {
  return apps.flatMap((app) => {
    if (app.placement !== 'pinned') {
      return [];
    }
    const shortcut = APP_SHORTCUTS[app.id];
    return [
      {
        icon: app.icon,
        id: app.id,
        label: app.label,
        ...(shortcut ? { shortcut } : {}),
      },
    ];
  });
}
