/**
 * Unit coverage for the W7 turn-boundary snapshot triggers (BST-1164 T2):
 * turn lifecycle over fake service/repository seams — a turn is NOT a run
 * (resume legs attach, they never re-snapshot), pause observation, the
 * failed-capture sentinel row, stale-turn closure, restart adoption, and the
 * never-throws posture (a failed capture must never block or fail the run).
 * Real-git end-to-end coverage lives in
 * `changeset-snapshot-view.integration.test.ts`.
 */
import type { StreamChunk } from '@brainstrike/agent';
import { describe, expect, it } from 'vitest';
import type { EditCheckpointDatabase } from '../../assistant-server/edit-checkpoint-journal';
import {
  FAILED_SNAPSHOT_CAPTURE_OID,
  type InsertWorkspaceSnapshotInput,
  type SnapshotRepository,
  type WorkspaceSnapshotRow,
} from '../../assistant-server/snapshot-repository';
import type { ShadowRepoHandle, SnapshotService } from '../../assistant-server/snapshot-service';
import {
  createTurnBoundaryController,
  type LegPauseState,
  observeTurnPauseChunks,
  resolveTurnAnchorMessageId,
} from '../../assistant-server/snapshot-turn-boundaries';
import { createSnapshotTurnRegistry } from '../../assistant-server/snapshot-turn-registry';

const THREAD = 'thread-1';

