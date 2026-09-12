/**
 * The file-mutation native tool family (BST-743): writeWorkspaceFile,
 * stringReplaceWorkspaceFile, deleteWorkspaceFile, and renameWorkspaceFile —
 * per-file lock critical sections, read-before-write staleness guards,
 * edit-checkpoint capture, in-lock Workspace Index coherence, and the
 * out-of-lock post-edit LSP diagnostics. Security-sensitive: every path goes
 * through the audited `secure-file-write` containment helpers.
 *
 * Leaf module: depends on the staleness, reindex-side-effect,
 * path-resolution, and checkpoint leaves — never on `assistant-tools.ts`, so
 * no import cycle is possible.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  applyStringReplace,
  type DeleteWorkspaceFileInput,
  forgetKnownFile,
  getKnownFileMtime,
  type RenameWorkspaceFileInput,
  type RuntimeData,
  type RuntimeWorkspaceRoot,
  StringReplaceError,
  type StringReplaceMatchType,
  type StringReplaceWorkspaceFileInput,
  type WriteWorkspaceFileInput,
  withFileLock,
} from '@brainstrike/agent';
import { NATIVE_TOOL_ID, ToolInputError } from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import {
  ensureContainedDirectory,
  resolveWorkspaceWritePath,
  writeContainedFileBytes,
} from '../secure-file-write';
import {
  beforeStateToCapture,
  captureBeforeState,
  recordEditCheckpointForTool,
} from './edit-checkpoint-capture';
import { sha256Hex } from './edit-checkpoint-journal';
import { looksLikeReadWorkspaceFileGutterOutput } from './gutter-prefix-guard';
import { type EditDiagnosticsResult, getEditDiagnostics } from './lsp-diagnostics';
import {
  triggerEditedFileReindex,
  triggerFileDeletionInvalidation,
  triggerRenamedDestinationReindex,
} from './reindex-side-effects';
import {
  EDIT_FAILURE_HINT_MESSAGE,
  editFailureHintApplies,
  recordEditFailure,
  resetEditFailureStreak,
} from './tool-call-loop-guards';
import { REDACTED_PATH_LOG_VALUE, redactToolErrorForLog } from './tool-execute-support';
import {
  assertNoExternalEditSinceObserved,
  assertRenameSourceUnchangedSinceObserved,
  buildStaleFileError,
  readStateScope,
  recordOwnWriteObservation,
} from './workspace-file-staleness';
import { resolveWorkspaceLeafMutationPath } from './workspace-path-resolution';
import { resolveWorkspaceRoot } from './workspace-roots';
import { readWorkspaceTextFile } from './workspace-text-file-reader';

const logger = createLogger('DesktopAssistantTools');

export const MAX_WRITE_WORKSPACE_FILE_BYTES = 2_000_000;

const GUTTER_PREFIX_REFUSAL_MESSAGE =
  'This looks like readWorkspaceFile display output (line-number gutters). Strip the `N: ` prefixes or reconstruct the intended file content before writing.';

function assertNoReadWorkspaceFileGutters(candidate: string): void {
  if (looksLikeReadWorkspaceFileGutterOutput(candidate)) {
    throw new ToolInputError(GUTTER_PREFIX_REFUSAL_MESSAGE);
  }
}

function applyStringReplaceWithLoopGuard(args: {
  readonly fileContent: string;
  readonly newStr: string;
  readonly oldStr: string;
  readonly path: string;
  readonly rootId: string;
  readonly scope: string;
}): ReturnType<typeof applyStringReplace> {
  try {
    return applyStringReplace({
      fileContent: args.fileContent,
      newStr: args.newStr,
      oldStr: args.oldStr,
    });
  } catch (error) {
    if (
      error instanceof StringReplaceError &&
      (error.reason === 'ambiguous' || error.reason === 'not_found')
    ) {
      const failureCount = recordEditFailure(args.scope, args.rootId, args.path);
      if (editFailureHintApplies(failureCount)) {
        // APPEND, never replace: `error.message` carries the fuzzy-matcher's
        // specific diagnostic (matched line numbers, the "diverged after N
        // lines" cascade) — the single most actionable fact for widening
        // oldStr, and precisely what the model has the least ability to
        // guess after two prior failures (PR #2323 review).
        throw new StringReplaceError(error.reason, `${error.message} ${EDIT_FAILURE_HINT_MESSAGE}`);
      }
    }
    throw error;
  }
}

/**
 * Post-edit LSP diagnostics (report R2 Phase A), run AFTER the per-file lock
 * releases so a language-server round-trip never extends the write's critical
 * section. ALWAYS non-fatal: diagnostics must never fail an already-applied
 * edit. Returns undefined for unsupported languages (no note spam on every
 * markdown/json edit); for supported languages it returns the honest result
 * (diagnostics, or an available:false note when the server is unavailable/
 * timed out) for the tool to attach to its result.
 */
