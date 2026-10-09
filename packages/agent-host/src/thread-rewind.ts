/**
 * Restore a host thread to before a message (BST-1977, gap 2).
 *
 * A host thread's conversation is a committed tree, so a rewind hides
 * nothing. It moves the thread's tip back to the run the target message
 * followed; the next message branches from there, and the old branch stays
 * reachable. In files mode, the platform's snapshot owner (`rewindFiles`)
 * also restores every root to its state at the target message's turn start.
 *
 * The intent is committed before any file changes (`thread.rewind.started`,
 * `thread.rewind.redo.started`), and the outcome after them. A started step
 * with no outcome becomes `thread.rewind.interrupted` when the host next
 * opens, so files that may be partly restored are never silent state.
 * Conflict checks (`drift`, `redoConflicts`) run before the intent, so a
 * `conflicts` answer commits nothing.
 *
 * Restore points come from the runs' committed turn snapshots: the earliest
 * run answering the target message gives each of its roots' targets, and a
 * root first seen in a later run (in log order, on any branch) uses its first
 * turn start after that. A snapshot restore covers the whole workspace, which
 * reflects every run that executed.
 *
 * Redo undoes the thread's newest rewind until a run starts after it: the
 * owner finds each root's pre-revert snapshot by `rewindId`, so an
 * interrupted rewind stays redoable.
 */
import { randomUUID } from 'node:crypto';
import type { HostRunState } from './core-state.js';
import type { Json } from './json-value.js';
import type { HostPlatform } from './ports.js';
import type {
  HostEvent,
  HostLogRow,
  HostParams,
  HostResults,
  HostTurnSnapshot,
} from './protocol.js';

type Started = Extract<HostEvent, { type: 'thread.rewind.started' }>;
type Preview = HostResults['thread/rewind/preview'];
type RewindResult = HostResults['thread/rewind'];
type Rewound = Extract<RewindResult, { status: 'rewound' }>;
type RedoResult = HostResults['thread/rewind/redo'];

/** A root's null object ID records a capture that failed for it. */
const FAILED_CAPTURE_OID = /^0+$/;

interface ThreadRewind {
  /** False once a run starts after this rewind. */
  current: boolean;
  phase: 'redoing' | 'redone' | 'rewinding' | 'rewound';
  readonly started: Started;
}

/** Core's part of a rewind: its command ledger, its log, and the thread's runs. */
export interface HostThreadRewindPorts {
  accept(
    threadId: string,
    method: string,
    params: { commandId: string },
    result: Json,
    events: readonly HostEvent[]
  ): Promise<void>;
  append(threadId: string, events: readonly HostEvent[]): Promise<unknown>;
  command<T extends Json>(
    method: string,
    params: { commandId: string; threadId: string },
    perform: () => Promise<T>
  ): Promise<T>;
  owner(): {
    readonly pending: Map<AbortController, string>;
    readonly platform: HostPlatform;
    readonly runs: ReadonlyMap<string, HostRunState>;
  };
}

interface RewindTarget {
  readonly files: { readonly reason: string } | { readonly targets: HostTurnSnapshot[] };
  readonly headId: string | null;
  readonly runId: string;
  readonly runIds: string[];
}

function failureDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Each root's restore point from the runs' committed turn starts, or why there is none. */
function restorePoints(
  threadRuns: readonly HostRunState[],
  first: HostRunState
): RewindTarget['files'] {
  const start = first.turnStart;
  if (!start) {
    return { reason: "This message's turn predates workspace snapshots" };
  }
  if (start.failure !== undefined) {
    return { reason: `The workspace snapshot at this message's turn failed: ${start.failure}` };
  }
  const targets = new Map<string, HostTurnSnapshot>();
  for (const run of threadRuns.slice(threadRuns.indexOf(first))) {
    for (const root of run.turnStart?.roots ?? []) {
      if (!targets.has(root.rootId)) {
        targets.set(root.rootId, root);
      }
    }
  }
  const failed = [...targets.values()].find((root) => FAILED_CAPTURE_OID.test(root.commitOid));
  return failed
    ? { reason: `The workspace snapshot of root "${failed.rootId}" failed when it was taken` }
    : { targets: [...targets.values()] };
}

export class HostThreadRewinds {
  private readonly latest = new Map<string, ThreadRewind>();

  constructor(private readonly ports: HostThreadRewindPorts) {}

