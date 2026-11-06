/**
 * Command sessions a run started that ended by themselves, on their way to a
 * model. A worker told to run long work in the background started one,
 * returned "still running", and nothing ever reported the session's end, so
 * its parent went idle on a validation it never saw finish (debug pack
 * 2026-11-04). An exit now reaches the thread that started the session, or,
 * once that thread is an idle child, its nearest ancestor: a busy thread hears
 * it when its run ends, an idle root wakes for it, and any other run the
 * thread starts first carries it.
 *
 * Each exit is a notice (ADR-0028 step 3b), committed on the thread that
 * hears it, so one that no run has taken yet survives a restart. The delivery
 * a run commits records which exits it took.
 */
import { createLogger } from '@brainstrike/logging';
import { hostChildCallSign } from './child-presentation.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import type { HostRunState } from './core-state.ts';
import { type HostSessionNotice, hostNoticeBranch } from './notices.ts';
import type { HostCommandSessionExit, HostPlatform } from './ports.ts';

const logger = createLogger('AgentHost');

/** The share of a session's output a model is pointed at: about a screen of log. */
const TAIL_UTF16_CODE_UNITS = 4000;

function duration(exit: HostCommandSessionExit): string {
  const seconds = Math.max(0, Math.round((exit.exitedAt - exit.createdAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ending(exit: HostCommandSessionExit): string {
  return exit.signal ? `was ended by signal ${exit.signal}` : `exited with code ${exit.exitCode}`;
}

/** What the model reads about ended sessions: who started each, how it ended, and where to read. */
export function describeHostCommandSessionExits(
  threadId: string,
  exits: readonly HostCommandSessionExit[]
): string {
  const lines = exits.map((exit) => {
    const starter =
      exit.threadId === threadId ? 'you' : `subagent ${hostChildCallSign(exit.threadId)}`;
    const from = Math.max(0, exit.outputCursor - TAIL_UTF16_CODE_UNITS);
    const read = JSON.stringify({
      operation: { action: 'read', cursor: from, sessionId: exit.sessionId },
      root: exit.rootId,
    });
    return `- ${exit.sessionId} (root ${exit.rootId}), started by ${starter}, ${ending(exit)} after ${duration(exit)}. Its output ends at cursor ${exit.outputCursor}; read its last lines with brainstrike_inspectCommandSessions ${read}.`;
  });
  return [
    `Command sessions that ended by themselves — ${exits.length}:`,
    ...lines,
    'Read each one’s output to learn whether the work it ran succeeded, then continue the task.',
  ].join('\n');
}

/** An exit as the notice the thread that hears it is told (ADR-0028 step 3b). */
function hostSessionNotice(exit: HostCommandSessionExit): HostSessionNotice {
  return {
    createdAt: exit.createdAt,
    exitedAt: exit.exitedAt,
    kind: 'command-session',
    outputCursor: exit.outputCursor,
    session: {
      exitCode: exit.exitCode,
      rootId: exit.rootId,
      sessionId: exit.sessionId,
      signal: exit.signal,
      threadId: exit.threadId,
    },
  };
}

interface HostCommandExitPorts {
  readonly children: Pick<HostChildRuns, 'isChild' | 'notices' | 'parentOf'>;
  /** Commit a notice on the thread that hears it. */
  readonly post: (threadId: string, notice: HostSessionNotice) => Promise<unknown>;
  readonly runs: () => ReadonlyMap<string, HostRunState>;
  /** Admit the thread's wake once its settlements join. */
  readonly wake: (threadId: string) => void;
}

export class HostCommandSessionExits {
  private readonly ports: HostCommandExitPorts;
  /** Each thread's notices still committing: `idle` joins them. */
  private readonly posting = new Map<string, Set<Promise<void>>>();
  private unsubscribe: (() => void) | undefined;

  constructor(ports: HostCommandExitPorts) {
    this.ports = ports;
  }

  /** Hear the platform's ended sessions until `close`. */
  listen(platform: Pick<HostPlatform, 'commandSessionExits'>): void {
    this.unsubscribe = platform.commandSessionExits?.subscribe((exit) =>
      this.post(this.listener(exit.threadId), hostSessionNotice(exit))
    );
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private own(threadId: string): HostRunState[] {
    return [...this.ports.runs().values()].filter((run) => run.threadId === threadId);
  }

  private active(threadId: string): boolean {
    return this.own(threadId).some((run) => !run.terminal);
  }

  /** The thread that hears an exit: the starter while it runs, else its nearest busy or root ancestor. */
  private listener(threadId: string): string {
    let target = threadId;
    while (this.ports.children.isChild(target) && !this.active(target)) {
      const parent = this.ports.children.parentOf(target);
      if (parent === undefined) {
        break;
      }
      target = parent;
    }
    return target;
  }

  /** Tell `threadId` once, then wake it: the wake admits only an idle thread. */
  private post(threadId: string, notice: HostSessionNotice): void {
    const { children, post } = this.ports;
    // A deleted thread has no run left to hear it.
    if (
      this.own(threadId).length === 0 ||
      children.notices.has(threadId, notice.session.sessionId)
    ) {
      return;
    }
    const posting = this.posting.get(threadId) ?? new Set<Promise<void>>();
    this.posting.set(threadId, posting);
    const posted = post(threadId, notice)
      .then(() => this.heard(threadId))
      .catch((cause: unknown) => reportHostExitNoticeFailure(threadId, cause))
      .finally(() => {
        posting.delete(posted);
        if (posting.size === 0 && this.posting.get(threadId) === posting) {
          this.posting.delete(threadId);
        }
      });
    posting.add(posted);
  }

  /**
   * A notice committed on `threadId`: a child whose run ended while it
   * committed hands it on, as that run's end would have; any other thread
   * wakes, and the wake admits only an idle one.
   */
  private heard(threadId: string): void {
    if (this.ports.children.isChild(threadId) && !this.active(threadId)) {
      this.handOn(threadId);
      return;
    }
    this.ports.wake(threadId);
  }

  /** A run ended: an idle child's exits go on to the thread that hears them now. */
  handOn(threadId: string): void {
    const { children, runs } = this.ports;
    if (!children.isChild(threadId) || this.active(threadId)) {
      return;
    }
    const branch = hostNoticeBranch(runs(), this.own(threadId).at(-1));
    for (const notice of children.notices.due(threadId, branch)) {
      if (notice.kind === 'command-session') {
        this.post(this.listener(threadId), { ...notice, handedOnFrom: threadId });
      }
    }
  }

  /** The thread's notices still committing. */
  inFlight(threadId: string): Promise<void>[] {
    return [...(this.posting.get(threadId) ?? [])];
  }
}

/** A notice that did not commit is reported; the session's end is not told. */
function reportHostExitNoticeFailure(threadId: string, cause: unknown): void {
  logger.warn('Host command session notice was not committed', {
    code: 'host_command_exit_notice_failed',
    errorName: cause instanceof Error ? cause.name : typeof cause,
    threadId,
  });
}
