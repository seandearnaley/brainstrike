/** Durable workspace identity; the agent host's root registry is its only writer. */
export interface WorkspaceRootRecord {
  /** The folder's identity, pinned at grant. */
  readonly canonicalPath: string;
  readonly createdAt: number;
  readonly displayName: string;
  readonly id: string;
  readonly kind: 'path' | 'worktree';
  readonly lastVerifiedAt: number;
  readonly path: string;
  readonly status: 'live' | 'disconnected';
}

export type WorkspaceRootRequest =
  | { readonly operation: 'list' }
  /** The folders the person has open, in their order. A managed worktree is never open. */
  | { readonly operation: 'list-open' }
  /** The roots of the worktree ledger's unarchived worktrees: threads' checkouts (ADR-0034). */
  | { readonly operation: 'list-worktrees' }
  | { readonly operation: 'delete'; readonly rootId: string; readonly paths: readonly string[] }
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