/** In-memory SnapshotRepository with mint-ordered `createdAt` strings. */
function fakeRepository() {
  const rows: WorkspaceSnapshotRow[] = [];
  let counter = 0;
  const repository: SnapshotRepository = {
    deleteByIds: () => {
      throw new Error('deleteByIds is not under test');
    },
    deleteForThread: () => {
      throw new Error('deleteForThread is not under test');
    },
    insertSnapshot: (input: InsertWorkspaceSnapshotInput) => {
      counter += 1;
      const row: WorkspaceSnapshotRow = {
        commitOid: input.commitOid,
        createdAt: String(counter).padStart(8, '0'),
        id: `row-${counter}`,
        kind: input.kind,
        rootId: input.rootId,
        rootPath: input.rootPath,
        runId: input.runId ?? null,
        threadId: input.threadId,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    latestSnapshotFor: () => {
      throw new Error('latestSnapshotFor is not under test');
    },
    rootsForThread: () => {
      throw new Error('rootsForThread is not under test');
    },
    snapshotsForThread: (threadId: string) =>
      Promise.resolve(rows.filter((row) => row.threadId === threadId)),
  };
  return { repository, rows };
}

interface SnapshotCall {
  readonly kind: string;
  readonly rootId: string;
  readonly runId: string | undefined;
}

/** Full-surface fake service; unused methods throw so drift is loud. */
function fakeService(options?: { readonly failRootIds?: readonly string[] }) {
  const calls: SnapshotCall[] = [];
  let oidCounter = 0;
  const notUnderTest = (name: string) => () => {
    throw new Error(`${name} is not under test`);
  };
  const service = {
    applyRestorePlan: notUnderTest('applyRestorePlan'),
    computeRestorePlan: notUnderTest('computeRestorePlan'),
    diffRefs: notUnderTest('diffRefs'),
    ensureShadowRepo: (root: { readonly path: string; readonly rootId: string }) =>
      Promise.resolve(
        Object.freeze({
          gitDir: `/shadow/${root.rootId}/git`,
          rootId: root.rootId,
          rootPath: root.path,
        }) as ShadowRepoHandle
      ),
    pruneThread: notUnderTest('pruneThread'),
    snapshot: (
      handle: ShadowRepoHandle,
      meta: {
        readonly kind: string;
        readonly runId?: string | undefined;
        readonly threadId: string;
      }
    ) => {
      calls.push({ kind: meta.kind, rootId: handle.rootId, runId: meta.runId });
      if (options?.failRootIds?.includes(handle.rootId)) {
        return Promise.reject(new Error(`capture exploded for ${handle.rootId}`));
      }
      oidCounter += 1;
      return Promise.resolve({ commitOid: String(oidCounter).padStart(40, 'a') });
    },
    snapshotFileHashes: notUnderTest('snapshotFileHashes'),
    sweepOrphans: notUnderTest('sweepOrphans'),
  } as unknown as SnapshotService;
  return { calls, service };
}

const dummyDb: EditCheckpointDatabase = {
  query: () => {
    throw new Error('the boundary controller must not query the database directly');
  },
};

function makeController(overrides?: {
  readonly failRootIds?: readonly string[];
  readonly repository?: SnapshotRepository;
}) {
  const registry = createSnapshotTurnRegistry();
  const { repository, rows } = fakeRepository();
  const repo = overrides?.repository ?? repository;
  const { calls, service } = fakeService(
    overrides?.failRootIds === undefined ? undefined : { failRootIds: overrides.failRootIds }
  );
  const controller = createTurnBoundaryController({
    registry,
    resolveDatabase: () => Promise.resolve(dummyDb),
    snapshots: { createRepository: () => repo, service },
  });
  return { calls, controller, registry, rows };
}

const ROOTS = [
  { path: '/ws/a', rootId: 'root-a' },
  { path: '/ws/b', rootId: 'root-b' },
] as const;

describe('turn-boundary triggers — turn lifecycle', () => {
  it('a fresh turn takes one turn-start snapshot per root, sequentially, and records ledger rows', async () => {
    const { calls, controller, registry, rows } = makeController();
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: false,
      roots: [...ROOTS],
      runId: 'run-1',
      threadId: THREAD,
    });

    expect(calls).toEqual([
      { kind: 'turn-start', rootId: 'root-a', runId: 'run-1' },
      { kind: 'turn-start', rootId: 'root-b', runId: 'run-1' },
    ]);
    expect(rows.map((row) => [row.kind, row.rootId, row.runId])).toEqual([
      ['turn-start', 'root-a', 'run-1'],
      ['turn-start', 'root-b', 'run-1'],
    ]);
    const state = registry.openTurn(THREAD);
    expect(state).not.toBeNull();
    expect(state?.anchorMessageId).toBe('msg-1');
    expect(state?.firstRunId).toBe('run-1');
    expect([...(state?.runIds ?? [])]).toEqual(['run-1']);
    expect(state?.startOutcomes.get('root-a')).toMatchObject({
      kind: 'captured',
      rootPath: '/ws/a',
    });
  });

  it('a resume leg attaches its run id to the open turn WITHOUT re-snapshotting (a turn is not a run)', async () => {
    const { calls, controller, registry } = makeController();
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: false,
      roots: [...ROOTS],
      runId: 'run-1',
      threadId: THREAD,
    });
    const callsAfterStart = calls.length;
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: true,
      roots: [...ROOTS],
      runId: 'run-2',
      threadId: THREAD,
    });

    expect(calls.length).toBe(callsAfterStart);
    expect([...(registry.openTurn(THREAD)?.runIds ?? [])]).toEqual(['run-1', 'run-2']);
  });

  it('a completed PAUSE keeps the turn open; the resume leg terminal takes the turn-end snapshots', async () => {
    const { calls, controller, registry, rows } = makeController();
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: false,
      roots: [...ROOTS],
      runId: 'run-1',
      threadId: THREAD,
    });
    await controller.completeLeg({
      paused: true,
      runId: 'run-1',
      status: 'completed',
      threadId: THREAD,
    });
    expect(registry.openTurn(THREAD)).not.toBeNull();
    expect(rows.filter((row) => row.kind === 'turn-end')).toHaveLength(0);

    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: true,
      roots: [...ROOTS],
      runId: 'run-2',
      threadId: THREAD,
    });
    await controller.completeLeg({
      paused: false,
      runId: 'run-2',
      status: 'completed',
      threadId: THREAD,
    });

    expect(calls.filter((call) => call.kind === 'turn-end').map((call) => call.rootId)).toEqual([
      'root-a',
      'root-b',
    ]);
    expect(
      rows.filter((row) => row.kind === 'turn-end').map((row) => [row.rootId, row.runId])
    ).toEqual([
      ['root-a', 'run-2'],
      ['root-b', 'run-2'],
    ]);
    const state = registry.get(THREAD);
    expect(state?.open).toBe(false);
    expect(state?.lastRunId).toBe('run-2');
  });

  it('a FAILED leg closes the turn even when a pause was observed (no resume is coming)', async () => {
    const { controller, registry } = makeController();
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: false,
      roots: [...ROOTS],
      runId: 'run-1',
      threadId: THREAD,
    });
    await controller.completeLeg({
      paused: true,
      runId: 'run-1',
      status: 'failed',
      threadId: THREAD,
    });
    expect(registry.get(THREAD)?.open).toBe(false);
  });

  it('an abandoned open turn is closed (turn-end recorded) before the NEXT turn starts', async () => {
    const { controller, registry, rows } = makeController();
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: false,
      roots: [...ROOTS],
      runId: 'run-1',
      threadId: THREAD,
    });
    await controller.completeLeg({
      paused: true,
      runId: 'run-1',
      status: 'completed',
      threadId: THREAD,
    });

    await controller.beginLeg({
      anchorMessageId: 'msg-2',
      isResume: false,
      roots: [...ROOTS],
      runId: 'run-9',
      threadId: THREAD,
    });

    const kinds = rows.map((row) => row.kind);
    // Old turn's ends land BEFORE the new turn's starts.
    expect(kinds).toEqual([
      'turn-start',
      'turn-start',
      'turn-end',
      'turn-end',
      'turn-start',
      'turn-start',
    ]);
    // The abandoned turn closes under ITS OWN identity: its turn-end rows
    // carry the abandoned turn's last leg id (run-1), NEVER the incoming
    // leg's (run-9) — otherwise run-9 would be both turn 1's `endRunId` and
    // turn 2's `startRunId`, and bracket resolution would resolve run-9
    // BACKWARDS into the abandoned turn (a wrong-baseline restore for undo).
    expect(rows.map((row) => row.runId)).toEqual([
      'run-1',
      'run-1',
      'run-1',
      'run-1',
      'run-9',
      'run-9',
    ]);
    const state = registry.openTurn(THREAD);
    expect(state?.anchorMessageId).toBe('msg-2');
    expect(state?.firstRunId).toBe('run-9');
  });

  it('an abandoned turn that had a RESUME leg closes under its NEWEST own leg id', async () => {
    const { controller, rows } = makeController();
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: false,
      roots: [...ROOTS],
      runId: 'run-1',
      threadId: THREAD,
    });
    await controller.completeLeg({
      paused: true,
      runId: 'run-1',
      status: 'completed',
      threadId: THREAD,
    });
    // A resume leg arrives (run-2), pauses again, and is then abandoned.
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: true,
      roots: [...ROOTS],
      runId: 'run-2',
      threadId: THREAD,
    });
    await controller.completeLeg({
      paused: true,
      runId: 'run-2',
      status: 'completed',
      threadId: THREAD,
    });

    await controller.beginLeg({
      anchorMessageId: 'msg-2',
      isResume: false,
      roots: [...ROOTS],
      runId: 'run-9',
      threadId: THREAD,
    });

    // The close is stamped with run-2 — the abandoned turn's newest leg —
    // keeping the ledger's run ids disjoint across brackets.
    expect(rows.map((row) => `${row.kind}:${row.runId}`)).toEqual([
      'turn-start:run-1',
      'turn-start:run-1',
      'turn-end:run-2',
      'turn-end:run-2',
      'turn-start:run-9',
      'turn-start:run-9',
    ]);
  });
});

