/**
 * BST-1990: the where-control marks a thread folder the workspace no longer
 * serves and offers its repairs: Reopen folder, Remove from this thread, and
 * "Use another folder…" once no thread folder is live.
 */

import { act } from '@brainstrike/test-utils/react-act';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceBar, type WorkspaceBarProps } from '../workspace-bar/workspace-bar';

const bravo = {
  displayName: 'bravo',
  path: '/ws/bravo',
  removed: true,
  rootId: 'r-bravo',
} as const;
const alpha = { displayName: 'alpha', path: '/ws/alpha', rootId: 'r-alpha' } as const;

function props(overrides: Partial<WorkspaceBarProps>): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onAddRecent: vi.fn(),
    onAddWorkspaceFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemovePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    onUseFolder: vi.fn(),
    primaryRoot: bravo,
    recentRoots: [],
    secondaryRoots: [],
    workspaceFolders: [],
    ...overrides,
  };
}

async function openRootSubmenu(rootId: string): Promise<HTMLElement> {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  await user.click(screen.getByTestId('workspace-bar-where-chip'));
  const trigger = await screen.findByTestId(`workspace-bar-root-${rootId}`);
  await act(async () => {
    trigger.focus();
  });
  await user.keyboard('{ArrowRight}');
  return trigger;
}

describe('a removed thread folder in the where-control', () => {
  it('is named on the chip itself', () => {
    render(<WorkspaceBar {...props({ secondaryRoots: [alpha] })} />);
    expect(screen.getByTestId('workspace-bar-where-chip')).toHaveAccessibleName(
      'Where this thread works: bravo (closed), 1 more'
    );
  });

  it('as the primary, offers Reopen and a Remove that promotes the live folder', async () => {
    const onAddRecent = vi.fn();
    const onRemovePrimary = vi.fn();
    render(<WorkspaceBar {...props({ onAddRecent, onRemovePrimary, secondaryRoots: [alpha] })} />);
    const row = await openRootSubmenu('r-bravo');
    expect(row).toHaveTextContent('Closed');
    expect(screen.queryByTestId('workspace-bar-reveal-r-bravo')).not.toBeInTheDocument();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByTestId('workspace-bar-remove-primary-r-bravo'));
    expect(onRemovePrimary).toHaveBeenCalledWith('r-bravo');
  });

  it('as the only folder, keeps Remove disabled and offers another workspace folder', async () => {
    const onRemovePrimary = vi.fn();
    const onUseFolder = vi.fn();
    render(
      <WorkspaceBar
        {...props({
          onRemovePrimary,
          onUseFolder,
          workspaceFolders: [{ displayName: 'charlie', path: '/ws/charlie' }],
        })}
      />
    );
    await openRootSubmenu('r-bravo');
    const remove = await screen.findByTestId('workspace-bar-remove-primary-r-bravo');
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    expect(remove).toHaveAccessibleDescription('Choose another folder for this thread first.');
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(remove);
    expect(onRemovePrimary).not.toHaveBeenCalled();
    // Back out of the row's submenu; the chip's own menu stays open.
    await user.keyboard('{ArrowLeft}');
    const use = await screen.findByTestId('workspace-bar-use-another-folder');
    await act(async () => {
      use.focus();
    });
    await user.keyboard('{ArrowRight}');
    await user.click(await screen.findByTestId('workspace-bar-use-folder-/ws/charlie'));
    expect(onUseFolder).toHaveBeenCalledWith({ displayName: 'charlie', path: '/ws/charlie' });
  });

  it('as a secondary, cannot be made primary and can be removed', async () => {
    const onRemoveSecondary = vi.fn();
    render(
      <WorkspaceBar
        {...props({ onRemoveSecondary, primaryRoot: alpha, secondaryRoots: [bravo] })}
      />
    );
    await openRootSubmenu('r-bravo');
    const menu = await screen.findByTestId('workspace-bar-readd-r-bravo');
    expect(within(menu).getByText('Reopen folder')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-bar-make-primary-r-bravo')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-bar-use-another-folder')).not.toBeInTheDocument();
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByTestId('workspace-bar-remove-secondary-r-bravo'));
    expect(onRemoveSecondary).toHaveBeenCalledWith('r-bravo');
  });

  it("says why it can't be opened, and offers to try again", async () => {
    render(
      <WorkspaceBar
        {...props({
          primaryRoot: alpha,
          secondaryRoots: [{ ...bravo, reopenFailure: 'The folder no longer exists.' }],
        })}
      />
    );
    const row = await openRootSubmenu('r-bravo');
    expect(row).toHaveTextContent("Can't be opened: The folder no longer exists.");
    const retry = await screen.findByTestId('workspace-bar-readd-r-bravo');
    expect(within(retry).getByText('Try again')).toBeInTheDocument();
  });

  it("keeps the host's reason as written in the chip's name", () => {
    render(
      <WorkspaceBar
        {...props({
          primaryRoot: {
            ...bravo,
            reopenFailure: 'The folder is no longer at /Users/Sean/Beaker.',
          },
        })}
      />
    );
    expect(screen.getByTestId('workspace-bar-where-chip')).toHaveAccessibleName(
      "Where this thread works: bravo (can't be opened: The folder is no longer at /Users/Sean/Beaker.)"
    );
  });

  it('shows a reopen in flight as opening', () => {
    render(<WorkspaceBar {...props({ primaryRoot: { ...bravo, reopening: true } })} />);
    expect(screen.getByTestId('workspace-bar-where-chip')).toHaveAccessibleName(
      'Where this thread works: bravo (opening…)'
    );
  });
});
