import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
/** Root-relative POSIX path: no leading slash, no empty, `.` or `..` segment. */
export const WorkspaceRelativePath = Schema.String.check(Schema.isMinCodePoints(1)).check(
  Schema.makeFilter((value) =>
    !value.startsWith('/') &&
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
      ? undefined
      : { issue: 'Expected a normalized root-relative path', path: [] }
  )
);
export const HOST_WORKSPACE_EDIT_OPS = ['write', 'string_replace', 'delete', 'rename'] as const;
export const HostWorkspaceEditOpSchema = Schema.Literals(HOST_WORKSPACE_EDIT_OPS);
export type HostEditOp = (typeof HOST_WORKSPACE_EDIT_OPS)[number];
/** A file's observed identity; content is never part of the client-visible event. */
export const HostFileIdentitySchema = Schema.Struct({
  existed: Schema.Boolean,
  hash: Schema.NullOr(Sha256),
  size: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
/**
 * A path's state before the run first changed it. Content lives in a
 * content-addressed StateStore blob that this event references (`blobRefs`).
 */
export const HostEditBaselineSchema = Schema.Union(
  [
    Schema.Struct({ kind: Schema.Literal('absent'), path: WorkspaceRelativePath }),
    Schema.Struct({
      blob: Sha256,
      bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      encoding: Schema.Literals(['utf8', 'base64']),
      hash: Sha256,
      kind: Schema.Literal('content'),
      mode: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      path: WorkspaceRelativePath,
    }),
    Schema.Struct({
      kind: Schema.Literal('unavailable'),
      path: WorkspaceRelativePath,
      reason: Schema.Literals(['too_large', 'symlink', 'not_a_file']),
    }),
  ],
  { mode: 'oneOf' }
);
export type HostEditBaseline = (typeof HostEditBaselineSchema)['Type'];
export const HostEditRevertOutcomeSchema = Schema.Union(
  [
    Schema.Struct({ entryId: Id, status: Schema.Literal('reverted') }),
    Schema.Struct({
      entryId: Id,
      reason: Schema.String.check(Schema.isMinCodePoints(1)),
      status: Schema.Literals(['conflict', 'not_revertible']),
    }),
  ],
  { mode: 'oneOf' }
);
export type HostEditRevertOutcome = (typeof HostEditRevertOutcomeSchema)['Type'];
/** A workspace root as a turn's snapshot names it: its durable ID and absolute path. */
export const HostTurnSnapshotRootSchema = Schema.Struct({
  rootId: Id,
  rootPath: Schema.String.check(Schema.isMinCodePoints(1)),
});
export type HostTurnSnapshotRoot = (typeof HostTurnSnapshotRootSchema)['Type'];
/**
 * One root's snapshot at a turn boundary: the platform's snapshot commit. The
 * null object ID records a capture that failed for this root, so the turn's
 * Changes review fails visibly rather than showing part of its changes.
 */
export const HostTurnSnapshotSchema = Schema.Struct({
  ...HostTurnSnapshotRootSchema.fields,
  commitOid: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
});
export type HostTurnSnapshot = (typeof HostTurnSnapshotSchema)['Type'];
/** A path whose files changed after a rewind's preview (or, for a redo, after the rewind). */
export const HostRewindConflictSchema = Schema.Struct({ path: WorkspaceRelativePath, rootId: Id });
export type HostRewindConflict = (typeof HostRewindConflictSchema)['Type'];
/** One path's restore in a rewind or redo; a conflict or failure leaves it untouched. */
export const HostRewindFileOutcomeSchema = Schema.Union(
  [
    Schema.Struct({
      path: WorkspaceRelativePath,
      rootId: Id,
      status: Schema.Literals(['restored', 'deleted', 'skipped-nested-repo']),
    }),
    Schema.Struct({
      detail: Schema.String.check(Schema.isMinCodePoints(1)),
      path: WorkspaceRelativePath,
      rootId: Id,
      status: Schema.Literals(['conflict', 'failed']),
    }),
  ],
  { mode: 'oneOf' }
);
export type HostRewindFileOutcome = (typeof HostRewindFileOutcomeSchema)['Type'];
