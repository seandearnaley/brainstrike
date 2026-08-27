/**
 * Main-process handlers for the desktop `changes` IPC domain (BST-1113).
 *
 * `resolveView` resolves any `Changeset` (agent-run / run-range / git-scope)
 * to an eager `ChangesetView`; `fileDiff` loads one file's
 * `StructuredFileDiff` lazily. Both accept `unknown` renderer-supplied
 * arguments (the IPC boundary is untrusted, same as `git-ipc-handlers.ts`) —
 * `validateChangeset`/`validatePath` structurally narrow the payload before
 * it ever reaches `ChangesetDiffService`, which only ever sees typed values.
 *
 * Every failure is a visible, typed `GitResult` — never a thrown bare
 * `Error`, never a silent coercion of a malformed payload. Unknown `kind`s
 * and unsupported/extra keys are rejected explicitly, mirroring
 * `git-structured-diff.ts`'s `validateStructuredFileDiffParams` posture.
 */
import type {
  AssistantRewindFinalization,
  AssistantRewindMode,
  AssistantRewindPreviewResult,
  AssistantRewindRedoResult,
  AssistantRewindResult,
} from '@brainstrike/assistant-contract';
import { ASSISTANT_REWIND_MODES } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type {
  Changeset,
  ChangesetView,
  GitInventory,
  GitResult,
  GitScope,
  StructuredFileDiff,
} from '@brainstrike/types';
import {
  type ChangesetDiffService,
  createChangesetDiffService,
} from './assistant-server/changeset-diff-service';
import type { CheckpointRevertDeps } from './assistant-server/checkpoint-reindex-deps';
import { createCheckpointReindexDeps } from './assistant-server/checkpoint-reindex-deps';
import type { EditCheckpointDatabase } from './assistant-server/edit-checkpoint-journal';
import type { GitInventoryService } from './assistant-server/git-inventory-service';
import type { GitCommandRunner } from './assistant-server/git-service';
import { createRewindFinalizationDeps } from './assistant-server/rewind-finalization-deps';
import { resolveRewindMessageForRun } from './assistant-server/rewind-repository';
import {
  applyRewind as applyRewindService,
  finalizeThreadRewinds as finalizeThreadRewindsService,
  type RewindFinalizationDeps,
  type RewindServiceDeps,
  redoRewind as redoRewindService,
  rewindToMessage as rewindToMessageService,
} from './assistant-server/rewind-service';
import type { RewindSnapshotDeps } from './assistant-server/rewind-snapshot-engine';
import type { SnapshotRepository } from './assistant-server/snapshot-repository';
import { createSnapshotRepository as createSnapshotRepositoryDefault } from './assistant-server/snapshot-repository';
import type { SnapshotService } from './assistant-server/snapshot-service';
import { getDatabase } from './db-main';
import { createDatabaseRootResolver, execFileGitRunner } from './git-ipc-handlers';
import { resolveRootCwd, type WorkspaceRootResolver } from './workspace-root-cwd';

const logger = createLogger('ChangesIpc');

const GIT_SCOPE_KINDS = ['branch-vs-base', 'commit', 'staged', 'uncommitted', 'unstaged'] as const;
type GitScopeKind = (typeof GIT_SCOPE_KINDS)[number];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isGitScopeKind(value: unknown): value is GitScopeKind {
  return GIT_SCOPE_KINDS.includes(value as GitScopeKind);
}

function rejectUnsupportedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  subject: string
): GitResult<true> {
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(record).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    return { error: `${subject} does not accept: ${unsupported.join(', ')}`, ok: false };
  }
  return { ok: true, value: true };
}

