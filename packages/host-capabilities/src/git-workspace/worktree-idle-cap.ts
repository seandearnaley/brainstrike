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
 *
 * Each pass first archives the repository's idle worktrees whose branches have
 * merged (BST-2504, `worktree-merged-archive.ts`), for every creation, so a
 * merged worktree never counts toward the 15. The same pass runs once in each
 * repository with live worktrees after the host opens (`afterOpen`), in the
 * same queue, and stops when the host closes.
 *
 * When a thread is deleted, the worktrees it made that no thread is bound to
 * are archived in the same queue (`afterThreadDeleted`, BST-2505,
 * `worktree-thread-cleanup.ts`).
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
import type { GitCommandRunner } from './git-service.ts';
import { IDLE_ARCHIVE_LEFT_IN_PLACE } from './worktree-idle-archive.ts';
import { archiveMergedWorktrees } from './worktree-merged-archive.ts';
import { isPathWithin } from './worktree-paths.ts';
import { createMutex, type WorktreeArchiveParams } from './worktree-service-inputs.ts';
import { archiveUnclaimedOf } from './worktree-thread-cleanup.ts';

const logger = createLogger('IdleWorktreeCap');

/** Owner decision 2026-11-12: idle managed worktrees a repository keeps. */
export const IDLE_WORKTREE_CAP = 15;

export interface IdleWorktreeCapDeps {
  /** The worktree service's serialized archive, which the cap calls with `idleCap`. */
  readonly archive: (
    params: WorktreeArchiveParams
  ) => Promise<BoundaryResult<WorktreeArchiveResult>>;
  /** Every live ledger row, for the pass after the host opens. */
  readonly listActive: () => Promise<readonly ManagedWorktreeRow[]>;
  /** A repository's ledger rows, archived ones too. */
  readonly listRepository: (repoCommonDir: string) => Promise<readonly ManagedWorktreeRow[]>;
  /** The live ledger rows a thread made, in every repository, for its deletion's pass. */
  readonly listThread: (threadId: string) => Promise<readonly ManagedWorktreeRow[]>;
  /**
   * Tells the thread a creation was for which worktrees the cap archived, and the thread that
   * made a merged worktree that it was archived.
   */
  readonly publish: (archive: HostIdleWorktreeArchive) => void;
  /**
   * The commit the ledger recorded as a worktree's at its creation, for archive on merge, which
   * takes a worktree only once its branch has moved from it (BST-2518).
   */
  readonly readBaseCommit: (worktreeId: string) => Promise<string | null>;
  /** Every recorded folder, closed ones too: a binding names its folders by root id. */
  readonly readRoots: () => Promise<
    readonly { readonly canonicalPath: string; readonly id: string; readonly path: string }[]
  >;
  /**
   * Every existing thread with its committed binding and whether it has a run yet; a deleted
   * thread is not listed.
   */
  readonly readThreads: () => Promise<
    readonly {
      readonly binding: ThreadWorkspaceBinding | null;
      readonly hasRun: boolean;
      readonly threadId: string;
    }[]
  >;
  /** Git as the host runs it in the person's folders, for archive on merge. */
  readonly run: GitCommandRunner;
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
  /**
   * After the host opens: archive on merge once in each repository with live worktrees, in the
   * cap's queue. Settles when it has finished, and never rejects: a failure is logged.
   */
  readonly afterOpen: () => Promise<void>;
  /**
   * After a thread's deletion has committed: archives the worktrees it made that no thread is
   * bound to, in the cap's queue (BST-2505). Settles when that pass has finished, and never
   * rejects: a failure is logged.
   */
  readonly afterThreadDeleted: (threadId: string) => Promise<void>;
  /** Starts no further pass, then waits for the ones in flight. */
  close(): Promise<void>;
}

type ListedThreads = Awaited<ReturnType<IdleWorktreeCapDeps['readThreads']>>;

/** The worktrees the bindings name: as a thread's worktree, or by the path of any of its folders. */
interface BindingClaims {
  readonly ids: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
}

