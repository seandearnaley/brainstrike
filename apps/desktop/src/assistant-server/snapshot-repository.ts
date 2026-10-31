/**
 * Workspace snapshot ledger vocabulary (BST-1164): the row shape, the app-side
 * UUIDv7 id minter, and the failed-capture marker.
 *
 * FAILED-CAPTURE ROWS: a snapshot capture that FAILED is still recorded, as a
 * row whose `commit_oid` is {@link FAILED_SNAPSHOT_CAPTURE_OID} (git's all-zero
 * null oid — a valid oid SHAPE naming no object). EVERY reader of the ledger
 * MUST check {@link isFailedSnapshotCaptureOid} before treating a row's oid as
 * a real commit. Never hand a sentinel oid to git.
 */

import { randomBytes } from 'node:crypto';

/**
 * Durable failed-capture marker (see the module doc comment): git's all-zero
 * null oid, stored in `commit_oid` when a snapshot capture failed. It names
 * no object by construction, so it can never be confused with a real commit.
 */
export const FAILED_SNAPSHOT_CAPTURE_OID = '0'.repeat(40);

export function isFailedSnapshotCaptureOid(oid: string): boolean {
  return oid === FAILED_SNAPSHOT_CAPTURE_OID;
}

const UUID_V7_MAX_TIMESTAMP_MS = 2 ** 48;
const UUID_V7_COUNTER_MAX = 0xf_ff;

let monotonicMs = -1;
let monotonicCounter = 0;

/**
 * App-side UUIDv7 (RFC 9562): 48-bit millisecond timestamp, version and
 * variant bits, a 12-bit per-millisecond MONOTONIC counter in rand_a (RFC
 * 9562 §6.2 method 2), and 62 random bits in rand_b. The id is minted here so
 * the caller owns it before the INSERT round trip — and so ids from this
 * process sort in MINT ORDER even within one millisecond, which is what makes
 * `ORDER BY created_at, id` deterministic when two snapshot rows carry a tied
 * timestamp (consecutive inserts can tie).
 */
export function generateWorkspaceSnapshotId(nowMs = Date.now()): string {
  if (!(Number.isSafeInteger(nowMs) && nowMs >= 0 && nowMs < UUID_V7_MAX_TIMESTAMP_MS)) {
    throw new RangeError(`uuidv7 timestamp out of range: ${nowMs}`);
  }
  let ms = nowMs;
  if (ms === monotonicMs) {
    monotonicCounter += 1;
    if (monotonicCounter > UUID_V7_COUNTER_MAX) {
      // 4097 ids in one millisecond: roll into the next millisecond (RFC 9562
      // "increment timestamp" guidance) rather than wrapping the counter,
      // which would break the mint-order sort this generator exists for.
      ms += 1;
      if (ms >= UUID_V7_MAX_TIMESTAMP_MS) {
        throw new RangeError(`uuidv7 timestamp overflow after counter rollover: ${ms}`);
      }
      monotonicMs = ms;
      monotonicCounter = 0;
    }
  } else {
    monotonicMs = ms;
    monotonicCounter = 0;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | ((monotonicCounter >> 8) & 0x0f);
  bytes[7] = monotonicCounter & 0xff;
  bytes[8] = 0x80 | (bytes.readUInt8(8) & 0x3f);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
