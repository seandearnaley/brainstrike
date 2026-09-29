/**
 * "+" add-tab menu button (BST-1270): renders OUTSIDE the tablist, lists one
 * item per registered app with shortcut chips, and activates (open-or-focus)
 * the picked app through the singleton contract.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { FileText, TerminalSquare } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceAddTabMenu } from '../workspace-add-tab-menu';
import { CONTEXT_EXPLORER_APP_ID, TERMINAL_APP_ID, type WorkspaceApp } from '../workspace-app';

const APPS: WorkspaceApp[] = [
  {
    icon: FileText,
    id: CONTEXT_EXPLORER_APP_ID,
    label: 'Files',
    placement: 'pinned',
    render: () => null,
  },
  {
    icon: TerminalSquare,
    id: TERMINAL_APP_ID,
    label: 'Terminal',
    placement: 'pinned',
    render: () => null,
  },
];

describe('WorkspaceAddTabMenu', () => {
  it('opens from the + trigger and lists registered apps with shortcut chips', () => {
    render(<WorkspaceAddTabMenu apps={APPS} onOpenApp={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Add workspace tab' });
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1, pointerType: 'mouse' });

    const filesItem = screen.getByRole('menuitem', { name: /Files/ });
    expect(filesItem).toBeInTheDocument();
    expect(filesItem.textContent).not.toMatch(/⌘P|Ctrl\+P/);
    const terminalItem = screen.getByRole('menuitem', { name: /Terminal/ });
    expect(terminalItem).toBeInTheDocument();
    // Shortcut chips render through the shared platform-aware formatter.
    expect(terminalItem.textContent).toMatch(/⌘T|Ctrl\+T/);
  });

  it('activates the picked app (open-or-focus singleton contract)', () => {
    const onOpenApp = vi.fn();
    render(<WorkspaceAddTabMenu apps={APPS} onOpenApp={onOpenApp} />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add workspace tab' }), {
      button: 0,
      pointerId: 1,
      pointerType: 'mouse',
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /Terminal/ }));

    expect(onOpenApp).toHaveBeenCalledExactlyOnceWith(TERMINAL_APP_ID);
  });
});
