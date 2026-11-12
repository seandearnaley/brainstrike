/**
 * ADR-0034 decision 7: a repository keeps at most 15 idle managed worktrees.
 *
 * After a worktree is created for a thread, the oldest idle worktrees of its
 * repository beyond 15 are archived through the worktree service's own
 * serialized archive, which keeps each one's snapshot ref, and the thread is
 * told which. "Idle" is no thread bound to it: no existing thread's binding
 * names it as its worktree or as any of its folders. The worktree just made
 * is its creator's and is never counted. Oldest is the ledger's `created_at`.
 *
 * The cap starts as the creation returns, which never waits on it, runs one
 * cap at a time, and logs a failure with its repository and worktree. A
 * creation that names no thread, or whose thread is gone, has no one to tell,
 * so it runs no cap; the repository's next creation for a thread does.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { HostIdleWorktreeArchive } from '@brainstrike/agent-host';
import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import type { ThreadWorkspaceBinding } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { createLogger } from '@brainstrike/logging';
import type {
  ManagedWorktreeRow,
  WorktreeArchiveResult,
  WorktreeCreateParams,
} from '@brainstrike/types';
import { IDLE_ARCHIVE_LEFT_IN_PLACE } from './worktree-idle-archive.ts';
import { isPathWithin } from './worktree-paths.ts';
import { createMutex, type WorktreeArchiveParams } from './worktree-service-inputs.ts';

const logger = createLogger('IdleWorktreeCap');

/** Owner decision 2026-11-12: idle managed worktrees a repository keeps. */
export const IDLE_WORKTREE_CAP = 15;

export interface IdleWorktreeCapDeps {
  /** The worktree service's serialized archive, which the cap calls with `idleCap`. */
  readonly archive: (
    params: WorktreeArchiveParams
  ) => Promise<BoundaryResult<WorktreeArchiveResult>>;
  /** A repository's ledger rows, archived ones too. */
  readonly listRepository: (repoCommonDir: string) => Promise<readonly ManagedWorktreeRow[]>;
  /** Tells the thread a creation was for which worktrees the cap archived. */
  readonly publish: (archive: HostIdleWorktreeArchive) => void;
  /** Every recorded folder, closed ones too: a binding names its folders by root id. */
  readonly readRoots: () => Promise<
    readonly { readonly canonicalPath: string; readonly id: string; readonly path: string }[]
  >;
  /** Every existing thread with its committed binding; a deleted thread is not listed. */
  readonly readThreads: () => Promise<
    readonly { readonly binding: ThreadWorkspaceBinding | null; readonly threadId: string }[]
  >;
}

export interface IdleWorktreeCap {
  /**
   * The worktree service's `afterCreate`: starts the cap for a creation for a thread. Settles
   * when that cap has finished, and never rejects: a failure is logged.
   */
  readonly afterCreate: (
    worktree: ManagedWorktreeRow,
    params: WorktreeCreateParams
  ) => Promise<void>;
  /** Starts no further cap, then waits for the ones in flight. */
  close(): Promise<void>;
}

/** The worktrees the bindings name: as a thread's worktree, or by the path of any of its folders. */
interface BindingClaims {
  readonly ids: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
}

function bindingClaims(
  threads: Awaited<ReturnType<IdleWorktreeCapDeps['readThreads']>>,
  roots: Awaited<ReturnType<IdleWorktreeCapDeps['readRoots']>>
): BindingClaims {
  const rootPaths = new Map(roots.map((root) => [root.id, [root.path, root.canonicalPath]]));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const { binding } of threads) {
    if (!binding) {
      continue;
    }
    if (binding.checkoutWorktreeId) {
      ids.add(binding.checkoutWorktreeId);
    }
    const folders = [
      binding.operatingRootId,
      binding.checkoutLocalRootId,
      ...(binding.secondaryRootIds ?? []),
    ].flatMap((rootId) => (rootId ? (rootPaths.get(rootId) ?? []) : []));
    for (const folder of [binding.checkoutWorktreePath, binding.operatingRootPath, ...folders]) {
      if (folder) {
        paths.add(folder);
      }
    }
  }
  return { ids, paths };
}

/**
 * Whether a binding claims the worktree: as a thread's worktree, or by a folder that is the
 * worktree or lies inside it (a folder within a worktree, opened on its own, is the worktree's
 * files). Compared by the ledger's path and by its realpath, since a binding's folders carry
 * both the path they were opened by and its canonical form.
 */
