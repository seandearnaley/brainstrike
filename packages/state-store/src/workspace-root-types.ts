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
  /** The name the person gave the project (ADR-0034); null while it has none, or no project. */
  readonly projectName: string | null;
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
  /**
   * ADR-0034: the scratch folder `rootId`, which the host has moved to `root`, becomes a folder of
   * the person's there, in one commit: same id, kind `path`, open at the end of the open folders,
   * its scratch record deleted and its project given as `register` gives one. Refused for a root
   * the store does not have, one that is not a scratch folder, and a place another record has.
   */
  | {
      readonly operation: 'scratch-to-project';
      readonly root: {
        readonly canonicalPath: string;
        readonly displayName: string;
        readonly path: string;
      };
      readonly rootId: string;
    }
  /**
   * ADR-0034: names the project, trimmed; an empty name clears it. Refused for a name longer
   * than `PROJECT_NAME_MAX_LENGTH` characters and for a project the store does not have. Answers
   * the roots of the project's folders.
   */
  | { readonly operation: 'rename-project'; readonly name: string; readonly projectId: string }
  /**
   * ADR-0034 build decisions (BST-2520): names the project of a repository found inside an open
   * folder, which has no root, by its own checkout's canonical path. Its first name makes the
   * project, in the same commit; an empty name with no project yet writes nothing. Refused for
   * an empty or relative path, one inside a `.git` folder (a submodule as git names it), and one
   * inside a scratch folder or a managed worktree.
   */
  | {
      readonly canonicalPath: string;
      readonly name: string;
      readonly operation: 'rename-project';
    }
  /**
   * ADR-0034: joins the folder of the root to the project, as the person asked, and deletes the
   * project it leaves once no folder is in it. Writes no trust or hook approval. Refused for an
   * unknown root or project, and for a managed worktree or a scratch folder. Answers the root.
   */
  | { readonly operation: 'join-project'; readonly projectId: string; readonly rootId: string }
  /**
   * ADR-0034 build decisions (BST-2511, BST-2520): the same join for a repository found inside an
   * open folder, which has no root of its own, named by its own checkout's canonical path. With no
   * project yet, its folder row is made in the chosen project, in the same commit. Refused for the
   * paths `rename-project` refuses by path. Answers the roots recorded at that path, if any.
   */
  | {
      readonly canonicalPath: string;
      readonly operation: 'join-project';
      readonly projectId: string;
    }
  /**
   * ADR-0034 build decisions (BST-2520): the projects kept for these canonical paths, for the
   * repositories the host's worktree listing found. A read: it never makes a project.
   */
  | { readonly canonicalPaths: readonly string[]; readonly operation: 'repository-projects' }
  | {
      readonly operation: 'disconnect-except';
      readonly mountedPaths: readonly string[];
      /** Folders the person closed: they leave the open list in the same transaction. */
      readonly closeRootIds?: readonly string[];
    };

/**
 * The project kept for a repository's checkout (ADR-0034): the folder's canonical path, the
 * project's id, and the name the person gave it.
 */
export interface WorkspaceRepositoryProject {
  readonly canonicalPath: string;
  readonly id: string;
  /** Null while the person has given it none. */
  readonly name: string | null;
}

export interface WorkspaceRootReply {
  /**
   * `join-project` answers the project it deleted when the folder it moved was that project's
   * last (ADR-0040: the host then removes that project's memory); no other request does.
   */
  readonly deletedProjectIds?: readonly string[];
  /** `repository-projects` answers the projects it found here; no other request does. */
  readonly projects?: readonly WorkspaceRepositoryProject[];
  readonly roots: readonly WorkspaceRootRecord[];
}

export interface WorkspaceRootPort {
  workspaceRoots(request: WorkspaceRootRequest): Promise<WorkspaceRootReply>;
}