/** Structurally validate a `git-scope` changeset's `scope` object. */
function validateGitScope(value: unknown): GitResult<GitScope> {
  if (!(value && typeof value === 'object') || Array.isArray(value)) {
    return { error: 'git-scope changeset requires scope to be an object', ok: false };
  }
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (!isGitScopeKind(kind)) {
    const allowed = GIT_SCOPE_KINDS.map((candidate) => `"${candidate}"`).join(', ');
    return {
      error: `git-scope scope.kind must be one of ${allowed} (received "${String(kind)}")`,
      ok: false,
    };
  }

  if (kind === 'commit') {
    const keysResult = rejectUnsupportedKeys(
      record,
      ['kind', 'commitId'],
      'git-scope scope kind "commit"'
    );
    if (!keysResult.ok) {
      return keysResult;
    }
    const commitId = record['commitId'];
    if (!isNonEmptyString(commitId)) {
      return { error: 'git-scope scope kind "commit" requires a non-empty commitId', ok: false };
    }
    return { ok: true, value: { commitId, kind: 'commit' } };
  }

  if (kind === 'branch-vs-base') {
    const keysResult = rejectUnsupportedKeys(
      record,
      ['kind', 'baseRef'],
      'git-scope scope kind "branch-vs-base"'
    );
    if (!keysResult.ok) {
      return keysResult;
    }
    const baseRef = record['baseRef'];
    if (baseRef !== undefined && !isNonEmptyString(baseRef)) {
      return {
        error:
          'git-scope scope kind "branch-vs-base" baseRef must be a non-empty string when present',
        ok: false,
      };
    }
    return {
      ok: true,
      value: isNonEmptyString(baseRef)
        ? { baseRef, kind: 'branch-vs-base' }
        : { kind: 'branch-vs-base' },
    };
  }

  // staged | uncommitted | unstaged: no fields beyond `kind`.
  const keysResult = rejectUnsupportedKeys(record, ['kind'], `git-scope scope kind "${kind}"`);
  if (!keysResult.ok) {
    return keysResult;
  }
  return { ok: true, value: { kind } };
}

/** Structurally validate an `agent-run` changeset payload. */
function validateAgentRunChangeset(record: Record<string, unknown>): GitResult<Changeset> {
  const keysResult = rejectUnsupportedKeys(
    record,
    ['kind', 'runId', 'threadId'],
    'changeset kind "agent-run"'
  );
  if (!keysResult.ok) {
    return keysResult;
  }
  const runId = record['runId'];
  const threadId = record['threadId'];
  if (!isNonEmptyString(runId)) {
    return { error: 'changeset kind "agent-run" requires a non-empty runId', ok: false };
  }
  if (!isNonEmptyString(threadId)) {
    return { error: 'changeset kind "agent-run" requires a non-empty threadId', ok: false };
  }
  return { ok: true, value: { kind: 'agent-run', runId, threadId } };
}

/** Structurally validate a `run-range` changeset payload. */
function validateRunRangeChangeset(record: Record<string, unknown>): GitResult<Changeset> {
  const keysResult = rejectUnsupportedKeys(
    record,
    ['kind', 'fromRunId', 'threadId', 'toRunId'],
    'changeset kind "run-range"'
  );
  if (!keysResult.ok) {
    return keysResult;
  }
  const fromRunId = record['fromRunId'];
  const threadId = record['threadId'];
  const toRunId = record['toRunId'];
  if (!isNonEmptyString(fromRunId)) {
    return { error: 'changeset kind "run-range" requires a non-empty fromRunId', ok: false };
  }
  if (!isNonEmptyString(threadId)) {
    return { error: 'changeset kind "run-range" requires a non-empty threadId', ok: false };
  }
  if (toRunId !== undefined && !isNonEmptyString(toRunId)) {
    return {
      error: 'changeset kind "run-range" toRunId must be a non-empty string when present',
      ok: false,
    };
  }
  return {
    ok: true,
    value: {
      fromRunId,
      kind: 'run-range',
      threadId,
      ...(isNonEmptyString(toRunId) ? { toRunId } : {}),
    },
  };
}

/** Structurally validate a `git-scope` changeset payload (top-level fields + nested `scope`). */
function validateGitScopeChangeset(record: Record<string, unknown>): GitResult<Changeset> {
  const keysResult = rejectUnsupportedKeys(
    record,
    ['kind', 'repositoryRoot', 'worktreePath', 'scope'],
    'changeset kind "git-scope"'
  );
  if (!keysResult.ok) {
    return keysResult;
  }
  const repositoryRoot = record['repositoryRoot'];
  const worktreePath = record['worktreePath'];
  if (!isNonEmptyString(repositoryRoot)) {
    return { error: 'changeset kind "git-scope" requires a non-empty repositoryRoot', ok: false };
  }
  if (!isNonEmptyString(worktreePath)) {
    return { error: 'changeset kind "git-scope" requires a non-empty worktreePath', ok: false };
  }
  const scopeResult = validateGitScope(record['scope']);
  if (!scopeResult.ok) {
    return scopeResult;
  }
  return {
    ok: true,
    value: { kind: 'git-scope', repositoryRoot, scope: scopeResult.value, worktreePath },
  };
}

