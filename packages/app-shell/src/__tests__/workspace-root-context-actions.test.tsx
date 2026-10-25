import type { ContextTarget } from '@brainstrike/context-actions';
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceRootActions } from '../workspace-root-context-actions';
import { TerminalHost as wrapper } from './helpers/workspace-terminal-services-wrapper';

const { createThreadInFolderMock, openTerminalAtMock, useCreateThreadInFolderMock } = vi.hoisted(
  () => ({
    createThreadInFolderMock: vi.fn(),
    openTerminalAtMock: vi.fn(),
    useCreateThreadInFolderMock: vi.fn(),
  })
);

vi.mock('../stores/terminal-target-store', () => ({
  useTerminalTargetStore: { getState: () => ({ openTerminalAt: openTerminalAtMock }) },
}));

vi.mock('../hooks/use-create-thread-in-folder', () => ({
  useCreateThreadInFolder: useCreateThreadInFolderMock,
}));

const desktopRoot: ContextTarget = {
  displayName: 'brainstrike',
  isMain: true,
  kind: 'workspace-root',
  path: '/Users/dev/GitHub/brainstrike',
  rootId: 'root-1',
};

const webRoot: ContextTarget = {
  displayName: 'notes',
  isMain: false,
  kind: 'workspace-root',
  path: null,
  rootId: 'root-web-1',
};

describe('useWorkspaceRootActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCreateThreadInFolderMock.mockReturnValue(createThreadInFolderMock);
  });

  it('opens the terminal at the root itself — cwd IS the root path', async () => {
    const [openTerminal] = renderHook(() => useWorkspaceRootActions(), { wrapper }).result.current;

    await openTerminal?.run(desktopRoot, {});

    expect(openTerminalAtMock).toHaveBeenCalledExactlyOnceWith({
      cwd: '/Users/dev/GitHub/brainstrike',
      rootId: 'root-1',
    });
    expect(createThreadInFolderMock).not.toHaveBeenCalled();
  });

  it('omits Open in Terminal entirely when the terminal bridge is absent', () => {
    // No provider: the tree has no terminal bridge, as on web.
    expect(
      renderHook(() => useWorkspaceRootActions()).result.current.map((action) => action.id)
    ).toEqual(['workspace-root.new-thread-here']);
  });

  it('hides Open in Terminal for a pathless root', () => {
    const [openTerminal] = renderHook(() => useWorkspaceRootActions(), { wrapper }).result.current;

    expect(openTerminal?.isVisible?.(webRoot)).toBe(false);
    expect(openTerminal?.isVisible?.(desktopRoot)).toBe(true);
  });

  it('starts a thread bound to the root and opens no terminal', async () => {
    const newThread = renderHook(() => useWorkspaceRootActions(), { wrapper }).result.current[1];

    await newThread?.run(desktopRoot, {});

    expect(createThreadInFolderMock).toHaveBeenCalledExactlyOnceWith({
      displayName: 'brainstrike',
      path: '/Users/dev/GitHub/brainstrike',
      rootId: 'root-1',
    });
    expect(openTerminalAtMock).not.toHaveBeenCalled();
  });

  it('starts a thread for a pathless root, passing path: null explicitly', async () => {
    const newThread = renderHook(() => useWorkspaceRootActions(), { wrapper }).result.current[1];

    await newThread?.run(webRoot, {});

    expect(createThreadInFolderMock).toHaveBeenCalledExactlyOnceWith({
      displayName: 'notes',
      path: null,
      rootId: 'root-web-1',
    });
  });

  it('omits New thread here while the thread repository is unresolved', () => {
    useCreateThreadInFolderMock.mockReturnValueOnce(null);

    expect(
      renderHook(() => useWorkspaceRootActions(), { wrapper }).result.current.map(
        (action) => action.id
      )
    ).toEqual(['workspace-root.open-in-terminal']);
  });
});
