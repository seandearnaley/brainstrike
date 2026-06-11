/**
 * Local runtime adapter for browser-based LLM inference.
 * The app shell injects the concrete backend so shared UI does not depend on
 * the assistant runtime implementation package.
 */
import type { ChatModelAdapter, ChatModelRunResult } from '@assistant-ui/react';
import type {
  AssistantRunEventKind,
  AssistantRunEventMetadata,
  AssistantRunEventStatus,
  LocalLlmBackend,
  LocalLlmBackendFactory,
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmMessage,
  LocalLlmToolCall,
} from '@brainstrike/assistant-contract';
import { acquireBackgroundWorkPauseReason } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import {
  type AssistantContentPart,
  type AssistantDataContentPart,
  type AssistantToolCallContentPart,
  buildAssistantContentParts,
  createLocalRunEvent,
  createRunEventPart,
  createToolCallPart,
  createToolCallParts,
  drainPendingUpdate,
  mergeToolCallParts,
} from './local-runtime-content-parts';
import {
  createDesktopGenerationOptions,
  createGeneratingMessage,
  createReadyMessage,
  getDesktopLlmHost,
  handleDesktopProgressEvent,
  type LocalRuntimeLoadingProgressCallback,
} from './local-runtime-desktop-host';
import { convertMessages } from './local-runtime-message-conversion';
import {
  buildLocalToolDefinitions,
  buildLocalToolUnavailableReason,
  type LocalRuntimeToolConfig,
} from './local-runtime-tool-definitions';

export type { LocalRuntimeToolConfig } from './local-runtime-tool-definitions';

const logger = createLogger('LocalRuntimeAdapter');

type LocalLlmStreamHandlers = NonNullable<LocalLlmGenerationOptions['stream']>;

let backendInstance: LocalLlmBackend | null = null;
let backendInstancePromise: Promise<LocalLlmBackend> | null = null;
let backendFactory: LocalLlmBackendFactory | null = null;
let currentModelId: string | null = null;
const warmedDesktopModelIds = new Set<string>();
const desktopWarmupPromises = new Map<string, Promise<void>>();
let backendStateLock: Promise<void> = Promise.resolve();
let localGenerationQueue: Promise<void> | null = null;
// Track disposal lifecycle to prevent race conditions
// - requested: disposal has been requested (blocks new inits from returning soon-to-be-disposed instances)
// - inProgress: disposal is actively running (prevents new init while cleanup happens)
// - promise: Promise that resolves when disposal completes, allowing callers to wait
const disposalState: {
  requested: boolean;
  inProgress: boolean;
  promise: Promise<void> | null;
} = { requested: false, inProgress: false, promise: null };

/**
 * Get or create the LocalLlmBackend singleton.
 * Uses promise-based caching to prevent race conditions when called concurrently.
 * The concrete backend is injected by app-shell. UI code must not import the
 * agent runtime package directly because this package is shared foundation.
 *
 * Handles edge cases:
 * - disposeLocalBackend() called during initialization: checks flag and disposes new instance
 * - getBackend() called during disposal: waits for disposal to complete first
 */
async function getBackend(
  loadBackend: LocalLlmBackendFactory | undefined
): Promise<LocalLlmBackend> {
  // If disposal is in progress, wait for it to complete before creating new instance
  // This prevents returning an instance that's about to be disposed
  if (disposalState.inProgress && disposalState.promise) {
    try {
      await disposalState.promise;
    } catch {
      // Disposal failed - that's ok, we'll create a fresh instance
    }
  }

  // Fast path: already initialized and not in disposal process
  if (backendInstance && !disposalState.requested && !disposalState.inProgress) {
    return backendInstance;
  }

  if (loadBackend) {
    backendFactory = loadBackend;
  }
  if (!backendFactory) {
    throw new Error('Local LLM backend factory was not provided by the application shell.');
  }
  const resolvedBackendFactory = backendFactory;

  // Race condition protection: use promise-based cache
  // If initialization is in progress, wait for it instead of creating another instance
  if (!backendInstancePromise) {
    backendInstancePromise = (async () => {
      try {
        const instance = await resolvedBackendFactory();

        // Check if disposal was requested while we were initializing
        if (disposalState.requested) {
          // Disposal was requested - clean up the instance we just created
          await instance.dispose();
          // Clear the promise so future getBackend() calls create a fresh instance
          backendInstancePromise = null;
          throw new Error('Backend initialization cancelled: disposal was requested');
        }

        backendInstance = instance;
        return instance;
      } catch (error) {
        // Clear stale promise on any initialization failure to allow retry
        backendInstancePromise = null;
        throw error;
      }
    })();
  }

  return backendInstancePromise;
}