async function collectEditDiagnostics(args: {
  root: RuntimeWorkspaceRoot;
  absolutePath: string;
  content: string;
}): Promise<EditDiagnosticsResult | undefined> {
  try {
    const result = await getEditDiagnostics({
      absolutePath: args.absolutePath,
      content: args.content,
      rootId: args.root.rootId,
      rootPath: args.root.path,
    });
    return result.reason === 'unsupported-language' ? undefined : result;
  } catch (error) {
    logger.error('Post-edit LSP diagnostics failed; edit still applied', {
      error: redactToolErrorForLog(error),
      path: REDACTED_PATH_LOG_VALUE,
    });
    return;
  }
}

/** Stop prevents a queued mutation from starting. Once a filesystem mutation
 * starts, its normal checkpoint/index settlement must finish before releasing
 * the lock; cancellation must not erase or leave completed work unattributed. */
function assertFileMutationActive(
  runtimeData: RuntimeData | undefined,
  signal: AbortSignal | undefined
): void {
  runtimeData?.signal?.throwIfAborted();
  signal?.throwIfAborted();
}

export async function runWriteWorkspaceFile(
  input: WriteWorkspaceFileInput,
  runtimeData: RuntimeData | undefined,
  toolCallId?: string,
  executionThreadId?: string,
  signal?: AbortSignal
): Promise<{
  rootName: string;
  rootId: string;
  path: string;
  bytesWritten: number;
  created: boolean;
  lsp?: EditDiagnosticsResult;
}> {
  assertFileMutationActive(runtimeData, signal);
  const threadScope = executionThreadId ?? readStateScope(runtimeData);
  // Cheap bounded size check FIRST (PR #2352 review): an over-limit payload
  // is rejected before it pays for the gutter guard's `split('\n')` pass —
  // both are pure pre-lock validations, so the ordering only affects how
  // much work an already-doomed oversized write does before failing.
  const buffer = Buffer.from(input.content, 'utf8');
  if (buffer.byteLength > MAX_WRITE_WORKSPACE_FILE_BYTES) {
    throw new Error(
      `Content for "${input.path}" is ${buffer.byteLength} bytes, exceeding the ${MAX_WRITE_WORKSPACE_FILE_BYTES} byte write limit.`
    );
  }
  assertNoReadWorkspaceFileGutters(input.content);

  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const resolved = await resolveWorkspaceWritePath(root.path, input.path);

  // Serialize same-file writes against concurrent edits (Mastra runs tool calls
  // within a step concurrently). Key by the canonical absolute path so two edits
  // to the same file can never interleave and lose an update. The re-index runs
  // INSIDE the lock so the write + the re-index-enqueue are one atomic critical
  // section per file: a concurrent edit can never slip its newer bytes (and
  // mtime) between this write and its re-index, which would otherwise leave the
  // RAG row stale relative to disk. `triggerEditedFileReindex` is already
  // non-fatal (it catches+logs internally), so it never extends the lock's
  // failure surface.
  const scope = threadScope;
  const { created } = await withFileLock(resolved.absolutePath, async () => {
    // Staleness compare INSIDE the lock (report R8): if this scope observed the
    // file at a different mtime than disk carries now, someone else edited it
    // since — refuse instead of overwriting their work. New/unobserved files
    // pass untouched.
    await assertNoExternalEditSinceObserved({
      absolutePath: resolved.absolutePath,
      requestedPath: input.path,
      scope,
    });
    // Capture the before-identity (existence + hash) for the attribution
    // ledger INSIDE the lock so no concurrent same-file edit can slip newer
    // bytes between capture and write.
    const beforeState = await captureBeforeState(resolved.absolutePath);
    assertFileMutationActive(runtimeData, signal);
    const writeResult = await writeContainedFileBytes({
      buffer,
      requestedPath: input.path,
      resolved,
    });
    // A full-rewrite is the recovery path the edit-failure hint itself
    // recommends (BST-1188) — it must clear the path's stringReplace failure
    // streak too, or the NEXT unrelated stringReplace miss on this path still
    // gets the escalated message even though the model just took the
    // suggested recovery action (PR #2323 review).
    resetEditFailureStreak(scope, root.rootId, resolved.workspacePath);
    // Our own write is the scope's freshest observation — consecutive writes
    // must never trip the guard on themselves.
    await recordOwnWriteObservation(scope, resolved.absolutePath);
    await triggerEditedFileReindex({
      absolutePath: resolved.absolutePath,
      content: input.content,
      rootId: root.rootId,
      runtimeData,
      size: buffer.byteLength,
      workspacePath: resolved.workspacePath,
    });
    await recordEditCheckpointForTool({
      afterExisted: true,
      afterHash: sha256Hex(buffer),
      before: beforeStateToCapture(beforeState),
      executionThreadId,
      op: 'write',
      path: resolved.workspacePath,
      rootId: root.rootId,
      runtimeData,
      toolCallId,
      toolName: NATIVE_TOOL_ID.writeWorkspaceFile,
    });
    return writeResult;
  });

  // Diagnose OUTSIDE the lock (report R2): a language-server round-trip must
  // not extend the write's critical section. Non-fatal.
  const lsp = await collectEditDiagnostics({
    absolutePath: resolved.absolutePath,
    content: input.content,
    root,
  });

  return {
    bytesWritten: buffer.byteLength,
    created,
    path: resolved.workspacePath,
    rootId: root.rootId,
    rootName: root.displayName,
    ...(lsp ? { lsp } : {}),
  };
}

