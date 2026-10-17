import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BLOBS_DIR, withSeq } from '@brainstrike/state-store';
import approved from '@brainstrike/test-utils/fixtures/committed-approved-host-run.json' with {
  type: 'json',
};
import plan from '@brainstrike/test-utils/fixtures/committed-host-plan.json' with { type: 'json' };
import rich from '@brainstrike/test-utils/fixtures/committed-rich-host-runs.json' with {
  type: 'json',
};
import { Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { storedHostEvent } from '../src/event-storage.js';
import { decodeHostRow, messages, search, text } from '../src/host-state-producer.js';
import { HostLogRowSchema } from '../src/protocol.js';
import * as desktop from '../src/state-projection.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});
/**
 * Recorded committed host runs, stored as Core stores them: run snapshots and
 * large bodies spool to content-addressed blobs. One tool result is inflated
 * past the spool threshold, so the corpus has a spooled body as well as run
 * snapshot references.
 */
function storedCorpus() {
  const rows = [...rich, ...approved, ...plan].map((row) =>
    Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })(row)
  );
  const finished = rows.find((row) => row.event.type === 'effect.finished');
  if (!finished) {
    throw new Error('the corpus needs a tool result to spool');
  }
  rows.push({
    ...finished,
    event: { ...finished.event, output: `large tool output ✓\n${'x'.repeat(40_000)}` },
    seq: 10_000,
  } as typeof finished);
  const blobs = new Map<string, string>();
  const raws = rows.map((row) => {
    const stored = storedHostEvent(row.threadId, row.event);
    for (const blob of stored.blobs ?? []) {
      blobs.set(blob.hash, blob.content);
    }
    return { raw: withSeq(row.seq, JSON.stringify(stored.event)), row };
  });
  return { blobs, raws };
}
describe('the host state producer, as the browser writer runs it', () => {
  it("decodes and projects every committed row exactly as the desktop's file-backed producer does", () => {
    const { blobs, raws } = storedCorpus();
    expect(raws.some(({ raw }) => raw.includes('"snapshotRef"'))).toBe(true);
    expect(raws.some(({ raw }) => /"blob":"[a-f0-9]{64}"/.test(raw))).toBe(true);
    const root = mkdtempSync(path.join(os.tmpdir(), 'brainstrike-producer-'));
    roots.push(root);
    mkdirSync(path.join(root, BLOBS_DIR));
    for (const [hash, content] of blobs) {
      writeFileSync(path.join(root, BLOBS_DIR, hash), content);
    }
    const encoder = new TextEncoder();
    const readBlob = (hash: string): Uint8Array => {
      const content = blobs.get(hash);
      if (content === undefined) {
        throw new Error(`missing blob ${hash}`);
      }
      return encoder.encode(content);
    };
    const fromFiles = raws.map(({ raw }) => desktop.decode(raw, 'prod', root));
    const fromReader = raws.map(({ raw }) => decodeHostRow(raw, 'prod', readBlob));
    expect(fromReader).toEqual(fromFiles);
    expect(fromReader.some((event) => event.type === 'unreadable')).toBe(false);
    expect(fromReader.map(text)).toEqual(fromFiles.map(desktop.text));
    expect(fromReader.map(search)).toEqual(fromFiles.map(desktop.search));
    const threadRows = (decoded: typeof fromReader) =>
      decoded.map((event, index) => ({
        event,
        seq: event.seq,
        threadId: raws[index]?.row.threadId as string,
      }));
    expect(messages(threadRows(fromReader))).toEqual(desktop.messages(threadRows(fromFiles)));
  });
  it('refuses a row that needs a blob when no reader is given, as the desktop does without a root', () => {
    const { raws } = storedCorpus();
    const spooled = raws.find(({ raw }) => raw.includes('"snapshotRef"'));
    if (!spooled) {
      throw new Error('the corpus needs a run snapshot reference');
    }
    expect(decodeHostRow(spooled.raw, 'prod')).toEqual(desktop.decode(spooled.raw, 'prod'));
    expect(decodeHostRow(spooled.raw, 'prod')).toMatchObject({
      reason: 'Host blob projection requires its acquired truth root',
      type: 'unreadable',
    });
  });
});
