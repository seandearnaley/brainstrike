import { Schema } from 'effect';

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
 * desktop's private clients reach these methods.
 */
export const WORKSPACE_ROOTS_METHOD_SCHEMAS = {
  /**
   * Folder grant without the picker: the path must be a folder this app recorded, a recent
   * folder or a managed worktree. A recorded scratch folder mounts as its thread's (ADR-0034).
   */
  'workspace/roots/add': Schema.Struct({ path: AbsolutePath }),
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
  'workspace/roots/add': OpenRootSchema,
  'workspace/roots/open': Schema.Struct({ root: Schema.NullOr(OpenRootSchema) }),
  'workspace/roots/pick': Schema.Struct({ root: Schema.NullOr(OpenRootSchema) }),
  'workspace/roots/recent': Schema.Struct({ roots: Schema.Array(RecentRootSchema) }),
  'workspace/roots/remove': Schema.Null,
  'workspace/roots/restore': Schema.Struct({ roots: Schema.Array(OpenRootSchema) }),
  'workspace/roots/seed-for-e2e': Schema.Null,
} as const;
