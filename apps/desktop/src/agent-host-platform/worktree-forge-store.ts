import type { ForgeCachePort, WorktreeLedgerPort } from '@brainstrike/state-store';
import type { MessageConnection } from 'vscode-jsonrpc';
import { z } from 'zod';

const Text = z.string();
const Id = Text.min(1);
const SetupStatus = z.enum(['failed', 'none', 'skipped', 'succeeded']);
const Worktree = z.strictObject({
  archivedAt: z.iso.datetime().nullable(),
  archiveSnapshotRef: Text.nullable(),
  baseRef: Text,
  branch: Text.nullable(),
  createdAt: z.iso.datetime(),
  createdBy: z.enum(['agent', 'user']),
  id: Id,
  path: Id,
  repoCommonDir: Id,
  runId: Text.nullable(),
  setupOutput: Text.nullable(),
  setupReason: Text.nullable(),
  setupStatus: SetupStatus,
  threadId: Text.nullable(),
});
const WorktreeRequest = z.discriminatedUnion('operation', [
  z.strictObject({ id: Id, operation: z.literal('get') }),
  z.strictObject({ operation: z.literal('by-path'), path: Id }),
  z.strictObject({ operation: z.literal('list-active') }),
  z.strictObject({ operation: z.literal('list-repository'), repoCommonDir: Id }),
  z.strictObject({ operation: z.literal('insert'), row: Worktree }),
  z.strictObject({ id: Id, operation: z.literal('archive'), snapshotRef: Id }),
  z.strictObject({ id: Id, operation: z.literal('restore') }),
  z.strictObject({
    id: Id,
    operation: z.literal('setup'),
    output: Text.nullable(),
    reason: Text.nullable(),
    status: SetupStatus,
  }),
  z.strictObject({ branch: Text, id: Id, operation: z.literal('branch') }),
]);
const WorktreeReply = z.strictObject({ rows: z.array(Worktree) });
const Check = z.strictObject({
  conclusion: z.enum([
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
  url: Text.nullable(),
});
const PullRequest = z.strictObject({
  checks: z.array(Check),
  checksRollup: z.enum(['failing', 'none', 'passing', 'pending']),
  headSha: Id,
  isDraft: z.boolean(),
  number: z.number().int(),
  reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
  state: z.enum(['open', 'closed', 'merged']),
  title: Text,
  url: Id,
});
const Entry = z.strictObject({ observedAt: z.iso.datetime(), pullRequest: PullRequest.nullable() });
const CacheKey = { branch: Id, repoCommonDir: Id };
const ForgeRequest = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('get'), ...CacheKey }),
  z.strictObject({ operation: z.literal('write'), ...CacheKey, ...Entry.shape }),
]);
export const ForgeCacheReplySchema = z.strictObject({ entry: Entry.nullable() });
const WORKTREE_METHOD = 'host/worktree-ledger';
const FORGE_METHOD = 'host/forge-cache';
const SNAPSHOT_METHOD = 'host/forge-cache-snapshot';
const Snapshot = z.array(
  z.strictObject({
    branch: Id,
    checksRollup: z.enum(['failing', 'none', 'passing', 'pending']),
    isDraft: z.boolean(),
    number: z.number().int(),
    repoCommonDir: Id,
    state: z.enum(['open', 'closed', 'merged']),
    url: Id,
  })
);

/** Private Main transport; each operation remains owned by the profile's SQLite writer. */
export function serveWorktreeForgeStore(
  connection: MessageConnection,
  store: WorktreeLedgerPort & ForgeCachePort
): { close(): Promise<void> } {
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
        z.strictObject({}).parse(input);
        return store.forgeCacheSnapshot();
      })
    ),
    connection.onRequest(WORKTREE_METHOD, (input: unknown) =>
      admitted(() => store.worktreeLedger(WorktreeRequest.parse(input)))
    ),
    connection.onRequest(FORGE_METHOD, (input: unknown) =>
      admitted(() => store.forgeCache(ForgeRequest.parse(input)))
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
      ForgeCacheReplySchema.parse(
        await connection.sendRequest(FORGE_METHOD, ForgeRequest.parse(request))
      ),
    forgeCacheSnapshot: async () =>
      Snapshot.parse(await connection.sendRequest(SNAPSHOT_METHOD, {})),
    worktreeLedger: async (request) =>
      WorktreeReply.parse(
        await connection.sendRequest(WORKTREE_METHOD, WorktreeRequest.parse(request))
      ),
  };
}
