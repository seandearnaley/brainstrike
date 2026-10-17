// @vitest-environment node
/** Host-owned Changes: real committed snapshots, two Git roots and one plain root. */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { FAILED_SNAPSHOT_CAPTURE_OID } from '../../assistant-server/snapshot-repository';
import {
  cleanHostFixtures,
  editAll,
  hostSnapshotFixture,
  write,
} from './host-snapshot-test-support';

afterEach(cleanHostFixtures);
const HEAVY_TIMEOUT_MS = 60_000;
const agentRun = (threadId: string, runId: string) => ({
  kind: 'agent-run' as const,
  runId,
  threadId,
});

describe('host snapshot changes — real multi-root Git', () => {
  it(
    'captures shell-created and plain-root files with real totals and no fabricated tool attribution',
    async () => {
      const f = await hostSnapshotFixture();
      const run = await f.send(() => editAll(f));
      const result = await f.resolver().resolveView(agentRun(f.threadId, run.runId));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      const byKey = new Map(
        result.value.files.map((file) => [`${file.rootId}:${file.path}`, file])
      );
      expect(byKey.get('root-a:src/index.ts')).toMatchObject({ status: 'modified' });
      expect(byKey.get('root-b:src/index.ts')).toMatchObject({ status: 'modified' });
      expect(byKey.get('root-c:notes/scratch.md')).toMatchObject({ status: 'modified' });
      expect(byKey.get('root-c:notes/generated.lock')).toMatchObject({
        additions: 1,
        status: 'added',
      });
      // Host log has no workspace.edit.recorded: direct shell writes are visible but unattributed.
      expect(result.value.files.every((file) => file.toolAttributed === false)).toBe(true);
      expect(result.value.totalAdditions).toBe(
        result.value.files.reduce((n, file) => n + (file.additions ?? 0), 0)
      );
      expect(result.value.totalAdditions).toBeGreaterThan(0);
      expect(typeof result.value.totalDeletions).toBe('number');
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'disambiguates the same relative path across roots',
    async () => {
      const f = await hostSnapshotFixture();
      const run = await f.send(async () => {
        await write(f.a, 'same.txt', 'root A\n');
        await write(f.c, 'same.txt', 'root C\n');
      });
      const resolver = f.resolver();
      for (const [rootId, content] of [
        ['root-a', 'root A\n'],
        ['root-c', 'root C\n'],
      ] as const) {
        const diff = await resolver.fileDiff(rootId, agentRun(f.threadId, run.runId), 'same.txt');
        expect(diff).toMatchObject({
          ok: true,
          value: { content: { kind: 'full', newContent: content } },
        });
      }
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'grows the live view before turn-end, reading only incremental host rows with PGlite unavailable',
    async () => {
      const f = await hostSnapshotFixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const run = await f.start(async () => {
        entered.resolve();
        await release.promise;
      });
      try {
        await entered.promise;
        const resolver = f.resolver();
        await write(f.b, 'mid-turn-shell.txt', 'first\n');
        const first = await resolver.resolveView(agentRun(f.threadId, run.runId));
        expect(first).toMatchObject({
          ok: true,
          value: {
            files: expect.arrayContaining([
              expect.objectContaining({ path: 'mid-turn-shell.txt', rootId: 'root-b' }),
            ]),
          },
        });
        if (!first.ok) {
          throw new Error(first.error);
        }
        expect(first.value.files.every((file) => file.toolAttributed === undefined)).toBe(true);
        await write(f.c, 'second-mid-turn.txt', 'later\n');
        const second = await resolver.resolveView(agentRun(f.threadId, run.runId));
        expect(second).toMatchObject({
          ok: true,
          value: {
            files: expect.arrayContaining([
              expect.objectContaining({ path: 'second-mid-turn.txt', rootId: 'root-c' }),
            ]),
          },
        });
        expect(f.requestedSeqs[0]).toBe(0);
        expect(f.requestedSeqs[1]).toBeGreaterThan(0);
        expect(
          (await f.rows()).filter(
            ({ event }) =>
              event.type === 'workspace.snapshot.recorded' && event.boundary === 'turn-end'
          )
        ).toHaveLength(0);
      } finally {
        release.resolve();
        await f.settled(run.runId);
      }
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'one failed root capture refuses the whole view and remains failed after physical host reopen',
    async () => {
      const f = await hostSnapshotFixture({ failedRoot: 'root-b' });
      const run = await f.send();
      const check = async () => {
        const result = await f.resolver().resolveView(agentRun(f.threadId, run.runId));
        expect(result).toMatchObject({
          error: expect.stringMatching(/^changeset-snapshot-capture-failed:/),
          ok: false,
        });
      };
      await check();
      expect(
        (await f.rows()).some(
          ({ event }) =>
            event.type === 'workspace.snapshot.recorded' &&
            event.roots.some(
              (root) => root.rootId === 'root-b' && root.commitOid === FAILED_SNAPSHOT_CAPTURE_OID
            )
        )
      ).toBe(true);
      await f.reopen();
      await check();
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'a failed whole capture stays explicit instead of an empty successful diff',
    async () => {
      const f = await hostSnapshotFixture({ captureFailure: true });
      const run = await f.send();
      expect(await f.resolver().resolveView(agentRun(f.threadId, run.runId))).toMatchObject({
        error: expect.stringMatching(/^changeset-snapshot-capture-failed:/),
        ok: false,
      });
      expect(
        (await f.rows()).some(
          ({ event }) => event.type === 'workspace.snapshot.recorded' && 'failure' in event
        )
      ).toBe(true);
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'a current host run with no snapshot capability refuses instead of consulting legacy rows',
    async () => {
      const f = await hostSnapshotFixture({ capture: false });
      const run = await f.send();
      expect(await f.resolver().resolveView(agentRun(f.threadId, run.runId))).toMatchObject({
        error: expect.stringMatching(/^changeset-snapshot-missing:/),
        ok: false,
      });
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'unknown run and thread identities never alias a nearby timestamp or a prior turn',
    async () => {
      const f = await hostSnapshotFixture();
      await f.send(() => editAll(f));
      const resolver = f.resolver();
      expect(await resolver.resolveView(agentRun(f.threadId, 'run-ghost'))).toMatchObject({
        error: expect.stringMatching(/^changeset-snapshot-missing:/),
        ok: false,
      });
      expect(await resolver.resolveView(agentRun('thread-ghost', 'run-ghost'))).toMatchObject({
        error: expect.stringMatching(/^changeset-snapshot-missing:/),
        ok: false,
      });
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'a host range spans committed runs to the live worktree and refuses a fabricated terminal range',
    async () => {
      const f = await hostSnapshotFixture();
      const first = await f.send(() => write(f.a, 'src/index.ts', 'a-v0\nturn one\n'));
      const second = await f.send(async () => {
        await write(f.a, 'src/index.ts', 'a-v0\nturn one\nturn two\n');
        await write(f.b, 'range-shell.txt', 'shell turn two\n');
      });
      await f.reopen();
      const resolver = f.resolver();
      const result = await resolver.resolveView({
        fromRunId: first.runId,
        kind: 'run-range',
        threadId: f.threadId,
      });
      expect(result).toMatchObject({
        ok: true,
        value: {
          files: expect.arrayContaining([
            expect.objectContaining({ additions: 2, path: 'src/index.ts', rootId: 'root-a' }),
            expect.objectContaining({ path: 'range-shell.txt', rootId: 'root-b' }),
          ]),
        },
      });
      expect(
        await resolver.resolveView({
          fromRunId: first.runId,
          kind: 'run-range',
          threadId: f.threadId,
          toRunId: second.runId,
        })
      ).toMatchObject({ error: expect.stringMatching(/^run-range-unsupported:/), ok: false });
    },
    HEAVY_TIMEOUT_MS
  );
  it(
    'approval resumes the same committed run and keeps one start/end bracket across all roots',
    async () => {
      const f = await hostSnapshotFixture({ approval: true });
      const requested = Promise.withResolvers<string>();
      const unsubscribe = f.onCommitted((row) => {
        if (row.threadId === f.threadId && row.event.type === 'interaction.requested') {
          requested.resolve(row.event.interactionId);
        }
      });
      try {
        const run = await f.start(() => editAll(f));
        const interactionId = await requested.promise;
        expect((await f.rows()).filter(({ event }) => event.type === 'run.started')).toHaveLength(
          1
        );
        await f.client().request('interaction/respond', {
          commandId: randomUUID(),
          decision: 'approve',
          interactionId,
          runId: run.runId,
          threadId: f.threadId,
        });
        await f.settled(run.runId);
        const rows = await f.rows();
        expect(rows.filter(({ event }) => event.type === 'run.started')).toHaveLength(1);
        const snapshots = rows.flatMap(({ event }) =>
          event.type === 'workspace.snapshot.recorded' ? [event] : []
        );
        expect(
          snapshots.map((event) => ({
            boundary: event.boundary,
            roots: event.roots.length,
            runId: event.runId,
          }))
        ).toEqual([
          { boundary: 'turn-start', roots: 3, runId: run.runId },
          { boundary: 'turn-end', roots: 3, runId: run.runId },
        ]);
        expect(await f.resolver().resolveView(agentRun(f.threadId, run.runId))).toMatchObject({
          ok: true,
          value: {
            files: expect.arrayContaining([
              expect.objectContaining({ path: 'notes/generated.lock', rootId: 'root-c' }),
            ]),
          },
        });
      } finally {
        unsubscribe();
      }
    },
    HEAVY_TIMEOUT_MS
  );
});
