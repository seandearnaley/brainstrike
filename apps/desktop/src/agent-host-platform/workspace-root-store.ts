import type {
  WorkspaceRootPort,
  WorkspaceRootReply,
  WorkspaceRootRequest,
} from '@brainstrike/state-store';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';

const Id = z.string().min(1);
const WorkspaceRootRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('list') }),
  z.strictObject({ operation: z.literal('delete'), paths: z.array(Id).min(1), rootId: Id }),
  z.strictObject({
    operation: z.literal('register'),
    root: z.strictObject({ displayName: Id, path: Id, preferredId: Id }),
  }),
  z.strictObject({ mountedPaths: z.array(Id), operation: z.literal('disconnect-except') }),
]);
const WorkspaceRootReplySchema = z.strictObject({
  roots: z.array(
    z.strictObject({
      createdAt: z.number().nonnegative(),
      displayName: Id,
      id: Id,
      kind: z.enum(['path', 'worktree']),
      lastVerifiedAt: z.number().nonnegative(),
      path: Id,
      status: z.enum(['live', 'disconnected']),
    })
  ),
});
const METHOD = 'host/workspace-roots';

/** Only the private launcher platform connection serves this writer capability. */
export function serveWorkspaceRootStore(
  connection: MessageConnection,
  store: WorkspaceRootPort
): { close(): Promise<void> } {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<WorkspaceRootReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing) {
      throw new Error('Workspace root store endpoint is closing');
    }
    const request = WorkspaceRootRequestSchema.parse(input);
    const work = store.workspaceRoots(request);
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  });
  return {
    close: () => {
      closing ??= Promise.resolve().then(async () => {
        while (pending.size > 0) {
          await Promise.allSettled([...pending]);
        }
        subscription.dispose();
      });
      return closing;
    },
  };
}

/** Main borrows the acquired host writer; no local store or SQL bridge is opened. */
export function createWorkspaceRootClient(connection: MessageConnection): WorkspaceRootPort {
  return {
    workspaceRoots: async (request: WorkspaceRootRequest): Promise<WorkspaceRootReply> =>
      WorkspaceRootReplySchema.parse(
        await connection.sendRequest(METHOD, WorkspaceRootRequestSchema.parse(request))
      ),
  };
}
