/**
 * The agent host's `changes/*` methods (BST-1113, ADR-0029 stage 2).
 *
 * `resolveView` resolves any `Changeset` (agent-run / run-range / git-scope)
 * to an eager `ChangesetView`; `fileDiff` loads one file's
 * `StructuredFileDiff` lazily. Both accept `unknown` renderer-supplied
 * arguments (the client boundary is untrusted, same as `git-methods.ts`) —
 * `validateChangeset`/`validatePath` structurally narrow the payload before
 * it ever reaches `ChangesetDiffService`, which only ever sees typed values.
 *
 * Every failure is a visible, typed `BoundaryResult` — never a thrown bare
 * `Error`, never a silent coercion of a malformed payload. Unknown `kind`s
 * and unsupported/extra keys are rejected explicitly, mirroring
 * `git-structured-diff.ts`'s `validateStructuredFileDiffParams` posture.
 */
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { createLogger } from '@brainstrike/logging';
import type {
  Changeset,
  ChangesetView,
  GitInventory,
  GitScope,
  StructuredFileDiff,
} from '@brainstrike/types';
import { resolveRootCwd, type WorkspaceRootResolver } from '../workspace-root-cwd.ts';
import { type ChangesetDiffService, createChangesetDiffService } from './changeset-diff-service.ts';
import type { HostThreadTurns } from './changeset-host-turns.ts';
import { gitInvalid, gitRefused, gitThrew } from './git-failure.ts';
import type { GitInventoryService } from './git-inventory-service.ts';
import { execFileGitRunner } from './git-methods.ts';
import type { GitCommandRunner } from './git-service.ts';
import type { SnapshotService } from './snapshot-service.ts';

const logger = createLogger('ChangesMethods');

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
): BoundaryResult<true> {
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(record).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    return gitInvalid(`${subject} does not accept: ${unsupported.join(', ')}`);
  }
  return { ok: true, value: true };
}

