/**
 * Host threads' Changes review, resolved by Main from the host's committed log
 * (BST-1977). A host turn is a run, because an approval continues the same
 * run. Its log records:
 * - the run's roots at the turn's start and end (`workspace.snapshot.recorded`);
 * - each tool edit (`workspace.edit.recorded`);
 * - the run's end (`run.finished`).
 *
 * An `agent-run` changeset resolves with the legacy engine's semantics
 * (`changeset-snapshot-view.ts`):
 * - once the run has ended, start against end per root, with its committed
 *   tool edits as the attribution;
 * - while it runs, start against the live work-tree, without attribution;
 * - a missing or failed capture fails the whole view, never part of it.
 *
 * A `run-range` changeset with no TO run is what a rewind to before a message
 * would restore (`thread/rewind/preview` names its `fromRunId`): each root's
 * restore point against the live work-tree, without attribution. Restore
 * points follow Core's rule: the FROM run's turn start, and for a root first
 * seen in a later run (in log order), its first turn start after that.
 *
 * A thread's log is folded incrementally: each read asks only for rows after
 * the last folded `seq`, and folding skips any row at or below it, so a live
 * refresh reads only new rows and concurrent reads fold each row once. No
 * PGlite read happens here.
 */
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import type { GitResult } from '@brainstrike/types';
import {
  captureFailedError,
  type ResolvedTurnTargets,
  type RootDiffTarget,
  type SnapshotAttributionRecord,
  snapshotMissingError,
} from './changeset-snapshot-targets';
import { isFailedSnapshotCaptureOid } from './snapshot-repository';

type HostTurnSnapshot = Extract<HostLogRow['event'], { type: 'workspace.snapshot.recorded' }>;

/** What a host run's log says about its turn. */
interface HostRunTurn {
  readonly attribution: SnapshotAttributionRecord[];
  end?: HostTurnSnapshot;
  finished: boolean;
  start?: HostTurnSnapshot;
}

interface FoldedHostThread {
  readonly runs: Map<string, HostRunTurn>;
  seq: number;
}

export interface HostThreadTurnsSource {
  /** The host's top-level thread ids (`thread/list`). */
  readonly listThreads: () => Promise<ReadonlySet<string>>;
  /** A host thread's committed rows after `fromSeq` (`thread/read`). */
  readonly readRows: (threadId: string, fromSeq: number) => Promise<readonly HostLogRow[]>;
}

export interface HostThreadTurns {
  /** Whether the host has already listed this thread; no request is made. */
  readonly knows: (threadId: string) => boolean;
  /** Ask the host whether it owns the thread, remembering every thread it lists. */
  readonly owns: (threadId: string) => Promise<boolean>;
  /** A rewind's restore points from `fromRunId` against the live work-tree. */
  readonly rangeTargetsOf: (
    threadId: string,
    fromRunId: string
  ) => Promise<GitResult<ResolvedTurnTargets>>;
  /** A host run's diff targets, from its thread's committed log. */
  readonly targetsOf: (threadId: string, runId: string) => Promise<GitResult<ResolvedTurnTargets>>;
}

function runTurn(thread: FoldedHostThread, runId: string): HostRunTurn {
  let turn = thread.runs.get(runId);
  if (!turn) {
    turn = { attribution: [], finished: false };
    thread.runs.set(runId, turn);
  }
  return turn;
}

function foldRow(thread: FoldedHostThread, row: HostLogRow): void {
  if (row.seq <= thread.seq) {
    return;
  }
  thread.seq = row.seq;
  const { event } = row;
  if (event.type === 'workspace.snapshot.recorded') {
    const turn = runTurn(thread, event.runId);
    if (event.boundary === 'turn-start') {
      turn.start = event;
    } else {
      turn.end = event;
    }
  } else if (event.type === 'workspace.edit.recorded') {
    runTurn(thread, event.runId).attribution.push({
      fromPath: event.fromPath ?? null,
      path: event.path,
      rootId: event.rootId,
    });
  } else if (event.type === 'run.finished') {
    runTurn(thread, event.runId).finished = true;
  }
}