async function claimed(claims: BindingClaims, row: ManagedWorktreeRow): Promise<boolean> {
  if (claims.ids.has(row.id)) {
    return true;
  }
  const worktreePaths = [row.path, await realpath(row.path).catch(() => row.path)];
  for (const folder of claims.paths) {
    if (worktreePaths.some((worktreePath) => isPathWithin(folder, worktreePath))) {
      return true;
    }
  }
  return false;
}

/** Newest first: `created_at`, then id, as the ledger lists a repository. */
function newestFirst(left: ManagedWorktreeRow, right: ManagedWorktreeRow): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? 1 : -1;
  }
  return left.id < right.id ? 1 : -1;
}

export function createIdleWorktreeCap(deps: IdleWorktreeCapDeps): IdleWorktreeCap {
  const turn = createMutex();
  const pending = new Set<Promise<void>>();
  let closing = false;

  const readClaims = async (): Promise<BindingClaims> => {
    const [threads, roots] = await Promise.all([deps.readThreads(), deps.readRoots()]);
    return bindingClaims(threads, roots);
  };

  /** One idle worktree through the service's archive; undefined when it stays. */
  async function archiveOne(
    row: ManagedWorktreeRow
  ): Promise<HostIdleWorktreeArchive['worktrees'][number] | undefined> {
    const context = { repoCommonDir: row.repoCommonDir, worktreeId: row.id };
    const outcome = await deps.archive({
      idleCap: { isBound: async () => claimed(await readClaims(), row) },
      worktreeId: row.id,
    });
    if (!outcome.ok) {
      if (IDLE_ARCHIVE_LEFT_IN_PLACE.has(outcome.error.code)) {
        logger.info('The idle-worktree cap left a worktree', { ...context, reason: outcome.error });
      } else {
        logger.error('The idle-worktree cap could not archive a worktree', {
          ...context,
          error: outcome.error,
        });
      }
      return;
    }
    const { snapshotRef, worktree } = outcome.value;
    return {
      branch: worktree.branch,
      name: path.basename(worktree.path),
      snapshotRef,
      worktreeId: worktree.id,
    };
  }

  async function archiveBeyondCap(
    created: ManagedWorktreeRow,
    threadId: string,
    runId: string | undefined
  ): Promise<void> {
    const threads = await deps.readThreads();
    if (!threads.some((thread) => thread.threadId === threadId)) {
      logger.info('The thread a worktree was made for is gone; with no one to tell, no cap runs', {
        threadId,
        worktreeId: created.id,
      });
      return;
    }
    const rows = await deps.listRepository(created.repoCommonDir);
    const claims = bindingClaims(threads, await deps.readRoots());
    const active = rows.filter((row) => row.archivedAt === null && row.id !== created.id);
    const bound = await Promise.all(active.map((row) => claimed(claims, row)));
    const idle = active.filter((_row, index) => !bound[index]).sort(newestFirst);
    // A worktree left in place keeps its place: no younger one is archived in its stead.
    const beyond = idle.slice(IDLE_WORKTREE_CAP).reverse();
    const archived: HostIdleWorktreeArchive['worktrees'] = [];
    for (const row of beyond) {
      if (closing) {
        logger.info('The host is closing; the idle-worktree cap stops', { worktreeId: row.id });
        break;
      }
      const entry = await archiveOne(row);
      if (entry) {
        archived.push(entry);
      }
    }
    if (archived.length > 0) {
      deps.publish({
        limit: IDLE_WORKTREE_CAP,
        ...(runId ? { runId } : {}),
        threadId,
        worktrees: archived,
      });
    }
  }

  return {
    afterCreate: (worktree, params) => {
      const { runId, threadId } = params;
      if (!threadId) {
        logger.info('A worktree created for no thread runs no cap: there is no one to tell', {
          worktreeId: worktree.id,
        });
        return Promise.resolve();
      }
      if (closing) {
        logger.info('The host is closing; no idle-worktree cap starts', {
          worktreeId: worktree.id,
        });
        return Promise.resolve();
      }
      const task = turn(() => archiveBeyondCap(worktree, threadId, runId)).catch(
        (error: unknown) => {
          logger.error('The idle-worktree cap failed', {
            error,
            repoCommonDir: worktree.repoCommonDir,
            threadId,
            worktreeId: worktree.id,
          });
        }
      );
      pending.add(task);
      void task.finally(() => pending.delete(task));
      return task;
    },
    close: async () => {
      closing = true;
      await Promise.all([...pending]);
    },
  };
}
