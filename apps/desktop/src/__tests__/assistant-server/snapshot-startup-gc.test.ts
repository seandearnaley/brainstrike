/** Host-log ownership and real shadow-Git payloads replace retired SQL fixtures. */
import { type HostLogRow, HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { SnapshotChainEntry } from '../../assistant-server/snapshot-chains';
import type { SnapshotService } from '../../assistant-server/snapshot-service';
import {
  runSnapshotStartupGc,
  type SnapshotStartupGcDeps,
} from '../../assistant-server/snapshot-startup-gc';

const ROOT = { path: '/tmp/root-1', rootId: 'root-1' };
const oid = (value: number): string => value.toString(16).padStart(40, '0');
function turns(count: number): SnapshotChainEntry[] {
  return Array.from({ length: count }, (_, index) => count - index).flatMap((turn) => [
    { commitOid: oid(turn * 2), kind: 'turn-end' as const, runId: `run-${turn}` },
    { commitOid: oid(turn * 2 - 1), kind: 'turn-start' as const, runId: `run-${turn}` },
  ]);
}
function pendingRows(chain: readonly SnapshotChainEntry[]): HostLogRow[] {
  const rows = [...chain]
    .reverse()
    .filter((entry) => entry.kind === 'turn-start')
    .map((entry, index) =>
      HostLogRowSchema.parse({
        event: {
          boundary: 'turn-start',
          roots: [{ commitOid: entry.commitOid, rootId: ROOT.rootId, rootPath: ROOT.path }],
          runId: entry.runId,
          type: 'workspace.snapshot.recorded',
        },
        seq: index + 1,
        threadId: 'thread-1',
      })
    );
  rows.push(
    HostLogRowSchema.parse({
      event: {
        commandId: 'command-1',
        headId: null,
        messageId: 'message-1',
        mode: 'conversation-and-files',
        rewindId: 'rewind-1',
        runId: 'run-1',
        type: 'thread.rewind.started',
      },
      seq: rows.length + 1,
      threadId: 'thread-1',
    })
  );
  return rows;
}
interface FixtureOptions {
  readonly chains?: Readonly<Record<string, readonly SnapshotChainEntry[] | Error>>;
  readonly hostThreads?: readonly string[] | Error;
  readonly refs?: Readonly<Record<string, readonly string[] | Error>>;
  readonly rows?: Readonly<Record<string, readonly HostLogRow[] | Error>>;
}
function fixture(options: FixtureOptions = {}) {
  const events: string[] = [];
  const pruned: { rootId: string; threadId: string }[] = [];
  const histories: { rootId: string; boundaries: readonly string[] }[] = [];
  const service = {
    ensureShadowRepo: vi.fn(async (root: typeof ROOT) => ({
      gitDir: `/shadow/${root.rootId}`,
      rootId: root.rootId,
      rootPath: root.path,
    })),
    listSnapshotThreadIds: vi.fn(async (handle: { rootId: string }) => {
      const value = options.refs?.[handle.rootId] ?? [];
      if (value instanceof Error) {
        throw value;
      }
      return value;
    }),
    pruneHistory: vi.fn(async (handle: { rootId: string }, boundaries: readonly string[]) => {
      events.push('prune-history');
      histories.push({ boundaries, rootId: handle.rootId });
    }),
    pruneThread: vi.fn(async (handle: { rootId: string }, threadId: string) => {
      events.push('prune-ref');
      pruned.push({ rootId: handle.rootId, threadId });
      return { deleted: true };
    }),
  };
  const readHostThreadIds = vi.fn(async () => {
    events.push('read-host');
    if (options.hostThreads instanceof Error) {
      throw options.hostThreads;
    }
    return new Set(options.hostThreads ?? []);
  });
  const readHostThreadRows = vi.fn(async (threadId: string) => {
    const value = options.rows?.[threadId] ?? [];
    if (value instanceof Error) {
      throw value;
    }
    return value;
  });
  const deps: SnapshotStartupGcDeps = {
    isRootPathAccessible: async () => true,
    liveRoots: [ROOT],
    readHostThreadIds,
    readHostThreadRows,
    readThreadChain: async (_handle, threadId) => {
      const value = options.chains?.[threadId] ?? [];
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
    snapshotService: service as unknown as SnapshotService,
    turnRing: 2,
  };
  return { deps, events, histories, pruned, readHostThreadIds, readHostThreadRows, service };
}

describe('host-owned startup snapshot retention', () => {
  it('deletes nothing when the host inventory is unavailable', async () => {
    const f = fixture({
      chains: { 'thread-1': turns(4) },
      hostThreads: new Error('host unavailable'),
      refs: { 'root-1': ['thread-1'] },
    });
    const report = await runSnapshotStartupGc(f.deps);
    expect(report.failures).toHaveLength(1);
    expect(f.pruned).toEqual([]);
    expect(f.histories).toEqual([]);
  });
  it('reads host ownership before pruning a dead ref, then reclaims history', async () => {
    const f = fixture({ refs: { 'root-1': ['dead'] } });
    await runSnapshotStartupGc(f.deps);
    expect(f.events).toEqual(['read-host', 'prune-ref', 'prune-history']);
  });
  it('does not query host ownership on an empty profile', async () => {
    const f = fixture({ hostThreads: new Error('host unavailable') });
    expect((await runSnapshotStartupGc(f.deps)).failures).toEqual([]);
    expect(f.readHostThreadIds).not.toHaveBeenCalled();
    expect(f.readHostThreadRows).not.toHaveBeenCalled();
  });
  it('purges a dead thread ref and reclaims its empty root', async () => {
    const f = fixture({ refs: { 'root-1': ['dead'] } });
    const report = await runSnapshotStartupGc(f.deps);
    expect(report.refOnlyPruned).toEqual([{ rootId: 'root-1', threadId: 'dead' }]);
    expect(f.histories).toEqual([{ boundaries: [], rootId: 'root-1' }]);
  });
  it('cuts by turn starts despite interleaved pre-revert captures', async () => {
    const chain = turns(4);
    chain.splice(6, 0, { commitOid: oid(20), kind: 'pre-revert', runId: 'old-rewind' });
    const f = fixture({
      chains: { 'thread-1': chain },
      hostThreads: ['thread-1'],
      refs: { 'root-1': ['thread-1'] },
    });
    const report = await runSnapshotStartupGc(f.deps);
    expect(report.hostRingTrimmed).toEqual([{ rootId: 'root-1', threadId: 'thread-1' }]);
    expect(f.histories).toEqual([{ boundaries: [oid(5)], rootId: 'root-1' }]);
  });
  it('retains an outstanding redo target then reclaims after its committed completion', async () => {
    const chain = [
      { commitOid: oid(20), kind: 'pre-revert' as const, runId: 'rewind-1' },
      ...turns(4),
    ];
    const rows = pendingRows(chain);
    const f = fixture({
      chains: { 'thread-1': chain },
      hostThreads: ['thread-1'],
      refs: { 'root-1': ['thread-1'] },
      rows: { 'thread-1': rows },
    });
    expect((await runSnapshotStartupGc(f.deps)).failures).toEqual([]);
    expect(f.histories).toEqual([]);
    rows.push(
      HostLogRowSchema.parse({
        event: { outcomes: [], rewindId: 'rewind-1', type: 'thread.rewind.redone' },
        seq: rows.length + 1,
        threadId: 'thread-1',
      })
    );
    await runSnapshotStartupGc(f.deps);
    expect(f.histories).toEqual([{ boundaries: [oid(5)], rootId: 'root-1' }]);
  });
  it('refuses reclamation if a pending redo target is absent from the actual chain', async () => {
    const f = fixture({
      chains: { 'thread-1': turns(4).slice(0, 4) },
      hostThreads: ['thread-1'],
      refs: { 'root-1': ['thread-1'] },
      rows: { 'thread-1': pendingRows(turns(4)) },
    });
    expect((await runSnapshotStartupGc(f.deps)).failures).toHaveLength(1);
    expect(f.histories).toEqual([]);
  });
  it('keeps a chain within the ring untouched', async () => {
    const f = fixture({
      chains: { 'thread-1': turns(2) },
      hostThreads: ['thread-1'],
      refs: { 'root-1': ['thread-1'] },
    });
    expect((await runSnapshotStartupGc(f.deps)).hostRingTrimmed).toEqual([]);
    expect(f.histories).toEqual([]);
  });
  it('prunes residue while preserving every surviving chain boundary', async () => {
    const f = fixture({
      chains: { 'thread-1': turns(1) },
      hostThreads: ['thread-1'],
      refs: { 'root-1': ['thread-1', 'dead'] },
    });
    await runSnapshotStartupGc(f.deps);
    expect(f.pruned).toEqual([{ rootId: 'root-1', threadId: 'dead' }]);
    expect(f.histories).toEqual([{ boundaries: [oid(1)], rootId: 'root-1' }]);
  });
  it('lists long and already-cut short chains together in the shallow boundary', async () => {
    const f = fixture({
      chains: { long: turns(4), short: [{ commitOid: oid(30), kind: 'turn-start', runId: 'old' }] },
      hostThreads: ['long', 'short'],
      refs: { 'root-1': ['long', 'short'] },
    });
    await runSnapshotStartupGc(f.deps);
    expect(f.histories).toEqual([{ boundaries: [oid(5), oid(30)], rootId: 'root-1' }]);
  });
  it('does not reclaim a root when any surviving chain is unreadable', async () => {
    const f = fixture({
      chains: { broken: new Error('bad object') },
      hostThreads: ['broken'],
      refs: { 'root-1': ['broken', 'dead'] },
    });
    expect((await runSnapshotStartupGc(f.deps)).failures).toHaveLength(1);
    expect(f.histories).toEqual([]);
    expect(f.pruned).toEqual([{ rootId: 'root-1', threadId: 'dead' }]);
  });
  it('does not prune an incomplete ref inventory', async () => {
    const f = fixture({ refs: { 'root-1': new Error('for-each-ref failed') } });
    expect((await runSnapshotStartupGc(f.deps)).failures).toHaveLength(1);
    expect(f.pruned).toEqual([]);
    expect(f.histories).toEqual([]);
    expect(f.readHostThreadIds).not.toHaveBeenCalled();
  });
  it('retains child thread refs supplied by the complete host ledger inventory', async () => {
    const f = fixture({
      chains: { child: turns(1), parent: turns(1) },
      hostThreads: ['parent', 'child'],
      refs: { 'root-1': ['parent', 'child'] },
    });
    expect((await runSnapshotStartupGc(f.deps)).refOnlyPruned).toEqual([]);
    expect(f.readHostThreadRows).toHaveBeenCalledWith('child');
    expect(f.pruned).toEqual([]);
  });
  it('keeps the live host ref and deletes only the absent host ref', async () => {
    const f = fixture({
      chains: { live: turns(1) },
      hostThreads: ['live'],
      refs: { 'root-1': ['live', 'dead'] },
    });
    await runSnapshotStartupGc(f.deps);
    expect(f.pruned).toEqual([{ rootId: 'root-1', threadId: 'dead' }]);
    expect(f.readHostThreadIds).toHaveBeenCalledOnce();
  });
  it('keeps all roots unpruned when host ownership cannot be read', async () => {
    const f = fixture({
      hostThreads: new Error('unavailable'),
      refs: { 'root-1': ['a'], 'root-2': ['b'] },
    });
    const report = await runSnapshotStartupGc({
      ...f.deps,
      liveRoots: [ROOT, { path: '/tmp/root-2', rootId: 'root-2' }],
    });
    expect(report.failures).toHaveLength(1);
    expect(f.pruned).toEqual([]);
    expect(f.histories).toEqual([]);
  });
  it('reads one consistent host log per thread across roots', async () => {
    const f = fixture({
      chains: { 'thread-1': turns(3) },
      hostThreads: ['thread-1'],
      refs: { 'root-1': ['thread-1'], 'root-2': ['thread-1'] },
    });
    await runSnapshotStartupGc({
      ...f.deps,
      liveRoots: [ROOT, { path: '/tmp/root-2', rootId: 'root-2' }],
    });
    expect(f.readHostThreadIds).toHaveBeenCalledOnce();
    expect(f.readHostThreadRows).toHaveBeenCalledExactlyOnceWith('thread-1');
  });
  it('leaves an inaccessible root untouched and visible as skipped', async () => {
    const f = fixture({ refs: { 'root-1': ['dead'] } });
    const report = await runSnapshotStartupGc({
      ...f.deps,
      isRootPathAccessible: async () => false,
    });
    expect(report.skippedInaccessibleRoots).toEqual([ROOT]);
    expect(report.failures).toEqual([]);
    expect(f.service.ensureShadowRepo).not.toHaveBeenCalled();
    expect(f.pruned).toEqual([]);
  });
  it('continues to independent roots after a shadow repository failure', async () => {
    const f = fixture({ refs: { 'root-2': ['dead'] } });
    f.service.ensureShadowRepo.mockRejectedValueOnce(new Error('root vanished'));
    const report = await runSnapshotStartupGc({
      ...f.deps,
      liveRoots: [ROOT, { path: '/tmp/root-2', rootId: 'root-2' }],
    });
    expect(report.failures).toHaveLength(1);
    expect(f.pruned).toEqual([{ rootId: 'root-2', threadId: 'dead' }]);
  });
  it('never uses a failed-capture target as a shallow boundary', async () => {
    const rows = pendingRows([{ commitOid: '0'.repeat(40), kind: 'turn-start', runId: 'run-1' }]);
    const f = fixture({
      chains: { 'thread-1': turns(4) },
      hostThreads: ['thread-1'],
      refs: { 'root-1': ['thread-1'] },
      rows: { 'thread-1': rows },
    });
    expect((await runSnapshotStartupGc(f.deps)).failures).toHaveLength(1);
    expect(f.histories).toEqual([]);
  });
  it('retains history if reading the current redo state fails', async () => {
    const f = fixture({
      chains: { 'thread-1': turns(4) },
      hostThreads: ['thread-1'],
      refs: { 'root-1': ['thread-1'] },
      rows: { 'thread-1': new Error('connection closed') },
    });
    expect((await runSnapshotStartupGc(f.deps)).failures).toHaveLength(1);
    expect(f.histories).toEqual([]);
  });
});