export interface LocalRuntimeAdapterOptions {
  completeRuntimeData?: (
    runtimeData: Record<string, unknown> | undefined,
    status: 'cancelled' | 'completed' | 'failed',
    error?: string
  ) => Promise<void> | void;
  loadBackend?: LocalLlmBackendFactory;
  modelId: string;
  /**
   * Called for each streamed snapshot while local generation is in flight.
   * Used as a liveness signal (e.g. renewing foreground-activity leases).
   * Hook failures are logged and must never break the stream.
   */
  onActivity?: () => void;
  onError?: (error: Error) => void;
  onLoadingProgress?: LocalRuntimeLoadingProgressCallback;
  /**
   * Called once per completed turn with the final generation's token counts.
   * Maps Gemma's tokenizer-true usage to the shared inputTokens/outputTokens
   * shape used by the context usage store.
   * For multi-round tool-call turns, only the LAST generation's usage is
   * reported — its prompt reflects the accumulated context including tool
   * results, consistent with the one-turn-lag meter semantics.
   */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  prepareRuntimeData?: () => Promise<Record<string, unknown> | undefined>;
  runtimeData?: Record<string, unknown>;
  thinkingEnabled?: boolean;
  tools?: readonly LocalRuntimeToolConfig[];
}

async function yieldToUi(): Promise<void> {
  await Promise.resolve();
}

async function executeToolCalls(
  toolCalls: readonly LocalLlmToolCall[],
  runtimeData: Record<string, unknown> | undefined
): Promise<{
  messages: LocalLlmMessage[];
  parts: AssistantToolCallContentPart[];
}> {
  const toolExecutor = getToolExecutor();
  if (typeof toolExecutor?.execute !== 'function') {
    throw new Error('Local tool execution is unavailable in this environment.');
  }

  const toolMessages: LocalLlmMessage[] = [];
  const toolParts: AssistantToolCallContentPart[] = [];

  for (const toolCall of toolCalls) {
    let parsedArgs: unknown = {};
    try {
      parsedArgs = JSON.parse(toolCall.function.arguments) as unknown;
    } catch {
      parsedArgs = {};
    }

    const execution = await toolExecutor.execute(toolCall.function.name, parsedArgs, runtimeData);
    const responsePayload = execution.success
      ? execution.result
      : {
          error: execution.error ?? 'Tool execution failed.',
        };

    toolMessages.push({
      role: 'tool',
      content: '',
      toolCallId: toolCall.id,
      toolResponses: [
        {
          name: toolCall.function.name,
          response: responsePayload,
        },
      ],
    });
    toolParts.push(
      createToolCallPart(toolCall, {
        result: execution.success ? execution.result : execution.error,
        isError: !execution.success,
      })
    );
  }

  return {
    messages: toolMessages,
    parts: toolParts,
  };
}

let desktopHostStatusSyncInstalled = false;
let desktopHostStatusUnsubscribe: (() => void) | null = null;
let desktopHostStatusSource: object | null = null;
const desktopWarmupRequestIds = new Map<string, string>();

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

