import type { ChildContinuationHostPort } from '@brainstrike/agent';
import type { DelegatedConversationBaseline } from '@brainstrike/assistant-contract';
import {
  createDelegatedContinuationRepository,
  type DelegatedConversationDatabase,
  DelegatedConversationIdentityError,
  type DelegatedConversationScope,
} from '@brainstrike/db';
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
    initial: boolean
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
      if (!claims.has(key)) {
        throw new DelegatedConversationIdentityError('continuation-decision-claim-lost');
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
    async prepareContinuation(input) {
      if (!database.transaction) {
        throw new Error('Continuation admission requires a database transaction.');
      }
      const scope = await readScope();
      const node = await database.transaction(async (tx) => {
        const claimed = await createDelegatedContinuationRepository(tx, scope, hostRunId).prepare(
          input
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
        return claimed;
      });
      baselines.set(node.id, await captureHistory(node.threadId, node.resourceId, false));
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
      const baseline = await captureHistory(node.threadId, node.resourceId, false);
      baselines.set(node.id, baseline);
      return {
        ...node,
        baseline,
        messageId: projectionId(node.id),
      };
    },
  };
}
