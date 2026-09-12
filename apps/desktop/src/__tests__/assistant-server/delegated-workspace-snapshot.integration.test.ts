import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrate, wasmLoader } from '@brainstrike/db';
import { expect, it } from 'vitest';
import { captureDelegatedWorkspaceStart } from '../../assistant-server/delegated-workspace-snapshot';
import { execFileSnapshotGitRunner } from '../../assistant-server/snapshot-git';
import {
  createSnapshotRepository,
  FAILED_SNAPSHOT_CAPTURE_OID,
} from '../../assistant-server/snapshot-repository';
import { createSnapshotService } from '../../assistant-server/snapshot-service';
import { singleRootRuntime } from './_tool-test-helpers';

it('retains the pre-execution child baseline across recovery and refuses late or failed captures', async () => {
  const childId =
    'thread-74da70cd-4f39-46de-81b3-56b7b5b1b416-b7a52f6c-7e72-4241-bf33-e5b9bbf1d93e-70950143-21e5-44b4-8aa0-b574d36ad961-55dbf797-1713-4fc6-b4e4-9e85f0453bb7';
  const directory = await mkdtemp(path.join(os.tmpdir(), 'child-snapshot-'));
  const database = await wasmLoader.createPGlite('memory://child-snapshot');
  try {
    await migrate(database);
    const rootPath = path.join(directory, 'workspace');
    await mkdir(rootPath);
    const runtime = {
      ...singleRootRuntime(rootPath),
      workspaceRoots: [{ displayName: 'Workspace', path: rootPath, rootId: 'root-a' }],
    };
    const snapshots = {
      createRepository: createSnapshotRepository,
      service: createSnapshotService({
        runner: execFileSnapshotGitRunner,
        snapshotsBaseDir: path.join(directory, '.shadow'),
      }),
    };
    await writeFile(path.join(rootPath, 'user.txt'), 'Existing user work');
    await captureDelegatedWorkspaceStart(database, childId, runtime, snapshots);
    const repository = createSnapshotRepository(database);
    const initial = await repository.snapshotsForThread(childId);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ kind: 'turn-start', runId: null, threadId: childId });
    expect(initial[0]?.commitOid).not.toBe(FAILED_SNAPSHOT_CAPTURE_OID);
    await writeFile(path.join(rootPath, 'child.txt'), 'Completed child effect');
    await captureDelegatedWorkspaceStart(database, childId, runtime, snapshots);
    expect(await repository.snapshotsForThread(childId)).toEqual(initial);
    expect(await repository.snapshotsForThread('parent')).toEqual([]);
    await writeFile(path.join(rootPath, 'sibling.txt'), 'Independent sibling effect');
    const baseline = initial[0];
    if (!baseline) {
      throw new Error('Expected recursive child baseline');
    }
    const handle = await snapshots.service.ensureShadowRepo({ path: rootPath, rootId: 'root-a' });
    expect(
      await snapshots.service.restorePathsFromSnapshot(handle, baseline.commitOid, [
        { expectAbsent: true, path: 'child.txt' },
      ])
    ).toEqual([{ outcome: 'deleted', path: 'child.txt' }]);
    expect(await readFile(path.join(rootPath, 'user.txt'), 'utf8')).toBe('Existing user work');
    expect(await readFile(path.join(rootPath, 'sibling.txt'), 'utf8')).toBe(
      'Independent sibling effect'
    );
    expect(await snapshots.service.listSnapshotThreadIds(handle)).toEqual([childId]);

    // Recovery after admission captured one root but the host died before the next.
    const first = initial[0];
    if (!first) {
      throw new Error('Expected the captured baseline');
    }
    await repository.insertSnapshot({
      commitOid: first.commitOid,
      kind: 'turn-start',
      rootId: 'root-a',
      rootPath,
      threadId: 'partial-child',
    });
    const otherRoot = path.join(directory, 'other-root');
    await mkdir(otherRoot);
    await captureDelegatedWorkspaceStart(
      database,
      'partial-child',
      {
        ...runtime,
        workspaceRoots: [
          ...runtime.workspaceRoots,
          { displayName: 'Other', path: otherRoot, rootId: 'root-b' },
        ],
      },
      snapshots
    );
    expect((await repository.snapshotsForThread('partial-child')).map((row) => row.rootId)).toEqual(
      ['root-a', 'root-b']
    );

    await database.exec(`INSERT INTO mastra_threads
      (id, "resourceId", title, "createdAt", "updatedAt") VALUES
      ('legacy-child', 'owner', 'Legacy', NOW(), NOW());
      INSERT INTO brainstrike_assistant_thread_runs
      (id, resource_id, thread_id, provider, model, runtime_kind, status,
       started_at, created_at, updated_at) VALUES
      ('legacy-run', 'owner', 'legacy-child', 'openai', 'test', 'desktop', 'completed',
       NOW(), NOW(), NOW());`);
    await captureDelegatedWorkspaceStart(database, 'legacy-child', runtime, snapshots);
    expect(await repository.snapshotsForThread('legacy-child')).toEqual([]);

    const missingRuntime = {
      ...runtime,
      workspaceRoots: [
        { displayName: 'Missing', path: path.join(directory, 'missing'), rootId: 'missing-root' },
      ],
    };
    await captureDelegatedWorkspaceStart(database, 'failed-child', missingRuntime, snapshots);
    expect(await repository.snapshotsForThread('failed-child')).toMatchObject([
      { commitOid: FAILED_SNAPSHOT_CAPTURE_OID, kind: 'turn-start' },
    ]);
    await captureDelegatedWorkspaceStart(
      database,
      'failed-child',
      {
        ...runtime,
        workspaceRoots: [{ displayName: 'Reconnected', path: rootPath, rootId: 'missing-root' }],
      },
      snapshots
    );
    expect(await repository.snapshotsForThread('failed-child')).toMatchObject([
      { commitOid: FAILED_SNAPSHOT_CAPTURE_OID, kind: 'turn-start' },
    ]);
  } finally {
    await database.close();
    await rm(directory, { force: true, recursive: true });
  }
});