export async function runStringReplaceWorkspaceFile(
  input: StringReplaceWorkspaceFileInput,
  runtimeData: RuntimeData | undefined,
  toolCallId?: string,
  executionThreadId?: string,
  signal?: AbortSignal
): Promise<{
  rootName: string;
  rootId: string;
  path: string;
  bytesWritten: number;
  matchType: StringReplaceMatchType;
  replaced: true;
  lsp?: EditDiagnosticsResult;
}> {
  assertFileMutationActive(runtimeData, signal);
  const threadScope = executionThreadId ?? readStateScope(runtimeData);
  assertNoReadWorkspaceFileGutters(input.newStr);
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  // Resolve the write path up front so we can lock on the canonical absolute
  // path. resolveWorkspaceWritePath clamps ".." and contains symlinked
  // ancestors; the read below uses the same containment as the read tools.
  const resolved = await resolveWorkspaceWritePath(root.path, input.path);

  // The whole read-modify-write-AND-reindex cycle runs under the per-file lock so
  // a concurrent edit (another stringReplace, or a writeWorkspaceFile) to the
  // SAME file cannot interleave and drop an update or stale the RAG row. Edits to
  // different files still run in parallel.
  const scope = threadScope;
  const result = await withFileLock(resolved.absolutePath, async () => {
    // Read through the SAME checked read path the read tools use (isFile, 2 MB
    // byte cap, NUL-byte binary probe, realpath-both-sides containment), so the
    // edit inherits PR-2.1's path-escape protection on the read side too.
    let file: Awaited<ReturnType<typeof readWorkspaceTextFile>>;
    try {
      file = await readWorkspaceTextFile({
        requestedPath: input.path,
        rootPath: root.path,
      });
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new ToolInputError(
          'stringReplaceWorkspaceFile edits only an existing file. Use writeWorkspaceFile to create the new file.'
        );
      }
      throw error;
    }

    // Staleness compare (report R8): oldStr/newStr were crafted from what this
    // scope last observed. If disk moved past that observation, applying the
    // replacement risks semantically clobbering someone else's edit — refuse
    // and make the model re-read. Unobserved files pass (compare-only).
    const known = getKnownFileMtime(scope, resolved.absolutePath);
    if (known !== undefined && known !== file.mtimeMs) {
      throw buildStaleFileError(input.path);
    }

    // Pure fuzzy-match cascade. THROWS StringReplaceError on ambiguous/not-found
    // matches — never applies a low-confidence edit (no silent fallbacks).
    const replacement = applyStringReplaceWithLoopGuard({
      fileContent: file.content,
      newStr: input.newStr,
      oldStr: input.oldStr,
      path: resolved.workspacePath,
      rootId: root.rootId,
      scope,
    });

    const buffer = Buffer.from(replacement.newContent, 'utf8');
    if (buffer.byteLength > MAX_WRITE_WORKSPACE_FILE_BYTES) {
      throw new Error(
        `Edited content for "${input.path}" is ${buffer.byteLength} bytes, exceeding the ${MAX_WRITE_WORKSPACE_FILE_BYTES} byte write limit.`
      );
    }

    assertFileMutationActive(runtimeData, signal);
    await writeContainedFileBytes({ buffer, requestedPath: input.path, resolved });
    resetEditFailureStreak(scope, root.rootId, resolved.workspacePath);
    // Our own write is the scope's freshest observation — a follow-up edit in
    // the same thread must never trip the guard on it.
    await recordOwnWriteObservation(scope, resolved.absolutePath);

    // Journal the attribution row: the file existed (the checked reader just
    // read it), so this is an `ok` identity capture — hash + size, no content
    // (restores come from the turn-start snapshot).
    const beforeBuffer = Buffer.from(file.content, 'utf8');
    await recordEditCheckpointForTool({
      afterExisted: true,
      afterHash: sha256Hex(buffer),
      before: {
        beforeExisted: true,
        beforeHash: sha256Hex(beforeBuffer),
        beforeSize: beforeBuffer.byteLength,
        captureStatus: 'ok',
      },
      executionThreadId,
      op: 'string_replace',
      path: resolved.workspacePath,
      rootId: root.rootId,
      runtimeData,
      toolCallId,
      toolName: NATIVE_TOOL_ID.stringReplaceWorkspaceFile,
    });

    // Keep the RAG index coherent: re-index the edited file INSIDE the same
    // per-file critical section as the read-modify-write. Running it after the
    // lock released reopened the very race the lock closes — a concurrent edit
    // could land its newer bytes (and mtime) between this write and its
    // re-index, leaving the file_records row stale relative to disk and
    // self-healing-proof (matching mtime skips the next sync's re-read). No-ops
    // when the file isn't part of the Workspace Index; already non-fatal (it
    // catches+logs internally), so it never undoes a successful edit nor
    // extends the lock's failure surface.
    await triggerEditedFileReindex({
      absolutePath: resolved.absolutePath,
      content: replacement.newContent,
      rootId: root.rootId,
      runtimeData,
      size: buffer.byteLength,
      workspacePath: resolved.workspacePath,
    });

    return {
      bytesWritten: buffer.byteLength,
      matchType: replacement.matchType,
      newContent: replacement.newContent,
    };
  });

  // Diagnose OUTSIDE the lock (report R2), against the just-written content.
  const lsp = await collectEditDiagnostics({
    absolutePath: resolved.absolutePath,
    content: result.newContent,
    root,
  });

  return {
    bytesWritten: result.bytesWritten,
    matchType: result.matchType,
    path: resolved.workspacePath,
    replaced: true,
    rootId: root.rootId,
    rootName: root.displayName,
    ...(lsp ? { lsp } : {}),
  };
}