async function waitForAbortableDesktopWarmup(
  warmupPromise: Promise<void>,
  abortSignal: AbortSignal | undefined
): Promise<void> {
  if (!abortSignal) {
    await warmupPromise;
    return;
  }

  if (abortSignal.aborted) {
    throw createAbortError();
  }

  await new Promise<void>((resolve, reject) => {
    const handleAbort = () => {
      reject(createAbortError());
    };

    abortSignal.addEventListener('abort', handleAbort, { once: true });
    warmupPromise.then(
      () => {
        abortSignal.removeEventListener('abort', handleAbort);
        resolve();
      },
      (error: unknown) => {
        abortSignal.removeEventListener('abort', handleAbort);
        reject(error);
      }
    );
  });
}

async function withBackendStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const previousLock = backendStateLock;
  let releaseLock!: () => void;
  backendStateLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;
  try {
    return await operation();
  } finally {
    releaseLock();
  }
}

function acquireLocalGenerationSlot(): (() => void) | Promise<() => void> {
  if (disposalState.inProgress && disposalState.promise) {
    return disposalState.promise.then(() => acquireLocalGenerationSlot());
  }
  const previousQueue = localGenerationQueue;
  let releaseSlot!: () => void;
  const currentSlot = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });
  const releaseCurrentSlot = () => {
    releaseSlot();
    if (localGenerationQueue === currentSlot) {
      localGenerationQueue = null;
    }
  };
  localGenerationQueue = previousQueue ? previousQueue.then(() => currentSlot) : currentSlot;
  if (!previousQueue) {
    return releaseCurrentSlot;
  }
  return previousQueue.then(() => releaseCurrentSlot);
}

function ensureDesktopHostStateSync(
  llmHost: NonNullable<ReturnType<typeof getDesktopLlmHost>>
): void {
  if (!llmHost.onStatus) {
    return;
  }
  if (desktopHostStatusSource === llmHost && desktopHostStatusSyncInstalled) {
    return;
  }

  desktopHostStatusUnsubscribe?.();
  desktopHostStatusSource = llmHost;
  desktopHostStatusUnsubscribe = llmHost.onStatus((status) => {
    if (status.state === 'error' || status.state === 'stopped') {
      warmedDesktopModelIds.clear();
      desktopWarmupPromises.clear();
    }
  });
  desktopHostStatusSyncInstalled = true;
}

async function ensureDesktopModelWarmed(
  llmHost: NonNullable<ReturnType<typeof getDesktopLlmHost>>,
  modelId: string,
  onLoadingProgress: LocalRuntimeAdapterOptions['onLoadingProgress'],
  abortSignal?: AbortSignal
): Promise<void> {
  if (warmedDesktopModelIds.has(modelId)) {
    return;
  }

  const existingWarmup = desktopWarmupPromises.get(modelId);
  if (existingWarmup) {
    await waitForAbortableDesktopWarmup(existingWarmup, abortSignal);
    return;
  }

  let currentWarmupPromise: Promise<void> | null = null;
  const nextWarmupPromise = (async () => {
    const warmupRequestId = crypto.randomUUID();
    desktopWarmupRequestIds.set(modelId, warmupRequestId);
    onLoadingProgress?.({
      stage: 'loading',
      progress: 0,
      message: 'Starting local model host...',
    });
    const unsubscribeWarmupProgress = llmHost.onProgress?.((progress: unknown) => {
      handleDesktopProgressEvent(
        progress,
        warmupRequestId,
        onLoadingProgress,
        () => {},
        () => {}
      );
    });
    try {
      if (!llmHost.warmup) {
        throw new Error('Desktop llm host does not implement warmup.');
      }
      await llmHost.warmup({ modelId, requestId: warmupRequestId });
      warmedDesktopModelIds.add(modelId);
    } finally {
      if (desktopWarmupRequestIds.get(modelId) === warmupRequestId) {
        desktopWarmupRequestIds.delete(modelId);
      }
      unsubscribeWarmupProgress?.();
      if (currentWarmupPromise && desktopWarmupPromises.get(modelId) === currentWarmupPromise) {
        desktopWarmupPromises.delete(modelId);
      }
    }
  })();
  currentWarmupPromise = nextWarmupPromise;

  desktopWarmupPromises.set(modelId, nextWarmupPromise);
  await waitForAbortableDesktopWarmup(nextWarmupPromise, abortSignal);
}

