import { BoundaryFailureSchema } from '@brainstrike/assistant-contract';
import type {
  ChangesApplyResult,
  ChangesCommit,
  ChangesetView,
  ChangesInvalidationEvent,
  GitCommitResult,
  GitCreateBranchResult,
  GitInventory,
  GitPushPullResult,
  GitRepository,
  GitStatus,
  GitSwitchBranchResult,
  ManagedWorktreePathEntry,
  ManagedWorktreeRow,
  StructuredFileDiff,
  WorktreeArchivePreview,
  WorktreeArchiveResult,
  WorktreeCheckoutStatus,
  WorktreeCreateContext,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeSettings,
} from '@brainstrike/types';
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Text = Schema.String;
const NullableText = Schema.NullOr(Text);
const Count = Schema.Number;
const Texts = Schema.Array(Text);
const None = Schema.Record(Schema.String, Schema.Never);
const RootRequest = Schema.Struct({ rootId: Id });

const GitError = Schema.Struct({ error: BoundaryFailureSchema, ok: Schema.Literal(false) });
/** The git cluster keeps its `BoundaryResult` envelope across the wire, failures typed. */
function gitResult<T extends Schema.Constraint>(value: T) {
  return Schema.Union([Schema.Struct({ ok: Schema.Literal(true), value }), GitError], {
    mode: 'oneOf',
  });
}

// --- git -------------------------------------------------------------------

const GitStatusFileSchema = Schema.Struct({
  originalPath: Schema.optionalKey(Text),
  path: Text,
  staged: Schema.Boolean,
  status: Text,
  unstaged: Schema.Boolean,
  untracked: Schema.Boolean,
});
const GitStatusSchema = Schema.Struct({
  ahead: Schema.NullOr(Count),
  behind: Schema.NullOr(Count),
  branch: NullableText,
  clean: Schema.Boolean,
  files: Schema.Array(GitStatusFileSchema),
  isRepository: Schema.Boolean,
  upstream: NullableText,
}) satisfies Schema.ConstraintDecoder<GitStatus>;
const GitCommitResultSchema = Schema.Struct({
  branch: NullableText,
  commit: Text,
}) satisfies Schema.ConstraintDecoder<GitCommitResult>;
const GitPushPullResultSchema = Schema.Struct({
  output: Text,
}) satisfies Schema.ConstraintDecoder<GitPushPullResult>;
const GitWorktreeSummaryFields = {
  bare: Schema.Boolean,
  branch: NullableText,
  current: Schema.Boolean,
  detached: Schema.Boolean,
  head: NullableText,
  lockedReason: NullableText,
  name: Text,
  path: Text,
  prunableReason: NullableText,
};
const GitWorktreeSummarySchema = Schema.Struct(GitWorktreeSummaryFields);
const GitRepositorySchema = Schema.Struct({
  branches: Schema.Array(
    Schema.Struct({
      current: Schema.Boolean,
      head: Text,
      name: Text,
      upstream: NullableText,
      worktreePath: NullableText,
    })
  ),
  currentWorktree: GitWorktreeSummarySchema,
  defaultRemote: NullableText,
  name: Text,
  openedRoot: Text,
  remotes: Texts,
  repositoryRoot: Text,
  scope: Schema.Literals(['repository', 'workspace']),
  worktrees: Schema.Array(GitWorktreeSummarySchema),
}) satisfies Schema.ConstraintDecoder<GitRepository>;
const GitSwitchBranchResultSchema = Schema.Struct({
  branch: Text,
}) satisfies Schema.ConstraintDecoder<GitSwitchBranchResult>;
const GitCreateBranchResultSchema = Schema.Struct({
  branch: Text,
}) satisfies Schema.ConstraintDecoder<GitCreateBranchResult>;

// --- Changes ---------------------------------------------------------------

