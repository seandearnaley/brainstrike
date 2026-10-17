/**
 * A host thread's workspace snapshot (its tabs and panels) as the shell's
 * thread workspace repository reads and saves it, through the host that owns
 * the thread (BST-1940): desktop's and the web's thread hosts share it.
 */
import type { HostClient } from '@brainstrike/agent-host/browser';
import {
  WorkspaceSnapshotSchema,
  type WorkspaceSnapshotV1,
} from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import {
  type ThreadWorkspaceRepository,
  WORKSPACE_MEMORY_RESOURCE_ID,
} from '@brainstrike/assistant-data';

/** The client of the host that owns a thread; undefined for a thread no host here owns. */
export type HostThreadClient = (
  threadId: string
) => Promise<Pick<HostClient, 'request'> | undefined>;

export function hostThreadWorkspaceRepository(
  threadClient: HostThreadClient
): ThreadWorkspaceRepository {
  const owner = async (threadId: string): Promise<Pick<HostClient, 'request'>> => {
    const host = await threadClient(threadId);
    if (!host) {
      throw new Error('This workspace snapshot is not owned by the attached agent host.');
    }
    return host;
  };
  // The host's result schema (`WorkspaceSnapshotSchema`) validated the snapshot;
  // it differs from the interface only in spelling an absent field `undefined`.
  const getThreadWorkspace = async (threadId: string): Promise<WorkspaceSnapshotV1 | null> =>
    (await (await owner(threadId)).request('thread/workspace/read', { threadId }))
      .snapshot as WorkspaceSnapshotV1 | null;
  return {
    getThreadWorkspace,
    getThreadWorkspaces: async (threadIds) => {
      const snapshots = await Promise.all(
        threadIds.map(async (id) => [id, await getThreadWorkspace(id)] as const)
      );
      return new Map(
        snapshots.flatMap(([id, snapshot]) => (snapshot ? [[id, snapshot] as const] : []))
      );
    },
    setThreadWorkspace: async (threadId, resourceId, snapshot) => {
      const host = await owner(threadId);
      if (resourceId !== WORKSPACE_MEMORY_RESOURCE_ID) {
        throw new Error('The host thread belongs to the workspace resource');
      }
      await host.request('thread/workspace/set', {
        commandId: crypto.randomUUID(),
        snapshot: WorkspaceSnapshotSchema.parse(snapshot),
        threadId,
      });
    },
  };
}
