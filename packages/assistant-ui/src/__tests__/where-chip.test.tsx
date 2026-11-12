/**
 * ADR-0034, owner decisions 2026-11-11: the composer's folder, branch and
 * checkout chips are one control, "where this thread works". Closed it reads
 * `<project> · <checkout>`; open it lists Local and the thread's worktree, the
 * Branch and Folders submenus, and the worktree's own actions. Each row keeps
 * the handler it had as its own chip.
 */
import { act } from '@brainstrike/test-utils/react-act';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  NOT_A_GIT_REPOSITORY_REASON,
  WorkspaceBar,
  type WorkspaceBarBranchMenu,
  type WorkspaceBarMode,
  type WorkspaceBarProps,
} from '../workspace-bar/workspace-bar';

type User = ReturnType<typeof userEvent.setup>;
const setup = (): User => userEvent.setup({ pointerEventsCheck: 0 });

const RUN_IN_PROGRESS = "Available when this thread's run ends.";
const brainstrike = {
  displayName: 'brainstrike',
  path: '/ws/brainstrike',
  rootId: 'r-main',
} as const;
const swiftBadger = {
  displayName: 'swift-badger',
  path: '/managed/brainstrike/swift-badger',
  rootId: 'r-wt',
} as const;
const docs = { displayName: 'docs', path: '/ws/docs', rootId: 'r-docs' } as const;
const worktree = {
  branch: 'bs/swift-badger',
  detached: false,
  name: 'swift-badger',
  path: '/managed/brainstrike/swift-badger',
  setupReason: null,
  setupStatus: 'succeeded' as const,
  worktreeId: 'w-1',
};

function mode(overrides: Partial<WorkspaceBarMode> = {}): WorkspaceBarMode {
  return {
    archiveConfirmation: null,
    baseRefs: [{ label: 'Current branch', value: 'HEAD' }],
    checkoutChangeDisabledReason: null,
    createDisabledReason: null,
    defaultBranchPrefix: 'bs/',
    defaultName: 'quiet-otter',
    disabledReason: null,
    managedParentPath: '/managed/brainstrike',
    onArchive: undefined,
    onCreate: vi.fn(() => Promise.resolve()),
    onCreateBranchHere: undefined,
    onHandOffToLocal: undefined,
    onOpenCreateSheet: vi.fn(() => Promise.resolve()),
    onOpenPicker: vi.fn(),
    pending: false,
    picker: {
      error: null,
      loading: false,
      onGrantAccess: undefined,
      onOpenChange: vi.fn(),
      onSelect: vi.fn(),
      open: false,
      options: [],
    },
    repositorySetupConsent: null,
    setupSummary: '',
    uncommittedFolderName: null,
    worktree: null,
    ...overrides,
  };
}

function branchMenu(overrides: Partial<WorkspaceBarBranchMenu> = {}): WorkspaceBarBranchMenu {
  return {
    onCreateBranch: vi.fn(),
    onFetch: vi.fn(),
    onQueryChange: vi.fn(),
    onSwitch: vi.fn(),
    pending: false,
    query: '',
    rows: [
      { current: true, disabledReason: null, name: 'main', switchable: false, worktreeName: null },
      {
        current: false,
        disabledReason: null,
        name: 'feature/alpha',
        switchable: true,
        worktreeName: null,
      },
    ],
    scopeReason: null,
    ...overrides,
  };
}

function props(overrides: Partial<WorkspaceBarProps> = {}): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onAddWorkspaceFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemovePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    onUseFolder: vi.fn(),
    primaryRoot: brainstrike,
    recentRoots: [],
    secondaryRoots: [],
    workspaceFolders: [],
    ...overrides,
  };
}

/** Local in brainstrike, on main with uncommitted changes. */
function local(overrides: Partial<WorkspaceBarProps> = {}): WorkspaceBarProps {
  return props({
    branchMenu: branchMenu(),
    checkout: { ahead: null, behind: null, branch: 'main', dirty: true },
    mode: mode(),
    ...overrides,
  });
}

