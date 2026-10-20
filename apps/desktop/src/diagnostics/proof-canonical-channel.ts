import { createHash } from 'node:crypto';
import { canonicalOperations } from '../canonical-utility-protocol';

export type CanonicalProofSide = 'parent' | 'child' | 'channel';
type Phase =
  | 'send'
  | 'sent'
  | 'send-failed'
  | 'receive'
  | 'callback-start'
  | 'callback-success'
  | 'callback-failure';
const controls = new Set(['attach', 'close', 'cancel', 'trigger', 'start-scan', 'join-scan']);
let sequence = 0;

/** PROOF ONLY. Never serialize payloads, application request IDs, errors, paths or content. */
export function proofCanonicalChannel(
  side: CanonicalProofSide,
  phase: Phase,
  input: unknown
): void {
  if (process.env['BRAINSTRIKE_PROOF_CANONICAL'] !== '1') {
    return;
  }
  if (!(input && typeof input === 'object')) {
    return;
  }
  const frame = input as Record<string, unknown>;
  const op = typeof frame['op'] === 'string' ? frame['op'] : undefined;
  process.stderr.write(
    `[canonical-proof] ${JSON.stringify({
      at: Date.now(),
      kind:
        typeof frame['kind'] === 'string' &&
        ['call', 'result', 'cancel', 'event'].includes(frame['kind'])
          ? frame['kind']
          : 'invalid',
      monotonicMs: performance.now(),
      owner:
        typeof frame['owner'] === 'string'
          ? createHash('sha256').update(frame['owner']).digest('hex').slice(0, 32)
          : 'invalid',
      phase,
      pid: process.pid,
      ppid: process.ppid,
      sequence: ++sequence,
      side,
      timeOrigin: performance.timeOrigin,
      ...(typeof frame['id'] === 'number' && Number.isSafeInteger(frame['id'])
        ? { id: frame['id'] }
        : {}),
      ...(op
        ? { op: Object.hasOwn(canonicalOperations, op) || controls.has(op) ? op : 'unknown' }
        : {}),
      ...(typeof frame['ok'] === 'boolean' ? { ok: frame['ok'] } : {}),
      ...(frame['cancelled'] === true ? { cancelled: true } : {}),
    })}\n`
  );
}

export function proofCanonicalSender(
  side: CanonicalProofSide,
  send: (frame: object) => void
): (frame: object) => void {
  if (process.env['BRAINSTRIKE_PROOF_CANONICAL'] !== '1') {
    return send;
  }
  return (frame) => {
    proofCanonicalChannel(side, 'send', frame);
    try {
      send(frame);
    } catch (error) {
      proofCanonicalChannel(side, 'send-failed', frame);
      throw error;
    }
    proofCanonicalChannel(side, 'sent', frame);
  };
}
