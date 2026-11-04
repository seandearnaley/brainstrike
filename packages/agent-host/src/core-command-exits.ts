/**
 * Command sessions a run started that ended by themselves, on their way to a
 * model. A worker told to run long work in the background started one,
 * returned "still running", and nothing ever reported the session's end, so
 * its parent went idle on a validation it never saw finish (debug pack
 * 2026-11-04). An exit now reaches the thread that started the session, or,
 * once that thread is an idle child, its nearest ancestor: a busy thread hears
 * it when its run ends, an idle root wakes for it.
 *
 * Process-local: a session never outlives its host, so a restart leaves
 * nothing to report. The delivery a wake commits records which exits it took.
 */
import { hostChildCallSign } from './child-presentation.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import type { HostRunState } from './core-state.ts';
import type { HostCommandSessionExit, HostPlatform } from './ports.ts';
import type { HostChildDelivery, HostCommandSessionDelivery } from './protocol.ts';

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
    return `- ${exit.sessionId} (root ${exit.rootId}), started by ${starter}, ${ending(exit)} after ${duration(exit)}. Its output ends at cursor ${exit.outputCursor}; read its last lines with brainstrike_inspectCommandSessions {action:"read", sessionId:"${exit.sessionId}", cursor:${from}}.`;
  });
  return [
    `Command sessions that ended by themselves — ${exits.length}:`,
    ...lines,
    'Read each one’s output to learn whether the work it ran succeeded, then continue the task.',
  ].join('\n');
}

export function hostCommandSessionDelivery(
  exit: HostCommandSessionExit
): HostCommandSessionDelivery {
  return {
    exitCode: exit.exitCode,
    rootId: exit.rootId,
    sessionId: exit.sessionId,
    signal: exit.signal,
    threadId: exit.threadId,
  };
}

interface HostCommandExitPorts {
  readonly children: Pick<HostChildRuns, 'isChild' | 'parentOf'>;
  readonly runs: () => ReadonlyMap<string, HostRunState>;
  /** Admit the thread's wake once its settlements join. */
  readonly wake: (threadId: string) => void;
}

export class HostCommandSessionExits {
  private readonly ports: HostCommandExitPorts;
  private readonly queued = new Map<string, HostCommandSessionExit[]>();
  private unsubscribe: (() => void) | undefined;

  constructor(ports: HostCommandExitPorts) {
    this.ports = ports;
  }

  /** Hear the platform's ended sessions until `close`. */
  listen(platform: Pick<HostPlatform, 'commandSessionExits'>): void {
    this.unsubscribe = platform.commandSessionExits?.subscribe((exit) => this.report(exit));
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

  report(exit: HostCommandSessionExit): void {
    const target = this.listener(exit.threadId);
    if (this.own(target).length === 0) {
      // A deleted thread has no run left to hear it.
      return;
    }
    const queue = this.queued.get(target) ?? [];
    if (!queue.some((queuedExit) => queuedExit.sessionId === exit.sessionId)) {
      queue.push(exit);
    }
    this.queued.set(target, queue);
    if (!this.active(target)) {
      this.ports.wake(target);
    }
  }

  /** A run ended: an idle child's exits go on to the thread that hears them now. */
  handOn(threadId: string): void {
    if (!this.ports.children.isChild(threadId) || this.active(threadId)) {
      return;
    }
    const queue = this.queued.get(threadId);
    this.queued.delete(threadId);
    for (const exit of queue ?? []) {
      this.report(exit);
    }
  }

  pending(threadId: string): readonly HostCommandSessionExit[] {
    return this.queued.get(threadId) ?? [];
  }

  /** The exits a committed run's delivery took no longer wait. */
  delivered(threadId: string, delivery: HostChildDelivery | undefined): void {
    if (delivery?.via !== 'wake' || !delivery.commandSessions) {
      return;
    }
    const taken = new Set(delivery.commandSessions.map((session) => session.sessionId));
    const left = this.pending(threadId).filter((exit) => !taken.has(exit.sessionId));
    if (left.length > 0) {
      this.queued.set(threadId, left);
    } else {
      this.queued.delete(threadId);
    }
  }

  forget(threadId: string): void {
    this.queued.delete(threadId);
  }
}
