import { createContext, type ReactElement, type ReactNode, useContext } from 'react';
import type { ChangesBridge } from './changes/changes-bridge';
import type { GitBridge } from './git-panel/git-bridge';
import type { WorktreesBridge } from './worktrees/worktrees-bridge';

/**
 * The workspace git cluster — the Git panel, Changes and managed worktrees —
 * as the renderer reaches it. The desktop builds each from
 * its agent-host connection (ADR-0029); a host without one provides `null` and
 * every surface built on it is omitted, never stubbed.
 */
export interface WorkspaceGitServices {
  readonly changes: ChangesBridge | null;
  readonly git: GitBridge | null;
  readonly worktrees: WorktreesBridge | null;
}

/** No git cluster at all: web, and any tree rendered without a provider. */
export const NO_WORKSPACE_GIT_SERVICES: WorkspaceGitServices = {
  changes: null,
  git: null,
  worktrees: null,
};

const WorkspaceGitServicesContext = createContext<WorkspaceGitServices>(NO_WORKSPACE_GIT_SERVICES);

export interface WorkspaceGitServicesProviderProps {
  readonly children: ReactNode;
  readonly services: WorkspaceGitServices;
}

/** Mount once per visible host; pass a stable `services` object. */
export function WorkspaceGitServicesProvider({
  children,
  services,
}: WorkspaceGitServicesProviderProps): ReactElement {
  return (
    <WorkspaceGitServicesContext.Provider value={services}>
      {children}
    </WorkspaceGitServicesContext.Provider>
  );
}

export function useGitBridge(): GitBridge | null {
  return useContext(WorkspaceGitServicesContext).git;
}

export function useChangesBridge(): ChangesBridge | null {
  return useContext(WorkspaceGitServicesContext).changes;
}

export function useWorktreesBridge(): WorktreesBridge | null {
  return useContext(WorkspaceGitServicesContext).worktrees;
}
