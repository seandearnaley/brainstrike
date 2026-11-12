import type {
  WorkspaceRootPort,
  WorkspaceRootReply,
  WorkspaceRootRequest,
} from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { sendCatalogRequest } from './request.ts';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
/**
 * ADR-0029 stage 4: Main only reads the roots. The agent host's root registry
 * writes them through its own store, never over this transport.
 */
const WorkspaceRootRequestSchema = Schema.Struct({ operation: Schema.Literal('list') });
const WorkspaceRootReplySchema = Schema.Struct({
  roots: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        canonicalPath: Id,
        createdAt: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        displayName: Id,
        id: Id,
        kind: Schema.Literals(['path', 'worktree', 'scratch']),
        lastVerifiedAt: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        path: Id,
        projectId: Schema.NullOr(Id),
        status: Schema.Literals(['live', 'disconnected']),
      })
    )
  ),
});
const METHOD = 'host/workspace-roots';
/** Served only after host authentication; Main's reads borrow the acquired store. */
export function serveWorkspaceRootStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: WorkspaceRootPort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<WorkspaceRootReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing !== undefined) {
      throw new Error('Workspace root store endpoint is closing');
    }
    const request = Schema.decodeUnknownSync(WorkspaceRootRequestSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
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
/** Main reads the acquired host store; no local store or SQL bridge is opened. */
export function createWorkspaceRootClient(connection: MessageConnection): WorkspaceRootPort {
  return {
    workspaceRoots: async (request: WorkspaceRootRequest): Promise<WorkspaceRootReply> =>
      Schema.decodeUnknownSync(WorkspaceRootReplySchema, {
        errors: 'all',
        onExcessProperty: 'error',
      })(
        await sendCatalogRequest(
          connection,
          METHOD,
          Schema.decodeUnknownSync(WorkspaceRootRequestSchema, {
            errors: 'all',
            onExcessProperty: 'error',
          })(request)
        )
      ),
  };
}
