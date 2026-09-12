import type { ChildContinuationHostPort } from '@brainstrike/agent';
import type { DelegatedConversationBaseline } from '@brainstrike/assistant-contract';
import {
  createDelegatedContinuationRepository,
  createDelegatedConversationRepository,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
} from '@brainstrike/db';
import { prepareDelegatedChildBranch } from './delegated-child-branch';
import { continuationProjectionId } from './delegated-continuation-identity';
import { reserveDelegatedInvocation } from './delegated-tree-admission';

/** One managed host leg owns every mutation; human input never supplies authority. */
export function createDesktopDelegatedContinuationHost(
  database: DelegatedConversationDatabase,
  hostRunId: string,
  readScope: () => Promise<DelegatedConversationScope & { turnMessageId: string }>,
  captureHistory: (
    threadId: string,
    resourceId: string,
    initial: boolean,
    completeHistory?: boolean
  ) => Promise<DelegatedConversationBaseline>,
  resolveDelegatedDecision?: (
    input: Parameters<ChildContinuationHostPort['claimContinuationDecision']>[0]
  ) => Promise<void>
): ChildContinuationHostPort {
  const baselines = new Map<string, DelegatedConversationBaseline>();
  const claims = new Set<string>();
  const decisionKey = (
    input: Parameters<ChildContinuationHostPort['claimContinuationDecision']>[0]
  ): string =>
    JSON.stringify([input.id, input.nativeRunId, input.toolCallId, input.kind, input.delegation]);
  const projectionId = (id: string): string => continuationProjectionId(hostRunId, id);
  const repository = async () =>
    createDelegatedContinuationRepository(database, await readScope(), hostRunId);
  const authorizeDelegation = async (
    input: Parameters<ChildContinuationHostPort['claimContinuationDecision']>[0]
  ): Promise<void> => {
    if (!input.delegation) {
      return;
    }
    if (!resolveDelegatedDecision) {
      throw new DelegatedConversationIdentityError('continuation-descendant-authority-unavailable');
    }
    await resolveDelegatedDecision(input);
  };
  return {
    async bindContinuation(input) {
      const baseline = baselines.get(input.id);
      if (!baseline) {
        throw new DelegatedConversationIdentityError('continuation-history-not-prepared');
      }
      const node = await (await repository()).bind(input.id, input.nativeRunId);
      return { baseline, messageId: projectionId(node.id), threadId: node.threadId };
    },
    async claimContinuationDecision(input) {
      await authorizeDelegation(input);
      await (await repository()).claimDecision(input);
      claims.add(decisionKey(input));
    },
    async finishContinuation(input) {
      // Native failure may end consumption without a terminal stream event.
      // The repository settles this projection atomically with the receipt.
      await (await repository()).finish(
        input.id,
        input.status,
        input.error,
        projectionId(input.id)
      );
    },
    async finishContinuationDecision(input) {
      const key = decisionKey(input);
      // Disposal may follow validation failure before claim, or an explicit
      // unexecuted release. Cleanup only this host's remaining claims.
      if (!claims.has(key)) {
        return;
      }
      await (await repository()).finishDecision(input);
      claims.delete(key);
    },
    async persistContinuationEvent(input) {
      if (input.messageId !== projectionId(input.id)) {
        throw new DelegatedConversationIdentityError('continuation-message-mismatch');
      }
      const repo = await repository();
      const node = await repo.read(input.id);
      await repo.recordEvent(input.id, {
        ...input.event,
        metadata: {
          ...input.event.metadata,
          continuationHostRunId: hostRunId,
          continuationId: node.id,
          continuationNativeRunId: node.nativeRunId,
          nativeMessageId: input.messageId,
        },
        runId: projectionId(input.id),
        sequence: input.sequence,
      });
    },
    async persistContinuationUsage(input) {
      await (await repository()).recordUsage(input.id, input);
    },
    async prepareContinuation(input, configure) {
      if (!database.transaction) {
        throw new Error('Continuation admission requires a database transaction.');
      }
      const scope = await readScope();
      const node = await database.transaction(async (tx) => {
        const child = await createDelegatedConversationRepository(tx).get(scope, input.threadId);
        if (!child) {
          throw new DelegatedConversationIdentityError('continuation-input-not-admitted');
        }
        const claimed = await createDelegatedContinuationRepository(tx, scope, hostRunId).prepare(
          input,
          configure?.(child.configuration)
        );
        await reserveDelegatedInvocation(
          tx,
          scope,
          hostRunId,
          claimed.parentThreadId,
          false,
          claimed.threadId,
          claimed.configuration
        );
        return await prepareDelegatedChildBranch(
          tx,
          { ...claimed, messageId: projectionId(claimed.id) },
          true
        );
      });
      try {
        const baseline = await captureHistory(
          node.threadId,
          node.resourceId,
          false,
          Boolean(node.branch)
        );
        baselines.set(
          node.id,
          node.branch ? { ...baseline, headId: node.branchMessageIds?.at(-1) ?? null } : baseline
        );
      } catch (error) {
        // Admission committed, but no native wake can occur without its baseline.
        // Release the durable active slot without permitting replay of this receipt.
        try {
          await createDelegatedContinuationRepository(database, scope, hostRunId).finish(
            node.id,
            'failed',
            error instanceof Error ? error.message : 'Child history capture failed.',
            projectionId(node.id)
          );
        } catch (settlementError) {
          throw new AggregateError(
            [error, settlementError],
            'Child history capture and receipt settlement failed.'
          );
        }
        throw error;
      }
      return { ...node, messageId: projectionId(node.id) };
    },
    async releaseUnexecutedContinuationDecision(input) {
      const key = decisionKey(input);
      if (!claims.has(key)) {
        throw new DelegatedConversationIdentityError('continuation-decision-claim-lost');
      }
      await (await repository()).releaseDecision(input);
      claims.delete(key);
    },
    async resolveContinuationDecision(input) {
      await authorizeDelegation(input);
      const node = await (await repository()).resolveDecision(input);
      const [baseline, prepared] = await Promise.all([
        captureHistory(node.threadId, node.resourceId, false, Boolean(node.branch)),
        prepareDelegatedChildBranch(database, { ...node, messageId: projectionId(node.id) }, false),
      ]);
      const selectedBaseline = prepared.branch
        ? { ...baseline, headId: prepared.branchMessageIds?.at(-1) ?? null }
        : baseline;
      baselines.set(node.id, selectedBaseline);
      return {
        ...prepared,
        baseline: selectedBaseline,
        messageId: projectionId(node.id),
      };
    },
  };
}
