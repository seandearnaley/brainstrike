import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const AbsolutePath = Schema.String.check(Schema.isMinCodePoints(1));
const NoParams = Schema.Record(Schema.String, Schema.Never);

/**
 * A mounted folder: `available` is false while it cannot be mounted (an unplugged drive).
 * `worktree` marks a managed worktree, a thread's checkout that is never an open folder
 * (ADR-0034).
 */
const OpenRootSchema = Schema.Struct({
  available: Schema.Boolean,
  path: AbsolutePath,
  rootId: Id,
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
  /** Folder grant without the picker: the path must be a recent folder or a managed worktree. */
  'workspace/roots/add': Schema.Struct({ path: AbsolutePath }),
  /**
   * Deletes one open folder's canonical data and closes it. Refused before anything is removed
   * while the store is read-only, the folder is not mounted, or another change holds the
   * folders; the folder is fenced from every host read, watch and run until the deletion ends.
   */
  'workspace/roots/delete-data': Schema.Struct({ rootId: Id }),
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
  /** Mounts the open folders again and answers them in their order. */
  'workspace/roots/restore': NoParams,
  /** E2E only: replaces the open folders (with their ids) and the recent-folders ledger. */
  'workspace/roots/seed-for-e2e': Schema.Struct({
    recentPaths: Schema.Array(AbsolutePath),
    roots: Schema.Array(Schema.Struct({ path: AbsolutePath, rootId: Id })),
  }),
} as const;
export const WORKSPACE_ROOTS_RESULT_SCHEMAS = {
  'workspace/roots/add': OpenRootSchema,
  'workspace/roots/delete-data': Schema.Null,
  'workspace/roots/open': Schema.Struct({ root: Schema.NullOr(OpenRootSchema) }),
  'workspace/roots/pick': Schema.Struct({ root: Schema.NullOr(OpenRootSchema) }),
  'workspace/roots/recent': Schema.Struct({ roots: Schema.Array(RecentRootSchema) }),
  'workspace/roots/remove': Schema.Null,
  'workspace/roots/restore': Schema.Struct({ roots: Schema.Array(OpenRootSchema) }),
  'workspace/roots/seed-for-e2e': Schema.Null,
} as const;
