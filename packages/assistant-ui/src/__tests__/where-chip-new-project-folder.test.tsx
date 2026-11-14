/**
 * ADR-0034 build decisions (BST-2513): the where-control offers "New project folder…" for a
 * thread that works with no folder of its own, at the top of the menu, under "Where this thread
 * works" and before the folder rows. A thread in a scratch folder is offered Turn into a project…
 * instead. Like every checkout change it waits for the thread's run to end, and it shows why the
 * last one was refused.
 */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkspaceBar,
  type WorkspaceBarNewProjectFolder,
  type WorkspaceBarProps,
} from '../workspace-bar/workspace-bar';

const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

/** A thread with no folder of its own: no primary folder, while one is still open elsewhere. */
function props(overrides: Partial<WorkspaceBarProps> = {}): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onAddWorkspaceFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemovePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    onUseFolder: vi.fn(),
    recentRoots: [],
    secondaryRoots: [],
    workspaceFolders: [],
    ...overrides,
  };
}

function newProjectFolder(
  overrides: Partial<WorkspaceBarNewProjectFolder> = {}
): WorkspaceBarNewProjectFolder {
  return {
    disabledReason: null,
    onNewProjectFolder: vi.fn(),
    pending: false,
    refusal: null,
    ...overrides,
  };
}

async function openWhere(user: ReturnType<typeof setup>): Promise<HTMLElement> {
  await user.click(screen.getByTestId('workspace-bar-where-chip'));
  return await screen.findByRole('menu');
}

describe('New project folder…', () => {
  it('is offered only for a thread with no folder of its own', async () => {
    const user = setup();
    const { rerender } = render(<WorkspaceBar {...props()} />);
    await openWhere(user);
    expect(screen.queryByTestId('workspace-bar-new-project-folder')).toBeNull();

    rerender(<WorkspaceBar {...props({ newProjectFolder: newProjectFolder() })} />);
    expect(await screen.findByTestId('workspace-bar-new-project-folder')).toHaveTextContent(
      'New project folder…'
    );
  });

  it('is the first row under "Where this thread works", before the folder rows', async () => {
    const user = setup();
    render(<WorkspaceBar {...props({ newProjectFolder: newProjectFolder() })} />);
    const menu = await openWhere(user);
    const items = within(menu).getAllByRole('menuitem');
    expect(items[0]).toHaveAttribute('data-testid', 'workspace-bar-new-project-folder');
    expect(items.map((item) => item.dataset['testid'])).toContain('workspace-bar-add-folder');
    // The where-menu's own section holds it, apart from the ways to add a folder.
    const row = screen.getByTestId('workspace-bar-new-project-folder');
    const label = within(menu).getByText('Where this thread works');
    expect(label.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.nextElementSibling).toHaveAttribute('role', 'separator');
  });

  it('asks the host to make the folder', async () => {
    const user = setup();
    const value = newProjectFolder();
    render(<WorkspaceBar {...props({ newProjectFolder: value })} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-new-project-folder'));
    expect(value.onNewProjectFolder).toHaveBeenCalledTimes(1);
  });

  it("waits for the thread's run to end, saying so", async () => {
    const user = setup();
    const value = newProjectFolder({ disabledReason: "Available when this thread's run ends." });
    render(<WorkspaceBar {...props({ newProjectFolder: value })} />);
    await openWhere(user);
    const item = screen.getByTestId('workspace-bar-new-project-folder');
    expect(item).toHaveAttribute('data-disabled');
    expect(
      screen.getByTestId('workspace-bar-new-project-folder-disabled-reason')
    ).toHaveTextContent("Available when this thread's run ends.");
    await user.click(item);
    expect(value.onNewProjectFolder).not.toHaveBeenCalled();
  });

  it('is busy while the folder is made', async () => {
    const user = setup();
    render(<WorkspaceBar {...props({ newProjectFolder: newProjectFolder({ pending: true }) })} />);
    await openWhere(user);
    expect(screen.getByTestId('workspace-bar-new-project-folder')).toHaveAttribute('data-disabled');
  });

  it('shows why the last one was refused', async () => {
    const user = setup();
    const refusal = '/Users/me/Projects/plan already exists, so no project folder was made there.';
    render(<WorkspaceBar {...props({ newProjectFolder: newProjectFolder({ refusal }) })} />);
    await openWhere(user);
    expect(screen.getByTestId('workspace-bar-new-project-folder-refusal')).toHaveTextContent(
      refusal
    );
    expect(screen.getByTestId('workspace-bar-new-project-folder')).not.toHaveAttribute(
      'data-disabled'
    );
  });
});
