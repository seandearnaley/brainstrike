import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BranchChip } from '../workspace-bar/branch-chip';
import type { WorkspaceBarForge } from '../workspace-bar/pr-chip';
import {
  WorkspaceBar,
  type WorkspaceBarBranchMenu,
  type WorkspaceBarProps,
} from '../workspace-bar/workspace-bar';

function baseProps(overrides: Partial<WorkspaceBarProps> = {}): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemovePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    onUseFolder: vi.fn(),
    primaryRoot: { displayName: 'brainstrike', path: '/ws/brainstrike', rootId: 'r-main' },
    recentRoots: [],
    secondaryRoots: [],
    workspaceFolders: [],
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
 * the submenu and closes it.
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

    expect(screen.getByTestId('workspace-bar')).toBeInTheDocument();

    const chip = screen.getByTestId('workspace-bar-folder-chip');
    expect(chip).toHaveTextContent('brainstrike');
    expect(chip).toHaveTextContent('+2');
    expect(chip).toHaveAttribute('title', '/ws/brainstrike');
    expect(chip).toHaveAccessibleName('Folder: brainstrike, 2 more');
  });

  // BST-1400: `data-checkout-state` is the deterministic e2e wait that
  // replaces sampling for the branch chip's absence.
  it('defaults data-checkout-state to resolved when the caller has no async checkout to await', () => {
    render(<WorkspaceBar {...baseProps()} />);
    expect(screen.getByTestId('workspace-bar')).toHaveAttribute('data-checkout-state', 'resolved');
  });

  it('surfaces the caller-supplied checkout state on the bar element', () => {
    const { rerender } = render(<WorkspaceBar {...baseProps({ checkoutState: 'pending' })} />);
    expect(screen.getByTestId('workspace-bar')).toHaveAttribute('data-checkout-state', 'pending');

    rerender(<WorkspaceBar {...baseProps({ checkoutState: 'resolved' })} />);
    expect(screen.getByTestId('workspace-bar')).toHaveAttribute('data-checkout-state', 'resolved');
  });

  it('routes unavailable forge detail to BranchChip and mounts PrChip for a pull request', async () => {
    const user = setup();
    const forgeBase = {
      onAskAgentToFixChecks: vi.fn(),
      onCopyUrl: vi.fn(),
      onOpenExternal: vi.fn(),
      onRefresh: vi.fn(),
      onWatchChange: vi.fn(),
      watched: true,
    };
    const unavailable: WorkspaceBarForge = {
      ...forgeBase,
      status: {
        failure: { detail: 'GitHub CLI authentication is required.', reason: 'gh-unauthenticated' },
        kind: 'unavailable',
      },
    };
    const { rerender } = render(
      <WorkspaceBar
        {...baseProps({ checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false } })}
        forge={unavailable}
      />
    );

    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    expect(await screen.findByTestId('workspace-bar-branch-forge-diagnostic')).toHaveTextContent(
      'GitHub CLI authentication is required.'
    );

    const available: WorkspaceBarForge = {
      ...forgeBase,
      status: {
        kind: 'pr',
        observedAt: '2026-08-24T00:00:00.000Z',
        pullRequest: {
          checks: [],
          checksRollup: 'none',
          headSha: 'sha',
          isDraft: false,
          number: 2574,
          reviewDecision: null,
          state: 'open',
          title: 'Workspace bar',
          url: 'https://github.com/acme/widgets/pull/2574',
        },
      },
    };
    rerender(
      <WorkspaceBar
        {...baseProps({ checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false } })}
        forge={available}
      />
    );
    expect(screen.getByTestId('workspace-bar-pr-chip')).toHaveTextContent('#2574');
  });

  // BST-1391 fix round (F2): a `stale` status with no last-known pull request
  // used to fall through the old `kind === 'unavailable'` gate — PrChip
  // renders nothing for it (same as `unavailable`), so the failure had
  // nowhere left to surface. It must reach the BranchChip's diagnostic too.
  it('routes a stale-with-null-pullRequest forge failure to BranchChip, same as unavailable', async () => {
    const user = setup();
    const staleWithNull: WorkspaceBarForge = {
      onAskAgentToFixChecks: undefined,
      onCopyUrl: vi.fn(),
      onOpenExternal: vi.fn(),
      onRefresh: vi.fn(),
      onWatchChange: vi.fn(),
      status: {
        failure: {
          detail: 'gh-unauthenticated: run `gh auth login`.',
          reason: 'gh-unauthenticated',
        },
        kind: 'stale',
        observedAt: '2026-08-24T00:00:00.000Z',
        pullRequest: null,
      },
      watched: true,
    };
    render(
      <WorkspaceBar
        {...baseProps({ checkout: { ahead: 0, behind: 0, branch: 'main', dirty: false } })}
        forge={staleWithNull}
      />
    );
    expect(screen.queryByTestId('workspace-bar-pr-chip')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    expect(await screen.findByTestId('workspace-bar-branch-forge-diagnostic')).toHaveTextContent(
      'gh-unauthenticated: run `gh auth login`.'
    );
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

  // BST-1400 item 12: disables "Add folder…" and Recent rows instead of
  // letting the OS picker run to completion only to have the thread-level
  // write refused afterward.
  it('disables Add folder… and Recent rows with a reason while addFolderDisabledReason is set', async () => {
    const user = setup();
    const onAddFolder = vi.fn();
    const onAddRecent = vi.fn();
    render(
      <WorkspaceBar
        {...baseProps({
          addFolderDisabledReason: "This thread hasn't finished loading yet",
          onAddFolder,
          onAddRecent,
          recentRoots: [{ displayName: 'alpha', path: '/ws/alpha' }],
        })}
      />
    );

    await openFolderMenu(user);
    const addFolderItem = await screen.findByTestId('workspace-bar-add-folder');
    const recentItem = await screen.findByTestId('workspace-bar-recent-/ws/alpha');
    expect(addFolderItem).toHaveAttribute('aria-disabled', 'true');
    expect(recentItem).toHaveAttribute('aria-disabled', 'true');
    expect(addFolderItem).toHaveTextContent("This thread hasn't finished loading yet");

    await user.click(addFolderItem);
    await user.click(recentItem);
    expect(onAddFolder).not.toHaveBeenCalled();
    expect(onAddRecent).not.toHaveBeenCalled();
  });

  it('still shows mounted secondaries when there is no primary root', async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...baseProps({
          primaryRoot: undefined,
          secondaryRoots: [{ displayName: 'docs', rootId: 'r-docs' }],
        })}
      />
    );

    // Callers must not pass secondaryRoots without primaryRoot (see the
    // primaryRoot doc in workspace-bar.tsx), but if that invariant is
    // violated the bar must not silently hide already-mounted state: the CTA
    // stays in its no-primary form (no "+1" badge)...
    const chip = screen.getByTestId('workspace-bar-folder-chip');
    expect(chip).toHaveTextContent('Choose a folder');
    expect(chip).not.toHaveTextContent('+1');

    // ...but the secondary itself still appears in the open menu.
    await openFolderMenu(user);
    expect(screen.getByTestId('workspace-bar-root-r-docs')).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
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

  // PR #2685 review: the shared DisableableMenuItem label span lost its
  // `truncate` class in the folder-chip refactor — a long basename widened
  // the dropdown instead of ellipsising. Root-action labels are fixed short
  // strings, so only Recent rows regress; pinned here directly.
  it('truncates a long Recent row basename instead of widening the dropdown', async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...baseProps({
          onAddRecent: vi.fn(),
          recentRoots: [
            {
              displayName: 'a-very-long-folder-basename-that-should-ellipsize-not-widen',
              path: '/ws/a-very-long-folder-basename-that-should-ellipsize-not-widen',
            },
          ],
        })}
      />
    );

    await openFolderMenu(user);
    const row = await screen.findByTestId(
      'workspace-bar-recent-/ws/a-very-long-folder-basename-that-should-ellipsize-not-widen'
    );
    const label = within(row).getByText(
      'a-very-long-folder-basename-that-should-ellipsize-not-widen'
    );
    expect(label.className.split(' ')).toContain('truncate');
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

  it('keeps a disabled Remove reason readable and keyboard-accessible', async () => {
    const user = setup();
    const onRemoveSecondary = vi.fn();
    render(
      <WorkspaceBar
        {...baseProps({
          onRemoveSecondary,
          secondaryRoots: [
            {
              displayName: 'brainstrike',
              removeDisabledReason: 'This folder is where Hand off returns to.',
              rootId: 'r-local',
            },
          ],
        })}
      />
    );

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-local');
    const remove = await screen.findByTestId('workspace-bar-remove-secondary-r-local');
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    expect(remove).toHaveAccessibleDescription('This folder is where Hand off returns to.');
    const reason = screen.getByText('This folder is where Hand off returns to.');
    expect(reason).toHaveClass('text-foreground');
    expect(remove).not.toHaveAttribute('data-disabled');

    await user.keyboard('{End}');
    expect(remove).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onRemoveSecondary).not.toHaveBeenCalled();
  });

  it('offers Reveal / Copy path per root only when the platform supplies the handlers', async () => {
    const user = setup();
    const onCopyPath = vi.fn();
    const onReveal = vi.fn();
    // The label is the platform's, never the chip's: this one is deliberately
    // not "Reveal in Finder", so a hardcoded OS name would fail here.
    const reveal = { label: 'Reveal in File Explorer', onReveal };
    const { rerender } = render(<WorkspaceBar {...baseProps()} />);

    await openFolderMenu(user);
    // Without either handler the primary row has no actions at all, so it is
    // informational — not a submenu the user can open onto an empty list.
    expect(screen.getByTestId('workspace-bar-root-r-main')).not.toHaveAttribute('role', 'menuitem');
    await user.keyboard('{Escape}');

    rerender(<WorkspaceBar {...baseProps({ onCopyPath, reveal })} />);
    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-main');

    // The primary's submenu offers Reveal/Copy but never the secondary-only
    // actions — the "never Remove for the primary" invariant, asserted here
    // where the primary submenu is actually open (not just absent from a
    // closed menu).
    expect(screen.queryByTestId('workspace-bar-remove-secondary-r-main')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-bar-make-primary-r-main')).not.toBeInTheDocument();

    const revealItem = await screen.findByTestId('workspace-bar-reveal-r-main');
    expect(revealItem).toHaveTextContent('Reveal in File Explorer');
    await user.click(revealItem);
    expect(onReveal).toHaveBeenCalledWith('/ws/brainstrike');

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-main');
    await user.click(await screen.findByTestId('workspace-bar-copy-path-r-main'));
    expect(onCopyPath).toHaveBeenCalledWith('/ws/brainstrike');
  });

  it('offers Open in Terminal on a root row and passes its rootId and path', async () => {
    const user = setup();
    const onOpenTerminal = vi.fn<(rootId: string, path: string) => void>();
    const onCopyPath = vi.fn<(path: string) => void>();
    render(<WorkspaceBar {...baseProps({ onCopyPath, onOpenTerminal })} />);

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-main');
    await user.click(await screen.findByTestId('workspace-bar-open-terminal-r-main'));

    expect(onOpenTerminal).toHaveBeenCalledExactlyOnceWith('r-main', '/ws/brainstrike');
    expect(onCopyPath).not.toHaveBeenCalled();
  });

  it('omits Open in Terminal when the platform supplies no handler', async () => {
    const user = setup();
    const onCopyPath = vi.fn<(path: string) => void>();
    render(<WorkspaceBar {...baseProps({ onCopyPath })} />);

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-main');

    // Positive control: without it, rootActions() returns [] regardless of
    // the onOpenTerminal gate — the row renders as an inert DropdownMenuLabel
    // and openRootSubmenu's ArrowRight is a no-op, so the absence assertion
    // below would pass even with the gate itself broken. Copy path proves a
    // REAL submenu with items exists; Open in Terminal is excluded from it
    // specifically, not merely absent because nothing rendered at all.
    expect(await screen.findByTestId('workspace-bar-copy-path-r-main')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-bar-open-terminal-r-main')).not.toBeInTheDocument();
  });

  it('omits Open in Terminal for a root with no filesystem path (web FSA root)', async () => {
    const user = setup();
    const onMakePrimary = vi.fn();
    const onOpenTerminal = vi.fn<(rootId: string, path: string) => void>();
    render(
      <WorkspaceBar
        {...baseProps({
          onMakePrimary,
          onOpenTerminal,
          secondaryRoots: [{ displayName: 'granted', rootId: 'r-fsa' }],
        })}
      />
    );

    await openFolderMenu(user);
    await openRootSubmenu(user, 'r-fsa');

    // Positive control: `onCopyPath`/`reveal` are themselves gated behind
    // `path` in rootActions(), so neither can ever render for a path-less
    // root — passing one would not distinguish a real submenu from an empty
    // one here. `Make primary` has no path dependency (it fires for any
    // non-primary root), so a path-less SECONDARY root is what actually
    // proves the row "still renders its other actions rather than the whole
    // submenu vanishing" — the claim the previous version of this comment
    // made without a fixture that could back it up.
    expect(await screen.findByTestId('workspace-bar-make-primary-r-fsa')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-bar-open-terminal-r-fsa')).not.toBeInTheDocument();
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
    // The glyph cluster is compact by design; the spelled-out summary is what
    // assistive tech actually gets (role="img" + aria-label built in
    // branch-chip.tsx), so pin it directly rather than re-deriving it from
    // the glyphs above.
    expect(chip).toHaveAccessibleName('On branch main · 2 ahead · clean');

    rerender(
      <WorkspaceBar
        {...baseProps({ checkout: { ahead: null, behind: null, branch: null, dirty: true } })}
      />
    );
    expect(screen.getByTestId('workspace-bar-branch-chip')).toHaveTextContent('detached');
    expect(screen.getByTestId('workspace-bar-branch-chip')).toHaveAttribute('data-dirty', 'true');
  });
});

describe('BranchChip menu', () => {
  const branchMenu = (overrides: Partial<WorkspaceBarBranchMenu> = {}): WorkspaceBarBranchMenu => ({
    onCreateBranch: vi.fn(),
    onFetch: vi.fn(),
    onQueryChange: vi.fn(),
    onSwitch: vi.fn(),
    pending: false,
    query: '',
    rows: [
      {
        current: true,
        disabledReason: 'Already checked out here.',
        name: 'main',
        switchable: false,
        worktreeName: null,
      },
      {
        current: false,
        disabledReason: null,
        name: 'feature/alpha',
        switchable: true,
        worktreeName: null,
      },
      {
        current: false,
        disabledReason: 'Checked out in worktree "beta-copy" — git allows one checkout per branch.',
        name: 'feature/beta',
        switchable: false,
        worktreeName: 'beta-copy',
      },
    ],
    scopeReason: null,
    ...overrides,
  });
  const clean = { ahead: null, behind: null, branch: 'main', dirty: false };
  const dirty = { ahead: null, behind: null, branch: 'main', dirty: true };

  it('opens a menu from the chip and switches to a switchable branch', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...baseProps()} branchMenu={menu} checkout={clean} />);
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    await user.click(await screen.findByTestId('workspace-bar-branch-row-feature/alpha'));
    expect(menu.onSwitch).toHaveBeenCalledWith('feature/alpha');
  });

  it('disables an unswitchable row and states the reason IN the row', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseProps()} branchMenu={branchMenu()} checkout={clean} />);
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    const beta = await screen.findByTestId('workspace-bar-branch-row-feature/beta');
    expect(beta).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('workspace-bar-branch-reason-feature/beta')).toHaveTextContent(
      'Checked out in worktree "beta-copy"'
    );
  });

  it('offers "Switch in a new worktree" for a dirty tree ONLY when the capability is supplied', async () => {
    const user = setup();
    // Same dirty-disabled row for BOTH halves of this test — only the
    // callback differs. If the positive half used the default fixture's
    // `feature/alpha` (switchable: true), the worktree item would be absent
    // from the negative half for the wrong reason (row.switchable) and the
    // capability gate itself would go unfalsified.
    const dirtyDisabledRows: WorkspaceBarBranchMenu['rows'] = [
      {
        current: false,
        disabledReason: 'Working tree has uncommitted changes — commit or stash first.',
        name: 'feature/alpha',
        switchable: false,
        worktreeName: null,
      },
    ];
    const withCapability = branchMenu({
      onSwitchInNewWorktree: vi.fn(),
      rows: dirtyDisabledRows,
    });
    const { unmount } = render(
      <WorkspaceBar {...baseProps()} branchMenu={withCapability} checkout={dirty} />
    );
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    const worktreeAction = await screen.findByTestId('workspace-bar-branch-worktree-feature/alpha');
    expect(worktreeAction).toHaveTextContent(
      "Switch in a new worktree (detached at this branch's tip)"
    );
    await user.click(worktreeAction);
    expect(withCapability.onSwitchInNewWorktree).toHaveBeenCalledWith('feature/alpha');
    unmount();

    render(
      <WorkspaceBar
        {...baseProps()}
        branchMenu={branchMenu({ rows: dirtyDisabledRows })}
        checkout={dirty}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    expect(screen.queryByTestId('workspace-bar-branch-worktree-feature/alpha')).toBeNull();
  });

  it('renders the scope reason instead of rows when the repository is out of scope', async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...baseProps()}
        branchMenu={branchMenu({ scopeReason: 'This folder is below the repository root.' })}
        checkout={clean}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    expect(await screen.findByTestId('workspace-bar-branch-scope-reason')).toHaveTextContent(
      'This folder is below the repository root.'
    );
    expect(screen.queryByTestId('workspace-bar-branch-row-feature/alpha')).toBeNull();
  });

  it('calls onQueryChange with the typed value from the filter input', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...baseProps()} branchMenu={menu} checkout={clean} />);
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    await user.type(await screen.findByTestId('workspace-bar-branch-search'), 'a');
    expect(menu.onQueryChange).toHaveBeenCalledWith('a');
  });

  it('calls onFetch when the Fetch item is clicked', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...baseProps()} branchMenu={menu} checkout={clean} />);
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    await user.click(await screen.findByTestId('workspace-bar-branch-fetch'));
    expect(menu.onFetch).toHaveBeenCalledTimes(1);
  });

  it('creates a branch from the inline field', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...baseProps()} branchMenu={menu} checkout={clean} />);
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    await user.type(await screen.findByTestId('workspace-bar-branch-new-name'), 'bs/bright-fox');
    await user.click(screen.getByTestId('workspace-bar-branch-create'));
    expect(menu.onCreateBranch).toHaveBeenCalledWith('bs/bright-fox');
  });

  it('stays a read-only image with no menu when branchMenu is absent', () => {
    render(
      <WorkspaceBar
        {...baseProps()}
        checkout={{ ahead: 2, behind: null, branch: 'main', dirty: false }}
      />
    );
    const chip = screen.getByTestId('workspace-bar-branch-chip');
    expect(chip).toHaveAttribute('role', 'img');
    expect(chip).toHaveAccessibleName('On branch main · 2 ahead · clean');
  });
});

