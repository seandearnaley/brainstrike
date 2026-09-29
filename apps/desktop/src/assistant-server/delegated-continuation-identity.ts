import { createHash } from 'node:crypto';

/** Opaque display/ledger identity only; never parsed for scope or native execution. */
export function continuationProjectionId(hostRunId: string, continuationId: string): string {
  return `continuation-${createHash('sha256')
    .update(JSON.stringify([hostRunId, continuationId]))
    .digest('hex')}`;
}
