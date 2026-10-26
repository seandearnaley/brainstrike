import type { WorktreeLedgerPort } from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.ts';

const Text = Schema.String;
const Id = Text.check(Schema.isMinCodePoints(1));
const SetupStatus = Schema.Literals(['failed', 'none', 'skipped', 'succeeded']);
const Worktree = Schema.Struct({
  archivedAt: Schema.NullOr(Schema.String.check(Schema.isPattern(z.regexes.datetime({})))),
  archiveSnapshotRef: Schema.NullOr(Text),
  baseRef: Text,
  branch: Schema.NullOr(Text),
  createdAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
  createdBy: Schema.Literals(['agent', 'user']),
  id: Id,
  path: Id,
  repoCommonDir: Id,
  runId: Schema.NullOr(Text),
  setupOutput: Schema.NullOr(Text),
  setupReason: Schema.NullOr(Text),
  setupStatus: SetupStatus,
  threadId: Schema.NullOr(Text),
});
const WorktreeRequest = Schema.Union(
  [
    Schema.Struct({ id: Id, operation: Schema.Literal('get') }),
    Schema.Struct({ operation: Schema.Literal('by-path'), path: Id }),
    Schema.Struct({ operation: Schema.Literal('list-active') }),
    Schema.Struct({ operation: Schema.Literal('list-repository'), repoCommonDir: Id }),
    Schema.Struct({ operation: Schema.Literal('insert'), row: Worktree }),
    Schema.Struct({ id: Id, operation: Schema.Literal('archive'), snapshotRef: Id }),
    Schema.Struct({ id: Id, operation: Schema.Literal('restore') }),
    Schema.Struct({
      id: Id,
      operation: Schema.Literal('setup'),
      output: Schema.NullOr(Text),
      reason: Schema.NullOr(Text),
      status: SetupStatus,
    }),
    Schema.Struct({ branch: Text, id: Id, operation: Schema.Literal('branch') }),
  ],
  { mode: 'oneOf' }
);
const WorktreeReply = Schema.Struct({ rows: Schema.mutable(Schema.Array(Worktree)) });
const WORKTREE_METHOD = 'host/worktree-ledger';
/** Private Main transport; each operation remains owned by the profile's SQLite writer. */
export function serveWorktreeLedgerStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: WorktreeLedgerPort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  async function admitted<T>(start: () => Promise<T>): Promise<T> {
    if (closing !== undefined) {
      throw new Error('Worktree ledger endpoint is closing');
    }
    const work = start();
    pending.add(work);
    try {
      return await work;
    } finally {
      pending.delete(work);
    }
  }
  const subscriptions = [
    connection.onRequest(WORKTREE_METHOD, (input: unknown) =>
      admitted(() =>
        store.worktreeLedger(
          Schema.decodeUnknownSync(WorktreeRequest, { errors: 'all', onExcessProperty: 'error' })(
            input
          )
        )
      )
    ),
  ];
  return {
    close: () => {
      closing ??= Promise.resolve().then(async () => {
        while (pending.size > 0) {
          await Promise.allSettled([...pending]);
        }
        for (const subscription of subscriptions) {
          subscription.dispose();
        }
      });
      return closing;
    },
  };
}
export function createWorktreeLedgerClient(connection: MessageConnection): WorktreeLedgerPort {
  return {
    worktreeLedger: async (request) =>
      Schema.decodeUnknownSync(WorktreeReply, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(
          connection,
          WORKTREE_METHOD,
          Schema.decodeSync(WorktreeRequest, { errors: 'all', onExcessProperty: 'error' })(request)
        )
      ),
  };
}
