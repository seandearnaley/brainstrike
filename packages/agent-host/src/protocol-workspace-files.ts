import type {
  DirectoryHandle,
  FileHandle,
  FileSystemChange,
  RecentRootEntry,
  RootDescriptor,
  WatcherHealthTransition,
} from '@brainstrike/types';
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Text = Schema.String;
const Count = Schema.Number;
const None = Schema.Record(Schema.String, Schema.Never);
const Done = Schema.Struct({});
const Platform = Schema.Literals(['web', 'electron']);

// --- handles and nodes -----------------------------------------------------

export const WorkspaceDirectoryHandleSchema = Schema.Struct({
  kind: Schema.Literal('directory'),
  name: Text,
  path: Text,
  platform: Platform,
  rootId: Schema.optionalKey(Id),
}) satisfies Schema.ConstraintDecoder<DirectoryHandle>;
const FileHandleSchema = Schema.Struct({
  kind: Schema.Literal('file'),
  name: Text,
  path: Text,
  platform: Platform,
  rootFolderId: Schema.optionalKey(Text),
  rootId: Schema.optionalKey(Id),
  size: Schema.optionalKey(Count),
}) satisfies Schema.ConstraintDecoder<FileHandle>;

/** One Explorer row as the desktop reads it: a path handle, never a browser capability. */
export interface WorkspaceFileNode {
  readonly children?: readonly WorkspaceFileNode[];
  readonly depth: number;
  readonly handle: DirectoryHandle | FileHandle;
  readonly isDepthTruncated?: boolean;
  readonly isSymbolicLink?: boolean;
  readonly isVisible?: boolean;
  readonly lastModified?: number;
  readonly loadError?: string;
  readonly loadState?: 'unloaded' | 'loading' | 'loaded' | 'error';
  readonly name: string;
  readonly path: string;
  readonly rootFolderId: string;
  readonly selectionState: 'checked' | 'unchecked' | 'indeterminate';
  readonly size?: number;
  readonly type: 'file' | 'directory' | 'loadMore' | 'truncated';
}
export const WorkspaceFileNodeSchema: Schema.Codec<WorkspaceFileNode> = Schema.Struct({
  children: Schema.optionalKey(
    Schema.Array(Schema.suspend((): Schema.Codec<WorkspaceFileNode> => WorkspaceFileNodeSchema))
  ),
  depth: Count,
  handle: Schema.Union([WorkspaceDirectoryHandleSchema, FileHandleSchema], { mode: 'oneOf' }),
  isDepthTruncated: Schema.optionalKey(Schema.Boolean),
  isSymbolicLink: Schema.optionalKey(Schema.Boolean),
  isVisible: Schema.optionalKey(Schema.Boolean),
  lastModified: Schema.optionalKey(Count),
  loadError: Schema.optionalKey(Text),
  loadState: Schema.optionalKey(Schema.Literals(['unloaded', 'loading', 'loaded', 'error'])),
  name: Text,
  path: Text,
  rootFolderId: Text,
  selectionState: Schema.Literals(['checked', 'unchecked', 'indeterminate']),
  size: Schema.optionalKey(Count),
  type: Schema.Literals(['file', 'directory', 'loadMore', 'truncated']),
});

export const WorkspaceRootDescriptorSchema = Schema.Struct({
  displayName: Text,
  handle: WorkspaceDirectoryHandleSchema,
  kind: Schema.Literals(['fsa', 'path']),
  permissionState: Schema.Literals(['granted', 'prompt', 'denied', 'unknown']),
  persisted: Schema.Boolean,
  rootId: Id,
}) satisfies Schema.ConstraintDecoder<RootDescriptor>;
const RecentRootEntrySchema = Schema.Struct({
  displayName: Text,
  lastGrantedAt: Count,
  path: Text,
}) satisfies Schema.ConstraintDecoder<RecentRootEntry>;

/** A file's text, or why a refresh should drop it instead of alerting. */
const FileReadSchema = Schema.Union(
  [Text, Schema.Struct({ code: Schema.Literals(['NOT_FOUND', 'TOO_LARGE']), message: Text })],
  { mode: 'oneOf' }
);

// --- watching --------------------------------------------------------------

const WatcherHealthTransitionSchema = Schema.Struct({
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
  timestamp: Count,
}) satisfies Schema.ConstraintDecoder<WatcherHealthTransition>;
const FileSystemChangeSchema = Schema.Struct({
  kind: Schema.Literals(['file', 'directory']),
  path: Text,
  type: Schema.Literals(['added', 'removed', 'modified']),
}) satisfies Schema.ConstraintDecoder<FileSystemChange>;
const WatchRequest = Schema.Struct({ watchId: Id });

