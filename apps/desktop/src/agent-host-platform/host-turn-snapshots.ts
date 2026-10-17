import type { HostTurnSnapshot } from '@brainstrike/agent-host';
import { Schema } from 'effect';
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc';
import { FAILED_SNAPSHOT_CAPTURE_OID } from '../assistant-server/snapshot-repository';
import type { SnapshotService } from '../assistant-server/snapshot-service';
import { captureRootSnapshot } from '../assistant-server/snapshot-turn-boundaries';
import {
  PlatformTurnSnapshotRequestSchema,
  PlatformTurnSnapshotResultSchema,
} from './platform-wire';
/** Main's one shadow-git snapshot owner; null until the app is ready to construct it. */
export type DesktopWorkspaceSnapshots = () => SnapshotService | null;
type Execute = <T>(
  token: CancellationToken,
  work: (signal: AbortSignal) => Promise<T>
) => Promise<T>;
/**
 * Serve a host run's turn-boundary snapshots over the same shadow-git owner as
 * legacy turns, under the host thread's own snapshot ref. The host's log is
 * their record: Main writes no ledger row. Roots are captured one at a time,
 * as legacy turns are, and a root that fails records the null object ID.
 */
export function serveHostTurnSnapshots(
  connection: MessageConnection,
  execute: Execute,
  snapshots: DesktopWorkspaceSnapshots | undefined
): void {
  connection.onRequest('platform/snapshot/capture', (input: unknown, token: CancellationToken) =>
    execute(token, async () => {
      const request = Schema.decodeUnknownSync(PlatformTurnSnapshotRequestSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(input);
      const service = snapshots?.();
      if (!service) {
        throw new Error('This desktop has no workspace snapshot owner');
      }
      const roots = request.roots.map(({ rootId, rootPath }) => ({ path: rootPath, rootId }));
      const captured: HostTurnSnapshot[] = [];
      for (const root of roots) {
        const outcome = await captureRootSnapshot(
          service,
          request.boundary,
          request.threadId,
          request.runId,
          root
        );
        captured.push({
          commitOid: outcome.kind === 'captured' ? outcome.commitOid : FAILED_SNAPSHOT_CAPTURE_OID,
          rootId: root.rootId,
          rootPath: outcome.rootPath,
        });
      }
      return Schema.decodeUnknownSync(PlatformTurnSnapshotResultSchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(captured);
    })
  );
}
