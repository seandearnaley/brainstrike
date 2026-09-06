import type { AssistantUiThreadHistoryAdapter } from '@brainstrike/assistant-contract';
import {
  isApprovalActionMessage,
  readActionMessageRunId,
} from '@brainstrike/assistant-contract/approval-action-message';
import type { SuspendedRunDiscovery } from '../assistant-suspended-approvals.js';
import {
  appendSuspendedPauseMessages,
  isSuspendedPauseMessageId,
  toHistoryRepository,
} from './assistant-history-projection.js';
import type { AssistantThreadRepository } from './assistant-thread-types.js';
import { ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT } from './assistant-thread-types.js';

export function createAssistantThreadHistoryAdapter({
  discoverSuspendedRuns,
  repository,
  resourceId,
  threadId,
}: {
  /**
   * Desktop-only capability: rediscover approvals AND suspend() pauses
   * stranded by a restart/reload (see assistant-suspended-approvals.ts).
   * Omitted on web (no assistant server / storage, so web never suspends),
   * where its absence means "no suspended pauses" and hydration is
   * byte-identical to today.
   */
  readonly discoverSuspendedRuns?: SuspendedRunDiscovery;
  readonly repository: AssistantThreadRepository;
  readonly resourceId: string;
  readonly threadId: string;
}): AssistantUiThreadHistoryAdapter {
  // DURABLE-PARENT INVARIANT (BST-1243): every persisted edge must reference a
  // durable (Mastra-persisted) message id or null. Approval/suspend flows
  // append UI-transient messages — the action echo, the post-resume leg, and
  // the synthetic rediscovered-pause notices — that Mastra deliberately never
  // persists; persisting their edges (or chaining a real message onto their
  // ids) dangles the graph, and reload hydration re-roots the child into a
  // phantom root carousel sibling. The maps below alias each transient id to
  // its nearest durable ancestor so persisted topology skips them entirely.
  const transientParentByAliasId = new Map<string, string | null>();
  const hydratedParentById = new Map<string, string | null>();
  const persistedEdgeIds = new Set<string>();
  let durableTailId: string | null = null;

  const resolveDurableParentId = (parentId: string | null): string | null => {
    let current = parentId;
    const seen = new Set<string>();
    while (current !== null && transientParentByAliasId.has(current)) {
      if (seen.has(current)) {
        throw new Error(`Assistant history transient-parent aliases form a cycle at ${current}.`);
      }
      seen.add(current);
      current = transientParentByAliasId.get(current) ?? null;
    }
    return current;
  };

  const recordParentEdge = async (messageId: string, parentId: string | null): Promise<void> => {
    if (!repository.recordMessageParent) {
      throw new Error('Assistant history repository cannot persist message branch topology.');
    }
    await repository.recordMessageParent({ messageId, parentId, resourceId, threadId });
    persistedEdgeIds.add(messageId);
  };

  // The echo is transport bookkeeping with no durable row — never an edge.
  // Its parent is the SUSPENDED assistant message, whose own runEnd append
  // never fires (suspension interrupts it), so backfill that durable edge
  // here; otherwise the reload group keys to a snapshot row id and every
  // descendant edge dangles. The backfill parent, in order of authority: the
  // hydrated graph parent when the suspended message was loaded; else the
  // suspending run's durable turn anchor (BST-1163 `turn_message_id`, stamped
  // identically on every leg of the turn — exact even when other sends landed
  // during the suspension or the suspended run was a regeneration branched
  // from an older prompt); else the live session tail as a legacy last resort
  // (runs predating the turn link). The repository upsert stays loud on
  // conflicting topology.
  const recordActionEchoAppend = async (
    message: unknown,
    resolvedParentId: string | null
  ): Promise<void> => {
    if (resolvedParentId === null || persistedEdgeIds.has(resolvedParentId)) {
      return;
    }
    let suspendedParentId: string | null;
    if (hydratedParentById.has(resolvedParentId)) {
      suspendedParentId = hydratedParentById.get(resolvedParentId) ?? null;
    } else {
      const actionRunId = readActionMessageRunId(message);
      const turnMessageId =
        actionRunId !== undefined && repository.getThreadRunTurnMessageId
          ? await repository.getThreadRunTurnMessageId(actionRunId, threadId)
          : null;
      suspendedParentId = turnMessageId ?? durableTailId;
    }
    await recordParentEdge(resolvedParentId, suspendedParentId);
  };

  return {
    async append(item) {
      // Mastra remains the only durable CONTENT writer. assistant-ui owns the
      // branch graph, so persist only its id/parent edge here; writing the
      // message body would duplicate or race Mastra's snapshots.
      if (!repository.recordMessageParent) {
        throw new Error('Assistant history repository cannot persist message branch topology.');
      }
      const resolvedParentId = resolveDurableParentId(item.parentId);
      if (isApprovalActionMessage(item.message)) {
        transientParentByAliasId.set(item.message.id, resolvedParentId);
        await recordActionEchoAppend(item.message, resolvedParentId);
        return;
      }
      if (
        item.message.role === 'assistant' &&
        item.parentId !== null &&
        transientParentByAliasId.has(item.parentId)
      ) {
        // A resume leg: the transient assistant-ui message continuing a
        // suspended run (its content persists under a fresh Mastra snapshot
        // id inside the suspended message's hydration group). Alias it so the
        // next real message chains onto the durable suspended id instead.
        // DELIBERATE v1 SCOPE: this also catches a REGENERATION taken from a
        // post-approval response (assistant-ui re-appends it with the echo as
        // parent, indistinguishable here from a resume leg). Its Mastra
        // content persists and hydrates chronologically inside the turn's
        // group; only the carousel affordance is not reconstructed after
        // reload. Distinguishing the two would require a timing-sensitive
        // probe of Mastra's row store — rejected; pinned by the
        // "regeneration taken from a post-approval response" case in
        // assistant-approval-topology.integration.test.ts.
        transientParentByAliasId.set(item.message.id, resolvedParentId);
        return;
      }
      await recordParentEdge(item.message.id, resolvedParentId);
      durableTailId = item.message.id;
    },
    async load() {
      // Discovery is a bounded, best-effort HTTP round-trip (see
      // assistant-suspended-approvals.ts) and the rare case, so it runs
      // CONCURRENTLY with the history queries instead of gating them: thread
      // render waits at most max(history, discovery-timeout), never their sum.
      const [messages, runEvents, discovery] = await Promise.all([
        repository.listMessages(threadId, resourceId, {
          limitLatest: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
        }),
        repository.listThreadRunEvents(threadId, resourceId, {
          limitLatestRuns: ASSISTANT_HISTORY_HYDRATION_MESSAGE_LIMIT,
        }),
        discoverSuspendedRuns
          ? discoverSuspendedRuns(threadId, resourceId)
          : Promise.resolve({ approvals: [], suspends: [] } as const),
      ]);
      // Reseed session topology state from hydration (a re-load replaces it).
      transientParentByAliasId.clear();
      hydratedParentById.clear();
      persistedEdgeIds.clear();
      for (const message of messages) {
        if (message.parentId !== undefined) {
          persistedEdgeIds.add(message.id);
        }
      }
      const base = toHistoryRepository(messages, runEvents);
      for (const hydrated of base.messages) {
        hydratedParentById.set(hydrated.message.id, hydrated.parentId);
      }
      durableTailId = base.headId ?? null;
      const result = appendSuspendedPauseMessages(base, discovery.approvals, discovery.suspends);
      // Synthetic pause notices chain onto the durable head (and each other);
      // alias them in order so an approve from a rediscovered notice resolves
      // through to the durable graph.
      for (const hydrated of result.messages) {
        if (isSuspendedPauseMessageId(hydrated.message.id)) {
          transientParentByAliasId.set(
            hydrated.message.id,
            resolveDurableParentId(hydrated.parentId)
          );
        }
      }
      return result;
    },
  };
}
