// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceRootReply } from '@brainstrike/state-store';
import { afterEach, expect, test, vi } from 'vitest';
import { execFileSnapshotGitRunner } from '../../assistant-server/snapshot-git';
import { createSnapshotService } from '../../assistant-server/snapshot-service';
import { startSnapshotStartupMaintenance } from '../../main/snapshot-lifecycle';

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'bs-snapshot-startup-owner-'));
  directories.push(dir);
  const rootPath = await mkdtemp(join(dir, 'workspace-'));
  const snapshotsBaseDir = join(dir, 'snapshots');
  const service = createSnapshotService({ runner: execFileSnapshotGitRunner, snapshotsBaseDir });
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const roots: WorkspaceRootReply = {
    roots: [
      {
        createdAt: 1,
        displayName: 'Workspace',
        id: 'root-1',
        kind: 'path',
        lastVerifiedAt: 1,
        path: rootPath,
        status: 'disconnected',
      },
    ],
  };
  return { logger, rootPath, roots, service, snapshotsBaseDir };
}

test('published snapshot factory waits for the authoritative catalog before opening a root', async () => {
  const f = await fixture();
  const catalog = Promise.withResolvers<WorkspaceRootReply>();
  const ensure = vi.spyOn(f.service, 'ensureShadowRepo');
  const returned = startSnapshotStartupMaintenance({
    logger: f.logger,
    readHostThreadIds: async () => new Set(),
    readHostThreadRows: async () => [],
    snapshotService: f.service,
    snapshotsBaseDir: f.snapshotsBaseDir,
    workspaceRoots: { workspaceRoots: () => catalog.promise },
  });
  expect(returned).toBeUndefined();
  expect(ensure).not.toHaveBeenCalled();
  catalog.resolve(f.roots);
  await vi.waitFor(() => expect(f.logger.info).toHaveBeenCalledTimes(2));
  expect(ensure).toHaveBeenCalledExactlyOnceWith({ path: f.rootPath, rootId: 'root-1' });
  expect(f.logger.error).not.toHaveBeenCalled();
});

test('the actual factory keeps a disconnected folder and its host-owned snapshot readable', async () => {
  const f = await fixture();
  const handle = await f.service.ensureShadowRepo({ path: f.rootPath, rootId: 'root-1' });
  await writeFile(join(f.rootPath, 'saved.txt'), 'retained');
  const capture = await f.service.snapshot(handle, {
    kind: 'turn-start',
    runId: 'child-run',
    threadId: 'child-thread',
  });
  const readHostThreadRows = vi.fn(async () => []);
  startSnapshotStartupMaintenance({
    logger: f.logger,
    readHostThreadIds: async () => new Set(['parent-thread', 'child-thread']),
    readHostThreadRows,
    snapshotService: f.service,
    snapshotsBaseDir: f.snapshotsBaseDir,
    workspaceRoots: { workspaceRoots: async () => f.roots },
  });
  await vi.waitFor(() => expect(f.logger.info).toHaveBeenCalledTimes(2));
  expect(readHostThreadRows).toHaveBeenCalledExactlyOnceWith('child-thread');
  expect((await f.service.snapshotFileHashes(handle, capture.commitOid)).has('saved.txt')).toBe(
    true
  );
  expect(f.logger.error).not.toHaveBeenCalled();
});

test('catalog failure prevents orphan deletion and retains the original failure', async () => {
  const f = await fixture();
  const failure = new Error('host catalog unavailable');
  const sweep = vi.spyOn(f.service, 'sweepOrphans');
  startSnapshotStartupMaintenance({
    logger: f.logger,
    readHostThreadIds: async () => new Set(),
    readHostThreadRows: async () => [],
    snapshotService: f.service,
    snapshotsBaseDir: f.snapshotsBaseDir,
    workspaceRoots: {
      workspaceRoots: async () => {
        throw failure;
      },
    },
  });
  await vi.waitFor(() => expect(f.logger.error).toHaveBeenCalled());
  expect(f.logger.error.mock.calls[0]?.[1]).toEqual({
    error: failure,
    snapshotsBaseDir: f.snapshotsBaseDir,
  });
  expect(sweep).not.toHaveBeenCalled();
});