function getToolExecutor(): {
  execute?: (
    toolId: string,
    input: unknown,
    runtimeData?: Record<string, unknown>
  ) => Promise<{
    durationMs: number;
    error?: string;
    result?: unknown;
    success: boolean;
  }>;
} | null {
  const toolWindow = window as Window & {
    tools?: {
      execute?: (
        toolId: string,
        input: unknown,
        runtimeData?: Record<string, unknown>
      ) => Promise<{
        durationMs: number;
        error?: string;
        result?: unknown;
        success: boolean;
      }>;
    };
  };
  return toolWindow.tools ?? null;
}

/**
 * Create a ChatModelAdapter for local browser-based LLM inference.
 * This adapter uses LocalLlmBackend which runs entirely in the browser
 * through the browser WebGPU runtime.
 */
export function createLocalModelAdapter(options: LocalRuntimeAdapterOptions): ChatModelAdapter {
  const {
    completeRuntimeData,
    loadBackend,
    modelId,
    thinkingEnabled,
    onActivity,
    onLoadingProgress: onLoadingProgressOption,
    onError,
    onUsage,
    prepareRuntimeData,
    runtimeData,
    tools,
  } = options;
  const notifyActivity = (): void => {
    try {
      onActivity?.();
    } catch (callbackError) {
      // A liveness hook failure must never break local generation.
      logger.warn('Local runtime onActivity callback failed', { error: callbackError });
    }
  };
  // Loading/warmup progress must renew the liveness hook too: the foreground
  // lease is acquired before the model loads, and a first download can outlive
  // the 5-minute foreground-activity fuse. Without renewal here, background
  // indexing would resume mid-run while the model is still downloading.
  const onLoadingProgress: NonNullable<LocalRuntimeAdapterOptions['onLoadingProgress']> = (
    progress
  ) => {
    notifyActivity();
    onLoadingProgressOption?.(progress);
  };
  const toolExecutor = getToolExecutor();
  const toolDefinitions = buildLocalToolDefinitions(
    tools,
    typeof toolExecutor?.execute === 'function'
  );

  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Generator handles init, conversion, streaming, and errors
    async *run({ messages, abortSignal }) {
      const releaseBackgroundPause = await acquireBackgroundWorkPauseReason('local-llm');
      const generationSlot = acquireLocalGenerationSlot();
      const releaseGenerationSlot =
        typeof generationSlot === 'function' ? generationSlot : await generationSlot;
      let preparedRuntimeData: Record<string, unknown> | undefined;
      const runEventParts: AssistantDataContentPart[] = [];
      const appendRunEvent = (
        kind: AssistantRunEventKind,
        status: AssistantRunEventStatus,
        label: string,
        metadata?: AssistantRunEventMetadata
      ): void => {
        runEventParts.push(createRunEventPart(createLocalRunEvent(kind, status, label, metadata)));
      };
      try {
        preparedRuntimeData = prepareRuntimeData ? await prepareRuntimeData() : runtimeData;
        appendRunEvent('run.started', 'running', 'Local assistant run started', {
          modelId,
          runtime: 'local',
        });
        // Convert messages to LocalLlmMessage format
        const localMessages = convertMessages(messages);

        if (localMessages.length === 0) {
          appendRunEvent('run.finished', 'completed', 'Local assistant run completed');
          await completeRuntimeData?.(preparedRuntimeData, 'completed');
          yield {
            content: buildAssistantContentParts(
              undefined,
              'No message content to process.',
              [],
              runEventParts
            ),
          };
          return;
        }
        yield {
          content: buildAssistantContentParts(undefined, '', [], runEventParts),
        };

        const generationOptions: LocalLlmGenerationOptions = {
          maxNewTokens: 1024,
          temperature: 0.7,
          signal: abortSignal,
          thinking: {
            enabled: thinkingEnabled ?? true,
          },
          ...(toolDefinitions ? { tools: toolDefinitions } : {}),
        };

        const llmHost = getDesktopLlmHost();
        if (llmHost) {
          ensureDesktopHostStateSync(llmHost);
        }
        if (llmHost?.generate) {
          appendRunEvent('run.step.started', 'running', 'Local model warmup started', {
            modelId,
          });
          yield {
            content: buildAssistantContentParts(undefined, '', [], runEventParts),
          };
          await ensureDesktopModelWarmed(llmHost, modelId, onLoadingProgress, abortSignal);
          appendRunEvent('run.step.finished', 'completed', 'Local model warmup completed', {
            modelId,
          });
          yield {
            content: buildAssistantContentParts(undefined, '', [], runEventParts),
          };
        }
        if (!llmHost?.generate) {
          appendRunEvent('run.step.started', 'running', 'Local model loading started', {
            modelId,
          });
          yield {
            content: buildAssistantContentParts(undefined, '', [], runEventParts),
          };
          await withBackendStateLock(async () => {
            const backend = await getBackend(loadBackend);
            if (!backend.isReady() || currentModelId !== modelId) {
              await backend.initialize({
                modelId,
                ...(onLoadingProgress ? { onProgress: onLoadingProgress } : {}),
              });
              currentModelId = modelId;
            }
          });
          appendRunEvent('run.step.finished', 'completed', 'Local model loading completed', {
            modelId,
          });
          yield {
            content: buildAssistantContentParts(undefined, '', [], runEventParts),
          };
        }

        currentModelId = modelId;
        const conversationMessages = [...localMessages];
        const maxToolRounds = 4;
        let accumulatedToolParts: AssistantToolCallContentPart[] = [];

        for (let toolRound = 0; toolRound < maxToolRounds; toolRound += 1) {
          appendRunEvent('run.step.started', 'running', 'Local generation started', {
            round: toolRound + 1,
          });
          yield {
            content: buildAssistantContentParts(undefined, '', accumulatedToolParts, runEventParts),
          };
          let result: LocalLlmGenerationResult;
          let streamedReasoningText = '';
          let streamedText = '';
          let deliveredStreamSnapshot = false;
          let pendingUpdate: ChatModelRunResult | null = null;
          let queueResolver: (() => void) | null = null;
          const notifyQueue = () => {
            queueResolver?.();
            queueResolver = null;
          };
          const enqueueUpdate = (content: AssistantContentPart[]) => {
            notifyActivity();
            pendingUpdate = { content };
            notifyQueue();
          };
          const waitForQueue = async () => {
            if (pendingUpdate) {
              return;
            }
            await new Promise<void>((resolve) => {
              queueResolver = resolve;
            });
          };
          const updateReasoningSnapshot = (reasoningText: string) => {
            streamedReasoningText = reasoningText;
            enqueueUpdate(
              buildAssistantContentParts(streamedReasoningText, streamedText, [], runEventParts)
            );
          };
          const updateTextSnapshot = (text: string) => {
            streamedText = text;
            deliveredStreamSnapshot = true;
            enqueueUpdate(
              buildAssistantContentParts(streamedReasoningText, streamedText, [], runEventParts)
            );
          };

          if (llmHost?.generate) {
            const requestId = crypto.randomUUID();
            if (abortSignal.aborted) {
              throw new DOMException('The operation was aborted.', 'AbortError');
            }
            const unsubscribeProgress = llmHost.onProgress?.((progress: unknown) => {
              handleDesktopProgressEvent(
                progress,
                requestId,
                onLoadingProgress,
                updateReasoningSnapshot,
                updateTextSnapshot
              );
            });
            const handleAbort = () => {
              void llmHost.cancel?.(requestId);
            };
            abortSignal.addEventListener('abort', handleAbort, { once: true });
            try {
              const generatePromise = llmHost.generate({
                requestId,
                modelId,
                messages: conversationMessages,
                options: createDesktopGenerationOptions(generationOptions),
              });
              while (true) {
                const settled = await Promise.race([
                  generatePromise.then((value: LocalLlmGenerationResult) => ({
                    type: 'result' as const,
                    value,
                  })),
                  waitForQueue().then(() => ({ type: 'queue' as const })),
                ]);
                if (settled.type === 'queue') {
                  const drained = drainPendingUpdate(pendingUpdate);
                  pendingUpdate = drained.nextPendingUpdate;
                  if (drained.update) {
                    yield drained.update;
                    await yieldToUi();
                  }
                  continue;
                }
                const drained = drainPendingUpdate(pendingUpdate);
                pendingUpdate = drained.nextPendingUpdate;
                if (drained.update) {
                  yield drained.update;
                  await yieldToUi();
                }
                result = settled.value;
                break;
              }
            } finally {
              abortSignal.removeEventListener('abort', handleAbort);
              unsubscribeProgress?.();
            }
          } else {
            const backend = await getBackend(loadBackend);
            const generatePromise = backend.generate(conversationMessages, {
              ...generationOptions,
              stream: {
                onStageChange: (
                  stage: NonNullable<LocalLlmStreamHandlers['onStageChange']> extends (
                    value: infer T
                  ) => void
                    ? T
                    : never
                ) => {
                  onLoadingProgress?.({
                    stage: 'generating',
                    progress: 0,
                    message: createGeneratingMessage(stage),
                  });
                },
                onReasoningSnapshot: updateReasoningSnapshot,
                onTextSnapshot: updateTextSnapshot,
              },
            });
            while (true) {
              const settled = await Promise.race([
                generatePromise.then((value: LocalLlmGenerationResult) => ({
                  type: 'result' as const,
                  value,
                })),
                waitForQueue().then(() => ({ type: 'queue' as const })),
              ]);
              if (settled.type === 'queue') {
                const drained = drainPendingUpdate(pendingUpdate);
                pendingUpdate = drained.nextPendingUpdate;
                if (drained.update) {
                  yield drained.update;
                  await yieldToUi();
                }
                continue;
              }
              const drained = drainPendingUpdate(pendingUpdate);
              pendingUpdate = drained.nextPendingUpdate;
              if (drained.update) {
                yield drained.update;
                await yieldToUi();
              }
              result = settled.value;
              break;
            }
          }

          const toolCallParts = createToolCallParts(result);
          accumulatedToolParts = mergeToolCallParts(accumulatedToolParts, toolCallParts);
          const finalContent = buildAssistantContentParts(
            result.reasoningText,
            result.text,
            accumulatedToolParts,
            runEventParts
          );
          if (!deliveredStreamSnapshot || accumulatedToolParts.length > 0) {
            yield {
              content: finalContent,
            };
          }

          if (!(result.toolCalls && result.toolCalls.length > 0)) {
            appendRunEvent('run.step.finished', 'completed', 'Local generation completed', {
              round: toolRound + 1,
            });
            appendRunEvent('run.finished', 'completed', 'Local assistant run completed');
            onLoadingProgress?.({
              stage: 'ready',
              progress: 100,
              message: createReadyMessage(),
            });
            if (result.usage) {
              onUsage?.({
                inputTokens: result.usage.promptTokens,
                outputTokens: result.usage.completionTokens,
              });
            }
            await completeRuntimeData?.(preparedRuntimeData, 'completed');
            yield {
              content: buildAssistantContentParts(
                result.reasoningText,
                result.text,
                accumulatedToolParts,
                runEventParts
              ),
            };
            return;
          }

          if (!toolDefinitions?.length) {
            const reason = buildLocalToolUnavailableReason(
              tools,
              typeof toolExecutor?.execute === 'function'
            );
            throw new Error(
              `Local model returned a tool call, but no runnable local tools are configured: ${reason}`
            );
          }

          onLoadingProgress?.({
            stage: 'generating',
            progress: 0,
            message: 'Running tool...',
          });
          appendRunEvent('tool.started', 'running', 'Local tool call started', {
            count: result.toolCalls.length,
            round: toolRound + 1,
          });
          const executedTools = await executeToolCalls(result.toolCalls, preparedRuntimeData);
          accumulatedToolParts = mergeToolCallParts(accumulatedToolParts, executedTools.parts);
          appendRunEvent('tool.completed', 'completed', 'Local tool call completed', {
            count: executedTools.parts.length,
            round: toolRound + 1,
          });
          appendRunEvent('run.step.finished', 'completed', 'Local generation step completed', {
            round: toolRound + 1,
          });
          yield {
            content: buildAssistantContentParts(
              result.reasoningText,
              result.text,
              accumulatedToolParts,
              runEventParts
            ),
          };

          conversationMessages.push({
            role: 'assistant',
            content: result.text,
            toolCalls: result.toolCalls,
          });
          conversationMessages.push(...executedTools.messages);
        }

        throw new Error('Local tool call loop exceeded the maximum number of iterations.');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check for abort
        if (error instanceof DOMException && error.name === 'AbortError') {
          appendRunEvent('run.cancelled', 'cancelled', 'Local assistant run cancelled');
          onLoadingProgress?.({
            stage: 'ready',
            progress: 100,
            message: 'Generation stopped.',
          });
          await completeRuntimeData?.(preparedRuntimeData, 'cancelled', errorMessage);
          yield {
            content: buildAssistantContentParts(
              undefined,
              'Generation cancelled.',
              [],
              runEventParts
            ),
          };
          return;
        }

        appendRunEvent('run.failed', 'failed', 'Local assistant run failed');
        await completeRuntimeData?.(preparedRuntimeData, 'failed', errorMessage);
        onError?.(error instanceof Error ? error : new Error(errorMessage));

        yield {
          content: buildAssistantContentParts(
            undefined,
            `Local model error: ${errorMessage}. Make sure the model is downloaded and WebGPU is available.`,
            [],
            runEventParts
          ),
        };
      } finally {
        releaseGenerationSlot();
        releaseBackgroundPause();
      }
    },
  };
}

