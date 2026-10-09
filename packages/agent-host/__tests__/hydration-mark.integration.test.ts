/**
 * Core commits a streamed chunk that no hydration fold reads (text deltas and
 * the step framing around them) with the store's hydrate mark off, so a
 * restart's open never reads it; the tool chunks the ledger counts stay
 * marked, and thread/read still returns every committed row.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PERMISSION_POLICIES } from '@brainstrike/assistant-contract';
import { STATE_DB, StateStore } from '@brainstrike/state-store';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { HostCore } from '../src/core.js';
import type { HostPlatform } from '../src/ports.js';
import type { HostLogRow } from '../src/protocol.js';
import { stream, text, toolCall } from './fixtures/child-run-host.js';

const TERMINAL_POLL = { interval: 50, timeout: 30_000 };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function platform(): HostPlatform {
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1;
      return stream(calls === 1 ? toolCall('answer', { text: 'x' }, 'call-1') : text('All done.'));
    },
  });
  return {
    close: async () => undefined,
    maxSteps: 3,
    readPermissionPolicy: () => ({ policies: { ...DEFAULT_PERMISSION_POLICIES }, yolo: false }),
    resolveModel: async () => model,
    tools: {
      answer: {
        description: 'Synthetic read-only tool',
        execute: async () => ({ answered: true }),
        identity: 'hydration-mark-fixture',
        inputSchema: z.object({ text: z.string() }),
        risk: 'read',
      },
    },
  };
}

const chunkType = ({ event }: HostLogRow): string | undefined =>
  event.type === 'stream.chunk'
    ? z.object({ type: z.string() }).parse(event.chunk).type
    : undefined;

test('a text chunk commits outside the hydration read; tool chunks and every other row stay in it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bs-hydration-mark-'));
  roots.push(root);
  let store = await StateStore.open(root);
  let core = await HostCore.open(store, platform(), () => () => undefined);
  let rows: HostLogRow[];
  let threadId: string;
  try {
    ({ threadId } = await core.startThread({ commandId: randomUUID() }));
    const { runId } = await core.startRun({
      commandId: randomUUID(),
      modelId: 'openai::gpt-hydration-mark-fixture',
      prompt: 'Call the tool, then answer.',
      threadId,
    });
    await expect
      .poll(
        async () =>
          (await core.read(threadId, 0)).some(
            (row) => row.event.type === 'run.finished' && row.event.runId === runId
          ),
        TERMINAL_POLL
      )
      .toBe(true);
    rows = await core.read(threadId, 0);
  } finally {
    await core.close();
    await store.close();
  }
  const db = new DatabaseSync(join(root, STATE_DB), { readOnly: true });
  const marks = new Map(
    db
      .prepare('SELECT seq, hydrate FROM run_events WHERE thread_id = ?')
      .all(threadId)
      .map((row) => [Number(row['seq']), Number(row['hydrate'])])
  );
  db.close();
  const markOf = (type: string | undefined) =>
    rows.filter((row) => chunkType(row) === type).map((row) => marks.get(row.seq));
  expect(markOf('text-delta')).toEqual([0]);
  expect(markOf('tool-call')).toEqual([1]);
  expect(markOf(undefined).every((mark) => mark === 1)).toBe(true);

  // The mark only keeps a row out of the open: the full read still has every row.
  store = await StateStore.open(root);
  core = await HostCore.open(store, platform(), () => () => undefined);
  try {
    expect(await core.read(threadId, 0)).toEqual(rows);
  } finally {
    await core.close();
    await store.close();
  }
});