/** In worktree swift-badger of brainstrike, with every worktree action wired. */
function inWorktree(modeOverrides: Partial<WorkspaceBarMode> = {}) {
  const handlers = {
    onArchive: vi.fn<() => void>(),
    onCreateBranchHere: vi.fn<(branch: string) => Promise<void>>(() => Promise.resolve()),
    onHandOffToLocal: vi.fn<() => void>(),
    onOpenPicker: vi.fn<() => void>(),
  };
  const value = mode({ ...handlers, worktree, ...modeOverrides });
  return {
    ...handlers,
    mode: value,
    props: props({
      branchMenu: branchMenu({
        rows: [
          {
            current: true,
            disabledReason: null,
            name: 'bs/swift-badger',
            switchable: false,
            worktreeName: null,
          },
        ],
      }),
      checkout: { ahead: null, behind: null, branch: 'bs/swift-badger', dirty: false },
      mode: value,
      primaryRoot: swiftBadger,
      secondaryRoots: [{ ...brainstrike, local: true }],
    }),
  };
}

function chip(): HTMLElement {
  return screen.getByTestId('workspace-bar-where-chip');
}

async function openWhere(user: User): Promise<HTMLElement> {
  await user.click(chip());
  return await screen.findByRole('menu');
}

/** Opens a submenu the way a keyboard user does (Radix's pointer grace area is all zeros headless). */
async function openSubmenu(user: User, testId: string): Promise<void> {
  const trigger = await screen.findByTestId(testId);
  await act(async () => {
    trigger.focus();
  });
  await user.keyboard('{ArrowRight}');
}

describe('the where-control, closed', () => {
  it('is one control in place of the folder, branch and checkout chips', () => {
    render(<WorkspaceBar {...local()} />);
    expect(chip()).toBeInTheDocument();
    for (const old of ['folder', 'branch', 'mode']) {
      expect(screen.queryByTestId(`workspace-bar-${old}-chip`)).toBeNull();
    }
  });

  it('asks for a folder when the thread has none', () => {
    render(<WorkspaceBar {...props({ primaryRoot: undefined })} />);
    expect(chip()).toHaveTextContent('Choose a folder');
    expect(chip()).toHaveAccessibleName('Choose a folder');
    expect(chip()).not.toHaveAttribute('title');
  });

  it('reads "<project> · Local" in the folder, with its uncommitted-changes dot', () => {
    render(<WorkspaceBar {...local()} />);
    expect(chip()).toHaveTextContent('brainstrike· Local');
    expect(chip()).toHaveAttribute('data-dirty', 'true');
    expect(chip()).toHaveAttribute('title', '/ws/brainstrike');
    expect(chip()).toHaveAccessibleName(
      'Where this thread works: brainstrike · Local, uncommitted changes'
    );
    expect(chip()).not.toHaveTextContent('main');
  });

  it('reads "<project> · <worktree>" in a worktree, named by its Local folder', () => {
    render(<WorkspaceBar {...inWorktree().props} />);
    expect(chip()).toHaveTextContent('brainstrike· swift-badger');
    expect(chip()).not.toHaveTextContent('+1');
    expect(chip()).toHaveAttribute('data-dirty', 'false');
    expect(chip()).toHaveAttribute('data-setup', 'succeeded');
    expect(chip()).toHaveAccessibleName('Where this thread works: brainstrike · swift-badger');
  });

  it('counts the folders beyond the project', () => {
    render(<WorkspaceBar {...local({ checkout: undefined, secondaryRoots: [docs] })} />);
    expect(chip()).toHaveTextContent('brainstrike+1· Local');
    expect(chip()).toHaveAccessibleName('Where this thread works: brainstrike, 1 more · Local');
  });

  it('names only the folder outside git, with no warning', () => {
    const { container } = render(
      <WorkspaceBar
        {...props({
          mode: mode({ disabledReason: NOT_A_GIT_REPOSITORY_REASON }),
          primaryRoot: { displayName: 'notes', path: '/ws/notes', rootId: 'r-notes' },
        })}
      />
    );
    expect(chip()).toHaveTextContent('notes');
    expect(chip()).not.toHaveTextContent('·');
    expect(chip()).toHaveAccessibleName('Where this thread works: notes');
    expect(container.querySelector('.lucide-triangle-alert')).toBeNull();
  });

  it('warns when the checkout cannot be read', () => {
    const { container } = render(
      <WorkspaceBar
        {...props({ mode: mode({ disabledReason: 'Git status could not be read: boom' }) })}
      />
    );
    expect(chip()).toHaveAccessibleName(
      'Where this thread works: brainstrike, Git status could not be read: boom'
    );
    expect(chip()).toHaveAttribute('title', 'Git status could not be read: boom');
    expect(container.querySelector('.lucide-triangle-alert')).not.toBeNull();
  });

  it('marks a closed folder', () => {
    render(<WorkspaceBar {...props({ primaryRoot: { ...brainstrike, removed: true } })} />);
    expect(chip()).toHaveTextContent('brainstrike (closed)');
    expect(chip()).toHaveAccessibleName('Where this thread works: brainstrike (closed)');
  });

  it('warns about a failed worktree setup', () => {
    const { container } = render(
      <WorkspaceBar
        {...inWorktree({
          worktree: { ...worktree, setupReason: 'exited with code 3.', setupStatus: 'failed' },
        }).props}
      />
    );
    expect(chip()).toHaveAttribute('data-setup', 'failed');
    expect(chip()).toHaveAccessibleName(
      'Where this thread works: brainstrike · swift-badger, setup failed'
    );
    expect(container.querySelector('.lucide-triangle-alert')).not.toBeNull();
  });
});

