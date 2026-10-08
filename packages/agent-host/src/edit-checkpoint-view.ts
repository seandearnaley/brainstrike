import {
  type AssistantCheckpointUndoAvailability,
  type AssistantEditCheckpointCaptureStatus,
  type AssistantEditCheckpointRecord,
  denormalizeNativeToolName,
} from '@brainstrike/assistant-contract';
import { WORKSPACE_MEMORY_RESOURCE_ID } from '@brainstrike/assistant-data/assistant-memory-resource';
import type { HostEditBaseline, HostEvent, HostLogRow } from './protocol.js';

/**
 * Client fold of a thread's committed edit checkpoints, in the existing
 * checkpoint-undo DTO the conversation UI renders. Browser-safe: it reads only
 * committed rows; Core's `checkpoint/revert` performs every restore.
 */
export const HOST_EDIT_BASELINE_MAX_BYTES = 2 * 1024 * 1024;

type Recorded = Extract<HostEvent, { type: 'workspace.edit.recorded' }>;
type Unavailable = Extract<HostEditBaseline, { kind: 'unavailable' }>;

/** One copy of why a path's prior state cannot be restored, shown before and at revert. */
export function hostEditBaselineUnavailableReason(reason: Unavailable['reason']): string {
  switch (reason) {
    case 'not_a_file':
      return 'it was not a regular file before this run changed it, so it cannot be restored.';
    case 'symlink':
      return 'it was a symbolic link before this run changed it, so it cannot be restored.';
    case 'too_large':
      return `it was larger than ${HOST_EDIT_BASELINE_MAX_BYTES} bytes before this run changed it, so its prior content was not kept.`;
    default:
      throw new Error('Unknown edit baseline unavailability');
  }
}

export interface HostEditCheckpointView {
  readonly availabilityById: ReadonlyMap<string, AssistantCheckpointUndoAvailability>;
  /** Commit order, oldest first. */
  readonly entries: readonly AssistantEditCheckpointRecord[];
}

function committedAt(row: HostLogRow): string {
  if (row.ts === undefined) {
    throw new Error('A committed edit checkpoint row has no commit time');
  }
  return new Date(row.ts).toISOString();
}

function captureStatus(
  event: Recorded,
  unavailable: Unavailable | undefined
): AssistantEditCheckpointCaptureStatus {
  if (unavailable?.reason === 'too_large') {
    return 'skipped_too_large';
  }
  if (event.op === 'rename') {
    return 'rename';
  }
  return event.before.existed ? 'ok' : 'created';
}

interface CommittedEdits {
  /** First committed baseline per (run, root, path). */
  readonly baselines: ReadonlyMap<string, HostEditBaseline>;
  /** Commit time of each reverted entry. */
  readonly reverted: ReadonlyMap<string, string>;
}

function baselineKey(runId: string, rootId: string, path: string): string {
  return JSON.stringify([runId, rootId, path]);
}

function committedEdits(rows: readonly HostLogRow[]): CommittedEdits {
  const baselines = new Map<string, HostEditBaseline>();
  const reverted = new Map<string, string>();
  for (const row of rows) {
    const event = row.event;
    if (event.type === 'workspace.edit.recorded') {
      for (const baseline of event.baselines) {
        const key = baselineKey(event.runId, event.rootId, baseline.path);
        if (!baselines.has(key)) {
          baselines.set(key, baseline);
        }
      }
    } else if (event.type === 'workspace.edit.reverted') {
      for (const outcome of event.outcomes) {
        if (outcome.status === 'reverted' && !reverted.has(outcome.entryId)) {
          reverted.set(outcome.entryId, committedAt(row));
        }
      }
    }
  }
  return { baselines, reverted };
}

/** Restorable only when every path the entry restores has a kept prior state. */
function entryAvailability(
  event: Recorded,
  baselines: CommittedEdits['baselines']
): {
  readonly availability: AssistantCheckpointUndoAvailability;
  readonly unavailable?: Unavailable;
} {
  const paths = event.fromPath === undefined ? [event.path] : [event.fromPath, event.path];
  for (const path of paths) {
    const baseline = baselines.get(baselineKey(event.runId, event.rootId, path));
    if (!baseline) {
      return {
        availability: { reason: 'No prior state was recorded for this edit.', restorable: false },
      };
    }
    if (baseline.kind === 'unavailable') {
      return {
        availability: {
          reason: `"${path}": ${hostEditBaselineUnavailableReason(baseline.reason)}`,
          restorable: false,
        },
        unavailable: baseline,
      };
    }
  }
  return { availability: { restorable: true } };
}

function checkpointRecord(
  row: HostLogRow,
  event: Recorded,
  unavailable: Unavailable | undefined,
  revertedAt: string | undefined
): AssistantEditCheckpointRecord {
  return {
    afterExisted: event.after.existed,
    afterHash: event.after.hash,
    beforeExisted: event.before.existed,
    beforeHash: event.before.hash,
    beforeSize: event.before.size,
    captureStatus: captureStatus(event, unavailable),
    fromPath: event.fromPath === undefined ? null : `/${event.fromPath}`,
    id: event.entryId,
    occurredAt: committedAt(row),
    op: event.op,
    path: `/${event.path}`,
    resourceId: WORKSPACE_MEMORY_RESOURCE_ID,
    revertedAt: revertedAt ?? null,
    rootId: event.rootId,
    runId: event.runId,
    threadId: row.threadId,
    toolCallId: event.toolCallId,
    toolName: denormalizeNativeToolName(event.toolId),
  };
}

export function foldHostEditCheckpoints(rows: readonly HostLogRow[]): HostEditCheckpointView {
  const edits = committedEdits(rows);
  const entries: AssistantEditCheckpointRecord[] = [];
  const availabilityById = new Map<string, AssistantCheckpointUndoAvailability>();
  for (const row of rows) {
    const event = row.event;
    if (event.type !== 'workspace.edit.recorded') {
      continue;
    }
    const { availability, unavailable } = entryAvailability(event, edits.baselines);
    availabilityById.set(event.entryId, availability);
    entries.push(checkpointRecord(row, event, unavailable, edits.reverted.get(event.entryId)));
  }
  return { availabilityById, entries };
}