const ChangedFileStatusSchema = Schema.Literals([
  'added',
  'deleted',
  'modified',
  'renamed',
  'untracked',
]);
const StructuredFileDiffSchema = Schema.Struct({
  additions: Schema.NullOr(Count),
  content: Schema.Union(
    [
      Schema.Struct({ kind: Schema.Literal('binary') }),
      Schema.Struct({
        kind: Schema.Literal('full'),
        newContent: NullableText,
        oldContent: NullableText,
        patch: Text,
      }),
      Schema.Struct({
        kind: Schema.Literal('hunks-only'),
        patch: Text,
        patchTruncated: Schema.Boolean,
        reason: Schema.Literals(['diff-overflow', 'over-cap-both', 'over-cap-new', 'over-cap-old']),
      }),
    ],
    { mode: 'oneOf' }
  ),
  deletions: Schema.NullOr(Count),
  oldPath: Schema.optionalKey(Text),
  path: Text,
  status: ChangedFileStatusSchema,
}) satisfies Schema.ConstraintDecoder<StructuredFileDiff>;
const GitScopeSchema = Schema.Union(
  [
    Schema.Struct({ baseRef: Schema.optionalKey(Text), kind: Schema.Literal('branch-vs-base') }),
    Schema.Struct({ commitId: Text, kind: Schema.Literal('commit') }),
    Schema.Struct({ kind: Schema.Literal('staged') }),
    Schema.Struct({ kind: Schema.Literal('uncommitted') }),
    Schema.Struct({ kind: Schema.Literal('unstaged') }),
  ],
  { mode: 'oneOf' }
);
const ChangesetSchema = Schema.Union(
  [
    Schema.Struct({ kind: Schema.Literal('agent-run'), runId: Id, threadId: Id }),
    Schema.Struct({
      kind: Schema.Literal('git-scope'),
      repositoryRoot: Text,
      scope: GitScopeSchema,
      worktreePath: Text,
    }),
    Schema.Struct({
      fromRunId: Id,
      kind: Schema.Literal('run-range'),
      threadId: Id,
      toRunId: Schema.optionalKey(Id),
    }),
  ],
  { mode: 'oneOf' }
);
const ChangesActionSchema = Schema.Literals(['revert', 'stage', 'unstage']);
const ChangesetViewSchema = Schema.Struct({
  changeset: ChangesetSchema,
  files: Schema.Array(
    Schema.Struct({
      actions: Schema.Array(ChangesActionSchema),
      additions: Schema.NullOr(Count),
      deletions: Schema.NullOr(Count),
      oldPath: Schema.optionalKey(Text),
      patch: NullableText,
      path: Text,
      pathInRoot: NullableText,
      repositoryRoot: NullableText,
      revision: Text,
      rootId: NullableText,
      status: ChangedFileStatusSchema,
      toolAttributed: Schema.optionalKey(Schema.Boolean),
      wholeFile: Schema.optionalKey(Schema.Literal(true)),
      worktreePath: NullableText,
    })
  ),
  totalAdditions: Schema.NullOr(Count),
  totalDeletions: Schema.NullOr(Count),
}) satisfies Schema.ConstraintDecoder<ChangesetView>;
const ChangesActionTargetSchema = Schema.Union(
  [
    Schema.Struct({
      files: Schema.Array(Schema.Struct({ path: Text, revision: Text })),
      kind: Schema.Literal('files'),
    }),
    Schema.Struct({ hunks: Texts, kind: Schema.Literal('hunks'), path: Text }),
  ],
  { mode: 'oneOf' }
);
const ChangesApplyResultSchema = Schema.Struct({
  paths: Texts,
}) satisfies Schema.ConstraintDecoder<ChangesApplyResult>;
const ChangesCommitSchema = Schema.Struct({
  commitId: Text,
  subject: Text,
}) satisfies Schema.ConstraintDecoder<ChangesCommit>;
const Containment = Schema.Union([Texts, Schema.Literal('outside-roots')]);
const WorktreeProvenanceSchema = Schema.Literals(['agent-reported', 'both', 'scanned']);
const Trust = Schema.Literals(['unvalidated', 'validated']);
const GitInventorySchema = Schema.Struct({
  errors: Texts,
  repositories: Schema.Array(
    Schema.Struct({
      identity: Schema.Struct({ gitCommonDir: Text, repositoryRoot: Text }),
      worktrees: Schema.Array(
        Schema.Struct({
          ...GitWorktreeSummaryFields,
          containment: Containment,
          provenance: WorktreeProvenanceSchema,
          trust: Trust,
          trustReason: NullableText,
        })
      ),
    })
  ),
}) satisfies Schema.ConstraintDecoder<GitInventory>;

// --- worktrees -------------------------------------------------------------

