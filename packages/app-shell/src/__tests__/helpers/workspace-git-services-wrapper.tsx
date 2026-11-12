import type { ReactElement, ReactNode } from 'react';
import { vi } from 'vitest';
import type { ChangesBridge } from '../../changes/changes-bridge';
import type { GitBridge } from '../../git-bridge';
import {
  NO_WORKSPACE_GIT_SERVICES,
  type WorkspaceGitServices,
  WorkspaceGitServicesProvider,
} from '../../workspace-git-services';
import type { WorktreesBridge } from '../../worktrees/worktrees-bridge';

/**
 * A `render`/`renderHook` wrapper that provides `services`, as the desktop host
 * does; any bridge left out stays absent, as on web.
 */
export function workspaceGitWrapper(
  services: Partial<WorkspaceGitServices>
): (props: { readonly children?: ReactNode }) => ReactElement {
  const value: WorkspaceGitServices = { ...NO_WORKSPACE_GIT_SERVICES, ...services };
  return function WorkspaceGitWrapper({ children }: { readonly children?: ReactNode }) {
    return <WorkspaceGitServicesProvider services={value}>{children}</WorkspaceGitServicesProvider>;
  };
}

/** A Changes bridge whose methods are spies, with `overrides` replacing any. */
export function stubChangesBridge(overrides: Partial<ChangesBridge> = {}): ChangesBridge {
  return {
    apply: vi.fn(),
    commits: vi.fn(),
    fileDiff: vi.fn(),
    inventory: vi.fn(),
    onInvalidated: vi.fn(() => () => undefined),
    resolveView: vi.fn(),
    ...overrides,
  };
}

/** A Git bridge whose methods are spies, with `overrides` replacing any. */
export function stubGitBridge(overrides: Partial<GitBridge> = {}): GitBridge {
  return {
    commit: vi.fn(),
    createBranch: vi.fn(),
    fetch: vi.fn(),
    push: vi.fn(),
    repository: vi.fn(),
    status: vi.fn(),
    switchBranch: vi.fn(),
    ...overrides,
  };
}

/** A worktrees bridge whose methods are spies, with `overrides` replacing any. */
export function stubWorktreesBridge(overrides: Partial<WorktreesBridge> = {}): WorktreesBridge {
  return {
    adopt: vi.fn(),
    archive: vi.fn(),
    checkoutStatus: vi.fn(),
    create: vi.fn(),
    createBranchHere: vi.fn(),
    createContext: vi.fn(),
    getSettings: vi.fn(),
    inspectArchive: vi.fn(),
    list: vi.fn(),
    listArchived: vi.fn(),
    listManagedPaths: vi.fn(),
    restore: vi.fn(),
    setSettings: vi.fn(),
    ...overrides,
  };
}
