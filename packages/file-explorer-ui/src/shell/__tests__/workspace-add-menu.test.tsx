// @vitest-environment node
/**
 * "+" add-tab menu (BST-1270). `workspaceAddMenuItems` derives the menu from
 * the REGISTERED pinned apps — registration is the capability gate (web shows
 * Files only; desktop adds Changes/Terminal) — and decorates known apps with
 * their keyboard shortcut chips.
 */

import { FileText, GitBranch, PanelsTopLeft, TerminalSquare } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { workspaceAddMenuItems } from '../workspace-add-menu';
import {
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  TERMINAL_APP_ID,
  type WorkspaceApp,
} from '../workspace-app';

function app(id: string, label: string): WorkspaceApp {
  const icons: Record<string, WorkspaceApp['icon']> = {
    [CHANGES_APP_ID]: GitBranch,
    [CONTEXT_EXPLORER_APP_ID]: FileText,
    [TERMINAL_APP_ID]: TerminalSquare,
  };
  return { icon: icons[id] ?? FileText, id, label, placement: 'pinned', render: () => null };
}

describe('workspaceAddMenuItems', () => {
  it('derives one item per registered app, in registry order', () => {
    const items = workspaceAddMenuItems([
      app(CONTEXT_EXPLORER_APP_ID, 'Files'),
      app(CHANGES_APP_ID, 'Changes'),
      app(TERMINAL_APP_ID, 'Terminal'),
    ]);

    expect(items.map((item) => item.id)).toEqual([
      CONTEXT_EXPLORER_APP_ID,
      CHANGES_APP_ID,
      TERMINAL_APP_ID,
    ]);
    expect(items.map((item) => item.label)).toEqual(['Files', 'Changes', 'Terminal']);
  });

  it('never offers an open dynamic tab: a canvas or child conversation opens where it lives', () => {
    const items = workspaceAddMenuItems([
      app(CONTEXT_EXPLORER_APP_ID, 'Files'),
      {
        icon: PanelsTopLeft,
        id: 'canvas-document:abc',
        label: 'Quarterly report',
        placement: 'dynamic',
        render: () => null,
      },
    ]);

    expect(items.map((item) => item.label)).toEqual(['Files']);
  });

  it('capability gating is registration: unregistered apps yield no item (web)', () => {
    const items = workspaceAddMenuItems([app(CONTEXT_EXPLORER_APP_ID, 'Files')]);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(CONTEXT_EXPLORER_APP_ID);
  });

  it('decorates ONLY chords that reproduce the item action (Terminal); Files carries none', () => {
    // ⌘P is quick-open (opens a FILE tab), not "open the Files app" — a chip
    // there would advertise a different behavior than the item performs.
    const items = workspaceAddMenuItems([
      app(CONTEXT_EXPLORER_APP_ID, 'Files'),
      app(CHANGES_APP_ID, 'Changes'),
      app(TERMINAL_APP_ID, 'Terminal'),
    ]);

    expect(items[0]?.shortcut).toBeUndefined();
    expect(items[1]?.shortcut).toBeUndefined();
    expect(items[2]?.shortcut).toEqual({ key: 't', modifiers: ['primary'] });
  });
});