const Creator = Schema.Literals(['agent', 'user']);
const SetupStatus = Schema.Literals(['failed', 'none', 'skipped', 'succeeded']);
const ManagedWorktreeRowSchema = Schema.Struct({
  archivedAt: NullableText,
  archiveSnapshotRef: NullableText,
  baseRef: Text,
  branch: NullableText,
  createdAt: Text,
  createdBy: Creator,
  id: Id,
  path: Text,
  repoCommonDir: Text,
  runId: NullableText,
  setupOutput: NullableText,
  setupReason: NullableText,
  setupStatus: SetupStatus,
  threadId: NullableText,
}) satisfies Schema.ConstraintDecoder<ManagedWorktreeRow>;
const WorktreeSetupCommandSchema = Schema.Union([
  Schema.Array(Id),
  Schema.Null,
  Schema.Literal('disabled'),
]);
const WorktreeSettingsSchema = Schema.Struct({
  isDefaultDirectory: Schema.Boolean,
  managedDirectory: Text,
  setupCommand: WorktreeSetupCommandSchema,
}) satisfies Schema.ConstraintDecoder<WorktreeSettings>;
const WorktreeCreateResultSchema = Schema.Struct({
  setup: Schema.Struct({
    copiedPaths: Texts,
    output: Text,
    reason: NullableText,
    skippedCopies: Schema.Array(Schema.Struct({ path: Text, pattern: Text, reason: Text })),
    status: SetupStatus,
    truncated: Schema.Boolean,
  }),
  worktree: ManagedWorktreeRowSchema,
}) satisfies Schema.ConstraintDecoder<WorktreeCreateResult>;
const WorktreeArchiveResultSchema = Schema.Struct({
  snapshotRef: Text,
  worktree: ManagedWorktreeRowSchema,
}) satisfies Schema.ConstraintDecoder<WorktreeArchiveResult>;
const WorktreeArchivePreviewSchema = Schema.Struct({
  confirmationToken: NullableText,
  ignoredEntryCount: Count,
  ignoredTopLevelEntries: Texts,
  ignoredTopLevelEntriesTruncated: Schema.Boolean,
  ignoredTopLevelEntryCount: Count,
}) satisfies Schema.ConstraintDecoder<WorktreeArchivePreview>;
const WorktreeCheckoutStatusSchema = Schema.Struct({
  ahead: Schema.NullOr(Count),
  behind: Schema.NullOr(Count),
  clean: Schema.Boolean,
  path: Text,
  upstream: NullableText,
}) satisfies Schema.ConstraintDecoder<WorktreeCheckoutStatus>;
const WorktreeCreateContextSchema = Schema.Struct({
  managedParentPath: Text,
  repositorySetup: Schema.NullOr(
    Schema.Struct({
      repositoryId: Text,
      repositoryPath: Text,
      scriptPath: Text,
      scriptSha256: Text,
    })
  ),
  suggestedName: Text,
}) satisfies Schema.ConstraintDecoder<WorktreeCreateContext>;
const WorktreeListSchema = Schema.Array(
  Schema.Struct({
    branch: NullableText,
    containment: Containment,
    createdAt: NullableText,
    detached: Schema.Boolean,
    disabledReason: NullableText,
    externalTool: Schema.NullOr(Schema.Literals(['claude-code', 'codex', 'cursor'])),
    id: NullableText,
    lockedReason: NullableText,
    managed: Schema.Boolean,
    name: Text,
    path: Text,
    primary: Schema.Boolean,
    provenance: WorktreeProvenanceSchema,
    remedy: Schema.NullOr(Schema.Literal('grant-access')),
    repoCommonDir: Text,
    repositoryRoot: Text,
    rootId: NullableText,
    rootIdIsExactMount: Schema.Boolean,
    setupReason: NullableText,
    setupStatus: SetupStatus,
    trust: Trust,
    trustReason: NullableText,
    usable: Schema.Boolean,
  })
) satisfies Schema.ConstraintDecoder<readonly WorktreeListEntry[]>;
const ManagedWorktreePathsSchema = Schema.Array(
  Schema.Struct({ id: Id, path: Text })
) satisfies Schema.ConstraintDecoder<readonly ManagedWorktreePathEntry[]>;
const RunProvenance = {
  runId: Schema.optionalKey(Id),
  threadId: Schema.optionalKey(Id),
};

// --- events ----------------------------------------------------------------

const ChangesInvalidationEventSchema = Schema.Struct({
  generation: Count,
  gitCommonDir: Text,
  repositoryRoot: NullableText,
}) satisfies Schema.ConstraintDecoder<ChangesInvalidationEvent>;
/** Host -> subscribed client: a repository changed on disk. */
export const GIT_WORKSPACE_EVENT = 'workspace/git/event';
export const GitWorkspaceEventSchema = Schema.Union(
  [
    Schema.Struct({
      event: ChangesInvalidationEventSchema,
      type: Schema.Literal('changes-invalidated'),
    }),
  ],
  { mode: 'oneOf' }
);
export type GitWorkspaceEvent = (typeof GitWorkspaceEventSchema)['Type'];

/** Main's root registration asks whether a folder is a managed worktree it may mount. */
export const WorktreePathClassificationSchema = Schema.Literals([
  'authorized',
  'managed-but-unauthorized',
  'unmanaged',
]);

/**
 * ADR-0029 stage 2: the desktop's git cluster, served by the host that owns
 * the workspace catalog. Changes, the branch chip and worktrees reach it over
 * the window's host connection.
 */
