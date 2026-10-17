import type { ForgeCachePort, WorktreeLedgerPort } from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';
import { sendCatalogRequest } from './request.js';

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
const Check = Schema.Struct({
  conclusion: Schema.Literals([
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'pending',
    'skipped',
    'success',
    'timed_out',
  ]),
  name: Id,
  url: Schema.NullOr(Text),
});
const PullRequest = Schema.Struct({
  checks: Schema.mutable(Schema.Array(Check)),
  checksRollup: Schema.Literals(['failing', 'none', 'passing', 'pending']),
  headSha: Id,
  isDraft: Schema.Boolean,
  number: Schema.Int,
  reviewDecision: Schema.NullOr(
    Schema.Literals(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])
  ),
  state: Schema.Literals(['open', 'closed', 'merged']),
  title: Text,
  url: Id,
});
const Entry = Schema.Struct({
  observedAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
  pullRequest: Schema.NullOr(PullRequest),
});
const CacheKey = { branch: Id, repoCommonDir: Id };
const ForgeRequest = Schema.Union(
  [
    Schema.Struct({ operation: Schema.Literal('get'), ...CacheKey }),
    Schema.Struct({ operation: Schema.Literal('write'), ...CacheKey, ...Entry.fields }),
  ],
  { mode: 'oneOf' }
);
export const ForgeCacheReplySchema = Schema.Struct({ entry: Schema.NullOr(Entry) });
const WORKTREE_METHOD = 'host/worktree-ledger';
const FORGE_METHOD = 'host/forge-cache';
const SNAPSHOT_METHOD = 'host/forge-cache-snapshot';
const Snapshot = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      branch: Id,
      checksRollup: Schema.Literals(['failing', 'none', 'passing', 'pending']),
      isDraft: Schema.Boolean,
      number: Schema.Int,
      repoCommonDir: Id,
      state: Schema.Literals(['open', 'closed', 'merged']),
      url: Id,
    })
  )
);
/** Private Main transport; each operation remains owned by the profile's SQLite writer. */
export function serveWorktreeForgeStore(
  connection: Pick<MessageConnection, 'onRequest'>,
  store: WorktreeLedgerPort & ForgeCachePort
): {
  close(): Promise<void>;
} {
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  async function admitted<T>(start: () => Promise<T>): Promise<T> {
    if (closing) {
      throw new Error('Worktree/Forge endpoint is closing');
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
    connection.onRequest(SNAPSHOT_METHOD, (input: unknown) =>
      admitted(() => {
        Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Never), {
          errors: 'all',
          onExcessProperty: 'error',
        })(input);
        return store.forgeCacheSnapshot();
      })
    ),
    connection.onRequest(WORKTREE_METHOD, (input: unknown) =>
      admitted(() =>
        store.worktreeLedger(
          Schema.decodeUnknownSync(WorktreeRequest, { errors: 'all', onExcessProperty: 'error' })(
            input
          )
        )
      )
    ),
    connection.onRequest(FORGE_METHOD, (input: unknown) =>
      admitted(() =>
        store.forgeCache(
          Schema.decodeUnknownSync(ForgeRequest, { errors: 'all', onExcessProperty: 'error' })(
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
export function createWorktreeForgeClient(
  connection: MessageConnection
): WorktreeLedgerPort & ForgeCachePort {
  return {
    forgeCache: async (request) =>
      Schema.decodeUnknownSync(ForgeCacheReplySchema, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(
          connection,
          FORGE_METHOD,
          Schema.decodeUnknownSync(ForgeRequest, { errors: 'all', onExcessProperty: 'error' })(
            request
          )
        )
      ),
    forgeCacheSnapshot: async () =>
      Schema.decodeUnknownSync(Snapshot, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(connection, SNAPSHOT_METHOD, {})
      ),
    worktreeLedger: async (request) =>
      Schema.decodeUnknownSync(WorktreeReply, { errors: 'all', onExcessProperty: 'error' })(
        await sendCatalogRequest(
          connection,
          WORKTREE_METHOD,
          Schema.decodeUnknownSync(WorktreeRequest, { errors: 'all', onExcessProperty: 'error' })(
            request
          )
        )
      ),
  };
}
