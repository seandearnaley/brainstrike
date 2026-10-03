// @ts-check
// The stored form of one run-log row, shared by the writer worker and the read-only readers (M0-A2 src/sqlite-log.ts,
// src/frame.ts). A row's payload is its event body with the row's seq written first: `{"seq":N,...}`.
// SQLite stores no checksum of row content: a flipped payload byte passes `integrity_check` and is returned as if
// nothing happened (M0-A2 item 3c), so every row also carries crc32(payload).
import { crc32 } from 'node:zlib';

/**
 * crc32 of the payload's UTF-8 bytes.
 * @param {string} payload
 * @returns {number}
 */
export const crcOf = (payload) => crc32(Buffer.from(payload, 'utf8'));

/**
 * Whether a stored row still matches its crc.
 * @param {{ readonly payload: string; readonly crc: number }} row
 * @returns {boolean}
 */
export function verified(row) {
  return crcOf(row.payload) === row.crc;
}

/**
 * The stored payload of event `body` at `seq`.
 * @param {number} seq
 * @param {string} body
 * @returns {string}
 */
export function withSeq(seq, body) {
  if (!body.startsWith('{') || body.length < 3 || body[1] === '}') {
    throw new Error('event body must be a non-empty JSON object');
  }
  return `{"seq":${seq},${body.slice(1)}`;
}

/** What a purge leaves in place of the purged event: the seq stays, every byte of the old body goes. */
export const TOMBSTONE_BODY = '{"type":"purged"}';

/**
 * Blob hashes an event references: by convention the event's top-level `blob` field (M0-A2 src/host.ts blobsOf).
 * @param {string} raw
 * @returns {string[]}
 */
export function blobsOf(raw) {
  const o = /** @type {{ blob?: unknown }} */ (JSON.parse(raw));
  if (o.blob === undefined) {
    return [];
  }
  if (typeof o.blob !== 'string' || !/^[a-f0-9]{64}$/.test(o.blob)) {
    throw new Error('event has an invalid blob hash');
  }
  return [o.blob];
}
