import type { HostRunState } from './core-state.js';
import type { HostRunAdmission } from './ports.js';
import type { HostEvent } from './protocol.js';

type TurnSnapshotEvent = Extract<HostEvent, { type: 'workspace.snapshot.recorded' }>;
type CaptureTurnBoundary = NonNullable<HostRunAdmission['captureTurnBoundary']>;

/**
 * One turn boundary's committed record: each root's snapshot (the null object
 * ID where that root failed), or why the capture failed as a whole. A capture
 * never fails the run; its Changes review fails visibly instead.
 */
async function captureBoundary(
  capture: CaptureTurnBoundary,
  run: HostRunState,
  boundary: TurnSnapshotEvent['boundary'],
  roots?: TurnSnapshotEvent['roots']
): Promise<TurnSnapshotEvent> {
  const record = { boundary, runId: run.id, type: 'workspace.snapshot.recorded' as const };
  try {
    const snapshots = await capture({
      boundary,
      ...(roots ? { roots: roots.map(({ rootId, rootPath }) => ({ rootId, rootPath })) } : {}),
      runId: run.id,
      threadId: run.threadId,
    });
    return { ...record, roots: [...snapshots] };
  } catch (cause) {
    return {
      ...record,
      failure: cause instanceof Error ? cause.message : String(cause),
      roots: [],
    };
  }
}

/** The run's turn start, before its prompt hooks or tools can change the workspace. */
export function hostTurnStart(
  run: HostRunState,
  admission: HostRunAdmission
): Promise<TurnSnapshotEvent> | undefined {
  const capture = admission.captureTurnBoundary;
  return capture ? captureBoundary(capture, run, 'turn-start') : undefined;
}

/** The run's turn end, over its turn-start roots; none without a recorded start. */
export async function hostTurnEnd(run: HostRunState): Promise<TurnSnapshotEvent[]> {
  const capture = run.admission?.captureTurnBoundary;
  const roots = run.turnStart?.roots;
  if (!(capture && roots && roots.length > 0)) {
    return [];
  }
  return [await captureBoundary(capture, run, 'turn-end', roots)];
}
