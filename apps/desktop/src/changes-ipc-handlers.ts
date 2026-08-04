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
import type { EditCheckpointDatabase } from './assistant-server/edit-checkpoint-journal';
import type { GitInventoryService } from './assistant-server/git-inventory-service';
import type { GitCommandRunner } from './assistant-server/git-service';
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

export interface ChangesIpcHandlers {
  readonly fileDiff: (
    rootId: unknown,
    changeset: unknown,
    path: unknown
  ) => Promise<GitResult<StructuredFileDiff>>;
  /**
   * Repository/worktree topology for the Changes surface's source picker and
   * tree grouping (BST-1114 T0). Takes no renderer-supplied arguments, so
   * there is nothing to validate at this boundary.
   */
  readonly inventory: () => Promise<GitResult<GitInventory>>;
  readonly resolveView: (rootId: unknown, changeset: unknown) => Promise<GitResult<ChangesetView>>;
}

export interface ChangesIpcHandlersOptions {
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

  const service: ChangesetDiffService =
    options.service ??
    createChangesetDiffService({
      resolveDatabase,
      resolveRootCwd: (rootId: unknown) => resolveRootCwd(resolver, rootId, 'changes', logger),
      run,
    });

  return {
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
    inventory: async () => {
      const inventoryService = resolveInventoryService();
      if (!inventoryService) {
        return {
          error:
            'changes:inventory is unavailable: the git inventory service is not running. Restart the app; if this persists it is a wiring bug, not an empty workspace.',
          ok: false,
        };
      }
      try {
        const snapshot = await inventoryService.getSnapshot();
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
  };
}
