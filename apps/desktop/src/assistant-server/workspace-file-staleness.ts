/**
 * Read-before-write staleness tracking for the desktop native tools (BST-743):
 * the scope key, the compare/record helpers, and the single actionable refusal
 * error. Shared by BOTH sides of the contract — the paged `readWorkspaceFile`
 * tool records fresh observations while the file-mutation tools
 * (write/stringReplace/delete/rename) compare against them inside their
 * per-file locks.
 *
 * Leaf module: depends only on node fs and the shared known-file mtime store in
 * `@brainstrike/agent` — never on `assistant-tools.ts`, so no import cycle is
 * possible.
 */
import fsPromises from 'node:fs/promises';
import {
  forgetKnownFile,
  getKnownFileMtime,
  type RuntimeData,
  recordKnownFileMtime,
} from '@brainstrike/agent';

/**
 * Scope key for the read-before-write staleness tracker: one thread's
 * observations never vouch for another's (a subagent thread must read a file
 * itself before its knowledge of it counts as fresh). The DB-less unit tests
 * and any pre-memory call sites fall back to a single shared sentinel scope.
 */
export function readStateScope(runtimeData: RuntimeData | undefined): string {
  return runtimeData?.memory?.threadId ?? '__no-thread__';
}

/**
 * Read-before-write staleness compare (report R8), inside the per-file lock.
 * When `scope` previously observed this file (content-bearing read or its own
 * successful write) and disk now carries a DIFFERENT mtime, someone else
 * changed the file since — refuse with an actionable error instead of
 * overwriting their work (lost-update guard). Never guards a file this scope
 * has no observation for (compare-only contract), and an observed file that
 * has since VANISHED is treated as new — recreating it loses nothing, so the
 * stale observation is dropped and the write proceeds.
 */
export async function assertNoExternalEditSinceObserved(args: {
  scope: string;
  absolutePath: string;
  requestedPath: string;
}): Promise<void> {
  const known = getKnownFileMtime(args.scope, args.absolutePath);
  if (known === undefined) {
    return;
  }
  let stat: import('node:fs').Stats;
  try {
    stat = await fsPromises.stat(args.absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      forgetKnownFile(args.scope, args.absolutePath);
      return;
    }
    throw error;
  }
  if (stat.mtimeMs !== known) {
    throw buildStaleFileError(args.requestedPath);
  }
}

/** The single actionable staleness refusal every edit tool throws (the model's
 * recovery path is always the same: re-read, then retry with fresh content). */
export function buildStaleFileError(requestedPath: string): Error {
  return new Error(
    `File "${requestedPath}" changed on disk since you last read it (someone else edited it). ` +
      'Re-read the file and retry the edit against its current content.'
  );
}

/** Record the post-mutation mtime as this scope's fresh observation, inside the
 * same lock as the write so no concurrent edit can slip between write and stat. */
export async function recordOwnWriteObservation(
  scope: string,
  absolutePath: string
): Promise<void> {
  const stat = await fsPromises.stat(absolutePath);
  recordKnownFileMtime(scope, absolutePath, stat.mtimeMs);
}

/**
 * Rename-source staleness compare (report R8), inside the rename's two-lock
 * critical section. IDENTITY MATTERS: reads record under the realpath'd
 * TARGET, so a symlink source compares the target's key + stat (the link's
 * own path is never recorded); a regular file compares its own lstat. A
 * DANGLING link has no target to compare — nothing observed, nothing guarded.
 */
export async function assertRenameSourceUnchangedSinceObserved(args: {
  fromMutationPath: string;
  fromStats: import('node:fs').Stats;
  requestedFromPath: string;
  runtimeData: RuntimeData | undefined;
  targetAbsolutePath: string;
  threadScope?: string;
}): Promise<void> {
  let compareKey = args.fromMutationPath;
  let sourceMtimeMs: number | undefined = args.fromStats.mtimeMs;
  if (args.fromStats.isSymbolicLink()) {
    compareKey = args.targetAbsolutePath;
    try {
      sourceMtimeMs = (await fsPromises.stat(args.targetAbsolutePath)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      sourceMtimeMs = undefined;
    }
  }
  const known = getKnownFileMtime(args.threadScope ?? readStateScope(args.runtimeData), compareKey);
  if (known !== undefined && sourceMtimeMs !== undefined && known !== sourceMtimeMs) {
    throw buildStaleFileError(args.requestedFromPath);
  }
}