describe('BranchChip forge diagnostic', () => {
  const checkout = { ahead: 0, behind: 0, branch: 'main', dirty: false };

  it('becomes a trigger that states why there is no PR chip', async () => {
    const user = userEvent.setup();
    render(
      <BranchChip
        checkout={checkout}
        forgeDiagnostic="GitHub CLI (gh) was not found on PATH. Install it to see pull request status."
      />
    );
    const chip = screen.getByTestId('workspace-bar-branch-chip');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip).toHaveAccessibleName(expect.stringContaining('PR status unavailable'));
    await user.click(chip);
    expect(await screen.findByTestId('workspace-bar-branch-forge-diagnostic')).toHaveTextContent(
      'GitHub CLI (gh) was not found on PATH.'
    );
  });

  it('merges the forge diagnostic into the existing branch switcher menu', async () => {
    const user = setup();
    const menu: WorkspaceBarBranchMenu = {
      onCreateBranch: vi.fn(),
      onFetch: vi.fn(),
      onQueryChange: vi.fn(),
      onSwitch: vi.fn(),
      pending: false,
      query: '',
      rows: [
        {
          current: false,
          disabledReason: null,
          name: 'feature/alpha',
          switchable: true,
          worktreeName: null,
        },
      ],
      scopeReason: null,
    };
    render(
      <BranchChip
        branchMenu={menu}
        checkout={checkout}
        forgeDiagnostic="GitHub CLI authentication is required."
      />
    );

    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    const diagnostic = await screen.findByTestId('workspace-bar-branch-forge-diagnostic');
    const openMenu = diagnostic.closest('[role="menu"]');
    expect(openMenu).toBeInstanceOf(HTMLElement);
    if (!(openMenu instanceof HTMLElement)) {
      throw new Error('The forge diagnostic must render inside the open branch menu.');
    }
    expect(diagnostic).toHaveTextContent('GitHub CLI authentication is required.');
    expect(within(openMenu).getByTestId('workspace-bar-branch-row-feature/alpha')).toBeVisible();
  });
});
