// The writer worker's replies as the facade returns them: its run-log rows and its errors.
import { StateStoreReadOnlyError, ThreadDamagedError, ThreadReadOnlyError } from './errors.js';
import type { LogRow, RunEvent } from './run-log-types.js';
import { CheckpointBlockedError } from './sqlite-checkpoint.mjs';

/** A verified run-log row as the writer worker replies with it (RunLog `Row`). */
export interface WorkerRow {
  readonly payload: string;
  readonly rawCount: number | null;
  readonly seq: number;
  readonly ts: number;
}

export function logRowOf(threadId: string, x: WorkerRow): LogRow {
  const row = {
    event: JSON.parse(x.payload) as RunEvent,
    raw: x.payload,
    seq: x.seq,
    threadId,
    ts: x.ts,
  };
  return x.rawCount === null ? row : { ...row, rawCount: x.rawCount };
}

export function errorOf(r: Readonly<Record<string, unknown>>): Error {
  const message = String(r['error']);
  switch (r['errorKind']) {
    case 'readonly':
      return new ThreadReadOnlyError(
        String(r['threadId']),
        message,
        typeof r['storeDamage'] === 'string' ? r['storeDamage'] : null
      );
    case 'store-readonly':
      return new StateStoreReadOnlyError(String(r['damage']));
    case 'damaged':
      return new ThreadDamagedError(String(r['threadId']), Number(r['atSeq']), String(r['detail']));
    case 'checkpoint-blocked':
      return new CheckpointBlockedError(message);
    default:
      return new Error(message);
  }
}
