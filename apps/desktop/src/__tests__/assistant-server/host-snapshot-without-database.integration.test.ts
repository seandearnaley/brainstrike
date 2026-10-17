import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostLogRowSchema } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';
import { afterEach, expect, test, vi } from 'vitest';
import { createHostThreadTurns } from '../../assistant-server/changeset-host-turns';
import { createSnapshotChangesetResolver } from '../../assistant-server/changeset-snapshot-view';
import { listThreadSnapshotChain } from '../../assistant-server/snapshot-chains';
import { execFileSnapshotGitRunner } from '../../assistant-server/snapshot-git';
import { createSnapshotService } from '../../assistant-server/snapshot-service';
import { runSnapshotStartupGc } from '../../assistant-server/snapshot-startup-gc';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'bs-host-only-snapshots-'));
  dirs.push(base);
  const rootPath = await mkdtemp(join(base, 'workspace-'));
  const service = createSnapshotService({
    runner: execFileSnapshotGitRunner,
    snapshotsBaseDir: join(base, 'snapshots'),
  });
  const rootId = 'host-only-root';
  const handle = await service.ensureShadowRepo({ path: rootPath, rootId });
  await writeFile(join(rootPath, 'file.txt'), 'before\n');
  const start = await service.snapshot(handle, {
    kind: 'turn-start',
    runId: 'run-1',
    threadId: 'thread-1',
  });
  await writeFile(join(rootPath, 'file.txt'), 'after\n');
  const end = await service.snapshot(handle, {
    kind: 'turn-end',
    runId: 'run-1',
    threadId: 'thread-1',
  });
  const rows = [start, end].map((capture, index) =>
    Schema.decodeUnknownSync(HostLogRowSchema, { errors: 'all', onExcessProperty: 'error' })({
      event: {
        boundary: index === 0 ? 'turn-start' : 'turn-end',
        roots: [{ commitOid: capture.commitOid, rootId, rootPath }],
        runId: 'run-1',
        type: 'workspace.snapshot.recorded',
      },
      seq: index + 1,
      threadId: 'thread-1',
    })
  );
  const hostThreads = createHostThreadTurns({
    listThreads: async () => new Set(['thread-1']),
    readRows: async (_threadId, fromSeq) => rows.filter((row) => row.seq > fromSeq),
  });
  return { hostThreads, rootId, rootPath, service };
}
const forbidden = (): never => {
  throw new Error('PGlite is absent from desktop');
};
test('cold Changes resolves a current host turn with no legacy database owner', async () => {
  const f = await fixture();
  const dependencies = {
    createRepository: forbidden,
    hostThreads: f.hostThreads,
    resolveDatabase: forbidden,
    resolveService: () => f.service,
  };
  const resolver = createSnapshotChangesetResolver(dependencies);
  const view = await resolver.resolveView({
    kind: 'agent-run',
    runId: 'run-1',
    threadId: 'thread-1',
  });
  expect(view.ok).toBe(true);
  if (view.ok) {
    expect(view.value.files).toEqual([
      expect.objectContaining({ path: 'file.txt', rootId: f.rootId }),
    ]);
  }
});
test('startup snapshot retention uses host ownership without any SQL query', async () => {
  const f = await fixture();
  const query = vi.fn(forbidden);
  const dependencies = {
    db: { query },
    liveRoots: [{ path: f.rootPath, rootId: f.rootId }],
    readHostThreadIds: async () => new Set(['thread-1']),
    readHostThreadRows: async () => [],
    readThreadChain: (handle: Parameters<typeof listThreadSnapshotChain>[1], threadId: string) =>
      listThreadSnapshotChain(execFileSnapshotGitRunner, handle, threadId),
    snapshotRepository: {
      deleteByIds: forbidden,
      deleteForThread: forbidden,
      insertSnapshot: forbidden,
      latestSnapshotFor: forbidden,
      rootsForThread: forbidden,
      snapshotsForThread: forbidden,
    },
    snapshotService: f.service,
  };
  const report = await runSnapshotStartupGc(dependencies);
  expect(report.failures).toEqual([]);
  expect(query).not.toHaveBeenCalled();
});
