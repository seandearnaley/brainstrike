// @vitest-environment node
/**
 * Rewind boundary on the current owner: real host protocol, durable log and shadow Git.
 * Three roots and direct shell writes remain the bar. Host branches replace tombstone
 * finalization; the retired changes:* rewind IPC is never constructed here.
 */
import { randomUUID } from 'node:crypto';
import { committedRunIdentity } from '@brainstrike/agent-host/committed-identities';
import type { HostParams } from '@brainstrike/agent-host/protocol';
import type { ReadyRewindPreview } from '@brainstrike/app-shell/changes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanHostFixtures,
  editAll,
  type HostSnapshotFixture,
  hostSnapshotFixture,
  read,
  write,
} from './host-snapshot-test-support';

let f: HostSnapshotFixture;
beforeEach(async () => {
  f = await hostSnapshotFixture();
});
afterEach(cleanHostFixtures);
const HEAVY_TIMEOUT_MS = 60_000;
async function preview(messageId: string): Promise<ReadyRewindPreview> {
  const result = await f.port.preview({ messageId, threadId: f.threadId });
  if (!(result.ok && result.value.ok)) {
    throw new Error('Expected a current host preview');
  }
  return result.value;
}
async function seed() {
  return await f.send(() => editAll(f));
}
async function apply(
  ready: ReadyRewindPreview,
  mode: 'conversation-only' | 'conversation-and-files' = 'conversation-and-files',
  acknowledgeConflicts = false
) {
  const result = await f.port.apply({ acknowledgeConflicts, mode, preview: ready });
  if (!(result.ok && result.value.ok)) {
    throw new Error('Expected the host rewind to apply');
  }
  return result.value;
}
async function assertUnchanged() {
  expect(await read(f.a, 'src/index.ts')).toBe('a-v1\n');
  expect(await read(f.b, 'src/index.ts')).toBe('b-v1\n');
  expect(await read(f.c, 'notes/scratch.md')).toBe('c-v1\n');
  expect(await read(f.c, 'notes/generated.lock')).toBe('shell wrote this\n');
}

