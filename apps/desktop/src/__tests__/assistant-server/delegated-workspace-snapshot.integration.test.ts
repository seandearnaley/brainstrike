import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    await captureDelegatedWorkspaceStart(database, 'child', runtime, snapshots);
    const repository = createSnapshotRepository(database);
    const initial = await repository.snapshotsForThread('child');
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ kind: 'turn-start', runId: null, threadId: 'child' });
    expect(initial[0]?.commitOid).not.toBe(FAILED_SNAPSHOT_CAPTURE_OID);
    await writeFile(path.join(rootPath, 'child.txt'), 'Completed child effect');
    await captureDelegatedWorkspaceStart(database, 'child', runtime, snapshots);
    expect(await repository.snapshotsForThread('child')).toEqual(initial);
    expect(await repository.snapshotsForThread('parent')).toEqual([]);
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
