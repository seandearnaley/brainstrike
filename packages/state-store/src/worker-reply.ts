// The writer worker's replies as the facade returns them: its run-log rows and its errors.
import {
  StateStoreReadOnlyError,
  StateStoreRefusalError,
  ThreadDamagedError,
  ThreadReadOnlyError,
} from './errors.ts';
import type { LogRow, RunEvent } from './run-log-types.ts';
import { CheckpointBlockedError } from './sqlite-checkpoint.mjs';

/** A verified run-log row as the writer worker replies with it (RunLog `Row`). */
export interface WorkerRow {
  readonly payload: string;
  readonly seq: number;
  readonly ts: number;
}

export function logRowOf(threadId: string, x: WorkerRow): LogRow {
  return {
    event: JSON.parse(x.payload) as RunEvent,
    raw: x.payload,
    seq: x.seq,
    threadId,
    ts: x.ts,
  };
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
    case 'refused':
      return new StateStoreRefusalError(String(r['code']), message);
    default:
      return new Error(message);
  }
}