/** One watcher's batch or health change, pushed only to the connection that started it. */
export const WORKSPACE_FILES_EVENT = 'files/watch-event';
export const WorkspaceFilesEventSchema = Schema.Union(
  [
    Schema.Struct({
      changes: Schema.Array(FileSystemChangeSchema),
      filteredChangeBoundaries: Schema.optionalKey(Schema.Array(Text)),
      filteredChangeBoundariesOverflow: Schema.optionalKey(Schema.Literal(true)),
      type: Schema.Literal('changes'),
      watchId: Id,
    }),
    Schema.Struct({
      health: WatcherHealthTransitionSchema,
      type: Schema.Literal('health'),
      watchId: Id,
    }),
  ],
  { mode: 'oneOf' }
);
export type WorkspaceFilesEvent = (typeof WorkspaceFilesEventSchema)['Type'];

// --- methods ---------------------------------------------------------------

export const WORKSPACE_FILES_METHOD_SCHEMAS = {
  'files/add-root-by-path': Schema.Struct({ path: Text }),
  'files/delete-root-data': Schema.Struct({ rootId: Id }),
  /** E2E launches only: write the folder ledgers a test starts from, as a saved profile has them. */
  'files/e2e/seed-roots': Schema.Struct({
    lastFolderPath: Text,
    recentPaths: Schema.Array(Text),
    roots: Schema.Array(Schema.Struct({ path: Text, rootId: Id })),
  }),
  'files/exists': Schema.Struct({ path: Text }),
  'files/read-directory': Schema.Struct({ handle: WorkspaceDirectoryHandleSchema }),
  'files/read-file': Schema.Struct({ handle: FileHandleSchema }),
  'files/read-file-by-absolute-path': Schema.Struct({
    absolutePath: Text,
    rootId: Id,
    rootPath: Text,
  }),
  'files/read-file-by-path': Schema.Struct({ path: Text }),
  'files/recent-roots': None,
  'files/remove-root': Schema.Struct({ rootId: Id }),
  'files/restore-last-folder': None,
  'files/restore-roots': None,
  'files/save-last-folder': Schema.Struct({ path: Text }),
  'files/unwatch': WatchRequest,
  'files/watch': Schema.Struct({ handle: WorkspaceDirectoryHandleSchema }),
  'files/watch-retry': WatchRequest,
  'files/watch-telemetry': None,
} as const;

export const WORKSPACE_FILES_RESULT_SCHEMAS = {
  'files/add-root-by-path': WorkspaceRootDescriptorSchema,
  'files/delete-root-data': Done,
  'files/e2e/seed-roots': Done,
  'files/exists': Schema.Boolean,
  'files/read-directory': Schema.Array(WorkspaceFileNodeSchema),
  'files/read-file': FileReadSchema,
  'files/read-file-by-absolute-path': FileReadSchema,
  'files/read-file-by-path': FileReadSchema,
  'files/recent-roots': Schema.Array(RecentRootEntrySchema),
  'files/remove-root': Done,
  'files/restore-last-folder': Schema.NullOr(WorkspaceDirectoryHandleSchema),
  'files/restore-roots': Schema.Array(WorkspaceRootDescriptorSchema),
  'files/save-last-folder': Done,
  'files/unwatch': Done,
  'files/watch': Schema.Struct({
    health: Schema.optionalKey(WatcherHealthTransitionSchema),
    watchId: Id,
  }),
  'files/watch-retry': Schema.Union(
    [
      Schema.Struct({ retried: Schema.Literal(true) }),
      Schema.Struct({
        reason: Schema.Literals(['in-flight', 'not-failed', 'terminal', 'throttled', 'unknown']),
        retried: Schema.Literal(false),
        retryAfterMs: Schema.optionalKey(Count),
      }),
    ],
    { mode: 'oneOf' }
  ),
  'files/watch-telemetry': Schema.Struct({
    activeWatchers: Count,
    batches: Count,
    cleanups: Count,
    degradedTransitions: Count,
    duplicateRegistrations: Count,
    events: Count,
    failures: Count,
    healthPushes: Count,
    lastSetupLatencyMs: Count,
    retries: Count,
    setupLatencySamples: Count,
  }),
} as const;
