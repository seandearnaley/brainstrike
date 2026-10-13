/** Durable workspace identity; Main remains the sole mount/grant authority. */
export interface WorkspaceRootRecord {
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
  | { readonly operation: 'delete'; readonly rootId: string; readonly paths: readonly string[] }
  | {
      readonly operation: 'register';
      readonly root: {
        readonly displayName: string;
        readonly path: string;
        readonly preferredId: string;
      };
    }
  | { readonly operation: 'disconnect-except'; readonly mountedPaths: readonly string[] };

export interface WorkspaceRootReply {
  readonly roots: readonly WorkspaceRootRecord[];
}

export interface WorkspaceRootPort {
  workspaceRoots(request: WorkspaceRootRequest): Promise<WorkspaceRootReply>;
}