describe('the where-control, open', () => {
  it('in Local, checks Local and says a clashing edit moves the thread to a worktree', async () => {
    const user = setup();
    render(<WorkspaceBar {...local()} />);
    const menu = await openWhere(user);
    expect(within(menu).getByText('Where this thread works')).toBeVisible();
    expect(screen.getByTestId('workspace-bar-where-project')).toHaveTextContent(
      'brainstrike/ws/brainstrike'
    );
    const localRow = screen.getByTestId('workspace-bar-where-local');
    expect(localRow).toHaveAttribute('aria-checked', 'true');
    expect(localRow).toHaveTextContent('Localmain');
    expect(screen.getByTestId('workspace-bar-where-local-isolation')).toHaveTextContent(
      'Moves to a worktree of its own if another thread is editing here.'
    );
    expect(screen.getByTestId('workspace-bar-branch')).toHaveAccessibleName(
      'Branch: On branch main · uncommitted changes'
    );
    expect(screen.getByTestId('workspace-bar-folders')).toHaveTextContent('Folders: brainstrike');
  });

  it('in a worktree, checks it, names its branch and setup, and offers Local', async () => {
    const user = setup();
    const value = inWorktree({
      worktree: { ...worktree, setupReason: 'no setup script.', setupStatus: 'skipped' },
    });
    render(<WorkspaceBar {...value.props} />);
    await openWhere(user);
    const localRow = screen.getByTestId('workspace-bar-mode-handoff');
    expect(localRow).toHaveAttribute('aria-checked', 'false');
    expect(localRow).toHaveTextContent('Local');
    const current = screen.getByTestId('workspace-bar-where-worktree');
    expect(current).toHaveAttribute('aria-checked', 'true');
    expect(current).toHaveTextContent('swift-badgerbs/swift-badger');
    expect(screen.getByTestId('workspace-bar-mode-setup-reason')).toHaveTextContent(
      'Setup skipped: no setup script.'
    );
    expect(screen.getByTestId('workspace-bar-mode-pick-worktree')).toHaveTextContent(
      'Other worktree…'
    );
    expect(screen.getByTestId('workspace-bar-mode-new-worktree')).toHaveTextContent(
      'New worktree…'
    );
    expect(screen.getByTestId('workspace-bar-branch')).toHaveTextContent('Branch: bs/swift-badger');
    expect(screen.getByTestId('workspace-bar-folders')).toHaveTextContent(
      'Folders: brainstrike +1'
    );
    expect(screen.getByTestId('workspace-bar-mode-create-branch-here')).toBeVisible();
    expect(screen.getByTestId('workspace-bar-mode-archive')).toBeVisible();
  });

  it("offers the worktree's own actions only when their handlers exist", async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...inWorktree({ onArchive: undefined, onCreateBranchHere: undefined }).props}
      />
    );
    await openWhere(user);
    expect(screen.getByTestId('workspace-bar-mode-handoff')).toBeVisible();
    expect(screen.queryByTestId('workspace-bar-mode-create-branch-here')).toBeNull();
    expect(screen.queryByTestId('workspace-bar-mode-archive')).toBeNull();
  });

  it('shows why the checkout is unavailable, and still offers the folders', async () => {
    const user = setup();
    render(<WorkspaceBar {...props({ mode: mode({ disabledReason: 'Not a git repository' }) })} />);
    await openWhere(user);
    expect(screen.getByTestId('workspace-bar-mode-diagnostic')).toHaveTextContent(
      'Not a git repository'
    );
    expect(screen.queryByTestId('workspace-bar-mode-new-worktree')).toBeNull();
    expect(screen.getByTestId('workspace-bar-folders')).toBeInTheDocument();
  });

  it('lists the folder rows in the menu itself while the thread has no folder', async () => {
    const user = setup();
    const onAddFolder = vi.fn();
    render(<WorkspaceBar {...props({ onAddFolder, primaryRoot: undefined })} />);
    await openWhere(user);
    expect(screen.queryByTestId('workspace-bar-folders')).toBeNull();
    await user.click(screen.getByTestId('workspace-bar-add-folder'));
    expect(onAddFolder).toHaveBeenCalledTimes(1);
  });
});