/** Structurally validate a `git-scope` changeset's `scope` object. */
function validateGitScope(value: unknown): BoundaryResult<GitScope> {
  if (!(value && typeof value === 'object') || Array.isArray(value)) {
    return gitInvalid('git-scope changeset requires scope to be an object');
  }
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (!isGitScopeKind(kind)) {
    const allowed = GIT_SCOPE_KINDS.map((candidate) => `"${candidate}"`).join(', ');
    return gitInvalid(
      `git-scope scope.kind must be one of ${allowed} (received "${String(kind)}")`
    );
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
      return gitInvalid('git-scope scope kind "commit" requires a non-empty commitId');
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
      return gitInvalid(
        'git-scope scope kind "branch-vs-base" baseRef must be a non-empty string when present'
      );
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
function validateAgentRunChangeset(record: Record<string, unknown>): BoundaryResult<Changeset> {
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
    return gitInvalid('changeset kind "agent-run" requires a non-empty runId');
  }
  if (!isNonEmptyString(threadId)) {
    return gitInvalid('changeset kind "agent-run" requires a non-empty threadId');
  }
  return { ok: true, value: { kind: 'agent-run', runId, threadId } };
}

/** Structurally validate a `run-range` changeset payload. */
function validateRunRangeChangeset(record: Record<string, unknown>): BoundaryResult<Changeset> {
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
    return gitInvalid('changeset kind "run-range" requires a non-empty fromRunId');
  }
  if (!isNonEmptyString(threadId)) {
    return gitInvalid('changeset kind "run-range" requires a non-empty threadId');
  }
  if (toRunId !== undefined && !isNonEmptyString(toRunId)) {
    return gitInvalid('changeset kind "run-range" toRunId must be a non-empty string when present');
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
function validateGitScopeChangeset(record: Record<string, unknown>): BoundaryResult<Changeset> {
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
    return gitInvalid('changeset kind "git-scope" requires a non-empty repositoryRoot');
  }
  if (!isNonEmptyString(worktreePath)) {
    return gitInvalid('changeset kind "git-scope" requires a non-empty worktreePath');
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
export function validateChangeset(value: unknown): BoundaryResult<Changeset> {
  if (!(value && typeof value === 'object') || Array.isArray(value)) {
    return gitInvalid('changeset payload must be an object with an explicit kind');
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
  return gitInvalid(
    `changeset kind must be "agent-run", "run-range", or "git-scope" (received "${String(kind)}")`
  );
}

/** Structurally validate a renderer-supplied `path` argument. */
export function validatePath(value: unknown): BoundaryResult<string> {
  if (!isNonEmptyString(value)) {
    return gitInvalid('changes:fileDiff requires a non-empty path');
  }
  return { ok: true, value };
}

// ===== Conversation Rewind (BST-1115 W5 T4) =====
//
// TWO LEVELS OF FAILURE, deliberately not collapsed into one:
//   - `BoundaryResult.ok === false` means THE CALL failed — a malformed renderer
//     payload, or an unexpected throw. Same posture as `resolveView`/
//     `fileDiff`: a typed failure, never a thrown bare `Error`.
//   - `BoundaryResult.value.ok === false` means the rewind was REFUSED for a domain
//     reason the service names (`conflicts-unacknowledged`, `message-not-found`,
//     …). That is a real answer, not an error, and the UI must show it.
// Flattening the two would make "your payload was garbage" indistinguishable
// from "one file conflicts and nothing was applied".

function asRecord(value: unknown, subject: string): BoundaryResult<Record<string, unknown>> {
  if (!(value && typeof value === 'object') || Array.isArray(value)) {
    return gitInvalid(`${subject} requires an object payload`);
  }
  return { ok: true, value: value as Record<string, unknown> };
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
function validateInventoryOptions(value: unknown): BoundaryResult<{ readonly maxAgeMs?: number }> {
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
    return gitInvalid(`${subject} requires maxAgeMs to be an integer >= 0`);
  }
  return { ok: true, value: { maxAgeMs } };
}

export interface ChangesMethods {
  readonly fileDiff: (
    rootId: unknown,
    changeset: unknown,
    path: unknown
  ) => Promise<BoundaryResult<StructuredFileDiff>>;
  readonly inventory: (options?: unknown) => Promise<BoundaryResult<GitInventory>>;
  readonly resolveView: (
    rootId: unknown,
    changeset: unknown
  ) => Promise<BoundaryResult<ChangesetView>>;
}

export interface ChangesMethodsOptions {
  readonly hostThreadTurns?: HostThreadTurns;
  readonly resolveInventoryService?: () => GitInventoryService | null;
  readonly resolver?: WorkspaceRootResolver;
  readonly resolveSnapshotService?: () => SnapshotService | null;
  readonly run?: GitCommandRunner;
  readonly service?: ChangesetDiffService;
}

/**
 * Create the `changes` methods, wiring the real {@link ChangesetDiffService}.
 * Every renderer-supplied argument is `unknown`; this is the narrowing
 * boundary — validation failures return a typed `{ ok: false }` `BoundaryResult`,
 * never a thrown error, mirroring `git-methods.ts`'s `withService`.
 */
export function createChangesMethods(options: ChangesMethodsOptions): ChangesMethods {
  const resolver = options.resolver;
  const run = options.run ?? execFileGitRunner;
  const resolveInventoryService = options.resolveInventoryService ?? (() => null);

  const service: ChangesetDiffService =
    options.service ??
    createChangesetDiffService({
      resolveRootCwd: (rootId: unknown) => {
        if (!resolver) {
          throw new Error('The workspace root catalog is unavailable.');
        }
        return resolveRootCwd(resolver, rootId, 'changes', logger);
      },
      run,
      // W7 T2 (BST-1164): the snapshot engine consumes the T1 injection
      // points. BOTH must be present to wire the engine; a partial pair is a
      // wiring bug and is surfaced as the typed unavailability error the
      // service returns for snapshot-less construction (never a silent
      // journal fallback).
      ...(options.hostThreadTurns && options.resolveSnapshotService
        ? {
            snapshots: {
              hostThreads: options.hostThreadTurns,
              resolveService: options.resolveSnapshotService,
            },
          }
        : {}),
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
        return gitThrew(error);
      }
    },
    inventory: async (options) => {
      const optionsResult = validateInventoryOptions(options);
      if (!optionsResult.ok) {
        return optionsResult;
      }
      const inventoryService = resolveInventoryService();
      if (!inventoryService) {
        return gitRefused(
          'availability',
          'changes.inventory-unavailable',
          'The git inventory service is not running. Restart the app; if this persists it is a wiring bug, not an empty workspace.'
        );
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
        return gitThrew(error);
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
        return gitThrew(error);
      }
    },
  };
}
