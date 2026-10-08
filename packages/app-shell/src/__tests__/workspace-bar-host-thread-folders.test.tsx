import type {
  WorkspaceBarMode,
  WorkspaceBarProps,
  WorkspaceBarWorktreeOption,
} from '@brainstrike/assistant-ui';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseWorkspaceBarArgs } from '../hooks/use-workspace-bar';
import { WorkspaceBarHost } from '../workspace-bar/workspace-bar-host';

const { rendered, composed } = vi.hoisted(() => ({
  composed: { current: undefined as WorkspaceBarProps | undefined },
  rendered: { props: undefined as WorkspaceBarProps | undefined },
}));

vi.mock('@brainstrike/assistant-ui', () => ({
  WorkspaceBar: (props: WorkspaceBarProps): ReactElement => {
    rendered.props = props;
    return <div data-testid="bar" />;
  },
}));
vi.mock('../hooks/use-workspace-bar', () => ({
  useWorkspaceBar: (): WorkspaceBarProps => {
    if (!composed.current) {
      throw new Error('No composed bar for this test');
    }
    return composed.current;
  },
}));

const ARGS: UseWorkspaceBarArgs = {
  assistantThreadRepository: null,
  database: null,
  memoryResourceId: 'workspace-a',
  rootDescriptors: undefined,
  selectedMemoryThreadId: 'host-thread-1',
};
const REASON = 'This thread has no owner for its folder set.';
const noop = (): void => undefined;

const WORKTREE = {
  branch: 'feature/a',
  current: false,
  externalTool: null,
  managed: true,
  name: 'feature-a',
  path: '/ws/worktrees/feature-a',
  remedy: null,
  repositoryName: 'repo',
  worktreeId: 'worktree-1',
} as const;
const USABLE: WorkspaceBarWorktreeOption = { ...WORKTREE, disabledReason: null, usable: true };
const UNGRANTED: WorkspaceBarWorktreeOption = {
  ...WORKTREE,
  disabledReason: 'Codex owns this worktree; grant access to use it here.',
  externalTool: 'codex',
  managed: false,
  path: '/ws/repo/.codex/worktrees/b',
  remedy: 'grant-access',
  usable: false,
  worktreeId: null,
};

const resolved = async (): Promise<void> => undefined;

/** The Local-mode shape `useWorktreeMode` composes for a repository with no worktree. */
function localMode(): WorkspaceBarMode {
  return {
    archiveConfirmation: null,
    baseRefs: [{ label: 'Current branch', value: 'HEAD' }],
    createDisabledReason: null,
    defaultBranchPrefix: 'bs/',
    defaultName: 'repo-1',
    disabledReason: null,
    localPath: '/ws/repo',
    managedParentPath: '/ws/worktrees',
    onArchive: undefined,
    onCreate: resolved,
    onCreateBranchHere: undefined,
    onHandOffToLocal: undefined,
    onOpenCreateSheet: resolved,
    onOpenPicker: noop,
    onOpenTerminal: undefined,
    onReveal: undefined,
    pending: false,
    picker: {
      error: null,
      loading: false,
      onGrantAccess: noop,
      onOpenChange: noop,
      onSelect: noop,
      open: false,
      options: [USABLE, UNGRANTED],
    },
    repositorySetupConsent: null,
    setupSummary: 'No setup script',
    worktree: null,
  };
}

function composedBar(): WorkspaceBarProps {
  return {
    branchMenu: {
      onCreateBranch: noop,
      onFetch: undefined,
      onQueryChange: noop,
      onSwitch: noop,
      onSwitchInNewWorktree: noop,
      pending: false,
      query: '',
      rows: [
        { current: true, disabledReason: null, name: 'main', switchable: true, worktreeName: null },
      ],
      scopeReason: null,
    },
    mode: localMode(),
    onAddFolder: noop,
    onAddRecent: noop,
    onDropItems: noop,
    onMakePrimary: noop,
    onRemoveSecondary: noop,
    primaryRoot: { displayName: 'repo', path: '/ws/repo', rootId: 'root-1' },
    recentRoots: [{ displayName: 'other', path: '/ws/other' }],
    secondaryRoots: [],
  };
}

beforeEach(() => {
  composed.current = composedBar();
  rendered.props = undefined;
});

describe('WorkspaceBarHost thread folder ownership', () => {
  it('passes the composed bar through unchanged for a thread whose folder facts have an owner', () => {
    render(<WorkspaceBarHost {...ARGS} />);
    expect(rendered.props).toStrictEqual(composed.current);
  });

  it('disables every action that ends in a thread folder or checkout write, before its side effects', () => {
    render(<WorkspaceBarHost {...ARGS} threadFoldersUnavailableReason={REASON} />);
    const bar = rendered.props;
    if (!bar) {
      throw new Error('The bar did not render');
    }
    // Add folder and every Recent row render disabled with the reason.
    expect(bar.addFolderDisabledReason).toBe(REASON);
    // A drop would mount globally and then refuse the thread attach.
    expect(bar.onDropItems).toBeUndefined();
    expect('onDropItems' in bar).toBe(false);
    // The mode chip stays interactive; only its binding actions say why.
    expect(bar.mode?.disabledReason).toBeNull();
    expect(bar.mode?.createDisabledReason).toBe(REASON);
    expect(bar.mode?.picker.options).toEqual([
      { ...USABLE, disabledReason: REASON, usable: false },
      UNGRANTED,
    ]);
    // Granting folder access is the root registry's action and writes no thread fact.
    expect(bar.mode?.picker.onGrantAccess).toBe(noop);
    // "Switch in a new worktree" would create a worktree on disk first.
    expect(bar.branchMenu).toBeDefined();
    expect(bar.branchMenu && 'onSwitchInNewWorktree' in bar.branchMenu).toBe(false);
    expect(bar.branchMenu?.onSwitch).toBe(noop);
  });

  it('keeps the folder-owned orientation and actions', () => {
    const original = composedBar();
    composed.current = original;
    render(<WorkspaceBarHost {...ARGS} threadFoldersUnavailableReason={REASON} />);
    expect(rendered.props?.primaryRoot).toBe(original.primaryRoot);
    expect(rendered.props?.recentRoots).toBe(original.recentRoots);
    expect(rendered.props?.onAddFolder).toBe(original.onAddFolder);
  });

  it('treats an empty reason as present rather than silently dropping the gate', () => {
    render(<WorkspaceBarHost {...ARGS} threadFoldersUnavailableReason="" />);
    expect(rendered.props && 'onDropItems' in rendered.props).toBe(false);
    expect(rendered.props?.mode?.createDisabledReason).toBe('');
  });

  it('omits mode and branch menu when the composition has none', () => {
    const { branchMenu: _branchMenu, mode: _mode, ...bare } = composedBar();
    composed.current = bare;
    render(<WorkspaceBarHost {...ARGS} threadFoldersUnavailableReason={REASON} />);
    expect(rendered.props && 'mode' in rendered.props).toBe(false);
    expect(rendered.props && 'branchMenu' in rendered.props).toBe(false);
    expect(rendered.props?.addFolderDisabledReason).toBe(REASON);
  });
});
