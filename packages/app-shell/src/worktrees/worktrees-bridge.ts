/**
 * The managed-worktree capability contract (spec §6.1).
 *
 * Web provides none, so the Mode chip is simply absent there — consumers
 * capability-check `useWorktreesBridge()` (`workspace-git-services.tsx`), never
 * `isElectron()`.
 */
import type {
  GitResult,
  ManagedWorktreePathEntry,
  ManagedWorktreeRow,
  WorktreeAdoptParams,
  WorktreeArchivePreview,
  WorktreeArchiveResult,
  WorktreeCheckoutStatus,
  WorktreeCreateContext,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeSettings,
} from '@brainstrike/types';

export interface WorktreesBridge {
  adopt: (params: WorktreeAdoptParams) => Promise<GitResult<ManagedWorktreeRow>>;
  archive: (params: {
    confirmIgnoredEntries?: string;
    force?: boolean;
    runId?: string;
    worktreeId: string;
  }) => Promise<GitResult<WorktreeArchiveResult>>;
  checkoutStatus: (params: { readonly path: string }) => Promise<GitResult<WorktreeCheckoutStatus>>;
  create: (params: WorktreeCreateParams) => Promise<GitResult<WorktreeCreateResult>>;
  createBranchHere: (params: {
    branch: string;
    worktreeId: string;
  }) => Promise<GitResult<ManagedWorktreeRow>>;
  createContext: (params: { rootId: string }) => Promise<GitResult<WorktreeCreateContext>>;
  getSettings: () => Promise<GitResult<WorktreeSettings>>;
  inspectArchive: (params: { worktreeId: string }) => Promise<GitResult<WorktreeArchivePreview>>;
  list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
  listManagedPaths: () => Promise<GitResult<readonly ManagedWorktreePathEntry[]>>;
  restore: (params: { worktreeId: string }) => Promise<GitResult<WorktreeCreateResult>>;
  setSettings: (params: {
    managedDirectory: string | null;
    setupCommand: WorktreeSettings['setupCommand'];
  }) => Promise<GitResult<WorktreeSettings>>;
}
