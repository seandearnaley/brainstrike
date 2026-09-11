import type { DelegationStartContext } from '@mastra/core/agent';
import { type MastraMemory, parseMemoryRequestContext } from '@mastra/core/memory';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import type { ToolHooks } from '@mastra/core/tools';
import type { RuntimeData } from '../types';
import {
  type AbortedTurnPersistence,
  createAbortedTurnPersistence,
} from './aborted-turn-persistence';
import type { DelegatedCancellationTarget } from './delegated-conversation-binding';

export interface DelegatedTurnPersistence {
  finalize: (targets?: readonly DelegatedCancellationTarget[]) => Promise<void>;
  hooks: (signal: AbortSignal) => ToolHooks;
  prepare: (
    context: DelegationStartContext,
    signal: AbortSignal,
    childSignal?: AbortSignal
  ) => void;
  readonly processor: InputProcessor & OutputProcessor;
}

interface NativeTurn {
  cleanupAbort?: () => void;
  complete: () => void;
  completion: Promise<void>;
  ownerSignal: AbortSignal;
  persistence?: AbortedTurnPersistence;
  signal: AbortSignal;
  toolCallId: string;
}

/** The native tool after-hook joins success, error and suspension before saving a Stop snapshot. */
export function createDelegatedTurnPersistence(
  memory: MastraMemory | undefined,
  rootMemoryScope: RuntimeData['memory']
): DelegatedTurnPersistence | undefined {
  if (!(memory && rootMemoryScope)) {
    return;
  }
  const turns = new Map<string, NativeTurn>();
  const contexts = new WeakMap<DelegationStartContext['requestContext'], NativeTurn>();
  const key = (context: { runId: string; toolCallId: string }) =>
    JSON.stringify([context.runId, context.toolCallId]);
  return {
    async finalize(targets) {
      const selected = targets
        ? new Set(
            targets.map((target) =>
              key({ runId: target.parentRuntimeRunId, toolCallId: target.parentToolCallId })
            )
          )
        : undefined;
      const settled = await Promise.allSettled(
        Array.from(turns, async ([identity, turn]) => {
          if (selected && !selected.has(identity)) {
            return;
          }
          try {
            if (!turn.persistence) {
              // An abort during input preparation may precede processInputStep.
              await turn.completion;
            }
            await turn.persistence?.finalize();
            // A normally finished child may still have its native save in flight.
            await turn.completion;
          } finally {
            turn.cleanupAbort?.();
            turns.delete(identity);
          }
        })
      );
      const errors = settled.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')
        );
      }
    },
    hooks(signal) {
      return {
        afterToolCall({ context }) {
          if (
            !(
              context &&
              typeof context === 'object' &&
              'toolCallId' in context &&
              typeof context.toolCallId === 'string'
            )
          ) {
            throw new Error('Delegated persistence requires the native tool execution identity.');
          }
          for (const [identity, turn] of turns) {
            if (turn.ownerSignal !== signal || turn.toolCallId !== context.toolCallId) {
              continue;
            }
            turn.cleanupAbort?.();
            turn.complete();
            if (!turn.signal.aborted) {
              turns.delete(identity);
            }
          }
        },
      };
    },
    prepare(context, ownerSignal, childSignal) {
      const signal = childSignal ?? ownerSignal;
      const identity = key(context);
      if (turns.has(identity)) {
        throw new Error('Delegated persistence already owns this native invocation.');
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      const turn: NativeTurn = {
        complete: resolve,
        completion: promise,
        ownerSignal,
        signal,
        toolCallId: context.toolCallId,
      };
      const capture = () => turn.persistence?.captureSnapshot();
      signal.addEventListener('abort', capture, { once: true });
      turn.cleanupAbort = () => signal.removeEventListener('abort', capture);
      turns.set(identity, turn);
      contexts.set(context.requestContext, turn);
    },
    processor: {
      id: 'brainstrike-delegated-turn-persistence',
      async processInputStep({ messageList, messageId, requestContext }) {
        const context = parseMemoryRequestContext(requestContext);
        if (context?.memoryConfig?.readOnly) {
          return messageList;
        }
        const turn = requestContext ? contexts.get(requestContext) : undefined;
        if (!(turn && context?.thread?.id && context.resourceId && messageId)) {
          throw new Error(
            'Delegated persistence requires native invocation, memory and message identities.'
          );
        }
        turn.persistence ??= createAbortedTurnPersistence({
          assistantMessageId: messageId,
          beforePersist: () => turn.completion,
          memory,
          runtimeData: { memory: { resourceId: context.resourceId, threadId: context.thread.id } },
          shouldPersist: () => turn.signal.aborted,
        });
        await turn.persistence.attachMessageList(messageList, messageId);
        if (turn.signal.aborted) {
          turn.persistence.captureSnapshot();
        }
        return messageList;
      },
      processOutputResult({ messageList, requestContext }) {
        const turn = requestContext ? contexts.get(requestContext) : undefined;
        if (turn && !turn.signal.aborted) {
          turn.persistence?.markNormalFinish();
        }
        return messageList;
      },
    },
  };
}
