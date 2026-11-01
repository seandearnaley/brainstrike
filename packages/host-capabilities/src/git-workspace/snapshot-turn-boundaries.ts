import { createLogger } from '@brainstrike/logging';
import type { SnapshotKind, SnapshotService } from './snapshot-service.ts';
import type { SnapshotCaptureOutcome } from './snapshot-turn-registry.ts';

const logger = createLogger('SnapshotTurnBoundaries');

/**
 * One root's boundary snapshot, shared by legacy turns and host runs. Never
 * throws: a failure is logged and becomes a failed outcome, which the caller
 * records as the failed-capture marker.
 */
export async function captureRootSnapshot(
  service: SnapshotService,
  kind: SnapshotKind,
  threadId: string,
  runId: string,
  root: { readonly path: string; readonly rootId: string }
): Promise<SnapshotCaptureOutcome> {
  try {
    const handle = await service.ensureShadowRepo({ path: root.path, rootId: root.rootId });
    const { commitOid } = await service.snapshot(handle, { kind, runId, threadId });
    return { commitOid, kind: 'captured', rootPath: handle.rootPath };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error('Workspace snapshot capture failed; recording a failed-capture marker', {
      kind,
      reason,
      rootId: root.rootId,
      runId,
      threadId,
    });
    return { kind: 'failed', reason, rootPath: root.path };
  }
}