describe('host rewind boundary validation', () => {
  it.each([
    undefined,
    {},
    { messageId: 'message' },
    { threadId: '' },
    { messageId: '', threadId: 'valid' },
    { messageId: 'message', nope: 1, threadId: 'valid' },
  ])(
    'rejects malformed preview %j without committing or touching files',
    async (payload) => {
      await seed();
      const before = await f.rows();
      await expect(
        f.client().request('thread/rewind/preview', payload as HostParams<'thread/rewind/preview'>)
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      await assertUnchanged();
    },
    HEAVY_TIMEOUT_MS
  );
  it.each([
    { mode: undefined },
    { mode: 'files-only' },
    { acknowledgeConflicts: 'yes', mode: 'conversation-and-files' },
  ])(
    'rejects malformed apply %j without defaulting into disk writes',
    async (invalid) => {
      const run = await seed();
      const before = await f.rows();
      await expect(
        f.client().request('thread/rewind', {
          commandId: randomUUID(),
          messageId: run.messageId,
          threadId: f.threadId,
          ...invalid,
        } as unknown as HostParams<'thread/rewind'>)
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      await assertUnchanged();
    },
    HEAVY_TIMEOUT_MS
  );
  it('rejects a redo with no durable rewind identity', async () => {
    const before = await f.rows();
    await expect(
      f.client().request('thread/rewind/redo', {
        commandId: randomUUID(),
        threadId: f.threadId,
      } as HostParams<'thread/rewind/redo'>)
    ).rejects.toThrow();
    expect(await f.rows()).toEqual(before);
  });
});

describe('host rewind preview over multi-root snapshots', () => {
  it(
    'resolves the message to its committed run, all roots and the shell-created file',
    async () => {
      const run = await seed();
      const ready = await preview(run.messageId);
      expect(ready).toMatchObject({
        changeset: { fromRunId: run.runId, kind: 'run-range', threadId: f.threadId },
        conversation: { kind: 'branched', turns: 1 },
        filesScope: { available: true },
        messageId: run.messageId,
      });
      expect(ready.view?.files.map((file) => file.rootId).sort()).toEqual([
        'root-a',
        'root-b',
        'root-c',
        'root-c',
      ]);
      expect(ready.view?.files.find((file) => file.path === 'notes/generated.lock')).toMatchObject({
        status: 'added',
      });
      expect(ready.restoreRoots).toEqual(f.roots);
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'resolves a run target through its recorded user-message identity, never timestamps',
    async () => {
      const first = await f.send();
      const second = await seed();
      const result = await f.port.preview({ runId: second.runId, threadId: f.threadId });
      expect(result).toMatchObject({
        ok: true,
        value: { changeset: { fromRunId: second.runId }, messageId: second.messageId, ok: true },
      });
      expect(second.messageId).not.toBe(first.messageId);
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'refuses an unknown run visibly without inventing a message or mutating history',
    async () => {
      await seed();
      const before = await f.rows();
      await expect(
        f.port.preview({ runId: 'run-does-not-exist', threadId: f.threadId })
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
    },
    HEAVY_TIMEOUT_MS
  );
});

describe('host rewind and redo over three real roots', () => {
  it(
    'conversation-only commits a branch movement and touches no file or reindex effect',
    async () => {
      const run = await seed();
      const result = await apply(await preview(run.messageId), 'conversation-only');
      expect(result.outcome).toEqual({
        conversation: { kind: 'branched', turns: 1 },
        notRestored: [],
        roots: [],
      });
      await assertUnchanged();
      expect(f.reindexed).toEqual([]);
      expect((await f.rows()).filter(({ event }) => event.type === 'run.started')).toHaveLength(1);
      expect((await f.rows()).some(({ event }) => event.type === 'thread.rewound')).toBe(true);
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'restores every root, removes a shell-created file, and names each root outcome',
    async () => {
      const run = await seed();
      const result = await apply(await preview(run.messageId));
      expect(await read(f.a, 'src/index.ts')).toBe('a-v0\n');
      expect(await read(f.b, 'src/index.ts')).toBe('b-v0\n');
      expect(await read(f.c, 'notes/scratch.md')).toBe('c-v0\n');
      expect(await read(f.c, 'notes/generated.lock')).toBeNull();
      expect(result.outcome.roots).toMatchObject([
        { attempted: 1, conflicts: 0, failed: 0, restored: 1, rootId: 'root-a' },
        { attempted: 1, conflicts: 0, failed: 0, restored: 1, rootId: 'root-b' },
        { attempted: 2, conflicts: 0, failed: 0, restored: 2, rootId: 'root-c' },
      ]);
      expect(f.reindexed).toEqual(['root-a', 'root-b', 'root-c']);
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'refuses file restoration without an issued preview and leaves all roots unchanged',
    async () => {
      const run = await seed();
      const before = await f.rows();
      await expect(
        f.client().request('thread/rewind', {
          commandId: randomUUID(),
          messageId: run.messageId,
          mode: 'conversation-and-files',
          threadId: f.threadId,
        })
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      await assertUnchanged();
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'one drifting root blocks the entire apply until its conflict is acknowledged',
    async () => {
      const run = await seed();
      const ready = await preview(run.messageId);
      const before = await f.rows();
      await write(f.b, 'src/index.ts', 'b-user-edit\n');
      const refused = await f.port.apply({
        acknowledgeConflicts: false,
        mode: 'conversation-and-files',
        preview: ready,
      });
      expect(refused).toMatchObject({
        ok: true,
        value: {
          conflicts: [{ forceable: true, path: 'src/index.ts', rootId: 'root-b' }],
          ok: false,
          redoable: null,
        },
      });
      expect(await f.rows()).toEqual(before);
      expect(await read(f.a, 'src/index.ts')).toBe('a-v1\n');
      expect(await read(f.c, 'notes/scratch.md')).toBe('c-v1\n');
      await apply(ready, 'conversation-and-files', true);
      expect(await read(f.b, 'src/index.ts')).toBe('b-v0\n');
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'redo restores every root including the shell-created file after physical host reopen',
    async () => {
      const run = await seed();
      const result = await apply(await preview(run.messageId));
      expect(await read(f.c, 'notes/generated.lock')).toBeNull();
      await f.reopen();
      expect(
        await f.port.redo({
          acknowledgeConflicts: false,
          rewindId: result.rewindId,
          roots: result.outcome.roots,
          threadId: f.threadId,
        })
      ).toMatchObject({ ok: true, value: { ok: true } });
      await assertUnchanged();
      expect((await f.rows()).some(({ event }) => event.type === 'thread.rewind.redone')).toBe(
        true
      );
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'redo names post-rewind drift and leaves it unchanged until explicit acknowledgement',
    async () => {
      const run = await seed();
      const result = await apply(await preview(run.messageId));
      await write(f.a, 'src/index.ts', 'user after rewind\n');
      const request = {
        rewindId: result.rewindId,
        roots: result.outcome.roots,
        threadId: f.threadId,
      };
      expect(await f.port.redo({ ...request, acknowledgeConflicts: false })).toMatchObject({
        ok: true,
        value: { forceable: true, ok: false },
      });
      expect(await read(f.a, 'src/index.ts')).toBe('user after rewind\n');
      expect(await f.port.redo({ ...request, acknowledgeConflicts: true })).toMatchObject({
        ok: true,
        value: { ok: true },
      });
      await assertUnchanged();
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'unknown rewind refuses without deleting any durable history',
    async () => {
      await seed();
      const before = await f.rows();
      await expect(
        f.port.redo({
          acknowledgeConflicts: false,
          rewindId: 'never-created',
          roots: f.roots,
          threadId: f.threadId,
        })
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      await assertUnchanged();
    },
    HEAVY_TIMEOUT_MS
  );
});

describe('host branches replace legacy tombstone finalization', () => {
  it(
    'next Send branches from before the rewound turn while retaining all earlier committed messages',
    async () => {
      const first = await f.send();
      const second = await seed();
      await apply(await preview(second.messageId), 'conversation-only');
      const before = await f.rows();
      const third = await f.send();
      const rows = await f.rows();
      expect(rows.slice(0, before.length)).toEqual(before);
      expect(committedRunIdentity(rows, second.runId).userMessageId).toBe(second.messageId);
      expect(
        rows.filter(({ event }) => event.type === 'run.started').map(({ event }) => event)
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: second.runId }),
          expect.objectContaining({ parentMessageId: first.runId, runId: third.runId }),
        ])
      );
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'next Send closes direct redo but retains the old branch across reopen',
    async () => {
      await f.send();
      const second = await seed();
      const result = await apply(await preview(second.messageId), 'conversation-only');
      await f.send();
      await f.reopen();
      const before = await f.rows();
      await expect(
        f.port.redo({
          acknowledgeConflicts: false,
          rewindId: result.rewindId,
          roots: [],
          threadId: f.threadId,
        })
      ).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      expect(
        before.some(({ event }) => event.type === 'run.started' && event.runId === second.runId)
      ).toBe(true);
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'a disconnected root refuses preview rather than silently dropping that root',
    async () => {
      const run = await seed();
      f.mounted.delete('root-b');
      const before = await f.rows();
      await expect(preview(run.messageId)).rejects.toThrow();
      expect(await f.rows()).toEqual(before);
      await assertUnchanged();
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'failure during file restore records interruption instead of pretending a complete restore',
    async () => {
      const run = await seed();
      const ready = await preview(run.messageId);
      f.loseRootAfterDrift();
      const result = await f.port.apply({
        acknowledgeConflicts: true,
        mode: 'conversation-and-files',
        preview: ready,
      });
      expect(result).toMatchObject({
        ok: true,
        value: { ok: false, redoable: { rewindId: expect.any(String) } },
      });
      expect((await f.rows()).some(({ event }) => event.type === 'thread.rewind.interrupted')).toBe(
        true
      );
      expect(await read(f.a, 'src/index.ts')).toBe('a-v0\n');
      expect(await read(f.b, 'src/index.ts')).toBe('b-v1\n');
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'a missing snapshot capability offers conversation-only with an explicit files refusal',
    async () => {
      const other = await hostSnapshotFixture({ capture: false });
      const run = await other.send();
      const result = await other.port.preview({
        messageId: run.messageId,
        threadId: other.threadId,
      });
      expect(result).toMatchObject({
        ok: true,
        value: { filesScope: { available: false }, ok: true, restoreRoots: null, view: null },
      });
    },
    HEAVY_TIMEOUT_MS
  );
});