/**
 * Structurally validate a renderer-supplied `Changeset` payload. Unknown
 * `kind` ⇒ a visible error naming the received kind; unknown/extra keys per
 * kind ⇒ rejected — no silent coercion or stripping.
 */
export function validateChangeset(value: unknown): GitResult<Changeset> {
  if (!(value && typeof value === 'object') || Array.isArray(value)) {
    return { error: 'changeset payload must be an object with an explicit kind', ok: false };
  }
  const record = value as Record<string, unknown>;
  const kind = record['kind'];

  if (kind === 'agent-run') {
    return validateAgentRunChangeset(record);
  }
  if (kind === 'run-range') {
    return validateRunRangeChangeset(record);
  }
  if (kind === 'git-scope') {
    return validateGitScopeChangeset(record);
  }
  return {
    error: `changeset kind must be "agent-run", "run-range", or "git-scope" (received "${String(kind)}")`,
    ok: false,
  };
}

/** Structurally validate a renderer-supplied `path` argument. */
export function validatePath(value: unknown): GitResult<string> {
  if (!isNonEmptyString(value)) {
    return { error: 'changes:fileDiff requires a non-empty path', ok: false };
  }
  return { ok: true, value };
}

// ===== Conversation Rewind (BST-1115 W5 T4) =====
//
// TWO LEVELS OF FAILURE, deliberately not collapsed into one:
//   - `GitResult.ok === false` means THE CALL failed — a malformed renderer
//     payload, or an unexpected throw. Same posture as `resolveView`/
//     `fileDiff`: a typed failure, never a thrown bare `Error`.
//   - `GitResult.value.ok === false` means the rewind was REFUSED for a domain
//     reason the service names (`conflicts-unacknowledged`, `message-not-found`,
//     …). That is a real answer, not an error, and the UI must show it.
// Flattening the two would make "your payload was garbage" indistinguishable
// from "one file conflicts and nothing was applied".

