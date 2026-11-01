import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const AbsolutePath = Schema.String.check(Schema.isMinCodePoints(1));
const Text = Schema.String;
/** A path inside a live root: absolute, or relative to the root `rootId` names. */
const RootPath = Schema.String.check(Schema.isMinCodePoints(1));

const DirectoryEntrySchema = Schema.Struct({
  isDirectory: Schema.Boolean,
  isFile: Schema.Boolean,
  isSymbolicLink: Schema.Boolean,
  lastModified: Schema.optionalKey(Schema.Finite),
  name: Text,
  /** The entry's absolute path, joined by the host's native path rules. */
  path: Text,
  size: Schema.optionalKey(Schema.Finite),
});

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
 * ADR-0029 stage 4: the Explorer's reads of, and recursive watches on, live
 * workspace roots, served by the host. Only the desktop's private clients
 * reach them, and a connection's watches end when it closes.
 */
export const WORKSPACE_FILES_METHOD_SCHEMAS = {
  /** Whether a path inside a live root exists. A path outside every live root is refused. */
  'workspace/files/exists': Schema.Struct({ path: AbsolutePath }),
  /**
   * One directory of a live root. `rootId` anchors the read to that root while
   * it is live; otherwise the deepest live root that contains the path serves it.
   */
  'workspace/files/list': Schema.Struct({ path: RootPath, rootId: Schema.optionalKey(Id) }),
  /**
   * One text file of a live root, resolved as `list` resolves a directory.
   * `rootPath` binds the read to exactly that live root: `rootId` must name it
   * and `rootPath` must be its path.
   */
  'workspace/files/read': Schema.Struct({
    path: RootPath,
    rootId: Schema.optionalKey(Id),
    rootPath: Schema.optionalKey(AbsolutePath),
  }),
  'workspace/files/unwatch': Schema.Struct({ watchId: Id }),
  /** The exact path of a live workspace root. */
  'workspace/files/watch': Schema.Struct({ path: AbsolutePath }),
  /** A deliberate retry of a failed watch; there is no automatic one. */
  'workspace/files/watch-retry': Schema.Struct({ watchId: Id }),
} as const;
export const WORKSPACE_FILES_RESULT_SCHEMAS = {
  'workspace/files/exists': Schema.Struct({ exists: Schema.Boolean }),
  /** The root that served the listing, and its entries as the native read bounded them. */
  'workspace/files/list': Schema.Struct({
    entries: Schema.Array(DirectoryEntrySchema),
    inspected: Schema.Finite,
    rootId: Id,
    truncated: Schema.Boolean,
    /** The native path of the marker node a truncated listing shows. */
    truncationPath: Text,
  }),
  /** A missing or oversized file is an answer the Explorer shows, not a failure. */
  'workspace/files/read': Schema.Union(
    [
      Schema.Struct({ content: Text }),
      Schema.Struct({ code: Schema.Literals(['NOT_FOUND', 'TOO_LARGE']), message: Text }),
    ],
    { mode: 'oneOf' }
  ),
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