  fold(row: HostLogRow): void {
    const { event, threadId } = row;
    const rewind = this.latest.get(threadId);
    switch (event.type) {
      case 'thread.rewind.started':
        this.latest.set(threadId, { current: true, phase: 'rewinding', started: event });
        return;
      case 'thread.rewound':
      case 'thread.rewind.interrupted':
        if (rewind?.started.rewindId === event.rewindId) {
          rewind.phase = 'rewound';
        }
        return;
      case 'thread.rewind.redo.started':
        if (rewind?.started.rewindId === event.rewindId) {
          rewind.phase = 'redoing';
        }
        return;
      case 'thread.rewind.redone':
        if (rewind?.started.rewindId === event.rewindId) {
          rewind.phase = 'redone';
        }
        return;
      case 'run.started':
        if (rewind) {
          rewind.current = false;
        }
        return;
      default:
        return;
    }
  }

  forgetThread(threadId: string): void {
    this.latest.delete(threadId);
  }

  /** The run a start without a parent follows after a rewind; undefined: the latest run. */
  tip(threadId: string): string | null | undefined {
    const rewind = this.latest.get(threadId);
    return rewind?.current && rewind.phase === 'rewound' ? rewind.started.headId : undefined;
  }

  /** A start's params with the rewound tip as its parent, when it names none. */
  position<
    T extends { readonly parentMessageId?: string | null | undefined; readonly threadId: string },
  >(params: T): T {
    const tip = this.tip(params.threadId);
    return params.parentMessageId === undefined && tip !== undefined
      ? { ...params, parentMessageId: tip }
      : params;
  }

  /** Each started rewind or redo with no outcome becomes visibly interrupted. */
  async recover(): Promise<void> {
    for (const [threadId, rewind] of this.latest) {
      if (rewind.phase === 'rewinding' || rewind.phase === 'redoing') {
        await this.ports.append(threadId, [
          {
            detail: 'The host stopped before this step finished; files may be partly restored',
            phase: rewind.phase === 'rewinding' ? 'rewind' : 'redo',
            rewindId: rewind.started.rewindId,
            type: 'thread.rewind.interrupted',
          },
        ]);
      }
    }
  }

  async preview(params: HostParams<'thread/rewind/preview'>): Promise<Preview> {
    const target = this.target(params.threadId, params.messageId);
    const rewindFiles = this.ports.owner().platform.rewindFiles;
    let files: Preview['files'];
    if (!rewindFiles) {
      files = { available: false, reason: 'This host has no workspace snapshot owner' };
    } else if ('reason' in target.files) {
      files = { available: false, reason: target.files.reason };
    } else {
      const { previewId } = await rewindFiles.preview({
        targets: target.files.targets,
        threadId: params.threadId,
      });
      files = { available: true, previewId, roots: target.files.targets };
    }
    return { files, headId: target.headId, runIds: target.runIds };
  }

  rewind(params: HostParams<'thread/rewind'>): Promise<HostResults['thread/rewind']> {
    const method = 'thread/rewind';
    return this.ports.command(method, params, async () => {
      const target = this.target(params.threadId, params.messageId);
      const rewindId = randomUUID();
      const started: Started = {
        commandId: params.commandId,
        headId: target.headId,
        messageId: params.messageId,
        mode: params.mode,
        rewindId,
        runId: target.runId,
        type: 'thread.rewind.started',
      };
      if (params.mode === 'conversation-only') {
        const result: Rewound = { outcomes: [], rewindId, status: 'rewound' };
        await this.ports.accept(params.threadId, method, params, result, [
          started,
          { outcomes: [], rewindId, type: 'thread.rewound' },
        ]);
        return result;
      }
      const { rewindFiles, targets } = this.fileTargets(target);
      if (params.previewId === undefined) {
        throw new Error('A files rewind needs its preview');
      }
      const request = { previewId: params.previewId, threadId: params.threadId };
      const conflicts = await rewindFiles.drift(request);
      if (conflicts.length > 0 && params.acknowledgeConflicts !== true) {
        const result: RewindResult = { conflicts: [...conflicts], status: 'conflicts' };
        return result;
      }
      await this.ports.append(params.threadId, [started]);
      return await this.restoring(params.threadId, async () => {
        try {
          const outcomes = [...(await rewindFiles.apply({ ...request, rewindId, targets }))];
          const result: Rewound = { outcomes, rewindId, status: 'rewound' };
          await this.ports.accept(params.threadId, method, params, result, [
            { outcomes, rewindId, type: 'thread.rewound' },
          ]);
          return result;
        } catch (cause) {
          const detail = failureDetail(cause);
          const result: RewindResult = { detail, rewindId, status: 'interrupted' };
          await this.ports.accept(params.threadId, method, params, result, [
            { detail, phase: 'rewind', rewindId, type: 'thread.rewind.interrupted' },
          ]);
          return result;
        }
      });
    });
  }

