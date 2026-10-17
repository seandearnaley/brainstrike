import type {
  WorkspaceRootPort,
  WorkspaceRootReply,
  WorkspaceRootRequest,
} from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { sendCatalogRequest } from './request.js';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const WorkspaceRootRequestSchema = Schema.Union(
  [
    Schema.Struct({ operation: Schema.Literal('list') }),
    Schema.Struct({
      operation: Schema.Literal('delete'),
      paths: Schema.mutable(Schema.Array(Id)).check(Schema.isMinLength(1)),
      rootId: Id,
    }),
    Schema.Struct({
      operation: Schema.Literal('register'),
      root: Schema.Struct({ displayName: Id, path: Id, preferredId: Id }),
    }),
    Schema.Struct({
      mountedPaths: Schema.mutable(Schema.Array(Id)),
      operation: Schema.Literal('disconnect-except'),
    }),
  ],
  { mode: 'oneOf' }
);
const WorkspaceRootReplySchema = Schema.Struct({
  roots: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        createdAt: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        displayName: Id,
        id: Id,
        kind: Schema.Literals(['path', 'worktree']),
        lastVerifiedAt: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
        path: Id,
        status: Schema.Literals(['live', 'disconnected']),
      })
    )
  ),
});
const METHOD = 'host/workspace-roots';
/** Served only after host authentication; all requests borrow the acquired writer. */
export function serveWorkspaceRootStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: WorkspaceRootPort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<WorkspaceRootReply>>();
  const subscription = connection.onRequest(METHOD, async (input: unknown) => {
    if (closing) {
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
/** Main borrows the acquired host writer; no local store or SQL bridge is opened. */
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
