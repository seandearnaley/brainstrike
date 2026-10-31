/**
 * The managed-worktree capability contract (spec §6.1).
 *
 * Web provides none, so the Mode chip is simply absent there — consumers
 * capability-check `useWorktreesBridge()` (`workspace-git-services.tsx`), never
 * `isElectron()`.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type {
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
  adopt: (params: WorktreeAdoptParams) => Promise<BoundaryResult<ManagedWorktreeRow>>;
  archive: (params: {
    confirmIgnoredEntries?: string;
    force?: boolean;
    runId?: string;
    worktreeId: string;
  }) => Promise<BoundaryResult<WorktreeArchiveResult>>;
  checkoutStatus: (params: {
    readonly path: string;
  }) => Promise<BoundaryResult<WorktreeCheckoutStatus>>;
  create: (params: WorktreeCreateParams) => Promise<BoundaryResult<WorktreeCreateResult>>;
  createBranchHere: (params: {
    branch: string;
    worktreeId: string;
  }) => Promise<BoundaryResult<ManagedWorktreeRow>>;
  createContext: (params: { rootId: string }) => Promise<BoundaryResult<WorktreeCreateContext>>;
  getSettings: () => Promise<BoundaryResult<WorktreeSettings>>;
  inspectArchive: (params: {
    worktreeId: string;
  }) => Promise<BoundaryResult<WorktreeArchivePreview>>;
  list: () => Promise<BoundaryResult<readonly WorktreeListEntry[]>>;
  listManagedPaths: () => Promise<BoundaryResult<readonly ManagedWorktreePathEntry[]>>;
  restore: (params: { worktreeId: string }) => Promise<BoundaryResult<WorktreeCreateResult>>;
  setSettings: (params: {
    managedDirectory: string | null;
    setupCommand: WorktreeSettings['setupCommand'];
  }) => Promise<BoundaryResult<WorktreeSettings>>;
}
