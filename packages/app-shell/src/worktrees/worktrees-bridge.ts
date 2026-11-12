/**
 * The managed-worktree capability contract (spec §6.1).
 *
 * Web provides none, so the where-control has no checkout rows there — consumers
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
  WorktreeRepositorySetupDecision,
  WorktreeSettings,
  WorktreeSetupConsent,
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
  /**
   * The person's Allow or Skip for the root's repository setup script, at the
   * hash they were shown; the host refuses it when the script changed since.
   * Only a person's answer calls it.
   */
  decideSetupConsent: (params: {
    decision: WorktreeRepositorySetupDecision;
    rootId: string;
    scriptSha256: string;
  }) => Promise<BoundaryResult<WorktreeSetupConsent>>;
  getSettings: () => Promise<BoundaryResult<WorktreeSettings>>;
  inspectArchive: (params: {
    worktreeId: string;
  }) => Promise<BoundaryResult<WorktreeArchivePreview>>;
  list: () => Promise<BoundaryResult<readonly WorktreeListEntry[]>>;
  listManagedPaths: () => Promise<BoundaryResult<readonly ManagedWorktreePathEntry[]>>;
  /** Every repository's standing setup script answer, for Settings › Workspace. */
  listSetupConsent: () => Promise<BoundaryResult<readonly WorktreeSetupConsent[]>>;
  restore: (params: { worktreeId: string }) => Promise<BoundaryResult<WorktreeCreateResult>>;
  revokeSetupConsent: (params: {
    repositoryId: string;
  }) => Promise<BoundaryResult<{ readonly revoked: boolean }>>;
  setSettings: (params: {
    managedDirectory: string | null;
    setupCommand: WorktreeSettings['setupCommand'];
  }) => Promise<BoundaryResult<WorktreeSettings>>;
}
