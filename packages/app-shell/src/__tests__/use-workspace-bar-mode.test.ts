import type { AssistantMemoryThread } from '@brainstrike/assistant-data';
import type { WorkspaceBarMode } from '@brainstrike/assistant-ui';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { branchSwitcherSpy, toastSpy, worktreeModeSpy } = vi.hoisted(() => ({
  branchSwitcherSpy: vi.fn(),
  toastSpy: vi.fn(),
  worktreeModeSpy: vi.fn(),
}));

vi.mock('../hooks/use-branch-switcher', () => ({ useBranchSwitcher: branchSwitcherSpy }));
vi.mock('../hooks/use-worktree-mode', () => ({ useWorktreeMode: worktreeModeSpy }));
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  toast: toastSpy,
}));

import { useWorkspaceBarMode } from '../hooks/use-workspace-bar-mode';

const mode = (overrides: Partial<WorkspaceBarMode> = {}): WorkspaceBarMode => ({
  baseRefs: [{ label: 'Current branch', value: 'HEAD' }],
  createDisabledReason: null,
  defaultBranchPrefix: 'bs/',
  defaultName: 'bright-fox',
  disabledReason: null,
  localPath: '/work/app',
  managedParentPath: '/managed/app-slug',
  onArchive: undefined,
  onCreate: vi.fn(() => Promise.resolve()),
  onCreateBranchHere: undefined,
  onHandOffToLocal: undefined,
  onOpenCreateSheet: vi.fn(() => Promise.resolve()),
  onOpenPicker: vi.fn(),
  onReveal: undefined,
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
  setupSummary: '',
  worktree: null,
  ...overrides,
});

const thread = {
  createdAt: new Date('2026-08-25T00:00:00.000Z'),
  id: 'thread-1',
  metadata: {},
  resourceId: 'workspace-1',
  title: 'Thread',
  updatedAt: new Date('2026-08-25T00:00:00.000Z'),
} satisfies AssistantMemoryThread;

function renderComposition() {
  return renderHook(() =>
    useWorkspaceBarMode({
      assistantThreadRepository: {} as never,
      checkout: { ahead: 0, behind: 0, branch: 'main', dirty: true },
      memoryResourceId: 'workspace-1',
      primaryRootId: 'r-1',
      primaryRootPath: '/work/app',
      selectedMemoryThreadId: 'thread-1',
      selectedThread: thread,
      updateThreadMetadata: vi.fn(),
    })
  );
}

describe('useWorkspaceBarMode branch escape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    branchSwitcherSpy.mockReturnValue(undefined);
  });

  it('supplies the escape only when creation is enabled and toasts a rejection', async () => {
    const onCreate = vi.fn(() => Promise.reject(new Error('bridge create failed')));
    worktreeModeSpy.mockReturnValue(mode({ onCreate }));
    renderComposition();
    const branchEscape = branchSwitcherSpy.mock.calls.at(-1)?.[0]?.onSwitchInNewWorktree;
    expect(branchEscape).toEqual(expect.any(Function));

    act(() => branchEscape?.('feature/alpha'));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith({
        description: 'bridge create failed',
        title: 'Switch in a new worktree failed',
        variant: 'destructive',
      })
    );
    expect(onCreate).toHaveBeenCalledWith({
      baseRef: 'feature/alpha',
      branch: { detached: true },
      name: 'feature-alpha',
    });
  });

  it('omits the escape capability when creation has a disabled reason', () => {
    worktreeModeSpy.mockReturnValue(
      mode({ createDisabledReason: 'Create a worktree before sending the first request.' })
    );
    renderComposition();

    expect(branchSwitcherSpy.mock.calls.at(-1)?.[0]?.onSwitchInNewWorktree).toBeUndefined();
  });
});
