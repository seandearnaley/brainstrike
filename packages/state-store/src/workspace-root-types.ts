/** Durable workspace identity; the agent host's root registry is its only writer. */
export interface WorkspaceRootRecord {
  /** The folder's identity, pinned at grant. */
  readonly canonicalPath: string;
  readonly createdAt: number;
  readonly displayName: string;
  readonly id: string;
  /**
   * `worktree` for a managed worktree and `scratch` for a folder the host made for a thread sent
   * with no folder (ADR-0034): each is a thread's own folder, never an open folder.
   */
  readonly kind: 'path' | 'worktree' | 'scratch';
  readonly lastVerifiedAt: number;
  readonly path: string;
  /**
   * The project this folder belongs to (ADR-0034, owner decisions 2026-11-10): an id of its own,
   * which the folder keeps however its path is spelled and when the person picks it again
   * somewhere else. Null for a root recorded as a managed worktree, which is a checkout of its
   * repository, for a scratch folder, and for a folder recorded before projects existed that has
   * not been opened since.
   */
  readonly projectId: string | null;
  readonly status: 'live' | 'disconnected';
}

export type WorkspaceRootRequest =
  | { readonly operation: 'list' }
  /** The folders the person has open, in their order. A managed worktree is never open. */
  | { readonly operation: 'list-open' }
  /** The roots of the worktree ledger's unarchived worktrees: threads' checkouts (ADR-0034). */
  | { readonly operation: 'list-worktrees' }
  /**
   * Registering a root opens it: it keeps its place, or joins the end; a managed worktree is
   * registered but never opened. A recorded root whose
   * identity changed is refused, unless the person granted the folder afresh (`repin`).
   */
  | {
      readonly operation: 'register';
      readonly repin?: boolean;
      readonly root: {
        readonly canonicalPath: string;
        readonly displayName: string;
        readonly path: string;
        readonly preferredId: string;
      };
    }
  /**
   * ADR-0034: records a folder the host just made as the thread's scratch folder, with its root,
   * in one commit. Refused for a folder already recorded and for a thread that has one.
   */
  | {
      readonly operation: 'register-scratch';
      readonly root: {
        readonly canonicalPath: string;
        readonly displayName: string;
        readonly path: string;
        readonly preferredId: string;
      };
      readonly threadId: string;
    }
  /** Every scratch folder's root: each is mounted for its thread, never opened. */
  | { readonly operation: 'list-scratch' }
  /** The thread's scratch folder's root, if it has one. */
  | { readonly operation: 'scratch-of-thread'; readonly threadId: string }
  /** Deletes the thread's scratch folder's root and record together; answers what it deleted. */
  | { readonly operation: 'forget-scratch'; readonly threadId: string }
  | {
      readonly operation: 'disconnect-except';
      readonly mountedPaths: readonly string[];
      /** Folders the person closed: they leave the open list in the same transaction. */
      readonly closeRootIds?: readonly string[];
    };

export interface WorkspaceRootReply {
  readonly roots: readonly WorkspaceRootRecord[];
}

export interface WorkspaceRootPort {
  workspaceRoots(request: WorkspaceRootRequest): Promise<WorkspaceRootReply>;
}
