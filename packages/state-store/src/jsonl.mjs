// @ts-check
// Run-log interchange, distinct from the complete VACUUM INTO state bundle. Runs on the writer worker only.
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blobsOf, verified } from './run-log-format.mjs';

const HEADER = { format: 'brainstrike-run-log', version: 1 };
const HASH = /^[a-f0-9]{64}$/;
/** @param {string} content */
const hashOf = (content) => createHash('sha256').update(content).digest('hex');
/** @typedef {{ threadId: string; seq: number; payload: string; crc: number; rawCount: number | null; createdAt: number }} Row */
/** @typedef {{ hash: string; content: string }} Blob */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @returns {Row} */
function eventRow(value) {
  if (
    !object(value) ||
    value['kind'] !== 'event' ||
    typeof value['threadId'] !== 'string' ||
    value['threadId'].length === 0 ||
    typeof value['seq'] !== 'number' ||
    !Number.isSafeInteger(value['seq']) ||
    value['seq'] < 1 ||
    typeof value['payload'] !== 'string' ||
    typeof value['crc'] !== 'number' ||
    !Number.isSafeInteger(value['crc']) ||
    typeof value['createdAt'] !== 'number' ||
    !Number.isFinite(value['createdAt']) ||
    !(
      value['rawCount'] === null ||
      (typeof value['rawCount'] === 'number' &&
        Number.isSafeInteger(value['rawCount']) &&
        value['rawCount'] > 0)
    )
  ) {
    throw new Error('JSONL: malformed event row');
  }
  const row = /** @type {Row} */ (/** @type {unknown} */ (value));
  if (!verified(row)) {
    throw new Error('JSONL: event checksum mismatch');
  }
  const event = JSON.parse(row.payload);
  if (
    !object(event) ||
    event['seq'] !== row.seq ||
    typeof event['type'] !== 'string' ||
    event['type'].length === 0
  ) {
    throw new Error('JSONL: invalid event payload');
  }
  return row;
}

/** @param {import('better-sqlite3').Database} db @param {string} blobsDir @param {string} path */
export function exportJsonl(db, blobsDir, path) {
  const fd = openSync(path, 'wx', 0o600);
  let complete = false;
  try {
    writeFileSync(fd, `${JSON.stringify(HEADER)}\n`);
    const seen = new Set();
    const tails = new Map();
    /** @type {IterableIterator<Row>} */
    const rows = /** @type {IterableIterator<Row>} */ (
      db
        .prepare(
          'SELECT thread_id AS threadId, seq, payload, crc, raw_count AS rawCount, created_at AS createdAt FROM run_events ORDER BY id'
        )
        .iterate()
    );
    for (const row of rows) {
      eventRow({ ...row, kind: 'event' });
      if (row.seq !== (tails.get(row.threadId) ?? 0) + 1) {
        throw new Error('JSONL: noncontiguous event sequence');
      }
      tails.set(row.threadId, row.seq);
      writeFileSync(fd, `${JSON.stringify({ ...row, kind: 'event' })}\n`);
      for (const hash of blobsOf(row.payload)) {
        if (!HASH.test(hash)) {
          throw new Error('JSONL: invalid blob hash');
        }
        if (seen.has(hash)) {
          continue;
        }
        const content = readFileSync(join(blobsDir, hash), 'utf8');
        if (hashOf(content) !== hash) {
          throw new Error(`JSONL: blob ${hash} checksum mismatch`);
        }
        writeFileSync(fd, `${JSON.stringify({ content, hash, kind: 'blob' })}\n`);
        seen.add(hash);
      }
    }
    fsyncSync(fd);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) {
      unlinkSync(path);
    }
  }
}

/** @param {string} path @returns {{ rows: Row[]; blobs: Blob[] }} */
export function readJsonl(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  if (lines.pop() !== '') {
    throw new Error('JSONL: truncated file (missing final newline)');
  }
  const header = JSON.parse(lines.shift() ?? '');
  if (
    !object(header) ||
    header['format'] !== HEADER.format ||
    header['version'] !== HEADER.version
  ) {
    throw new Error('JSONL: unsupported format');
  }
  /** @type {Row[]} */ const rows = [];
  /** @type {Map<string, string>} */ const blobs = new Map();
  const tails = new Map();
  const refs = new Set();
  for (const line of lines) {
    const value = JSON.parse(line);
    if (object(value) && value['kind'] === 'blob') {
      const hash = value['hash'];
      const content = value['content'];
      if (
        typeof hash !== 'string' ||
        !HASH.test(hash) ||
        typeof content !== 'string' ||
        hashOf(content) !== hash ||
        blobs.has(hash)
      ) {
        throw new Error('JSONL: invalid, duplicate or checksum-damaged blob');
      }
      blobs.set(hash, content);
      continue;
    }
    const row = eventRow(value);
    if (row.seq !== (tails.get(row.threadId) ?? 0) + 1) {
      throw new Error('JSONL: noncontiguous event sequence');
    }
    tails.set(row.threadId, row.seq);
    for (const hash of blobsOf(row.payload)) {
      refs.add(hash);
    }
    rows.push(row);
  }
  if (refs.size !== blobs.size || [...refs].some((hash) => !blobs.has(hash))) {
    throw new Error('JSONL: missing or unreferenced blob');
  }
  return { blobs: [...blobs].map(([hash, content]) => ({ content, hash })), rows };
}
