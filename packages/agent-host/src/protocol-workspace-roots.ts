import { Schema } from 'effect';
import {
  PROJECT_MEMORY_PANEL_METHOD_SCHEMAS,
  PROJECT_MEMORY_PANEL_RESULT_SCHEMAS,
} from './protocol-project-memory.ts';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const AbsolutePath = Schema.String.check(Schema.isMinCodePoints(1));
const NoParams = Schema.Record(Schema.String, Schema.Never);

/**
 * A mounted folder: `available` is false while it cannot be mounted (an unplugged drive).
 * `worktree` marks a managed worktree, a thread's checkout that is never an open folder, and
 * `scratch` a scratch folder, which the host made for a thread sent with no folder and is never
 * an open folder either (ADR-0034).
 */
const OpenRootSchema = Schema.Struct({
  available: Schema.Boolean,
  path: AbsolutePath,
  rootId: Id,
  scratch: Schema.Boolean,
  worktree: Schema.Boolean,
});
export type HostOpenRoot = (typeof OpenRootSchema)['Type'];

/** One folder the person granted this app; it may reopen without the picker. */
const RecentRootSchema = Schema.Struct({
  displayName: Schema.String,
  lastGrantedAt: Schema.Finite,
  path: AbsolutePath,
});

/**
 * ADR-0029 stage 4: the folders open in the desktop's workspace, owned by the
 * agent host. The host's root registry is the one writer of the root records,
 * their open order and the recent-folders ledger; Main keeps only the folder
 * picker, which the host asks for (`platform/workspace/pick-folder`). Only the
 * desktop's private clients reach these methods. The registry also writes the
 * projects the folders belong to (ADR-0034), through the same store domain.
 */
export const WORKSPACE_ROOTS_METHOD_SCHEMAS = {
  /** ADR-0040: a project's Memory panel (BST-2534). */
  ...PROJECT_MEMORY_PANEL_METHOD_SCHEMAS,
  /**
   * ADR-0034: the person moves the folder of `rootId` into the project `projectId`, so its
   * threads list with that project's. The project it leaves is deleted once no folder is in it.
   * Nothing joins by a remote URL or a commit, and the folder's trust and approved hooks stay its
   * own. Refused for a managed worktree or a scratch folder, and for an unknown folder or project.
   * A repository found inside an open folder has no root (BST-2511), so it is named by
   * `repositoryPath`, its own checkout's path as `worktrees/list` names it; with no project yet it
   * joins the chosen one directly (BST-2520).
   */
  'projects/join': Schema.Union([
    Schema.Struct({ projectId: Id, rootId: Id }),
    Schema.Struct({ projectId: Id, repositoryPath: AbsolutePath }),
  ]),
  /**
   * ADR-0034: names a project. The name is trimmed and an empty one clears it, so the project is
   * named by its folder again. Refused for a name over 80 characters and an unknown project. A
   * repository found inside an open folder is named by `repositoryPath`, as for a join, and its
   * first name makes its project (BST-2520). A path inside a `.git` folder, a scratch folder or a
   * managed worktree is refused.
   */
  'projects/rename': Schema.Union([
    Schema.Struct({ name: Schema.String, projectId: Id }),
    Schema.Struct({ name: Schema.String, repositoryPath: AbsolutePath }),
  ]),
  /**
   * Folder grant without the picker: the path must be a folder this app recorded, a recent
   * folder or a managed worktree. A recorded scratch folder mounts as its thread's (ADR-0034).
   */
  'workspace/roots/add': Schema.Struct({ path: AbsolutePath }),
  /**
   * ADR-0034 relink: a recorded folder that is no longer where it was is pointed, through the
   * native picker, at the folder the person chooses. The record keeps its id, so its threads and
   * project follow it; its trust is asked again at the new place, as any folder's is. Refused for
   * a managed worktree or a scratch folder, for a folder still at its recorded place, and for a
   * folder recorded under another id. `root` is null when the person cancelled the picker.
   */
  'workspace/roots/locate': Schema.Struct({ rootId: Id }),
  /**
   * Opens a folder as the window's project (ADR-0034): with `path`, a folder granted before
   * (Recents), else through the native picker. Every other open folder closes; one a running
   * thread works in stays mounted, closed, so the run keeps working. A managed worktree is
   * refused: it is a thread's checkout. `root` is null when the person cancelled the picker.
   */
  'workspace/roots/open': Schema.Struct({ path: Schema.optional(AbsolutePath) }),
  /** Folder grant through the native picker; `root` is null when the person cancelled. */
  'workspace/roots/pick': NoParams,
  'workspace/roots/recent': NoParams,
  /** Closes the folder; its record keeps its identity for a later re-add. */
  'workspace/roots/remove': Schema.Struct({ rootId: Id }),
  /**
   * Mounts the open folders again and answers them in their order, then the managed worktrees
   * and scratch folders, each mounted for its thread and never open (ADR-0034).
   */
  'workspace/roots/restore': NoParams,
  /** E2E only: replaces the open folders (with their ids) and the recent-folders ledger. */
  'workspace/roots/seed-for-e2e': Schema.Struct({
    recentPaths: Schema.Array(AbsolutePath),
    roots: Schema.Array(Schema.Struct({ path: AbsolutePath, rootId: Id })),
  }),
} as const;
export const WORKSPACE_ROOTS_RESULT_SCHEMAS = {
  ...PROJECT_MEMORY_PANEL_RESULT_SCHEMAS,
  'projects/join': Schema.Null,
  'projects/rename': Schema.Null,
  'workspace/roots/add': OpenRootSchema,
  'workspace/roots/locate': Schema.Struct({ root: Schema.NullOr(OpenRootSchema) }),
  'workspace/roots/open': Schema.Struct({ root: Schema.NullOr(OpenRootSchema) }),
  'workspace/roots/pick': Schema.Struct({ root: Schema.NullOr(OpenRootSchema) }),
  'workspace/roots/recent': Schema.Struct({ roots: Schema.Array(RecentRootSchema) }),
  'workspace/roots/remove': Schema.Null,
  'workspace/roots/restore': Schema.Struct({ roots: Schema.Array(OpenRootSchema) }),
  'workspace/roots/seed-for-e2e': Schema.Null,
} as const;