describe('turn-boundary triggers — failure posture (never block the run)', () => {
  it('a per-root capture failure records the durable sentinel row and a failed registry outcome; other roots still capture', async () => {
    const { controller, registry, rows } = makeController({ failRootIds: ['root-b'] });
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: false,
      roots: [...ROOTS],
      runId: 'run-1',
      threadId: THREAD,
    });

    const byRoot = new Map(rows.map((row) => [row.rootId, row]));
    expect(byRoot.get('root-a')?.commitOid).not.toBe(FAILED_SNAPSHOT_CAPTURE_OID);
    expect(byRoot.get('root-b')?.commitOid).toBe(FAILED_SNAPSHOT_CAPTURE_OID);
    const state = registry.openTurn(THREAD);
    expect(state?.startOutcomes.get('root-a')?.kind).toBe('captured');
    expect(state?.startOutcomes.get('root-b')).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('capture exploded'),
    });
  });

  it('a throwing ledger INSERT never rejects beginLeg (logged, run proceeds)', async () => {
    const throwingRepository: SnapshotRepository = {
      deleteByIds: () => Promise.reject(new Error('nope')),
      deleteForThread: () => Promise.reject(new Error('nope')),
      insertSnapshot: () => Promise.reject(new Error('ledger write exploded')),
      latestSnapshotFor: () => Promise.reject(new Error('nope')),
      rootsForThread: () => Promise.reject(new Error('nope')),
      snapshotsForThread: () => Promise.reject(new Error('nope')),
    };
    const { controller, registry } = makeController({ repository: throwingRepository });
    await expect(
      controller.beginLeg({
        anchorMessageId: 'msg-1',
        isResume: false,
        roots: [...ROOTS],
        runId: 'run-1',
        threadId: THREAD,
      })
    ).resolves.toBeUndefined();
    // The in-memory outcomes still captured — resolution stays live-capable.
    expect(registry.openTurn(THREAD)?.startOutcomes.get('root-a')?.kind).toBe('captured');
  });
});

