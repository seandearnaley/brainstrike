// @vitest-environment node
/**
 * "+" add-tab menu (BST-1270). `workspaceAddMenuItems` derives the menu from
 * the REGISTERED app list — registration is the capability gate (web shows
 * Files only; desktop adds Changes/Canvas/Terminal) — and decorates known
 * apps with their keyboard shortcut chips.
 */

import { FileText, GitBranch, Palette, TerminalSquare } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { workspaceAddMenuItems } from '../workspace-add-menu';
import {
  CANVAS_APP_ID,
  CHANGES_APP_ID,
  CONTEXT_EXPLORER_APP_ID,
  TERMINAL_APP_ID,
  type WorkspaceApp,
} from '../workspace-app';

function app(id: string, label: string): WorkspaceApp {
  const icons: Record<string, WorkspaceApp['icon']> = {
    [CANVAS_APP_ID]: Palette,
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
      app(CANVAS_APP_ID, 'Canvas'),
      app(TERMINAL_APP_ID, 'Terminal'),
    ]);

    expect(items.map((item) => item.id)).toEqual([
      CONTEXT_EXPLORER_APP_ID,
      CHANGES_APP_ID,
      CANVAS_APP_ID,
      TERMINAL_APP_ID,
    ]);
    expect(items.map((item) => item.label)).toEqual(['Files', 'Changes', 'Canvas', 'Terminal']);
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