/**
 * Dispose the backend and free resources.
 * Call this when the local provider is no longer needed.
 *
 * Handles race conditions:
 * - If initialization is in progress, waits and disposes the new instance
 * - If getBackend() is called during disposal, it waits for disposal to complete
 */
export async function disposeLocalBackend(): Promise<void> {
  // Prevent re-entry if disposal is already in progress
  if (disposalState.inProgress) {
    // Wait for existing disposal to complete
    if (disposalState.promise) {
      return disposalState.promise;
    }
    return;
  }

  // Signal disposal is starting
  disposalState.requested = true;
  disposalState.inProgress = true;
  const pendingGenerationQueue = localGenerationQueue;

  // Create a promise that callers can wait on
  disposalState.promise = (async () => {
    try {
      if (pendingGenerationQueue) {
        await pendingGenerationQueue;
        if (localGenerationQueue === pendingGenerationQueue) {
          localGenerationQueue = null;
        }
      }
      // Wait for any pending initialization to complete before disposing
      if (backendInstancePromise) {
        try {
          await backendInstancePromise;
        } catch {
          // Initialization may have failed or been cancelled - that's ok
        }
      }

      // Now safely dispose the instance
      if (backendInstance) {
        await backendInstance.dispose();
      }
    } finally {
      // Reset all state - must happen even if disposal fails
      backendInstance = null;
      backendInstancePromise = null;
      currentModelId = null;
      desktopHostStatusSyncInstalled = false;
      desktopHostStatusUnsubscribe?.();
      desktopHostStatusUnsubscribe = null;
      desktopHostStatusSource = null;
      warmedDesktopModelIds.clear();
      desktopWarmupPromises.clear();
      backendStateLock = Promise.resolve();
      disposalState.requested = false;
      disposalState.inProgress = false;
      disposalState.promise = null;
    }
  })();

  return disposalState.promise;
}

/**
 * Check if local inference is available in the current environment.
 */
export function isLocalInferenceAvailable(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return 'gpu' in navigator;
}

/**
 * Get the best available device for local inference.
 */
export function getBestInferenceDevice(): 'webgpu' | null {
  if (typeof window === 'undefined') {
    return null;
  }

  if ('gpu' in navigator) {
    return 'webgpu';
  }

  return null;
}