/** A boundary capture that failed as a whole, or the first root whose capture failed. */
function failedCapture(snapshot: HostTurnSnapshot): GitResult<never> | undefined {
  if (snapshot.failure !== undefined) {
    return {
      error:
        `changeset-snapshot-capture-failed: the ${snapshot.boundary} workspace snapshots were ` +
        `not captured (${snapshot.failure}); this changeset cannot be shown. ` +
        'Partial diffs are never fabricated.',
      ok: false,
    };
  }
  const failed = snapshot.roots.find((root) => isFailedSnapshotCaptureOid(root.commitOid));
  return failed
    ? captureFailedError(
        failed.rootId,
        `the ${snapshot.boundary} capture failed when it was attempted`
      )
    : undefined;
}

/** A host run's turn → per-root targets, live or settled. */
function targetsOfHostRun(
  threadId: string,
  runId: string,
  turn: HostRunTurn | undefined
): GitResult<ResolvedTurnTargets> {
  const start = turn?.start;
  if (!(turn && start)) {
    return snapshotMissingError(
      `run "${runId}" in host thread "${threadId}" recorded no workspace snapshots`
    );
  }
  const startFailure = failedCapture(start);
  if (startFailure) {
    return startFailure;
  }
  if (!turn.end) {
    if (turn.finished) {
      return snapshotMissingError(
        `run "${runId}" in host thread "${threadId}" ended without recording its turn-end snapshots`
      );
    }
    const targets = start.roots.map(
      ({ commitOid, rootId, rootPath }): RootDiffTarget => ({
        fromOid: commitOid,
        rootId,
        rootPath,
        to: { worktree: true },
      })
    );
    return { ok: true, value: { attribution: null, targets } };
  }
  const endFailure = failedCapture(turn.end);
  if (endFailure) {
    return endFailure;
  }
  const endByRoot = new Map(turn.end.roots.map((root) => [root.rootId, root]));
  const targets: RootDiffTarget[] = [];
  for (const root of start.roots) {
    const end = endByRoot.get(root.rootId);
    if (!end) {
      return snapshotMissingError(
        `root "${root.rootId}" has no turn-end snapshot for run "${runId}" (host thread "${threadId}")`
      );
    }
    targets.push({
      fromOid: root.commitOid,
      rootId: root.rootId,
      rootPath: end.rootPath,
      to: end.commitOid,
    });
  }
  return { ok: true, value: { attribution: turn.attribution, targets } };
}

/** Each root's restore point from `fromRunId` on, against the live work-tree. */
function rangeTargetsOfHostThread(
  threadId: string,
  fromRunId: string,
  thread: FoldedHostThread
): GitResult<ResolvedTurnTargets> {
  const turns = [...thread.runs.entries()];
  const from = turns.findIndex(([runId]) => runId === fromRunId);
  const start = turns[from]?.[1].start;
  if (!start) {
    return snapshotMissingError(
      `run "${fromRunId}" in host thread "${threadId}" recorded no turn-start snapshot`
    );
  }
  const targets = new Map<string, RootDiffTarget>();
  for (const [, turn] of turns.slice(from)) {
    if (!turn.start) {
      continue;
    }
    const failed = failedCapture(turn.start);
    if (failed) {
      return failed;
    }
    for (const { commitOid, rootId, rootPath } of turn.start.roots) {
      if (!targets.has(rootId)) {
        targets.set(rootId, { fromOid: commitOid, rootId, rootPath, to: { worktree: true } });
      }
    }
  }
  return { ok: true, value: { attribution: null, targets: [...targets.values()] } };
}

export function createHostThreadTurns(source: HostThreadTurnsSource): HostThreadTurns {
  const owned = new Set<string>();
  const threads = new Map<string, FoldedHostThread>();
  const folded = async (threadId: string): Promise<FoldedHostThread> => {
    let thread = threads.get(threadId);
    if (!thread) {
      thread = { runs: new Map(), seq: 0 };
      threads.set(threadId, thread);
    }
    for (const row of await source.readRows(threadId, thread.seq)) {
      foldRow(thread, row);
    }
    return thread;
  };
  return {
    knows: (threadId) => owned.has(threadId),
    owns: async (threadId) => {
      for (const listed of await source.listThreads()) {
        owned.add(listed);
      }
      return owned.has(threadId);
    },
    rangeTargetsOf: async (threadId, fromRunId) =>
      rangeTargetsOfHostThread(threadId, fromRunId, await folded(threadId)),
    targetsOf: async (threadId, runId) =>
      targetsOfHostRun(threadId, runId, (await folded(threadId)).runs.get(runId)),
  };
}
