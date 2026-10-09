/**
 * Workspace file identities on the host protocol: edit baselines and their
 * revert outcomes, turn snapshots, and a rewind's per-path conflicts and
 * restores. protocol.ts re-exports every name here.
 */
import { z } from 'zod';

const Id = z.string().min(1);
export const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
/** Root-relative POSIX path: no leading slash, no empty, `.` or `..` segment. */
export const WorkspaceRelativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Expected a normalized root-relative path'
  );
export const HOST_WORKSPACE_EDIT_OPS = ['write', 'string_replace', 'delete', 'rename'] as const;
export const HostWorkspaceEditOpSchema = z.enum(HOST_WORKSPACE_EDIT_OPS);
export type HostEditOp = (typeof HOST_WORKSPACE_EDIT_OPS)[number];
/** A file's observed identity; content is never part of the client-visible event. */
export const HostFileIdentitySchema = z.strictObject({
  existed: z.boolean(),
  hash: Sha256.nullable(),
  size: z.number().int().nonnegative().nullable(),
});
/**
 * A path's state before the run first changed it. Content lives in a
 * content-addressed StateStore blob that this event references (`blobRefs`).
 */
export const HostEditBaselineSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent'), path: WorkspaceRelativePath }),
  z.strictObject({
    blob: Sha256,
    bytes: z.number().int().nonnegative(),
    encoding: z.enum(['utf8', 'base64']),
    hash: Sha256,
    kind: z.literal('content'),
    mode: z.number().int().nonnegative(),
    path: WorkspaceRelativePath,
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    path: WorkspaceRelativePath,
    reason: z.enum(['too_large', 'symlink', 'not_a_file']),
  }),
]);
export type HostEditBaseline = z.infer<typeof HostEditBaselineSchema>;
export const HostEditRevertOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({ entryId: Id, status: z.literal('reverted') }),
  z.strictObject({
    entryId: Id,
    reason: z.string().min(1),
    status: z.enum(['conflict', 'not_revertible']),
  }),
]);
export type HostEditRevertOutcome = z.infer<typeof HostEditRevertOutcomeSchema>;
/** A workspace root as a turn's snapshot names it: its durable ID and absolute path. */
export const HostTurnSnapshotRootSchema = z.strictObject({
  rootId: Id,
  rootPath: z.string().min(1),
});
export type HostTurnSnapshotRoot = z.infer<typeof HostTurnSnapshotRootSchema>;
/**
 * One root's snapshot at a turn boundary: the platform's snapshot commit. The
 * null object ID records a capture that failed for this root, so the turn's
 * Changes review fails visibly rather than showing part of its changes.
 */
export const HostTurnSnapshotSchema = z.strictObject({
  ...HostTurnSnapshotRootSchema.shape,
  commitOid: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type HostTurnSnapshot = z.infer<typeof HostTurnSnapshotSchema>;
/** A path whose files changed after a rewind's preview (or, for a redo, after the rewind). */
export const HostRewindConflictSchema = z.strictObject({
  path: WorkspaceRelativePath,
  rootId: Id,
});
export type HostRewindConflict = z.infer<typeof HostRewindConflictSchema>;
/** One path's restore in a rewind or redo; a conflict or failure leaves it untouched. */
export const HostRewindFileOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    path: WorkspaceRelativePath,
    rootId: Id,
    status: z.enum(['restored', 'deleted', 'skipped-nested-repo']),
  }),
  z.strictObject({
    detail: z.string().min(1),
    path: WorkspaceRelativePath,
    rootId: Id,
    status: z.enum(['conflict', 'failed']),
  }),
]);
export type HostRewindFileOutcome = z.infer<typeof HostRewindFileOutcomeSchema>;
