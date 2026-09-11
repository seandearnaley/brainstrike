import {
  DELEGATION_LIMITS,
  type DelegatedBudgetPort,
  type DelegatedStepReservation,
} from '@brainstrike/assistant-contract';
import type { ToolsInput } from '@mastra/core/agent';
import { parseMemoryRequestContext } from '@mastra/core/memory';
import type { ErrorProcessor, InputProcessor, OutputProcessor } from '@mastra/core/processors';

/** FIFO permits for active model/tool work; native delegation waits own no permit. */
export class DelegatedWorkQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    const ready = Promise.withResolvers<() => void>();
    const abort = () => {
      const index = this.waiting.indexOf(start);
      if (index >= 0) {
        this.waiting.splice(index, 1);
      }
      ready.reject(signal?.reason ?? new Error('Delegated work aborted.'));
    };
    const start = () => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        ready.reject(signal.reason);
        this.advance();
        return;
      }
      this.active += 1;
      let released = false;
      ready.resolve(() => {
        if (released) {
          return;
        }
        released = true;
        this.active -= 1;
        this.advance();
      });
    };
    this.waiting.push(start);
    signal?.addEventListener('abort', abort, { once: true });
    this.advance();
    return await ready.promise;
  }

  private advance(): void {
    while (this.active < DELEGATION_LIMITS.maxConcurrentWork && this.waiting.length > 0) {
      this.waiting.shift()?.();
    }
  }
}

/** A durable binding alone never disables the native in-flight backstop. */
export function resolveDelegatedWorkBudget(
  budget: DelegatedBudgetPort | undefined,
  queue: DelegatedWorkQueue | undefined
): { budget: DelegatedBudgetPort; queue: DelegatedWorkQueue } | undefined {
  return budget && queue ? { budget, queue } : undefined;
}

/** One instance per native stream invocation, never shared by same-persona siblings. */
export function createDelegatedWorkBudget(
  budget: DelegatedBudgetPort,
  queue: DelegatedWorkQueue,
  rootSignal?: AbortSignal
): {
  processor: InputProcessor & OutputProcessor & ErrorProcessor;
  release(): void;
} {
  let reservation: DelegatedStepReservation | undefined;
  let releasePermit: (() => void) | undefined;
  let activeSignal: AbortSignal | undefined;
  const release = () => {
    activeSignal?.removeEventListener('abort', release);
    activeSignal = undefined;
    releasePermit?.();
    releasePermit = undefined;
  };
  return {
    processor: {
      id: 'brainstrike-delegated-work-budget',
      processAPIError() {
        release();
      },
      async processInputStep({
        requestContext,
        modelSettings,
        abortSignal,
        messages,
        messageList,
      }) {
        release();
        const native = parseMemoryRequestContext(requestContext);
        if (!(native?.thread?.id && native.resourceId)) {
          throw new Error('Delegated budget requires native child identity.');
        }
        // Native unwind can omit the processor signal; the host leg remains authoritative.
        const signal =
          rootSignal && abortSignal
            ? AbortSignal.any([rootSignal, abortSignal])
            : (rootSignal ?? abortSignal);
        releasePermit = await queue.acquire(signal);
        activeSignal = signal;
        signal?.addEventListener('abort', release, { once: true });
        try {
          signal?.throwIfAborted();
          reservation = await budget.reserveStep({
            resourceId: native.resourceId,
            threadId: native.thread.id,
          });
          signal?.throwIfAborted();
          if (reservation.synthesis) {
            messageList.addSystem(
              'Delegated work budget exhausted. Produce only a concise summary of completed work, partial results and remaining limitations. Do not call tools.',
              'brainstrike-budget-synthesis'
            );
          }
          return {
            messages,
            modelSettings: {
              ...modelSettings,
              maxOutputTokens: Math.min(
                modelSettings?.maxOutputTokens ?? reservation.outputTokens,
                reservation.outputTokens
              ),
            },
            ...(reservation.synthesis ? { activeTools: [], toolChoice: 'none' as const } : {}),
          };
        } catch (error) {
          release();
          throw error;
        }
      },
      async processOutputStep({ usage, toolCalls, messages }) {
        try {
          if (!reservation) {
            throw new Error('Delegated output has no durable reservation.');
          }
          await budget.settleStep(reservation.id, usage?.outputTokens);
          if (reservation.synthesis && toolCalls?.length) {
            throw new Error('Delegated synthesis cannot execute tools.');
          }
          return messages;
        } finally {
          release();
        }
      },
    },
    release,
  };
}

/** Keep native descriptors, approval flags and raw/model projections intact. */
export function queueDelegatedTools(
  tools: ToolsInput,
  queue: DelegatedWorkQueue,
  signal: () => AbortSignal | undefined
): ToolsInput {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      if (
        !(
          tool &&
          typeof tool === 'object' &&
          'execute' in tool &&
          typeof tool.execute === 'function'
        )
      ) {
        return [name, tool];
      }
      const execute = tool.execute as (...args: unknown[]) => unknown;
      const descriptors = Object.getOwnPropertyDescriptors(tool);
      const original = descriptors['execute'];
      descriptors['execute'] = {
        configurable: original?.configurable ?? true,
        enumerable: original?.enumerable ?? true,
        value: async (...args: unknown[]) => {
          const release = await queue.acquire(signal());
          try {
            return await execute.apply(tool, args);
          } finally {
            release();
          }
        },
        writable: original && 'writable' in original ? original.writable : true,
      };
      return [
        name,
        Object.defineProperties(
          Object.create(Object.getPrototypeOf(tool)),
          descriptors
        ) as ToolsInput[string],
      ];
    })
  );
}
