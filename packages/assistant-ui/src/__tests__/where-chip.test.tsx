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
    notARepository: false,
    onArchive: undefined,
    onCreate: vi.fn(() => Promise.resolve()),
    onCreateBranchHere: undefined,
    onHandOffToLocal: undefined,
    onOpenCreateSheet: vi.fn(() => Promise.resolve()),
    onOpenPicker: vi.fn(),
    onQuickCreate: vi.fn(() => Promise.resolve({ needsSheet: false })),
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
    threadCheckout: { worktreePath: null },
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
      threadCheckout: { worktreePath: worktree.path },
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

  it('reads "<folder> · Local" for a folder outside git, with no warning', () => {
    const { container } = render(
      <WorkspaceBar
        {...props({
          mode: mode({ disabledReason: 'Not a git repository', notARepository: true }),
          primaryRoot: { displayName: 'notes', path: '/ws/notes', rootId: 'r-notes' },
        })}
      />
    );
    expect(chip()).toHaveTextContent('notes· Local');
    expect(chip()).toHaveAccessibleName('Where this thread works: notes · Local');
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
    render(
      <WorkspaceBar
        {...props({
          primaryRoot: { ...brainstrike, removed: true },
          threadCheckout: { worktreePath: null },
        })}
      />
    );
    expect(chip()).toHaveTextContent('brainstrike (closed)');
    expect(chip()).toHaveAccessibleName('Where this thread works: brainstrike (closed)');
  });

  // ADR-0034 decision 3: the Explorer's header changes where the thread works through this
  // control, by asking it to open.
  it('opens its menu when another surface asks it to', async () => {
    const { rerender } = render(<WorkspaceBar {...local()} openRequest={0} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    rerender(<WorkspaceBar {...local()} openRequest={1} />);

    expect(await screen.findByRole('menu')).toBeVisible();
  });

  it('stays closed for a request made before it was shown', () => {
    render(<WorkspaceBar {...local()} openRequest={3} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  // The folder's git status is read again after every checkout change and on
  // a thread switch; app-shell withholds `mode` meanwhile (BST-2129).
  it('keeps saying Local while the folder’s git status is read again', () => {
    const { rerender } = render(<WorkspaceBar {...local()} />);
    expect(chip()).toHaveTextContent('brainstrike· Local');
    rerender(<WorkspaceBar {...local({ checkout: undefined, mode: undefined })} />);
    expect(chip()).toHaveTextContent('brainstrike· Local');
    expect(chip()).toHaveAccessibleName('Where this thread works: brainstrike · Local');
  });

  it('keeps naming the worktree while its git status is read again', () => {
    const { rerender } = render(<WorkspaceBar {...inWorktree().props} />);
    rerender(<WorkspaceBar {...inWorktree().props} mode={undefined} />);
    expect(chip()).toHaveTextContent('brainstrike· swift-badger');
    expect(chip()).toHaveAccessibleName('Where this thread works: brainstrike · swift-badger');
    // Before its Local folder's row has loaded, the worktree is still not Local.
    rerender(<WorkspaceBar {...inWorktree().props} mode={undefined} secondaryRoots={[]} />);
    expect(chip()).toHaveAccessibleName('Where this thread works: swift-badger');
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
  // Like the composer's other menus: the composer sits at the foot of a thread,
  // and a menu placed below it from a short first render is squeezed into a
  // scrolling strip once the rows that wait on git arrive.
  it('opens upward from the composer', async () => {
    const user = setup();
    render(<WorkspaceBar {...local()} />);
    const menu = await openWhere(user);
    expect(menu).toHaveAttribute('data-side', 'top');
  });

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
    expect(screen.getByTestId('workspace-bar-mode-new-worktree-customize')).toHaveTextContent(
      'Customize…'
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
    render(
      <WorkspaceBar
        {...props({ mode: mode({ disabledReason: 'Not a git repository', notARepository: true }) })}
      />
    );
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

  // ADR-0034, BST-2506: one click makes the worktree with Automatic isolation's defaults.
  it('New worktree… creates with the defaults at once and opens no sheet', async () => {
    const user = setup();
    const value = inWorktree();
    render(<WorkspaceBar {...value.props} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-mode-new-worktree'));
    expect(value.mode.onQuickCreate).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('worktree-create-dialog')).toBeNull();
    expect(value.mode.onOpenCreateSheet).not.toHaveBeenCalled();
    expect(value.onHandOffToLocal).not.toHaveBeenCalled();
    expect(value.onOpenPicker).not.toHaveBeenCalled();
  });

  it('New worktree… opens the sheet when the repository’s setup script has no answer', async () => {
    const user = setup();
    const value = local({
      mode: mode({
        onQuickCreate: vi.fn(() => Promise.resolve({ needsSheet: true })),
        repositorySetupConsent: {
          decision: null,
          onDecision: vi.fn(() => Promise.resolve()),
          repositoryPath: '/ws/brainstrike',
          scriptPath: '/ws/brainstrike/.brainstrike/worktree-setup.sh',
        },
      }),
    });
    render(<WorkspaceBar {...value} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-mode-new-worktree'));
    const sheet = await screen.findByTestId('worktree-create-dialog');
    expect(within(sheet).getByRole('button', { name: 'Allow script' })).toBeVisible();
    expect(within(sheet).getByTestId('worktree-create-submit')).toBeDisabled();
    expect(value.mode?.onCreate).not.toHaveBeenCalled();
  });

  it('Customize… refreshes the create context and opens the sheet', async () => {
    const user = setup();
    const value = inWorktree();
    render(<WorkspaceBar {...value.props} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-mode-new-worktree-customize'));
    expect(await screen.findByTestId('worktree-create-dialog')).toBeVisible();
    expect(value.mode.onOpenCreateSheet).toHaveBeenCalledTimes(1);
    expect(value.mode.onQuickCreate).not.toHaveBeenCalled();
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

  it('a click on the Branch row opens the switcher with its search field focused', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...local({ branchMenu: menu })} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-branch'));
    expect(await screen.findByTestId('workspace-bar-branch-search')).toHaveFocus();
    await user.keyboard('m');
    expect(menu.onQueryChange).toHaveBeenCalledWith('m');
    expect(screen.getByTestId('workspace-bar-branch-menu')).toBeInTheDocument();
  });

  it('the pointer moving on over the clicked Branch row leaves the keys in its search field', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...local({ branchMenu: menu })} />);
    await openWhere(user);
    const trigger = screen.getByTestId('workspace-bar-branch');
    await user.pointer({ coords: { clientX: 10, clientY: 10 }, target: trigger });
    await user.click(trigger);
    const search = await screen.findByTestId('workspace-bar-branch-search');
    expect(search).toHaveFocus();
    // A nudge of the mouse still over the row: Radix would focus the row, taking the keys back.
    await user.pointer({ coords: { clientX: 12, clientY: 11 }, target: trigger });
    expect(search).toHaveFocus();
    await user.keyboard('m');
    expect(menu.onQueryChange).toHaveBeenCalledWith('m');
    expect(screen.getByTestId('workspace-bar-branch-menu')).toBeInTheDocument();
  });

  it('a click on the Branch row its hover already opened focuses the search field', async () => {
    const user = setup();
    render(<WorkspaceBar {...local({ branchMenu: branchMenu() })} />);
    await openWhere(user);
    const trigger = screen.getByTestId('workspace-bar-branch');
    await user.hover(trigger);
    const search = await screen.findByTestId('workspace-bar-branch-search');
    // Hovering opens the switcher but leaves focus on the row, as every menu row has it.
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    expect(search).toHaveFocus();
  });

  it('the pointer moving into the Branch submenu gives its search field the keys', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...local({ branchMenu: menu })} />);
    await openWhere(user);
    await user.hover(screen.getByTestId('workspace-bar-branch'));
    await user.hover(await screen.findByTestId('workspace-bar-branch-row-feature/alpha'));
    expect(screen.getByTestId('workspace-bar-branch-search')).toHaveFocus();
    // Typed letters filter the branches instead of jumping the where-menu to a row by name.
    await user.keyboard('m');
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

/**
 * The order a move into a new worktree takes in the app: the operation is
 * pending, the binding lands (the thread's primary is the worktree folder,
 * whose git status is not read yet, so app-shell withholds the mode), the
 * status settles, and the operation ends.
 */
describe('a checkout change finishing', () => {
  const movedFolders = {
    primaryRoot: swiftBadger,
    secondaryRoots: [{ ...brainstrike, local: true as const }],
  };

  it('keeps the create sheet, still creating, until its operation ends', async () => {
    const user = setup();
    const created = Promise.withResolvers<void>();
    const started = mode({ onCreate: vi.fn(() => created.promise) });
    const { rerender } = render(<WorkspaceBar {...local({ mode: started })} />);
    await openWhere(user);
    await user.click(screen.getByTestId('workspace-bar-mode-new-worktree-customize'));
    await user.click(await screen.findByTestId('worktree-create-submit'));
    rerender(<WorkspaceBar {...local({ mode: { ...started, pending: true } })} />);
    expect(chip()).toHaveAttribute('aria-busy', 'true');

    // The binding lands; the worktree folder's status is not read yet.
    rerender(<WorkspaceBar {...props({ ...movedFolders, mode: undefined })} />);
    expect(screen.getByTestId('worktree-create-submit')).toHaveTextContent('Creating…');
    expect(chip()).toHaveAttribute('aria-busy', 'true');

    const settled = inWorktree().mode;
    rerender(<WorkspaceBar {...props({ ...movedFolders, mode: { ...settled, pending: true } })} />);
    expect(screen.getByTestId('worktree-create-submit')).toHaveTextContent('Creating…');

    rerender(<WorkspaceBar {...props({ ...movedFolders, mode: settled })} />);
    await act(async () => {
      created.resolve();
    });
    expect(screen.queryByTestId('worktree-create-dialog')).toBeNull();
    expect(chip()).not.toHaveAttribute('aria-busy');
    await openWhere(user);
    expect(screen.getByTestId('workspace-bar-where-worktree')).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('leaves an open menu open across the move, then shows the settled rows', async () => {
    const user = setup();
    const { rerender } = render(<WorkspaceBar {...local({ mode: mode({ pending: true }) })} />);
    await openWhere(user);
    expect(screen.getByText('Worktree operation in progress.')).toBeVisible();

    rerender(<WorkspaceBar {...props({ ...movedFolders, mode: undefined })} />);
    expect(screen.getAllByRole('menu')).toHaveLength(1);

    rerender(<WorkspaceBar {...props({ ...movedFolders, mode: inWorktree().mode })} />);
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.getByTestId('workspace-bar-where-worktree')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.queryByText('Worktree operation in progress.')).toBeNull();
    expect(chip()).not.toHaveAttribute('aria-busy');
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
    for (const row of [
      'handoff',
      'archive',
      'pick-worktree',
      'new-worktree',
      'new-worktree-customize',
    ]) {
      expect(screen.getByTestId(`workspace-bar-mode-${row}`)).toHaveAttribute('data-disabled');
    }
    for (const row of ['handoff', 'archive', 'pick-worktree', 'create', 'new-worktree-customize']) {
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

  it('shows why a Make primary that would leave the worktree waits, and does nothing', async () => {
    const user = setup();
    const onMakePrimary = vi.fn();
    const value = inWorktree({ checkoutChangeDisabledReason: RUN_IN_PROGRESS });
    render(
      <WorkspaceBar
        {...value.props}
        leaveWorktreeDisabledReason={RUN_IN_PROGRESS}
        onMakePrimary={onMakePrimary}
        secondaryRoots={[{ ...brainstrike, local: true }, docs]}
      />
    );
    await openWhere(user);
    await openSubmenu(user, 'workspace-bar-folders');
    await openSubmenu(user, 'workspace-bar-root-r-docs');
    const makePrimary = await screen.findByTestId('workspace-bar-make-primary-r-docs');
    expect(makePrimary).toHaveAttribute('aria-disabled', 'true');
    expect(makePrimary).toHaveAccessibleDescription(RUN_IN_PROGRESS);
    await user.click(makePrimary);
    expect(onMakePrimary).not.toHaveBeenCalled();
  });

  it('shows why removing a closed worktree folder waits, and does nothing', async () => {
    const user = setup();
    const onRemovePrimary = vi.fn();
    render(
      <WorkspaceBar
        {...props({
          leaveWorktreeDisabledReason: RUN_IN_PROGRESS,
          onAddRecent: vi.fn(),
          onRemovePrimary,
          primaryRoot: { ...swiftBadger, removed: true },
          secondaryRoots: [{ ...brainstrike, local: true }],
        })}
      />
    );
    await openWhere(user);
    await openSubmenu(user, 'workspace-bar-root-r-wt');
    const remove = await screen.findByTestId('workspace-bar-remove-primary-r-wt');
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    expect(remove).toHaveAccessibleDescription(RUN_IN_PROGRESS);
    // Reopening the folder changes no checkout and stays offered.
    expect(screen.getByTestId('workspace-bar-readd-r-wt')).not.toHaveAttribute('aria-disabled');
    await user.click(remove);
    expect(onRemovePrimary).not.toHaveBeenCalled();
  });

  it('shows why Use another folder… waits, and does nothing', async () => {
    const user = setup();
    const onUseFolder = vi.fn();
    render(
      <WorkspaceBar
        {...props({
          leaveWorktreeDisabledReason: RUN_IN_PROGRESS,
          onUseFolder,
          primaryRoot: { ...swiftBadger, removed: true },
          secondaryRoots: [{ ...brainstrike, local: true, removed: true }],
          workspaceFolders: [{ displayName: 'charlie', path: '/ws/charlie' }],
        })}
      />
    );
    await openWhere(user);
    await openSubmenu(user, 'workspace-bar-use-another-folder');
    const charlie = await screen.findByTestId('workspace-bar-use-folder-/ws/charlie');
    expect(charlie).toHaveAttribute('aria-disabled', 'true');
    expect(charlie).toHaveAccessibleDescription(RUN_IN_PROGRESS);
    await user.click(charlie);
    expect(onUseFolder).not.toHaveBeenCalled();
  });
});