describe('each where-control row wires only its own handler', () => {
  it('choosing Local in a worktree hands off to Local', async () => {
    const user = setup();
    const value = inWorktree();
    render(<WorkspaceBar {...value.props} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-mode-handoff'));
    expect(value.onHandOffToLocal).toHaveBeenCalledTimes(1);
    expect(value.onArchive).not.toHaveBeenCalled();
    expect(value.onCreateBranchHere).not.toHaveBeenCalled();
    expect(value.onOpenPicker).not.toHaveBeenCalled();
  });

  it('Other worktree… opens the existing picker', async () => {
    const user = setup();
    const value = inWorktree();
    render(<WorkspaceBar {...value.props} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-mode-pick-worktree'));
    expect(value.onOpenPicker).toHaveBeenCalledTimes(1);
    expect(value.onArchive).not.toHaveBeenCalled();
    expect(value.onCreateBranchHere).not.toHaveBeenCalled();
    expect(value.onHandOffToLocal).not.toHaveBeenCalled();
  });

  it('New worktree… refreshes the create context and opens the sheet', async () => {
    const user = setup();
    const value = inWorktree();
    render(<WorkspaceBar {...value.props} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-mode-new-worktree'));
    expect(await screen.findByTestId('worktree-create-dialog')).toBeVisible();
    expect(value.mode.onOpenCreateSheet).toHaveBeenCalledTimes(1);
    expect(value.onHandOffToLocal).not.toHaveBeenCalled();
    expect(value.onOpenPicker).not.toHaveBeenCalled();
  });

  it('Create branch here names the branch after the worktree', async () => {
    const user = setup();
    const value = inWorktree();
    render(<WorkspaceBar {...value.props} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-mode-create-branch-here'));
    expect(value.onCreateBranchHere).toHaveBeenCalledExactlyOnceWith('bs/swift-badger');
    expect(value.onArchive).not.toHaveBeenCalled();
    expect(value.onHandOffToLocal).not.toHaveBeenCalled();
  });

  it('Archive worktree… archives', async () => {
    const user = setup();
    const value = inWorktree();
    render(<WorkspaceBar {...value.props} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-mode-archive'));
    expect(value.onArchive).toHaveBeenCalledTimes(1);
    expect(value.onCreateBranchHere).not.toHaveBeenCalled();
    expect(value.onHandOffToLocal).not.toHaveBeenCalled();
  });

  it('the Branch submenu is the switcher: a row switches, and the menu closes', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...local({ branchMenu: menu })} />);
    await openWhere(user);
    await openSubmenu(user, 'workspace-bar-branch');
    expect(await screen.findByTestId('workspace-bar-branch-menu')).toHaveAccessibleName(
      'Branch: On branch main · uncommitted changes'
    );
    await user.click(screen.getByTestId('workspace-bar-branch-row-feature/alpha'));
    expect(menu.onSwitch).toHaveBeenCalledExactlyOnceWith('feature/alpha');
    expect(menu.onCreateBranch).not.toHaveBeenCalled();
    expect(menu.onFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it("keeps the Branch submenu open while its search field takes the menu's keys", async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...local({ branchMenu: menu })} />);
    await openWhere(user);
    await openSubmenu(user, 'workspace-bar-branch');
    const search = await screen.findByTestId('workspace-bar-branch-search');
    expect(search).toHaveFocus();
    await user.keyboard('m{ArrowLeft}');
    expect(menu.onQueryChange).toHaveBeenCalledWith('m');
    expect(screen.getByTestId('workspace-bar-branch-menu')).toBeInTheDocument();
  });

  it('the Folders submenu adds a folder and makes a folder primary', async () => {
    const user = setup();
    const onAddFolder = vi.fn();
    const onMakePrimary = vi.fn();
    render(<WorkspaceBar {...local({ onAddFolder, onMakePrimary, secondaryRoots: [docs] })} />);
    await openWhere(user);
    await openSubmenu(user, 'workspace-bar-folders');
    await openSubmenu(user, 'workspace-bar-root-r-docs');
    await user.click(await screen.findByTestId('workspace-bar-make-primary-r-docs'));
    expect(onMakePrimary).toHaveBeenCalledExactlyOnceWith('r-docs');

    await openWhere(user);
    await openSubmenu(user, 'workspace-bar-folders');
    await user.click(await screen.findByTestId('workspace-bar-add-folder'));
    expect(onAddFolder).toHaveBeenCalledTimes(1);
    expect(onMakePrimary).toHaveBeenCalledTimes(1);
  });
});

describe('what the merge removed', () => {
  it('offers no separate Hand off to Local, Reveal or Open in Terminal for the checkout', async () => {
    const user = setup();
    render(<WorkspaceBar {...inWorktree().props} />);
    await openWhere(user);
    expect(screen.queryByText('Hand off to Local')).toBeNull();
    expect(screen.queryByTestId('workspace-bar-mode-reveal')).toBeNull();
    expect(screen.queryByTestId('workspace-bar-mode-open-terminal')).toBeNull();
  });

  it('offers no Make primary on the Local folder while the Local row hands off to it', async () => {
    const user = setup();
    render(<WorkspaceBar {...inWorktree().props} onCopyPath={vi.fn()} />);
    await openWhere(user);
    await openSubmenu(user, 'workspace-bar-folders');
    await openSubmenu(user, 'workspace-bar-root-r-main');
    expect(await screen.findByTestId('workspace-bar-copy-path-r-main')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-bar-make-primary-r-main')).toBeNull();
  });

  it('keeps Make primary on the Local folder when no Local row can hand off', async () => {
    const user = setup();
    const onMakePrimary = vi.fn();
    const value = inWorktree();
    render(<WorkspaceBar {...value.props} mode={undefined} onMakePrimary={onMakePrimary} />);
    await openWhere(user);
    await openSubmenu(user, 'workspace-bar-folders');
    await openSubmenu(user, 'workspace-bar-root-r-main');
    await user.click(await screen.findByTestId('workspace-bar-make-primary-r-main'));
    expect(onMakePrimary).toHaveBeenCalledExactlyOnceWith('r-main');
  });
});

describe('while the thread runs', () => {
  it('disables the checkout rows with the reason, and leaves branch, folders and repairs open', async () => {
    const user = setup();
    const value = inWorktree({
      checkoutChangeDisabledReason: RUN_IN_PROGRESS,
      createDisabledReason: RUN_IN_PROGRESS,
    });
    const closedDocs = { ...docs, removed: true as const };
    render(
      <WorkspaceBar
        {...value.props}
        onAddRecent={vi.fn()}
        secondaryRoots={[{ ...brainstrike, local: true }, closedDocs]}
      />
    );
    await openWhere(user);
    for (const row of ['handoff', 'archive', 'pick-worktree', 'new-worktree']) {
      expect(screen.getByTestId(`workspace-bar-mode-${row}`)).toHaveAttribute('data-disabled');
    }
    for (const row of ['handoff', 'archive', 'pick-worktree', 'create']) {
      expect(screen.getByTestId(`workspace-bar-mode-${row}-disabled-reason`)).toHaveTextContent(
        RUN_IN_PROGRESS
      );
    }
    expect(screen.getByTestId('workspace-bar-mode-create-branch-here')).not.toHaveAttribute(
      'data-disabled'
    );
    expect(screen.getByTestId('workspace-bar-branch')).not.toHaveAttribute('data-disabled');
    expect(screen.getByTestId('workspace-bar-folders')).not.toHaveAttribute('data-disabled');
    // The closed folder's repairs are at the top level, not inside Folders.
    await openSubmenu(user, 'workspace-bar-root-r-docs');
    expect(await screen.findByTestId('workspace-bar-readd-r-docs')).toBeInTheDocument();
  });
});