  redo(params: HostParams<'thread/rewind/redo'>): Promise<HostResults['thread/rewind/redo']> {
    const method = 'thread/rewind/redo';
    return this.ports.command(method, params, async () => {
      this.assertIdle(params.threadId);
      const rewind = this.latest.get(params.threadId);
      if (
        !(rewind?.current && rewind.phase === 'rewound') ||
        rewind.started.rewindId !== params.rewindId
      ) {
        throw new Error("Only the thread's newest rewind can be redone, before a new run starts");
      }
      const { rewindId } = params;
      const redoStarted: HostEvent = {
        commandId: params.commandId,
        rewindId,
        type: 'thread.rewind.redo.started',
      };
      if (rewind.started.mode === 'conversation-only') {
        const result: RedoResult = { outcomes: [], status: 'redone' };
        await this.ports.accept(params.threadId, method, params, result, [
          redoStarted,
          { outcomes: [], rewindId, type: 'thread.rewind.redone' },
        ]);
        return result;
      }
      const target = this.target(params.threadId, rewind.started.messageId, rewind.started.runId);
      const { rewindFiles, targets } = this.fileTargets(target);
      const request = { rewindId, targets, threadId: params.threadId };
      const conflicts = await rewindFiles.redoConflicts(request);
      if (conflicts.length > 0 && params.acknowledgeConflicts !== true) {
        const result: RedoResult = { conflicts: [...conflicts], status: 'conflicts' };
        return result;
      }
      await this.ports.append(params.threadId, [redoStarted]);
      return await this.restoring(params.threadId, async () => {
        try {
          const outcomes = [...(await rewindFiles.redo({ ...request, acknowledged: conflicts }))];
          const result: RedoResult = { outcomes, status: 'redone' };
          await this.ports.accept(params.threadId, method, params, result, [
            { outcomes, rewindId, type: 'thread.rewind.redone' },
          ]);
          return result;
        } catch (cause) {
          const detail = failureDetail(cause);
          const result: RedoResult = { detail, status: 'interrupted' };
          await this.ports.accept(params.threadId, method, params, result, [
            { detail, phase: 'redo', rewindId, type: 'thread.rewind.interrupted' },
          ]);
          return result;
        }
      });
    });
  }

  private assertIdle(threadId: string): void {
    for (const run of this.ports.owner().runs.values()) {
      if (run.threadId === threadId && !run.terminal) {
        throw new Error('A rewind is refused while the thread has an active run');
      }
    }
  }

  /**
   * The target message on the thread's current branch: the run the
   * conversation returns to, the runs leaving it, and each root's restore
   * point. A redo names the rewind's own run, which a later branch may no
   * longer contain.
   */
  private target(threadId: string, messageId: string, rewoundRunId?: string): RewindTarget {
    this.assertIdle(threadId);
    const threadRuns = [...this.ports.owner().runs.values()].filter(
      (run) => run.threadId === threadId
    );
    const answering = threadRuns.filter((run) => run.branch.userMessageId === messageId);
    const first = answering[0];
    if (!first) {
      throw new Error('The rewind target is not a committed user message of this thread');
    }
    if (rewoundRunId !== undefined) {
      return {
        files: restorePoints(threadRuns, first),
        headId: first.branch.parentMessageId,
        runId: rewoundRunId,
        runIds: [rewoundRunId],
      };
    }
    const byId = new Map(threadRuns.map((run) => [run.id, run]));
    const tip = this.tip(threadId);
    const path: HostRunState[] = [];
    let cursor = tip === undefined ? threadRuns.at(-1) : tip === null ? undefined : byId.get(tip);
    while (cursor && cursor.branch.userMessageId !== messageId) {
      path.push(cursor);
      cursor =
        cursor.branch.parentMessageId === null
          ? undefined
          : byId.get(cursor.branch.parentMessageId);
    }
    if (!cursor) {
      throw new Error("The rewind target is not on the thread's current branch");
    }
    path.push(cursor);
    return {
      files: restorePoints(threadRuns, first),
      headId: cursor.branch.parentMessageId,
      runId: cursor.id,
      runIds: path.reverse().map((run) => run.id),
    };
  }

  private fileTargets(target: RewindTarget): {
    readonly rewindFiles: NonNullable<HostPlatform['rewindFiles']>;
    readonly targets: HostTurnSnapshot[];
  } {
    const rewindFiles = this.ports.owner().platform.rewindFiles;
    if (!rewindFiles) {
      throw new Error('This host has no workspace snapshot owner to restore files');
    }
    if ('reason' in target.files) {
      throw new Error(target.files.reason);
    }
    return { rewindFiles, targets: target.files.targets };
  }

  /** File work holds the thread like an admission, so a delete aborts rather than races it. */
  private async restoring<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const { pending } = this.ports.owner();
    pending.set(controller, threadId);
    try {
      return await work();
    } finally {
      pending.delete(controller);
    }
  }
}
