import {
  type DelegatedBudgetPort,
  DelegatedOutputReservationExceededError,
  type DelegatedStepReservation,
} from '@brainstrike/assistant-contract';
import type { ToolsInput } from '@mastra/core/agent';
import { parseMemoryRequestContext } from '@mastra/core/memory';
import type { ErrorProcessor, InputProcessor, OutputProcessor } from '@mastra/core/processors';
import {
  DELEGATED_SYNTHESIS_PART,
  type DelegatedSynthesisOutcomes,
} from './delegated-synthesis-outcomes';

/**
 * FIFO permits for active model/tool work; native delegation waits own no
 * permit. `maxConcurrentWork` is the request's setting
 * (`RuntimeSubagentSettings.maxConcurrentWork`), never a constant.
 */
export class DelegatedWorkQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly maxConcurrentWork: number;

  constructor(maxConcurrentWork: number) {
    if (!Number.isInteger(maxConcurrentWork) || maxConcurrentWork < 1) {
      throw new Error(
        `Delegated work concurrency must be a positive integer; received ${maxConcurrentWork}.`
      );
    }
    this.maxConcurrentWork = maxConcurrentWork;
  }

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
    while (this.active < this.maxConcurrentWork && this.waiting.length > 0) {
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
  rootSignal?: AbortSignal,
  synthesisOutcomes?: DelegatedSynthesisOutcomes
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
      async processOutputStep({
        usage,
        toolCalls,
        messages,
        finishReason,
        requestContext,
        writer,
      }) {
        try {
          if (!reservation) {
            throw new Error('Delegated output has no durable reservation.');
          }
          await settleOutputStep(budget, reservation, usage?.outputTokens, finishReason, toolCalls);
          if (reservation.synthesis && toolCalls?.length) {
            throw new Error('Delegated synthesis cannot execute tools.');
          }
          if (reservation.synthesis) {
            const native = parseMemoryRequestContext(requestContext);
            if (!(native?.thread?.id && native.resourceId && writer)) {
              throw new Error(
                'Delegated synthesis outcome requires native child identity and stream ownership.'
              );
            }
            const outcome = {
              cap: reservation.cap,
              limit: reservation.limit,
              outputTokens: usage?.outputTokens,
              reservedOutputTokens: reservation.outputTokens,
              // The provider cut the reserved summary: a truncated COMPLETION, never a failure.
              truncated: finishReason === 'length',
              used: reservation.used,
            };
            synthesisOutcomes?.record(native.thread.id, outcome);
            // Built so an unknown `outputTokens` is OMITTED: the part schema is strict.
            const { outputTokens, ...known } = outcome;
            await writer.custom({
              data: {
                ...known,
                ...(outputTokens === undefined ? {} : { outputTokens }),
                resourceId: native.resourceId,
                threadId: native.thread.id,
              },
              transient: true,
              type: DELEGATED_SYNTHESIS_PART,
            });
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

async function settleOutputStep(
  budget: DelegatedBudgetPort,
  reservation: DelegatedStepReservation,
  outputTokens: number | undefined,
  finishReason: string | undefined,
  toolCalls: readonly unknown[] | undefined
): Promise<void> {
  try {
    await budget.settleStep(reservation.id, outputTokens);
  } catch (error) {
    // The host has already charged the full usage. Retain only a cut, tool-free
    // final summary: it cannot spend more. Never recover a persistence failure.
    if (
      !(error instanceof DelegatedOutputReservationExceededError && reservation.synthesis) ||
      finishReason !== 'length' ||
      toolCalls?.length
    ) {
      throw error;
    }
  }
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