function bindingClaims(
  threads: ListedThreads,
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

type IdleCapArchive = Extract<HostIdleWorktreeArchive, { reason: 'idle-cap' }>;

export function createIdleWorktreeCap(deps: IdleWorktreeCapDeps): IdleWorktreeCap {
  const turn = createMutex();
  const pending = new Set<Promise<void>>();
  let closing = false;

  const readClaims = async (): Promise<BindingClaims> => {
    const [threads, roots] = await Promise.all([deps.readThreads(), deps.readRoots()]);
    return bindingClaims(threads, roots);
  };
  const isBound = async (row: ManagedWorktreeRow): Promise<boolean> =>
    claimed(await readClaims(), row);

  /** The repository's live worktrees no thread is bound to, besides the one just made. */
  async function idleWorktrees(
    repoCommonDir: string,
    threads: ListedThreads,
    createdId?: string
  ): Promise<ManagedWorktreeRow[]> {
    const rows = await deps.listRepository(repoCommonDir);
    const claims = bindingClaims(threads, await deps.readRoots());
    const active = rows.filter((row) => row.archivedAt === null && row.id !== createdId);
    const bound = await Promise.all(active.map((row) => claimed(claims, row)));
    return active.filter((_row, index) => !bound[index]);
  }

  /** Archive on merge in one repository; the ids it archived. A failure is logged. */
  async function archiveMerged(
    repoCommonDir: string,
    idle: readonly ManagedWorktreeRow[],
    threads: ListedThreads
  ): Promise<ReadonlySet<string>> {
    try {
      return await archiveMergedWorktrees(deps, {
        closing: () => closing,
        idle,
        isBound,
        repoCommonDir,
        threads,
      });
    } catch (error) {
      logger.error('Archive on merge failed', { error, repoCommonDir });
      return new Set();
    }
  }

  /** One idle worktree through the service's archive; undefined when it stays. */
  async function archiveOne(
    row: ManagedWorktreeRow
  ): Promise<IdleCapArchive['worktrees'][number] | undefined> {
    const context = { repoCommonDir: row.repoCommonDir, worktreeId: row.id };
    const outcome = await deps.archive({
      idleCap: { isBound: () => isBound(row) },
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
    idle: readonly ManagedWorktreeRow[],
    threadId: string,
    runId: string | undefined
  ): Promise<void> {
    // A worktree left in place keeps its place: no younger one is archived in its stead.
    const beyond = [...idle].sort(newestFirst).slice(IDLE_WORKTREE_CAP).reverse();
    const archived: IdleCapArchive['worktrees'] = [];
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
        reason: 'idle-cap',
        ...(runId ? { runId } : {}),
        threadId,
        worktrees: archived,
      });
    }
  }

  /** After a creation: archive on merge, then the cap for the thread the creation was for. */
  async function passAfterCreate(
    created: ManagedWorktreeRow,
    params: WorktreeCreateParams
  ): Promise<void> {
    const threads = await deps.readThreads();
    const idle = await idleWorktrees(created.repoCommonDir, threads, created.id);
    const merged = await archiveMerged(created.repoCommonDir, idle, threads);
    const { runId, threadId } = params;
    if (!threadId) {
      logger.info('A worktree created for no thread runs no cap: there is no one to tell', {
        worktreeId: created.id,
      });
      return;
    }
    const thread = threads.find((listed) => listed.threadId === threadId);
    if (thread === undefined) {
      logger.info('The thread a worktree was made for is gone; with no one to tell, no cap runs', {
        threadId,
        worktreeId: created.id,
      });
      return;
    }
    // The notice is shown with a run: the run that made the worktree, or the thread's latest.
    // With none to show it with, nothing is archived; the repository's next creation counts.
    if (runId === undefined && !thread.hasRun) {
      logger.info('The thread has no run to show the notice with; no cap runs', {
        threadId,
        worktreeId: created.id,
      });
      return;
    }
    await archiveBeyondCap(
      idle.filter((row) => !merged.has(row.id)),
      threadId,
      runId
    );
  }

  /** After the host opens: archive on merge in each repository with live worktrees. */
  async function passAfterOpen(): Promise<void> {
    const repositories = new Set((await deps.listActive()).map((row) => row.repoCommonDir));
    for (const repoCommonDir of repositories) {
      if (closing) {
        logger.info('The host is closing; archive on merge after opening stops', {
          repoCommonDir,
        });
        break;
      }
      await turn(async () => {
        const threads = await deps.readThreads();
        await archiveMerged(repoCommonDir, await idleWorktrees(repoCommonDir, threads), threads);
      });
    }
  }

  /** Tracks a pass so close waits for it; a failure is logged, never thrown. */
  function track(task: Promise<void>, context: Readonly<Record<string, unknown>>): Promise<void> {
    const tracked = task.catch((error: unknown) => {
      logger.error('The idle-worktree cap failed', { ...context, error });
    });
    pending.add(tracked);
    void tracked.finally(() => pending.delete(tracked));
    return tracked;
  }

  return {
    afterCreate: (worktree, params) => {
      if (closing) {
        logger.info('The host is closing; no idle-worktree cap starts', {
          worktreeId: worktree.id,
        });
        return Promise.resolve();
      }
      return track(
        turn(() => passAfterCreate(worktree, params)),
        {
          repoCommonDir: worktree.repoCommonDir,
          threadId: params.threadId ?? null,
          worktreeId: worktree.id,
        }
      );
    },
    afterOpen: () => {
      if (closing) {
        logger.info('The host is closing; archive on merge after opening does not start');
        return Promise.resolve();
      }
      return track(passAfterOpen(), { pass: 'after-open' });
    },
    afterThreadDeleted: (threadId) => {
      if (closing) {
        logger.info('The host is closing; a deleted thread’s worktrees are not archived', {
          threadId,
        });
        return Promise.resolve();
      }
      const pass = {
        archive: deps.archive,
        closing: () => closing,
        isBound,
        listThread: deps.listThread,
      };
      return track(
        turn(() => archiveUnclaimedOf(pass, threadId)),
        { pass: 'thread-deleted', threadId }
      );
    },
    close: async () => {
      closing = true;
      await Promise.all([...pending]);
    },
  };
}