function asRecord(value: unknown, subject: string): GitResult<Record<string, unknown>> {
  if (!(value && typeof value === 'object') || Array.isArray(value)) {
    return { error: `${subject} requires an object payload`, ok: false };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** Optional boolean field: absent ⇒ `false`; present-but-not-boolean ⇒ rejected. */
function validateOptionalBoolean(
  record: Record<string, unknown>,
  field: string,
  subject: string
): GitResult<boolean> {
  const value = record[field];
  if (value === undefined) {
    return { ok: true, value: false };
  }
  if (typeof value !== 'boolean') {
    return { error: `${subject} "${field}" must be a boolean when present`, ok: false };
  }
  return { ok: true, value };
}

/**
 * The target of a rewind preview: either the message directly (the assistant
 * panel's "Restore to before this message"), or a run whose starting message
 * the main process resolves (the Changes header's "Restore to before this" —
 * Amendment 1 A1.3; the surface knows a runId and never a messageId).
 *
 * EXACTLY ONE is required. Accepting both and silently preferring one would
 * let a caller believe it targeted the run when it targeted the message.
 */
export type RewindPreviewTarget =
  | { readonly kind: 'message'; readonly messageId: string; readonly threadId: string }
  | { readonly kind: 'run'; readonly runId: string; readonly threadId: string };

export function validateRewindPreviewPayload(value: unknown): GitResult<RewindPreviewTarget> {
  const subject = 'changes:rewindPreview';
  const recordResult = asRecord(value, subject);
  if (!recordResult.ok) {
    return recordResult;
  }
  const record = recordResult.value;
  const keysResult = rejectUnsupportedKeys(record, ['messageId', 'runId', 'threadId'], subject);
  if (!keysResult.ok) {
    return keysResult;
  }
  const threadId = record['threadId'];
  if (!isNonEmptyString(threadId)) {
    return { error: `${subject} requires a non-empty threadId`, ok: false };
  }
  const messageId = record['messageId'];
  const runId = record['runId'];
  const hasMessageId = messageId !== undefined;
  const hasRunId = runId !== undefined;
  if (hasMessageId === hasRunId) {
    return {
      error: `${subject} requires exactly one of messageId or runId (received ${hasMessageId ? 'both' : 'neither'})`,
      ok: false,
    };
  }
  if (hasMessageId) {
    if (!isNonEmptyString(messageId)) {
      return { error: `${subject} messageId must be a non-empty string`, ok: false };
    }
    return { ok: true, value: { kind: 'message', messageId, threadId } };
  }
  if (!isNonEmptyString(runId)) {
    return { error: `${subject} runId must be a non-empty string`, ok: false };
  }
  return { ok: true, value: { kind: 'run', runId, threadId } };
}

export interface RewindApplyPayload {
  readonly acknowledgeConflicts: boolean;
  readonly messageId: string;
  readonly mode: AssistantRewindMode;
  readonly threadId: string;
}

function isRewindMode(value: unknown): value is AssistantRewindMode {
  return ASSISTANT_REWIND_MODES.includes(value as AssistantRewindMode);
}

export function validateRewindApplyPayload(value: unknown): GitResult<RewindApplyPayload> {
  const subject = 'changes:applyRewind';
  const recordResult = asRecord(value, subject);
  if (!recordResult.ok) {
    return recordResult;
  }
  const record = recordResult.value;
  const keysResult = rejectUnsupportedKeys(
    record,
    ['acknowledgeConflicts', 'messageId', 'mode', 'threadId'],
    subject
  );
  if (!keysResult.ok) {
    return keysResult;
  }
  const messageId = record['messageId'];
  const threadId = record['threadId'];
  if (!isNonEmptyString(threadId)) {
    return { error: `${subject} requires a non-empty threadId`, ok: false };
  }
  if (!isNonEmptyString(messageId)) {
    return { error: `${subject} requires a non-empty messageId`, ok: false };
  }
  // The scope choice is REQUIRED and explicit (Amendment 1): there is no
  // default mode at this boundary either, so a payload that omits it is
  // rejected rather than quietly reverting files.
  const mode = record['mode'];
  if (!isRewindMode(mode)) {
    const allowed = ASSISTANT_REWIND_MODES.map((candidate) => `"${candidate}"`).join(', ');
    return {
      error: `${subject} requires an explicit mode, one of ${allowed} (received "${String(mode)}")`,
      ok: false,
    };
  }
  const acknowledgeResult = validateOptionalBoolean(record, 'acknowledgeConflicts', subject);
  if (!acknowledgeResult.ok) {
    return acknowledgeResult;
  }
  return {
    ok: true,
    value: { acknowledgeConflicts: acknowledgeResult.value, messageId, mode, threadId },
  };
}

export interface RewindRedoPayload {
  readonly acknowledgeConflicts: boolean;
  readonly rewindId: string;
}

export function validateRewindRedoPayload(value: unknown): GitResult<RewindRedoPayload> {
  const subject = 'changes:redoRewind';
  const recordResult = asRecord(value, subject);
  if (!recordResult.ok) {
    return recordResult;
  }
  const record = recordResult.value;
  const keysResult = rejectUnsupportedKeys(record, ['acknowledgeConflicts', 'rewindId'], subject);
  if (!keysResult.ok) {
    return keysResult;
  }
  const rewindId = record['rewindId'];
  if (!isNonEmptyString(rewindId)) {
    return { error: `${subject} requires a non-empty rewindId`, ok: false };
  }
  const acknowledgeResult = validateOptionalBoolean(record, 'acknowledgeConflicts', subject);
  if (!acknowledgeResult.ok) {
    return acknowledgeResult;
  }
  return { ok: true, value: { acknowledgeConflicts: acknowledgeResult.value, rewindId } };
}

export interface RewindFinalizePayload {
  readonly threadId: string;
}

export function validateRewindFinalizePayload(value: unknown): GitResult<RewindFinalizePayload> {
  const subject = 'changes:finalizeRewinds';
  const recordResult = asRecord(value, subject);
  if (!recordResult.ok) {
    return recordResult;
  }
  const record = recordResult.value;
  const keysResult = rejectUnsupportedKeys(record, ['threadId'], subject);
  if (!keysResult.ok) {
    return keysResult;
  }
  const threadId = record['threadId'];
  if (!isNonEmptyString(threadId)) {
    return { error: `${subject} requires a non-empty threadId`, ok: false };
  }
  return { ok: true, value: { threadId } };
}

/**
 * The `changes:inventory` options bag. Absent is the normal case (serve the
 * TTL cache); `{ maxAgeMs: 0 }` is the forced refresh a renderer that just
 * registered a root uses to guarantee the rebuild — and therefore the
 * per-repository watcher arming — sees its new `roots` row (BST-1397).
 *
 * Nothing is coerced: a non-integer, negative, or otherwise malformed
 * `maxAgeMs` is a caller bug and comes back as a visible `ok: false`. The
 * service itself throws on a bad value, so accepting one here would only
 * convert a validation error into an "unexpected handler failure".
 */
export function validateInventoryOptions(
  value: unknown
): GitResult<{ readonly maxAgeMs?: number }> {
  const subject = 'changes:inventory';
  if (value === undefined) {
    return { ok: true, value: {} };
  }
  const recordResult = asRecord(value, subject);
  if (!recordResult.ok) {
    return recordResult;
  }
  const record = recordResult.value;
  const keysResult = rejectUnsupportedKeys(record, ['maxAgeMs'], subject);
  if (!keysResult.ok) {
    return keysResult;
  }
  const maxAgeMs = record['maxAgeMs'];
  if (maxAgeMs === undefined) {
    return { ok: true, value: {} };
  }
  if (typeof maxAgeMs !== 'number' || !Number.isInteger(maxAgeMs) || maxAgeMs < 0) {
    return {
      error: `${subject} requires maxAgeMs to be an integer >= 0`,
      ok: false,
    };
  }
  return { ok: true, value: { maxAgeMs } };
}

export interface ChangesIpcHandlers {
  /**
   * Apply a Conversation Rewind (BST-1115). `mode` is required — see
   * {@link validateRewindApplyPayload}. The acknowledgment gate lives in the
   * service, not here: this boundary only carries the flag through.
   */
  readonly applyRewind: (payload: unknown) => Promise<GitResult<AssistantRewindResult>>;
  readonly fileDiff: (
    rootId: unknown,
    changeset: unknown,
    path: unknown
  ) => Promise<GitResult<StructuredFileDiff>>;
  /**
   * End the redo window for a thread: hard-delete its tombstoned messages
   * through the memory store's `deleteMessages` override and drop the sidecar
   * rows. Fired by the renderer when a USER-authored message starts a new run
   * (W5 T4b).
   *
   * `value.finalized === false` is a normal answer, not a failure — a thread
   * with no outstanding rewind is the common case, and this call is expected to
   * be cheap and idempotent.
   */
  readonly finalizeRewinds: (payload: unknown) => Promise<GitResult<AssistantRewindFinalization>>;
  /**
   * Repository/worktree topology for the Changes surface's source picker and
   * tree grouping (BST-1114 T0). The optional options bag is the only
   * renderer-supplied argument — see {@link validateInventoryOptions}.
   */
  readonly inventory: (options?: unknown) => Promise<GitResult<GitInventory>>;
  /** Undo the newest rewind in a thread — one level, until finalization. */
  readonly redoRewind: (payload: unknown) => Promise<GitResult<AssistantRewindRedoResult>>;
  readonly resolveView: (rootId: unknown, changeset: unknown) => Promise<GitResult<ChangesetView>>;
  /**
   * Pre-apply preview: the run range, the tombstone set, the advisory conflict
   * list, and the EXISTING run-range `ChangesetView` the confirm modal renders.
   */
  readonly rewindPreview: (payload: unknown) => Promise<GitResult<AssistantRewindPreviewResult>>;
}

/** Seams the rewind handlers call. Mirrors `AssistantCheckpointHandlerDependencies`.
 * Since the W7 T3 engine swap the service functions take the snapshot seams
 * too: `applyRewind`/`redoRewind` need the full {@link RewindServiceDeps}
 * (reindex + snapshot service + snapshot repository) and the preview needs
 * the snapshot half ({@link RewindSnapshotDeps}); the handlers compose them
 * from `createRevertDeps` plus the injected snapshot options. */
export interface RewindHandlerDependencies {
  readonly applyRewind: (
    db: EditCheckpointDatabase,
    args: {
      readonly acknowledgeConflicts?: boolean;
      readonly messageId: string;
      readonly mode: AssistantRewindMode;
      readonly threadId: string;
    },
    deps: RewindServiceDeps
  ) => Promise<AssistantRewindResult>;
  /**
   * Resolves the hard-delete seam finalization runs through. Takes no database
   * argument because the store owns its own handle — the production factory
   * builds a `PgliteMemoryStore` over the SAME main-process database, and the
   * narrower `EditCheckpointDatabase` view cannot satisfy it without a cast
   * that would lie about what a test double provides.
   */
  readonly createFinalizationDeps: () => Promise<RewindFinalizationDeps>;
  readonly createRevertDeps: (db: EditCheckpointDatabase) => Promise<CheckpointRevertDeps>;
  readonly finalizeThreadRewinds: (
    db: EditCheckpointDatabase,
    threadId: string,
    deps: RewindFinalizationDeps
  ) => Promise<AssistantRewindFinalization>;
  readonly redoRewind: (
    db: EditCheckpointDatabase,
    args: { readonly acknowledgeConflicts?: boolean; readonly rewindId: string },
    deps: RewindServiceDeps
  ) => Promise<AssistantRewindRedoResult>;
  readonly resolveMessageForRun: (
    db: EditCheckpointDatabase,
    threadId: string,
    runId: string
  ) => Promise<string | null>;
  readonly rewindToMessage: (
    db: EditCheckpointDatabase,
    args: { readonly messageId: string; readonly threadId: string },
    deps: RewindSnapshotDeps
  ) => Promise<AssistantRewindPreviewResult>;
}

const DEFAULT_REWIND_DEPENDENCIES: RewindHandlerDependencies = {
  applyRewind: applyRewindService,
  createFinalizationDeps: async () => createRewindFinalizationDeps(await getDatabase()),
  createRevertDeps: createCheckpointReindexDeps,
  finalizeThreadRewinds: finalizeThreadRewindsService,
  redoRewind: redoRewindService,
  resolveMessageForRun: resolveRewindMessageForRun,
  rewindToMessage: rewindToMessageService,
};

export interface ChangesIpcHandlersOptions {
  /**
   * Snapshot-row repository factory (BST-1164 W7 T1). Threaded by main.ts;
   * consumed by T2's snapshot changeset resolution below (paired with
   * `resolveSnapshotService`) and by the rewind handlers (T3 engine swap) —
   * both through this seam so neither edits main.ts. Defaults to the real
   * factory.
   */
  readonly createSnapshotRepository?: (db: EditCheckpointDatabase) => SnapshotRepository;
  /** Injectable for tests; defaults to a `getDatabase`-backed resolver. */
  readonly resolveDatabase?: () => Promise<EditCheckpointDatabase>;
  /**
   * Lazily resolves the app-lifetime {@link GitInventoryService}. Lazy because
   * the changes domain is registered at module load while the service is only
   * constructed once the app is ready — a value captured eagerly would be
   * permanently `null`. Absence is reported as a visible typed failure, never
   * as an empty inventory (an empty inventory is a real, different fact).
   */
  readonly resolveInventoryService?: () => GitInventoryService | null;
  /** Injectable for tests; defaults to the DB-backed workspace root resolver. */
  readonly resolver?: WorkspaceRootResolver;
  /**
   * Lazily resolves the ONE app-lifetime {@link SnapshotService}
   * (BST-1164 W7 T1). Lazy for the same registration-before-construction
   * reason as `resolveInventoryService`. Threaded by main.ts; consumed by
   * T2's snapshot changeset resolution below and by the rewind handlers (T3
   * engine swap) — a second service must never be constructed. Absence at
   * call time is a VISIBLE typed failure (a wiring bug, not a fallback).
   */
  readonly resolveSnapshotService?: () => SnapshotService | null;
  /**
   * Injectable rewind seam (BST-1115 W5 T4) so the handlers can be unit-tested
   * without a live PGlite or a real filesystem. Production wires the real
   * `rewind-service` functions plus the shared checkpoint reindex deps.
   */
  readonly rewind?: RewindHandlerDependencies;
  /** Injectable for tests; defaults to the real `execFile`-backed runner. */
  readonly run?: GitCommandRunner;
  /**
   * Injectable for tests: bypasses the real deps (`resolveDatabase`/
   * `resolver`/`run` above are ignored when this is provided) so a fake
   * service can prove the handler forwards the VALIDATED, typed changeset.
   */
  readonly service?: ChangesetDiffService;
}

/**
 * Create the `changes` IPC handlers, wiring the real {@link ChangesetDiffService}.
 * Every renderer-supplied argument is `unknown`; this is the narrowing
 * boundary — validation failures return a typed `{ ok: false }` `GitResult`,
 * never a thrown error, mirroring `git-ipc-handlers.ts`'s `withService`.
 */
export function createChangesIpcHandlers(
  options: ChangesIpcHandlersOptions = {}
): ChangesIpcHandlers {
  const resolver = options.resolver ?? createDatabaseRootResolver(getDatabase);
  const resolveDatabase =
    options.resolveDatabase ??
    (async (): Promise<EditCheckpointDatabase> =>
      (await getDatabase()) as unknown as EditCheckpointDatabase);
  const run = options.run ?? execFileGitRunner;
  const resolveInventoryService = options.resolveInventoryService ?? (() => null);
  const rewind = options.rewind ?? DEFAULT_REWIND_DEPENDENCIES;
  const resolveSnapshotService = options.resolveSnapshotService ?? (() => null);
  const createSnapshotRepository =
    options.createSnapshotRepository ?? createSnapshotRepositoryDefault;

  /**
   * The snapshot half of the rewind engine's deps (BST-1164 W7 T3). Resolved
   * per call because the ONE app-lifetime service is constructed after this
   * module registers; its absence at call time is a wiring bug and THROWS —
   * each handler's try/catch turns that into a visible typed failure, never
   * a silent conversation-only degradation of a files-mode rewind.
   */
  const resolveSnapshotEngine = (db: EditCheckpointDatabase): RewindSnapshotDeps => {
    const snapshotService = resolveSnapshotService();
    if (!snapshotService) {
      throw new Error(
        'Conversation Rewind is unavailable: the workspace snapshot service is not running. Restart the app; if this persists it is a wiring bug.'
      );
    }
    return { snapshotRepository: createSnapshotRepository(db), snapshotService };
  };

  const failed = (channel: string, error: unknown): GitResult<never> => {
    logger.error(`Unexpected ${channel} handler failure`, { error });
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  };

  const service: ChangesetDiffService =
    options.service ??
    createChangesetDiffService({
      resolveDatabase,
      resolveRootCwd: (rootId: unknown) => resolveRootCwd(resolver, rootId, 'changes', logger),
      run,
      // W7 T2 (BST-1164): the snapshot engine consumes the T1 injection
      // points. BOTH must be present to wire the engine; a partial pair is a
      // wiring bug and is surfaced as the typed unavailability error the
      // service returns for snapshot-less construction (never a silent
      // journal fallback).
      ...(options.createSnapshotRepository && options.resolveSnapshotService
        ? {
            snapshots: {
              createRepository: options.createSnapshotRepository,
              resolveService: options.resolveSnapshotService,
            },
          }
        : {}),
    });

  return {
    applyRewind: async (payload) => {
      const payloadResult = validateRewindApplyPayload(payload);
      if (!payloadResult.ok) {
        return payloadResult;
      }
      const { acknowledgeConflicts, messageId, mode, threadId } = payloadResult.value;
      try {
        const db = await resolveDatabase();
        const revertDeps = await rewind.createRevertDeps(db);
        return {
          ok: true,
          value: await rewind.applyRewind(
            db,
            { acknowledgeConflicts, messageId, mode, threadId },
            { ...revertDeps, ...resolveSnapshotEngine(db) }
          ),
        };
      } catch (error) {
        return failed('changes:applyRewind', error);
      }
    },
    fileDiff: async (rootId, changeset, path) => {
      const changesetResult = validateChangeset(changeset);
      if (!changesetResult.ok) {
        return changesetResult;
      }
      const pathResult = validatePath(path);
      if (!pathResult.ok) {
        return pathResult;
      }
      try {
        return await service.fileDiff(rootId, changesetResult.value, pathResult.value);
      } catch (error) {
        logger.error('Unexpected changes:fileDiff handler failure', { error });
        return { error: error instanceof Error ? error.message : String(error), ok: false };
      }
    },
    finalizeRewinds: async (payload) => {
      const payloadResult = validateRewindFinalizePayload(payload);
      if (!payloadResult.ok) {
        return payloadResult;
      }
      const { threadId } = payloadResult.value;
      try {
        const db = await resolveDatabase();
        const finalizationDeps = await rewind.createFinalizationDeps();
        return {
          ok: true,
          value: await rewind.finalizeThreadRewinds(db, threadId, finalizationDeps),
        };
      } catch (error) {
        return failed('changes:finalizeRewinds', error);
      }
    },
    inventory: async (options) => {
      const optionsResult = validateInventoryOptions(options);
      if (!optionsResult.ok) {
        return optionsResult;
      }
      const inventoryService = resolveInventoryService();
      if (!inventoryService) {
        return {
          error:
            'changes:inventory is unavailable: the git inventory service is not running. Restart the app; if this persists it is a wiring bug, not an empty workspace.',
          ok: false,
        };
      }
      try {
        const snapshot = await inventoryService.getSnapshot(optionsResult.value);
        // Project to the declared `GitInventory` shape: the snapshot's
        // `capturedAt` is a service-internal cache detail, not part of the
        // renderer contract.
        return {
          ok: true,
          value: { errors: snapshot.errors, repositories: snapshot.repositories },
        };
      } catch (error) {
        logger.error('Unexpected changes:inventory handler failure', { error });
        return { error: error instanceof Error ? error.message : String(error), ok: false };
      }
    },
    redoRewind: async (payload) => {
      const payloadResult = validateRewindRedoPayload(payload);
      if (!payloadResult.ok) {
        return payloadResult;
      }
      const { acknowledgeConflicts, rewindId } = payloadResult.value;
      try {
        const db = await resolveDatabase();
        const revertDeps = await rewind.createRevertDeps(db);
        return {
          ok: true,
          value: await rewind.redoRewind(
            db,
            { acknowledgeConflicts, rewindId },
            { ...revertDeps, ...resolveSnapshotEngine(db) }
          ),
        };
      } catch (error) {
        return failed('changes:redoRewind', error);
      }
    },
    resolveView: async (rootId, changeset) => {
      const changesetResult = validateChangeset(changeset);
      if (!changesetResult.ok) {
        return changesetResult;
      }
      try {
        return await service.resolveView(rootId, changesetResult.value);
      } catch (error) {
        logger.error('Unexpected changes:resolveView handler failure', { error });
        return { error: error instanceof Error ? error.message : String(error), ok: false };
      }
    },
    rewindPreview: async (payload) => {
      const payloadResult = validateRewindPreviewPayload(payload);
      if (!payloadResult.ok) {
        return payloadResult;
      }
      const target = payloadResult.value;
      try {
        const db = await resolveDatabase();
        // A run target resolves to its triggering message here, in the main
        // process, where the runs table lives. An unresolvable run is a VISIBLE
        // domain refusal naming the run — never a fabricated message id.
        let messageId: string;
        if (target.kind === 'message') {
          messageId = target.messageId;
        } else {
          const resolved = await rewind.resolveMessageForRun(db, target.threadId, target.runId);
          if (resolved === null) {
            return {
              ok: true,
              value: {
                conflicts: [],
                message: `no message in thread "${target.threadId}" follows run "${target.runId}"; there is nothing to restore to.`,
                ok: false,
                reason: 'message-not-found',
              },
            };
          }
          messageId = resolved;
        }
        return {
          ok: true,
          value: await rewind.rewindToMessage(
            db,
            { messageId, threadId: target.threadId },
            resolveSnapshotEngine(db)
          ),
        };
      } catch (error) {
        return failed('changes:rewindPreview', error);
      }
    },
  };
}
