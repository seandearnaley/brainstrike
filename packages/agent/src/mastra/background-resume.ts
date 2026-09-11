import type { BackgroundTask, BackgroundTaskManager } from '@mastra/core/background-tasks';
import type { MastraMemory } from '@mastra/core/memory';
import type { RuntimeData } from '../types';
import type { attachAbortedTurnMessageList } from './aborted-turn-persistence';
import type { MastraAgentRuntime } from './agent-runtime';
import { requireBackgroundResultDelivery } from './background-result-delivery';
import { saveBackgroundResult } from './background-results';
import type { BrainstrikeAgentStreamOptions } from './runtime-assembly/stream-options';
import type { AgentStreamOptions } from './turn-attempts';

export async function findPendingBackgroundTask(
  manager: BackgroundTaskManager | undefined,
  memory: RuntimeData['memory'],
  action: { readonly runId: string; readonly toolCallId: string }
): Promise<BackgroundTask | undefined> {
  if (!manager) {
    return undefined;
  }
  if (!memory) {
    throw new Error('Background decisions require the original root memory scope.');
  }
  const { tasks } = await manager.listTasks({
    resourceId: memory.resourceId,
    runId: action.runId,
    threadId: memory.threadId,
  });
  const matches = tasks.filter((task) => task.toolCallId === action.toolCallId);
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length !== 1 || matches[0]?.status !== 'suspended') {
    throw new Error('The background decision is stale or ambiguous.');
  }
  return matches[0];
}

async function readBackgroundTerminal(
  events: AsyncIterable<Record<string, unknown>>,
  emit: (event: unknown) => void
): Promise<string | undefined> {
  for await (const event of events) {
    emit(event);
    const type = String(event['type']);
    if (
      [
        'background-task-completed',
        'background-task-failed',
        'background-task-suspended',
        'background-task-cancelled',
      ].includes(type)
    ) {
      return type;
    }
  }
  return undefined;
}

/** Reconstruct the public native executor; consume its events before parent inference. */
export function createBackgroundResumeStream(params: {
  readonly task: BackgroundTask;
  readonly runtime: MastraAgentRuntime;
  readonly memory: MastraMemory;
  readonly resumeData: unknown;
  readonly options: BrainstrikeAgentStreamOptions;
  readonly attachParent: (
    stream: Parameters<typeof attachAbortedTurnMessageList>[1]
  ) => Promise<void>;
}): { readonly fullStream: ReadableStream<unknown>; getFullOutput(): Promise<void> } {
  const completion = Promise.withResolvers<void>();
  // The consumer joins this promise at the native terminal; retain early failures.
  completion.promise.catch(() => {});
  const fullStream = new ReadableStream<unknown>({
    async start(controller) {
      const { task, runtime, memory, options } = params;
      const manager = runtime.backgroundTaskManager;
      const watching = new AbortController();
      let deliveryError: unknown;
      const executionSettled = Promise.withResolvers<void>();
      try {
        if (!(manager && task.threadId && task.resourceId)) {
          throw new Error('Background resume has no native owner.');
        }
        const tools = await runtime.agent.getToolsForExecution({
          methodType: 'stream',
          resourceId: task.resourceId,
          runId: task.runId,
          threadId: task.threadId,
          ...(options.delegation ? { delegation: options.delegation } : {}),
          outputWriter: async (chunk: unknown) => {
            controller.enqueue(chunk);
          },
        });
        const execute = tools[task.toolName]?.execute;
        if (!execute) {
          throw new Error('The original background executor is unavailable.');
        }
        manager.registerTaskContext(task.id, {
          executor: {
            execute: async (args, nativeOptions) => {
              let output: unknown;
              let failure: unknown;
              try {
                output = await execute(args, {
                  messages: [],
                  outputWriter: async (chunk: unknown) => {
                    controller.enqueue(chunk);
                  },
                  toolCallId: task.toolCallId,
                  ...(nativeOptions?.abortSignal ? { abortSignal: nativeOptions.abortSignal } : {}),
                  ...(nativeOptions?.resumeData === undefined
                    ? {}
                    : { resumeData: nativeOptions.resumeData }),
                  ...(nativeOptions?.suspend ? { suspend: nativeOptions.suspend } : {}),
                });
                return output;
              } catch (error) {
                failure = error;
                throw error;
              } finally {
                // Native child resume mutates its invocation context to the leaf
                // call. The host join belongs to this original dispatch address.
                try {
                  await options.hooks?.afterToolCall?.({
                    context: { toolCallId: task.toolCallId },
                    input: args,
                    output,
                    toolName: task.toolName,
                    ...(failure === undefined ? {} : { error: failure }),
                  });
                } finally {
                  executionSettled.resolve();
                }
              }
            },
          },
          onResult: async (result) => {
            try {
              await saveBackgroundResult(memory, task, result);
              await requireBackgroundResultDelivery(await manager.getStorage()).markResultDelivered(
                task.id
              );
            } catch (error) {
              deliveryError = error;
              watching.abort();
              throw error;
            }
          },
        });
        const events = manager.stream({
          abortSignal: options.abortSignal
            ? AbortSignal.any([watching.signal, options.abortSignal])
            : watching.signal,
          taskId: task.id,
        });
        options.abortSignal?.throwIfAborted();
        await manager.resume(task.id, params.resumeData);
        const terminal = await readBackgroundTerminal(events, (event) => controller.enqueue(event));
        if (deliveryError !== undefined) {
          throw deliveryError;
        }
        options.abortSignal?.throwIfAborted();
        if (!terminal) {
          throw new Error('Background resume ended before a terminal task state.');
        }
        if (terminal === 'background-task-suspended') {
          // A new decision is not a returned result. Join the native snapshot
          // before closing this leg, without starting another parent inference.
          await executionSettled.promise;
          await manager.shutdown();
          completion.resolve();
          controller.close();
          return;
        }
        watching.abort();
        // Native result injection above is joined before its terminal event.
        const parent = await runtime.agent.stream([], {
          ...options,
          context: [
            {
              content: `Background invocation ${task.toolCallId} has returned. Use its saved outcome; do not execute it again.`,
              role: 'user',
            },
          ],
        } as AgentStreamOptions);
        await params.attachParent(parent);
        for await (const chunk of parent.fullStream) {
          controller.enqueue(chunk);
        }
        await parent.getFullOutput();
        completion.resolve();
        controller.close();
      } catch (error) {
        completion.reject(error);
        controller.error(error);
      } finally {
        watching.abort();
      }
    },
  });
  return { fullStream, getFullOutput: () => completion.promise };
}
