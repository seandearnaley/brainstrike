import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceBar, type WorkspaceBarProps } from '../workspace-bar/workspace-bar';

function baseProps(overrides: Partial<WorkspaceBarProps> = {}): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    primaryRoot: { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'r-main' },
    recentRoots: [],
    secondaryRoots: [],
    ...overrides,
  };
}

/** Radix menus need the pointer-events check off in a headless DOM. */
function setup() {
  return userEvent.setup({ pointerEventsCheck: 0 });
}

async function openFolderMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('workspace-bar-folder-chip'));
  await screen.findByRole('menu');
}

/**
 * Root rows with actions are submenus; open one the way a keyboard user does.
 * A POINTER open cannot be asserted in a headless DOM: Radix's submenu
 * "pointer grace area" is computed from getBoundingClientRect(), which is all
 * zeros here, so the very next pointer move onto a sub item reads as leaving
 * the submenu and closes it. Same reason ComposerModelMenu's drill-down test
 * drives its submenus with ArrowRight.
 */
async function openRootSubmenu(
  user: ReturnType<typeof userEvent.setup>,
  rootId: string
): Promise<void> {
  const trigger = await screen.findByTestId(`workspace-bar-root-${rootId}`);
  await act(async () => {
    trigger.focus();
  });
  await user.keyboard('{ArrowRight}');
}

describe('WorkspaceBar', () => {
  it('renders the primary folder name and a +N suffix for secondaries', () => {
    render(
      <WorkspaceBar
        {...baseProps({
          secondaryRoots: [
            { displayName: 'docs', rootId: 'r-docs' },
            { displayName: 'site', rootId: 'r-site' },
          ],
        })}
      />
    );

    const chip = screen.getByTestId('workspace-bar-folder-chip');
    expect(chip).toHaveTextContent('brainstrike');
    expect(chip).toHaveTextContent('+2');
    expect(chip).toHaveAttribute('title', '/ws/brainstrike');
    expect(chip).toHaveAccessibleName('Folder: brainstrike, 2 more');
  });

  it('renders a "Choose a folder" CTA with zero roots and calls onAddFolder from the menu', async () => {
    const user = setup();
    const onAddFolder = vi.fn();
    render(<WorkspaceBar {...baseProps({ onAddFolder, primaryRoot: undefined })} />);

    const chip = screen.getByTestId('workspace-bar-folder-chip');
    expect(chip).toHaveTextContent('Choose a folder');
    expect(chip).not.toHaveAttribute('title');

    await openFolderMenu(user);
    await user.click(await screen.findByTestId('workspace-bar-add-folder'));

    expect(onAddFolder).toHaveBeenCalledTimes(1);
  });

  it('lists recents only when onAddRecent is provided and calls it with the path', async () => {
    const user = setup();
    const onAddRecent = vi.fn();
    const { rerender } = render(
      <WorkspaceBar
        {...baseProps({ recentRoots: [{ displayName: 'alpha', path: '/ws/alpha' }] })}
      />
    );

    await openFolderMenu(user);
    expect(screen.queryByTestId('workspace-bar-recent-/ws/alpha')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    rerender(
      <WorkspaceBar
        {...baseProps({ onAddRecent, recentRoots: [{ displayName: 'alpha', path: '/ws/alpha' }] })}
      />
    );
    await openFolderMenu(user);
    await user.click(await screen.findByTestId('workspace-bar-recent-/ws/alpha'));

    expect(onAddRecent).toHaveBeenCalledWith('/ws/alpha');
  });

  it('hides recents that are already mounted in this thread', async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...baseProps({
          onAddRecent: vi.fn(),
          recentRoots: [
            { displayName: 'brainstrike', path: '/ws/brainstrike' },
            { displayName: 'docs', path: '/ws/docs' },
            { displayName: 'alpha', path: '/ws/alpha' },
          ],
          secondaryRoots: [{ displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' }],
        })}
      />
    );

    await openFolderMenu(user);

    expect(screen.queryByTestId('workspace-bar-recent-/ws/brainstrike')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-bar-recent-/ws/docs')).not.toBeInTheDocument();
    expect(await screen.findByTestId('workspace-bar-recent-/ws/alpha')).toBeInTheDocument();
  });

  it('offers Make primary / Remove for a secondary and never Remove for the primary', async () => {
    const user = setup();
    const onMakePrimary = vi.fn();
    const onRemoveSecondary = vi.fn();
    render(
      <WorkspaceBar
        {...baseProps({
          onMakePrimary,
          onRemoveSecondary,
          secondaryRoots: [{ displayName: 'docs', rootId: 'r-docs' }],
        })}
      />
    );

    await openFolderMenu(user);
    expect(screen.queryByTestId('workspace-bar-make-primary-r-main')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-bar-remove-secondary-r-main')).not.toBeInTheDocument();

    await openRootSubmenu(user, 'r-docs');
    await user.click(await screen.findByTestId('workspace-bar-make-primary-r-docs'));
    expect(onMakePrimary).toHaveBeenCalledWith('r-docs');

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-docs');
    await user.click(await screen.findByTestId('workspace-bar-remove-secondary-r-docs'));
    expect(onRemoveSecondary).toHaveBeenCalledWith('r-docs');
  });

  it('offers Reveal / Copy path per root only when the platform supplies the handlers', async () => {
    const user = setup();
    const onCopyPath = vi.fn();
    const onRevealRoot = vi.fn();
    const { rerender } = render(<WorkspaceBar {...baseProps()} />);

    await openFolderMenu(user);
    // Without either handler the primary row has no actions at all, so it is
    // informational — not a submenu the user can open onto an empty list.
    expect(screen.getByTestId('workspace-bar-root-r-main')).not.toHaveAttribute('role', 'menuitem');
    await user.keyboard('{Escape}');

    rerender(<WorkspaceBar {...baseProps({ onCopyPath, onRevealRoot })} />);
    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-main');

    await user.click(await screen.findByTestId('workspace-bar-reveal-r-main'));
    expect(onRevealRoot).toHaveBeenCalledWith('/ws/brainstrike');

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-main');
    await user.click(await screen.findByTestId('workspace-bar-copy-path-r-main'));
    expect(onCopyPath).toHaveBeenCalledWith('/ws/brainstrike');
  });

  it('renders the branch chip states and hides it without checkout data', () => {
    const { rerender } = render(<WorkspaceBar {...baseProps()} />);
    expect(screen.queryByTestId('workspace-bar-branch-chip')).not.toBeInTheDocument();

    rerender(
      <WorkspaceBar
        {...baseProps({ checkout: { ahead: 2, behind: 0, branch: 'main', dirty: false } })}
      />
    );
    const chip = screen.getByTestId('workspace-bar-branch-chip');
    expect(chip).toHaveTextContent('main');
    expect(chip).toHaveTextContent('↑2');
    expect(chip).not.toHaveTextContent('↓');
    expect(chip).toHaveAttribute('data-dirty', 'false');

    rerender(
      <WorkspaceBar
        {...baseProps({ checkout: { ahead: null, behind: null, branch: null, dirty: true } })}
      />
    );
    expect(screen.getByTestId('workspace-bar-branch-chip')).toHaveTextContent('detached');
    expect(screen.getByTestId('workspace-bar-branch-chip')).toHaveAttribute('data-dirty', 'true');
  });
});