export const GIT_WORKSPACE_METHOD_SCHEMAS = {
  'changes/apply': Schema.Struct({
    action: ChangesActionSchema,
    changeset: ChangesetSchema,
    rootId: Id,
    target: ChangesActionTargetSchema,
  }),
  'changes/commits': Schema.Struct({ rootId: Id, worktreePath: Text }),
  'changes/file-diff': Schema.Struct({ changeset: ChangesetSchema, path: Text, rootId: Id }),
  'changes/inventory': Schema.Struct({ maxAgeMs: Schema.optionalKey(Count) }),
  'changes/resolve-view': Schema.Struct({ changeset: ChangesetSchema, rootId: Id }),
  'git/commit': Schema.Struct({ description: Schema.optionalKey(Text), rootId: Id, summary: Text }),
  'git/create-branch': Schema.Struct({
    branch: Text,
    rootId: Id,
    startPoint: Schema.optionalKey(Text),
  }),
  'git/fetch': Schema.Struct({ remote: Text, rootId: Id }),
  'git/push': Schema.Struct({ remote: Schema.optionalKey(Text), rootId: Id }),
  'git/repository': RootRequest,
  'git/status': RootRequest,
  'git/switch-branch': Schema.Struct({ branch: Text, rootId: Id }),
  'workspace/git/subscribe': None,
  'worktrees/adopt': Schema.Struct({
    createdBy: Creator,
    id: Schema.optionalKey(Id),
    path: Text,
    ...RunProvenance,
  }),
  'worktrees/archive': Schema.Struct({
    confirmIgnoredEntries: Schema.optionalKey(Text),
    force: Schema.optionalKey(Schema.Boolean),
    runId: Schema.optionalKey(Id),
    worktreeId: Id,
  }),
  'worktrees/checkout-status': Schema.Struct({ path: Text }),
  'worktrees/classify-path': Schema.Struct({ path: Text }),
  'worktrees/create': Schema.Struct({
    baseRef: Text,
    branch: Schema.Union([
      Schema.Struct({ detached: Schema.Literal(true) }),
      Schema.Struct({ name: Text }),
    ]),
    createdBy: Creator,
    name: Text,
    repositorySetupDecision: Schema.optionalKey(
      Schema.Struct({
        decision: Schema.Literals(['approved', 'denied']),
        repositoryId: Text,
        scriptSha256: Text,
      })
    ),
    rootId: Id,
    ...RunProvenance,
  }),
  'worktrees/create-branch-here': Schema.Struct({ branch: Text, worktreeId: Id }),
  'worktrees/create-context': RootRequest,
  'worktrees/inspect-archive': Schema.Struct({ worktreeId: Id }),
  'worktrees/list': None,
  'worktrees/managed-paths': None,
  'worktrees/restore': Schema.Struct({ worktreeId: Id }),
  'worktrees/settings/read': None,
  'worktrees/settings/write': Schema.Struct({
    managedDirectory: NullableText,
    setupCommand: WorktreeSetupCommandSchema,
  }),
} as const;

export const GIT_WORKSPACE_RESULT_SCHEMAS = {
  'changes/apply': gitResult(ChangesApplyResultSchema),
  'changes/commits': gitResult(Schema.Array(ChangesCommitSchema)),
  'changes/file-diff': gitResult(StructuredFileDiffSchema),
  'changes/inventory': gitResult(GitInventorySchema),
  'changes/resolve-view': gitResult(ChangesetViewSchema),
  'git/commit': gitResult(GitCommitResultSchema),
  'git/create-branch': gitResult(GitCreateBranchResultSchema),
  'git/fetch': gitResult(GitPushPullResultSchema),
  'git/push': gitResult(GitPushPullResultSchema),
  'git/repository': gitResult(GitRepositorySchema),
  'git/status': gitResult(GitStatusSchema),
  'git/switch-branch': gitResult(GitSwitchBranchResultSchema),
  'workspace/git/subscribe': Schema.Struct({ subscribed: Schema.Literal(true) }),
  'worktrees/adopt': gitResult(ManagedWorktreeRowSchema),
  'worktrees/archive': gitResult(WorktreeArchiveResultSchema),
  'worktrees/checkout-status': gitResult(WorktreeCheckoutStatusSchema),
  'worktrees/classify-path': Schema.Struct({ classification: WorktreePathClassificationSchema }),
  'worktrees/create': gitResult(WorktreeCreateResultSchema),
  'worktrees/create-branch-here': gitResult(ManagedWorktreeRowSchema),
  'worktrees/create-context': gitResult(WorktreeCreateContextSchema),
  'worktrees/inspect-archive': gitResult(WorktreeArchivePreviewSchema),
  'worktrees/list': gitResult(WorktreeListSchema),
  'worktrees/managed-paths': gitResult(ManagedWorktreePathsSchema),
  'worktrees/restore': gitResult(WorktreeCreateResultSchema),
  'worktrees/settings/read': gitResult(WorktreeSettingsSchema),
  'worktrees/settings/write': gitResult(WorktreeSettingsSchema),
} as const;
