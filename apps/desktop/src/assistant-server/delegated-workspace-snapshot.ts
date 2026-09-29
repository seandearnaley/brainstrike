import type { RuntimeData } from '@brainstrike/agent';
import type { EditCheckpointDatabase } from './edit-checkpoint-journal';
import { desktopAssistantServerLogger as logger } from './logger';
import { FAILED_SNAPSHOT_CAPTURE_OID } from './snapshot-repository';
import type { TurnBoundarySnapshotDeps } from './snapshot-turn-boundaries';
import { getWorkspaceRoots } from './workspace-roots';

/** Capture before the child's input processor returns, using the existing shadow repository. */
export async function captureDelegatedWorkspaceStart(
  database: EditCheckpointDatabase,
  threadId: string,
  runtimeData: RuntimeData | undefined,
  snapshots: TurnBoundarySnapshotDeps | undefined
): Promise<void> {
  if (!snapshots) {
    return;
  }
  const repository = snapshots.createRepository(database);
  const capturedRoots = new Set<string>();
  for (const row of await repository.snapshotsForThread(threadId)) {
    if (row.kind === 'turn-start') {
      capturedRoots.add(row.rootId);
    }
  }
  // A pre-existing child without a baseline must remain honestly unrestorable.
  // Never manufacture a turn-start snapshot after that child has executed.
  const runs = await database.query(
    'SELECT id FROM brainstrike_assistant_thread_runs WHERE thread_id = $1 LIMIT 1',
    [threadId]
  );
  if (runs.rows.length > 0) {
    return;
  }
  for (const root of getWorkspaceRoots(runtimeData)) {
    if (capturedRoots.has(root.rootId)) {
      continue;
    }
    let commitOid = FAILED_SNAPSHOT_CAPTURE_OID;
    try {
      const handle = await snapshots.service.ensureShadowRepo({
        path: root.path,
        rootId: root.rootId,
      });
      commitOid = (await snapshots.service.snapshot(handle, { kind: 'turn-start', threadId }))
        .commitOid;
    } catch (error) {
      logger.error('Child turn-start snapshot failed; restoration is unavailable', {
        error,
        rootId: root.rootId,
        threadId,
      });
    }
    // No native run exists yet. The existing ledger resolves later child/resume
    // legs by their run timestamps inside this child's own turn bracket.
    await repository.insertSnapshot({
      commitOid,
      kind: 'turn-start',
      rootId: root.rootId,
      rootPath: root.path,
      threadId,
    });
  }
}