describe('turn-boundary triggers — restart adoption', () => {
  it('a resume leg in a fresh process adopts the open ledger bracket (no re-snapshot; sentinel rows become failed outcomes)', async () => {
    const { repository, rows } = fakeRepository();
    // A previous process recorded turn-start rows (root-b's capture failed)
    // and died before any turn-end.
    await repository.insertSnapshot({
      commitOid: 'b'.repeat(40),
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath: '/ws/a',
      runId: 'run-1',
      threadId: THREAD,
    });
    await repository.insertSnapshot({
      commitOid: FAILED_SNAPSHOT_CAPTURE_OID,
      kind: 'turn-start',
      rootId: 'root-b',
      rootPath: '/ws/b',
      runId: 'run-1',
      threadId: THREAD,
    });

    const registry = createSnapshotTurnRegistry();
    const { calls, service } = fakeService();
    const controller = createTurnBoundaryController({
      registry,
      resolveDatabase: () => Promise.resolve(dummyDb),
      snapshots: { createRepository: () => repository, service },
    });
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: true,
      roots: [...ROOTS],
      runId: 'run-2',
      threadId: THREAD,
    });

    expect(calls).toHaveLength(0);
    const state = registry.openTurn(THREAD);
    expect(state?.firstRunId).toBe('run-1');
    expect([...(state?.runIds ?? [])].sort()).toEqual(['run-1', 'run-2']);
    expect(state?.startOutcomes.get('root-a')).toMatchObject({
      commitOid: 'b'.repeat(40),
      kind: 'captured',
    });
    expect(state?.startOutcomes.get('root-b')?.kind).toBe('failed');

    await controller.completeLeg({
      paused: false,
      runId: 'run-2',
      status: 'completed',
      threadId: THREAD,
    });
    expect(
      rows.filter((row) => row.kind === 'turn-end').map((row) => [row.rootId, row.runId])
    ).toEqual([
      ['root-a', 'run-2'],
      ['root-b', 'run-2'],
    ]);
  });

  it('a resume leg with NO open turn anywhere registers an honest all-failed start (never a fabricated snapshot)', async () => {
    const { calls, controller, registry } = makeController();
    await controller.beginLeg({
      anchorMessageId: 'msg-1',
      isResume: true,
      roots: [...ROOTS],
      runId: 'run-2',
      threadId: THREAD,
    });
    expect(calls).toHaveLength(0);
    const state = registry.openTurn(THREAD);
    expect(state?.startOutcomes.get('root-a')).toMatchObject({
      kind: 'failed',
      reason: expect.stringContaining('before workspace snapshots'),
    });
  });
});

describe('observeTurnPauseChunks', () => {
  async function drain(
    chunks: readonly StreamChunk[],
    state: LegPauseState
  ): Promise<StreamChunk[]> {
    async function* source(): AsyncIterable<StreamChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    const seen: StreamChunk[] = [];
    for await (const chunk of observeTurnPauseChunks(source(), state)) {
      seen.push(chunk);
    }
    return seen;
  }

  it('flags a tool-approval-required pause and forwards every chunk untouched', async () => {
    const state: LegPauseState = { paused: false };
    const chunks: StreamChunk[] = [
      { type: 'text-delta', value: 'hello' } as StreamChunk,
      { type: 'tool-approval-required' } as unknown as StreamChunk,
    ];
    const seen = await drain(chunks, state);
    expect(state.paused).toBe(true);
    expect(seen).toEqual(chunks);
  });

  it('flags a RESUMABLE tool-suspend-required pause but NOT a resumeSupported:false one', async () => {
    const resumable: LegPauseState = { paused: false };
    await drain([{ type: 'tool-suspend-required' } as unknown as StreamChunk], resumable);
    expect(resumable.paused).toBe(true);

    const notResumable: LegPauseState = { paused: false };
    await drain(
      [{ resumeSupported: false, type: 'tool-suspend-required' } as unknown as StreamChunk],
      notResumable
    );
    expect(notResumable.paused).toBe(false);
  });

  it('propagates a source error unchanged', async () => {
    const state: LegPauseState = { paused: false };
    async function* failing(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', value: 'partial' } as StreamChunk;
      throw new Error('stream exploded');
    }
    const iterate = async () => {
      for await (const _chunk of observeTurnPauseChunks(failing(), state)) {
        // drain
      }
    };
    await expect(iterate()).rejects.toThrow('stream exploded');
  });
});

