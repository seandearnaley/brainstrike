/**
 * ADR-0034 decision 7: the platform's idle-worktree cap archived worktrees
 * after a worktree was created for a thread. Core tells that thread in a
 * committed row (`worktrees.archived`) that its transcript shows with the run
 * that made the worktree, or with the thread's latest run when the person
 * made it between runs. Archive on merge (BST-2504) tells the thread that made
 * each merged worktree the same way, with its latest run.
 */
import { createLogger } from '@brainstrike/logging';
import type { HostRunMap } from './core-state.ts';
import type { HostIdleWorktreeArchive, HostPlatform } from './ports.ts';
import type { HostEvent } from './protocol.ts';

const logger = createLogger('HostIdleWorktrees');

type HostWorktreesArchived = Extract<HostEvent, { type: 'worktrees.archived' }>;

interface HostIdleWorktreePorts {
  /** Commits the row on the thread, in Core's admission order; a deleted thread refuses it. */
  readonly post: (threadId: string, event: HostWorktreesArchived) => Promise<unknown>;
  readonly runs: () => HostRunMap;
}

export class HostIdleWorktreeNotices {
  private readonly ports: HostIdleWorktreePorts;
  private readonly posting = new Set<Promise<unknown>>();
  private unsubscribe: (() => void) | undefined;

  constructor(post: HostIdleWorktreePorts['post'], runs: HostIdleWorktreePorts['runs']) {
    this.ports = { post, runs };
  }

  listen(platform: Pick<HostPlatform, 'idleWorktreeArchives'>): void {
    this.unsubscribe = platform.idleWorktreeArchives?.subscribe((archive) => this.tell(archive));
  }

  /**
   * Before the host stops admitting: the cap starts no further archive, finishes the one in
   * flight and its notice is committed, so no worktree goes without its thread being told.
   * Then Core stops listening.
   */
  async retire(platform: Pick<HostPlatform, 'idleWorktreeArchives'>): Promise<void> {
    await platform.idleWorktreeArchives?.settle();
    await Promise.allSettled([...this.posting]);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private tell(archive: HostIdleWorktreeArchive): void {
    const context = {
      reason: archive.reason,
      runId: archive.runId ?? null,
      threadId: archive.threadId,
      worktreeIds: archive.worktrees.map(({ worktreeId }) => worktreeId),
    };
    const runs = this.ports.runs();
    const made = archive.runId === undefined ? undefined : runs.get(archive.runId);
    if (archive.runId !== undefined && made?.threadId !== archive.threadId) {
      logger.warn('The run that made a worktree is not one of its thread’s runs', context);
    }
    const run = made?.threadId === archive.threadId ? made : runs.ofThread(archive.threadId).at(-1);
    if (!run) {
      logger.error('Worktrees were archived for a thread with no run to show them with', context);
      return;
    }
    const event: HostWorktreesArchived =
      archive.reason === 'merged'
        ? {
            defaultBranch: archive.defaultBranch,
            reason: 'merged',
            runId: run.id,
            type: 'worktrees.archived',
            worktrees: [...archive.worktrees],
          }
        : {
            limit: archive.limit,
            reason: 'idle-cap',
            runId: run.id,
            type: 'worktrees.archived',
            worktrees: [...archive.worktrees],
          };
    const posted = this.ports.post(archive.threadId, event).catch((cause: unknown) => {
      logger.error('Could not tell a thread its worktrees were archived', {
        ...context,
        cause,
      });
    });
    this.posting.add(posted);
    void posted.finally(() => this.posting.delete(posted));
  }
}
