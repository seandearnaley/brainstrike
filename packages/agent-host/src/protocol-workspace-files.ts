import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const AbsolutePath = Schema.String.check(Schema.isMinCodePoints(1));
const Text = Schema.String;

const FileSystemChangeSchema = Schema.Struct({
  kind: Schema.Literals(['file', 'directory']),
  path: Text,
  type: Schema.Literals(['added', 'removed', 'modified']),
});
const WatcherHealthSchema = {
  backend: Schema.Literals(['fs-events', 'inotify', 'windows']),
  failure: Schema.optionalKey(
    Schema.Struct({
      code: Text,
      message: Text,
      retryable: Schema.Boolean,
      terminal: Schema.Boolean,
    })
  ),
  state: Schema.Literals(['starting', 'healthy', 'degraded', 'failed', 'stopped']),
  timestamp: Schema.Finite,
};

/**
 * One watched root's change batch or health transition, pushed only to the
 * connection that asked for the watch. A change batch may name the bounded
 * root-relative default-filter boundaries whose detailed records it withheld.
 */
export const WORKSPACE_FILES_EVENT = 'workspace/files/event';
export const WorkspaceFilesEventSchema = Schema.Union(
  [
    Schema.Struct({
      changes: Schema.mutable(Schema.Array(FileSystemChangeSchema)),
      filteredChangeBoundaries: Schema.optionalKey(Schema.Array(Text)),
      filteredChangeBoundariesOverflow: Schema.optionalKey(Schema.Literal(true)),
      type: Schema.Literal('changes'),
      watchId: Id,
    }),
    Schema.Struct({ ...WatcherHealthSchema, type: Schema.Literal('health'), watchId: Id }),
  ],
  { mode: 'oneOf' }
);
export type WorkspaceFilesEvent = (typeof WorkspaceFilesEventSchema)['Type'];

/**
 * ADR-0029 stage 4: the Explorer's recursive watch on a live workspace root,
 * served by the host. Only the desktop's private clients reach it, and a
 * connection's watches end when it closes.
 */
export const WORKSPACE_FILES_METHOD_SCHEMAS = {
  'workspace/files/unwatch': Schema.Struct({ watchId: Id }),
  /** The exact path of a live workspace root. */
  'workspace/files/watch': Schema.Struct({ path: AbsolutePath }),
  /** A deliberate retry of a failed watch; there is no automatic one. */
  'workspace/files/watch-retry': Schema.Struct({ watchId: Id }),
} as const;
export const WORKSPACE_FILES_RESULT_SCHEMAS = {
  'workspace/files/unwatch': Schema.Null,
  /** `health` is the watch's latest transition, which may precede the answer. */
  'workspace/files/watch': Schema.Struct({
    health: Schema.optionalKey(Schema.Struct(WatcherHealthSchema)),
    watchId: Id,
  }),
  'workspace/files/watch-retry': Schema.Union(
    [
      Schema.Struct({ retried: Schema.Literal(true) }),
      Schema.Struct({
        reason: Schema.Literals(['in-flight', 'not-failed', 'terminal', 'throttled', 'unknown']),
        retried: Schema.Literal(false),
        retryAfterMs: Schema.optionalKey(Schema.Finite),
      }),
    ],
    { mode: 'oneOf' }
  ),
} as const;