/**
 * Acquire the per-file write lock for BOTH `keyA` and `keyB` before running
 * `task`, releasing both afterward. The two locks are acquired in sorted order so
 * two concurrent renames touching an overlapping pair of paths always take them
 * in the SAME order and can never deadlock (classic lock-ordering). Same-key
 * pairs (a no-op self-rename) collapse to a single lock.
 */
export function withTwoFileLocks<T>(
  keyA: string,
  keyB: string,
  task: () => Promise<T>
): Promise<T> {
  if (keyA === keyB) {
    return withFileLock(keyA, task);
  }
  const [first, second] = keyA < keyB ? [keyA, keyB] : [keyB, keyA];
  return withFileLock(first, () => withFileLock(second, task));
}

export async function runDeleteWorkspaceFile(
  input: DeleteWorkspaceFileInput,
  runtimeData: RuntimeData | undefined,
  toolCallId?: string,
  executionThreadId?: string,
  signal?: AbortSignal
): Promise<{
  ok: true;
  path: string;
  rootName: string;
  indexInvalidated: boolean;
}> {
  assertFileMutationActive(runtimeData, signal);
  const threadScope = executionThreadId ?? readStateScope(runtimeData);
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  // Same path hardening as the write tools: clamps "..", contains symlinked
  // ancestors, and rejects the workspace root itself. A LIVE symlink whose target
  // escapes the root is refused here (realpath-then-containment). The delete +
  // index invalidation run inside the per-file lock so a concurrent edit to the
  // same path cannot interleave.
  const resolved = await resolveWorkspaceWritePath(root.path, input.path);
  // Act on the LINK itself, not its resolved target: deleting a symlink must
  // remove the pointer and leave the target intact (resolved.absolutePath is the
  // TARGET for a live in-root symlink).
  const mutationPath = await resolveWorkspaceLeafMutationPath(
    resolved.canonicalRootPath,
    resolved.requestedAbsolutePath,
    input.path
  );

  return withFileLock(mutationPath, async () => {
    let leafStats: import('node:fs').Stats;
    try {
      leafStats = await fsPromises.lstat(mutationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Path "${input.path}" does not exist.`);
      }
      throw error;
    }
    // A symlink leaf (live or dangling) is deleted AS A LINK — `unlink` removes
    // the pointer, never the target. Only a REAL directory is refused (lstat does
    // not follow the leaf, so a symlink-to-directory reports isDirectory() false).
    if (leafStats.isDirectory()) {
      throw new Error(
        `Path "${input.path}" is a directory. Deleting directories is not supported — use executeCommand for that.`
      );
    }

    // Capture the before-identity for the attribution ledger BEFORE
    // unlinking; the undo recreates the file from the turn-start snapshot.
    const beforeState = await captureBeforeState(mutationPath);
    assertFileMutationActive(runtimeData, signal);
    await fsPromises.unlink(mutationPath);
    // Drop the staleness observation with the file so a later re-creation at
    // this path is treated as new, not compared against a ghost.
    forgetKnownFile(threadScope, mutationPath);
    const { invalidated } = await triggerFileDeletionInvalidation({
      rootId: root.rootId,
      runtimeData,
      workspacePath: resolved.workspacePath,
    });
    await recordEditCheckpointForTool({
      afterExisted: false,
      afterHash: null,
      before: beforeStateToCapture(beforeState),
      executionThreadId,
      op: 'delete',
      path: resolved.workspacePath,
      rootId: root.rootId,
      runtimeData,
      toolCallId,
      toolName: NATIVE_TOOL_ID.deleteWorkspaceFile,
    });

    return {
      indexInvalidated: invalidated,
      ok: true,
      path: resolved.workspacePath,
      rootName: root.displayName,
    };
  });
}

export async function runRenameWorkspaceFile(
  input: RenameWorkspaceFileInput,
  runtimeData: RuntimeData | undefined,
  toolCallId?: string,
  executionThreadId?: string,
  signal?: AbortSignal
): Promise<{
  ok: true;
  fromPath: string;
  toPath: string;
  rootName: string;
  indexInvalidated: boolean;
}> {
  assertFileMutationActive(runtimeData, signal);
  const threadScope = executionThreadId ?? readStateScope(runtimeData);
  const root = resolveWorkspaceRoot(runtimeData, input.root);
  const fromResolved = await resolveWorkspaceWritePath(root.path, input.fromPath);
  const toResolved = await resolveWorkspaceWritePath(root.path, input.toPath);
  // Both paths resolve against the SAME single `root`, so a cross-root move is not
  // expressible through this schema; assert equal canonical roots as defense in
  // depth (never silently accept a cross-root move).
  if (fromResolved.canonicalRootPath !== toResolved.canonicalRootPath) {
    throw new Error(
      'Cross-root moves are not supported. Both paths must be in the same open folder.'
    );
  }
  // Act on the LINK itself for the source: renaming a symlink must move the
  // pointer and leave its target intact (fromResolved.absolutePath is the TARGET
  // for a live in-root symlink). A live symlink whose target escapes the root is
  // already refused above by resolveWorkspaceWritePath.
  const fromMutationPath = await resolveWorkspaceLeafMutationPath(
    fromResolved.canonicalRootPath,
    fromResolved.requestedAbsolutePath,
    input.fromPath
  );
  if (fromMutationPath === toResolved.absolutePath) {
    throw new Error(
      `fromPath and toPath resolve to the same file "${toResolved.workspacePath}"; nothing to rename.`
    );
  }

  // Lock BOTH paths (sorted order → deadlock-free) so a concurrent edit or rename
  // touching either path cannot interleave with this move.
  return withTwoFileLocks(fromMutationPath, toResolved.absolutePath, async () => {
    let fromStats: import('node:fs').Stats;
    try {
      fromStats = await fsPromises.lstat(fromMutationPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Path "${input.fromPath}" does not exist.`);
      }
      throw error;
    }
    // A symlink source is moved AS A LINK (rename(2) does not follow the final
    // component). Only a REAL directory is refused.
    if (fromStats.isDirectory()) {
      throw new Error(
        `Path "${input.fromPath}" is a directory. Renaming directories is not supported — use executeCommand for that.`
      );
    }

    // Staleness compare (report R8): a rename decided against a stale view of
    // the source (someone rewrote it since this scope read it) is refused the
    // same way an edit is. Unobserved sources pass (compare-only).
    const sourceIsSymlink = fromStats.isSymbolicLink();
    await assertRenameSourceUnchangedSinceObserved({
      fromMutationPath,
      fromStats,
      requestedFromPath: input.fromPath,
      runtimeData,
      targetAbsolutePath: fromResolved.absolutePath,
      threadScope,
    });

    // Destination must NOT already exist (no overwrite in v1). lstat so a symlink
    // at the destination also counts as "exists".
    let destinationExists = true;
    try {
      await fsPromises.lstat(toResolved.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      destinationExists = false;
    }
    if (destinationExists) {
      throw new Error(
        `Destination "${input.toPath}" already exists. Delete it first or choose another path (rename does not overwrite).`
      );
    }

    // Create any missing destination parent directories one component at a time,
    // rejecting symlinked intermediates (a plain mkdir -p would traverse them).
    await ensureContainedDirectory(
      toResolved.canonicalRootPath,
      path.dirname(toResolved.absolutePath)
    );

    assertFileMutationActive(runtimeData, signal);
    await fsPromises.rename(fromMutationPath, toResolved.absolutePath);

    // Move the observation with the file. Regular file: the source path is
    // gone; the destination (content unchanged — rename preserves mtime) is
    // this scope's freshest view of it. Symlink: only the LINK moved — the
    // target file and its (realpath-keyed) observation stay valid, and the
    // destination stat would follow the link (or throw on a dangling one), so
    // no destination record is made.
    forgetKnownFile(threadScope, fromMutationPath);
    if (!sourceIsSymlink) {
      await recordOwnWriteObservation(threadScope, toResolved.absolutePath);
    }

    // Index coherence: invalidate the SOURCE rows immediately (the differentiator
    // vs a shell mv). `indexInvalidated` reflects that source removal. The
    // DESTINATION is re-indexed through the edit seam, which no-ops for a
    // brand-new path — a not-previously-indexed destination's row is imported by
    // the background workspace sync (the documented staleness window: the moved
    // file is searchable via the live grep pass immediately, and via the semantic
    // index once the next sync imports it).
    const { invalidated } = await triggerFileDeletionInvalidation({
      rootId: root.rootId,
      runtimeData,
      workspacePath: fromResolved.workspacePath,
    });
    await triggerRenamedDestinationReindex({
      absolutePath: toResolved.absolutePath,
      rootId: root.rootId,
      rootPath: root.path,
      runtimeData,
      workspacePath: toResolved.workspacePath,
    });

    // Journal the attribution row: a rename has no content change; the undo
    // restores the source and deletes the destination from the turn-start
    // snapshot. fromPath = original source. The DESTINATION's content hash IS
    // recorded (same bytes the rename moved): the undo's conflict gate needs
    // it to detect post-rename user edits before deleting the destination —
    // a null hash on a present path reads as unverifiable ⇒ conflict there.
    // For a symlink source, `captureBeforeState` stats THROUGH the link, the
    // same way the gate's own disk read follows it (consistent identity); a
    // dangling link hashes as absent ⇒ null ⇒ the gate stays fail-safe.
    const afterState = await captureBeforeState(toResolved.absolutePath);
    await recordEditCheckpointForTool({
      afterExisted: true,
      afterHash: afterState.kind === 'present' ? afterState.hash : null,
      before: {
        beforeExisted: true,
        beforeHash: null,
        beforeSize: null,
        captureStatus: 'rename',
      },
      executionThreadId,
      fromPath: fromResolved.workspacePath,
      op: 'rename',
      path: toResolved.workspacePath,
      rootId: root.rootId,
      runtimeData,
      toolCallId,
      toolName: NATIVE_TOOL_ID.renameWorkspaceFile,
    });

    return {
      fromPath: fromResolved.workspacePath,
      indexInvalidated: invalidated,
      ok: true,
      rootName: root.displayName,
      toPath: toResolved.workspacePath,
    };
  });
}