describe('resolveTurnAnchorMessageId', () => {
  it('returns the LAST user message id (the triggering message, shared by every leg of the turn)', () => {
    expect(
      resolveTurnAnchorMessageId([
        { id: 'u1', parts: [], role: 'user' },
        { id: 'a1', parts: [], role: 'assistant' },
        { id: 'u2', parts: [], role: 'user' },
        { id: 'a2', parts: [], role: 'assistant' },
      ])
    ).toBe('u2');
  });

  it('returns null when the request carries no user message', () => {
    expect(resolveTurnAnchorMessageId([{ id: 'a1', parts: [], role: 'assistant' }])).toBeNull();
  });
});

/** Expected public cancellation contract; production API is implemented separately. */
function cancelOwnedTurn(
  controller: ReturnType<typeof createTurnBoundaryController>,
  input: {
    readonly threadId: string;
    readonly runId: string;
    readonly turnRunIds: readonly string[];
  }
): Promise<void> {
  return (
    controller as typeof controller & {
      completeCancelledTurn: (params: typeof input) => Promise<void>;
    }
  ).completeCancelledTurn(input);
}

describe('turn-boundary triggers — authoritative cancellation ownership', () => {
  async function waitingTurn(cold: boolean) {
    const { repository, rows } = fakeRepository();
    const first = makeController({ repository });
    await first.controller.beginLeg({
      anchorMessageId: 'message-current',
      isResume: false,
      roots: [...ROOTS],
      runId: 'current-start',
      threadId: THREAD,
    });
    await first.controller.beginLeg({
      anchorMessageId: 'message-current',
      isResume: true,
      roots: [...ROOTS],
      runId: 'current-resume',
      threadId: THREAD,
    });
    await first.controller.completeLeg({
      paused: true,
      runId: 'current-resume',
      status: 'completed',
      threadId: THREAD,
    });
    const active = cold ? makeController({ repository }) : first;
    return { ...active, rows };
  }

  it.each([false, true])(
    'closes only the matching waiting turn once (cold registry: %s)',
    async (cold) => {
      const { controller, registry, rows, calls } = await waitingTurn(cold);
      const before = calls.length;
      const cancellation = {
        runId: 'current-resume',
        threadId: THREAD,
        turnRunIds: ['current-start', 'current-resume'],
      };
      await cancelOwnedTurn(controller, cancellation);
      expect(registry.openTurn(THREAD)).toBeNull();
      expect(calls.slice(before)).toEqual([
        { kind: 'turn-end', rootId: 'root-a', runId: 'current-resume' },
        { kind: 'turn-end', rootId: 'root-b', runId: 'current-resume' },
      ]);
      expect(rows.filter((row) => row.kind === 'turn-end')).toHaveLength(2);
      await cancelOwnedTurn(controller, cancellation);
      expect(calls).toHaveLength(before + 2);
      expect(rows.filter((row) => row.kind === 'turn-end')).toHaveLength(2);
    }
  );

  it.each([false, true])(
    'historical cancellation cannot close the newer bracket (cold registry: %s)',
    async (cold) => {
      const { controller, registry, rows, calls } = await waitingTurn(cold);
      const before = calls.length;
      await cancelOwnedTurn(controller, {
        runId: 'historical-resume',
        threadId: THREAD,
        turnRunIds: ['historical-start', 'historical-resume'],
      });
      expect(calls).toHaveLength(before);
      expect(rows.filter((row) => row.kind === 'turn-end')).toHaveLength(0);
      expect(registry.openTurn(THREAD)?.firstRunId).toBe(cold ? undefined : 'current-start');
    }
  );

  it('requires the warm turn first run, not merely a matching later resume id', async () => {
    const { controller, registry, rows, calls } = await waitingTurn(false);
    const before = calls.length;
    await cancelOwnedTurn(controller, {
      runId: 'current-resume',
      threadId: THREAD,
      turnRunIds: ['current-resume'],
    });
    expect(calls).toHaveLength(before);
    expect(rows.filter((row) => row.kind === 'turn-end')).toHaveLength(0);
    expect(registry.openTurn(THREAD)?.firstRunId).toBe('current-start');
  });
});
