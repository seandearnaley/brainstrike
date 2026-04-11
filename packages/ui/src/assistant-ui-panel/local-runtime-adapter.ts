/**
 * Local runtime adapter for browser-based LLM inference.
 * Uses LocalLlmBackend from @brainstrike/agent/local-llm for in-browser inference
 * with transformers.js (ONNX models via WebGPU/WASM).
 */
import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ChatModelRunResult,
} from '@assistant-ui/react';
import type {
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmJsonSchema,
  LocalLlmMessage,
  LocalLlmToolCall,
  LocalLlmToolDefinition,
} from '@brainstrike/agent/local-llm';

/**
 * JSON types compatible with assistant-ui's ReadonlyJSONObject.
 * Defined locally since assistant-stream is a transitive dependency.
 */
type JsonValue = null | string | number | boolean | JsonObject | JsonArray;
interface JsonObject {
  readonly [key: string]: JsonValue;
}
type JsonArray = readonly JsonValue[];

interface AssistantTextContentPart {
  text: string;
  type: 'text';
}

interface AssistantReasoningContentPart {
  text: string;
  type: 'reasoning';
}

interface AssistantToolCallContentPart {
  args: JsonObject;
  argsText: string;
  isError?: boolean;
  result?: unknown;
  toolCallId: string;
  toolName: string;
  type: 'tool-call';
}
type AssistantContentPart =
  | AssistantReasoningContentPart
  | AssistantTextContentPart
  | AssistantToolCallContentPart;

/**
 * Type guard to validate that a parsed JSON value is a valid JsonObject.
 * Prevents prototype pollution and ensures the value is a plain object.
 */
function isJsonObject(value: unknown): value is JsonObject {
  // Must be a non-null object
  if (!value || typeof value !== 'object') {
    return false;
  }

  // Must not be an array or null (typeof null === 'object')
  if (Array.isArray(value) || value === null) {
    return false;
  }

  // Prototype pollution prevention: only accept plain objects
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeRequiredSchemaEntries(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function normalizeSchemaItems(value: unknown): LocalLlmJsonSchema | undefined {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return;
  }

  return {
    type: value['type'],
    ...(typeof value['description'] === 'string' ? { description: value['description'] } : {}),
  };
}

function normalizeSchemaProperty(value: unknown): LocalLlmJsonSchema | undefined {
  if (!isRecord(value) || typeof value['type'] !== 'string') {
    return;
  }

  const normalized: LocalLlmJsonSchema = {
    type: value['type'],
  };
  if (typeof value['description'] === 'string') {
    normalized.description = value['description'];
  }
  if (Array.isArray(value['enum']) && value['enum'].every((entry) => typeof entry === 'string')) {
    normalized.enum = value['enum'];
  }
  const items = normalizeSchemaItems(value['items']);
  if (items) {
    normalized.items = items;
  }
  return normalized;
}

function normalizeSchemaProperties(value: unknown): Record<string, LocalLlmJsonSchema> | undefined {
  if (!isRecord(value)) {
    return;
  }

  const properties = Object.entries(value).reduce<Record<string, LocalLlmJsonSchema>>(
    (result, [key, propertyValue]) => {
      const normalized = normalizeSchemaProperty(propertyValue);
      if (normalized) {
        result[key] = normalized;
      }
      return result;
    },
    {}
  );

  return Object.keys(properties).length > 0 ? properties : undefined;
}

function normalizeJsonSchema(value: unknown): (LocalLlmJsonSchema & { type: 'object' }) | null {
  if (!isRecord(value) || value['type'] !== 'object') {
    return null;
  }

  const parameters: LocalLlmJsonSchema & { type: 'object' } = {
    type: 'object',
  };
  const properties = normalizeSchemaProperties(value['properties']);
  if (properties) {
    parameters.properties = properties;
  }
  const required = normalizeRequiredSchemaEntries(value['required']);
  if (required) {
    parameters.required = required;
  }

  return parameters;
}

function buildLocalToolDefinitions(
  tools: readonly LocalRuntimeToolConfig[] | undefined,
  canExecuteTools: boolean
): LocalLlmToolDefinition[] | undefined {
  if (!(tools && tools.length > 0 && canExecuteTools)) {
    return;
  }

  const definitions = tools
    .filter((tool) => tool.enabled !== false && tool.isLocalRuntimeRunnable)
    .map((tool) => {
      const parameters = normalizeJsonSchema(tool.inputSchema);
      if (!parameters) {
        return null;
      }
      return {
        type: 'function' as const,
        function: {
          name: tool.id,
          description: tool.description ?? tool.id,
          parameters,
        },
      };
    })
    .filter((definition): definition is LocalLlmToolDefinition => Boolean(definition));

  return definitions.length > 0 ? definitions : undefined;
}

type LocalLlmBackendProgress = NonNullable<LocalRuntimeAdapterOptions['onLoadingProgress']>;
type LocalLlmStreamHandlers = NonNullable<LocalLlmGenerationOptions['stream']>;

interface LocalLlmBackendInstance {
  dispose(): Promise<void>;
  generate(
    messages: LocalLlmMessage[],
    options?: LocalLlmGenerationOptions
  ): Promise<LocalLlmGenerationResult>;
  initialize(config: { modelId: string; onProgress?: LocalLlmBackendProgress }): Promise<void>;
  isReady(): boolean;
}

let backendInstance: LocalLlmBackendInstance | null = null;
let backendInstancePromise: Promise<LocalLlmBackendInstance> | null = null;
let currentModelId: string | null = null;
const warmedDesktopModelIds = new Set<string>();
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
 * Dynamically imports to avoid loading transformers.js until needed.
 *
 * Handles edge cases:
 * - disposeLocalBackend() called during initialization: checks flag and disposes new instance
 * - getBackend() called during disposal: waits for disposal to complete first
 */
async function getBackend(): Promise<LocalLlmBackendInstance> {
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

  // Race condition protection: use promise-based cache
  // If initialization is in progress, wait for it instead of creating another instance
  if (!backendInstancePromise) {
    backendInstancePromise = (async () => {
      try {
        // Dynamic import to avoid bundling transformers.js in non-local builds
        const { LocalLlmBackend } = await import('@brainstrike/agent/local-llm');
        const instance = new LocalLlmBackend() as LocalLlmBackendInstance;

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

/**
 * Convert assistant-ui ThreadMessage to LocalLlmMessage format
 */
function convertMessages(messages: ChatModelRunOptions['messages']): LocalLlmMessage[] {
  const result: LocalLlmMessage[] = [];

  for (const msg of messages) {
    // Extract text content from message parts
    const textContent = msg.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');

    if (textContent.trim().length === 0) {
      continue;
    }

    // Map assistant-ui roles to LocalLlmMessage roles
    const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system';

    result.push({
      role,
      content: textContent,
    });
  }

  return result;
}

export interface LocalRuntimeAdapterOptions {
  modelId: string;
  onError?: (error: Error) => void;
  onLoadingProgress?: (progress: {
    stage: 'downloading' | 'generating' | 'loading' | 'ready';
    progress: number;
    message: string;
    file?: string;
  }) => void;
  runtimeData?: Record<string, unknown>;
  thinkingEnabled?: boolean;
  tools?: readonly LocalRuntimeToolConfig[];
}

export interface LocalRuntimeToolConfig {
  description?: string;
  enabled?: boolean;
  id: string;
  inputSchema?: Record<string, unknown>;
  isLocalRuntimeRunnable?: boolean;
}

function createToolCallParts(result: LocalLlmGenerationResult): AssistantToolCallContentPart[] {
  if (!(result.toolCalls && result.toolCalls.length > 0)) {
    return [];
  }

  return result.toolCalls.map((toolCall: LocalLlmToolCall) => createToolCallPart(toolCall));
}

function createToolCallPart(
  toolCall: LocalLlmToolCall,
  overrides?: Pick<AssistantToolCallContentPart, 'isError' | 'result'>
): AssistantToolCallContentPart {
  let parsedArgs: JsonObject = {};
  try {
    const parsed: unknown = JSON.parse(toolCall.function.arguments);
    if (isJsonObject(parsed)) {
      parsedArgs = parsed;
    }
  } catch {
    // Malformed JSON - fall back to empty object while preserving argsText.
  }

  return {
    type: 'tool-call',
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    args: parsedArgs,
    argsText: toolCall.function.arguments,
    ...(overrides?.result !== undefined ? { result: overrides.result } : {}),
    ...(overrides?.isError !== undefined ? { isError: overrides.isError } : {}),
  };
}

async function yieldToUi(): Promise<void> {
  await Promise.resolve();
}

interface LlmHostProgressEvent {
  payload: {
    clientRequestId?: string;
    file?: string;
    kind?: 'loading' | 'reasoning' | 'stage' | 'text';
    message?: string;
    progress?: number;
    reasoningText?: string;
    text?: string;
  };
  requestId: string;
  type: 'progress';
}

function isLlmHostProgressEvent(value: unknown): value is LlmHostProgressEvent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as { type?: unknown; payload?: unknown; requestId?: unknown };
  return (
    candidate.type === 'progress' &&
    typeof candidate.requestId === 'string' &&
    Boolean(candidate.payload && typeof candidate.payload === 'object')
  );
}

function createGeneratingMessage(stage: string | undefined): string {
  return stage === 'reasoning' ? 'Thinking...' : 'Generating answer...';
}

function createReadyMessage(): string {
  return 'Response complete.';
}

function buildAssistantContentParts(
  reasoningText: string | undefined,
  text: string,
  toolCallParts: AssistantToolCallContentPart[]
): AssistantContentPart[] {
  return [
    ...(reasoningText?.trim() ? [{ type: 'reasoning', text: reasoningText.trim() } as const] : []),
    ...toolCallParts,
    ...(text.trim() ? [{ type: 'text', text } as const] : []),
  ];
}

function mergeToolCallParts(
  existingParts: readonly AssistantToolCallContentPart[],
  nextParts: readonly AssistantToolCallContentPart[]
): AssistantToolCallContentPart[] {
  if (nextParts.length === 0) {
    return [...existingParts];
  }

  const merged = new Map<string, AssistantToolCallContentPart>();
  for (const part of existingParts) {
    merged.set(part.toolCallId, part);
  }
  for (const part of nextParts) {
    merged.set(part.toolCallId, part);
  }
  return [...merged.values()];
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
      ? execution
      : {
          ...execution,
          result: execution.error ?? 'Tool execution failed.',
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

function getDesktopLlmHost(): {
  cancel?: (requestId: string) => Promise<void>;
  generate?: (payload: {
    requestId?: string;
    modelId: string;
    messages: LocalLlmMessage[];
    options?: LocalLlmGenerationOptions;
  }) => Promise<LocalLlmGenerationResult>;
  onProgress?: (callback: (progress: unknown) => void) => () => void;
  onStatus?: (callback: (status: { runtimeKind: 'llm-host'; state: string }) => void) => () => void;
  warmup?: (payload: { modelId: string; requestId?: string } | string) => Promise<void>;
} | null {
  const hostWindow = window as Window & {
    llmHost?: {
      cancel?: (requestId: string) => Promise<void>;
      generate?: (payload: {
        requestId?: string;
        modelId: string;
        messages: LocalLlmMessage[];
        options?: LocalLlmGenerationOptions;
      }) => Promise<LocalLlmGenerationResult>;
      onProgress?: (callback: (progress: unknown) => void) => () => void;
      onStatus?: (
        callback: (status: { runtimeKind: 'llm-host'; state: string }) => void
      ) => () => void;
      warmup?: (payload: { modelId: string; requestId?: string } | string) => Promise<void>;
    };
  };
  return hostWindow.llmHost ?? null;
}

let desktopHostStatusSyncInstalled = false;

function ensureDesktopHostStateSync(
  llmHost: NonNullable<ReturnType<typeof getDesktopLlmHost>>
): void {
  if (desktopHostStatusSyncInstalled || !llmHost.onStatus) {
    return;
  }
  llmHost.onStatus((status) => {
    if (status.state === 'error' || status.state === 'stopped') {
      warmedDesktopModelIds.clear();
    }
  });
  desktopHostStatusSyncInstalled = true;
}

function createDesktopGenerationOptions(
  options: LocalLlmGenerationOptions
): Omit<LocalLlmGenerationOptions, 'signal'> {
  const { signal: _signal, ...cloneableOptions } = options;
  return cloneableOptions;
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

function drainPendingUpdate(pendingUpdate: ChatModelRunResult | null): {
  nextPendingUpdate: ChatModelRunResult | null;
  update: ChatModelRunResult | null;
} {
  if (!pendingUpdate) {
    return {
      nextPendingUpdate: null,
      update: null,
    };
  }

  return {
    nextPendingUpdate: null,
    update: pendingUpdate,
  };
}

function handleDesktopProgressEvent(
  progress: unknown,
  requestId: string,
  onLoadingProgress: LocalRuntimeAdapterOptions['onLoadingProgress'] | undefined,
  onReasoningSnapshot: (reasoningText: string) => void,
  onTextSnapshot: (text: string) => void
): void {
  if (!isLlmHostProgressEvent(progress) || progress.payload.clientRequestId !== requestId) {
    return;
  }

  if (progress.payload.kind === 'loading') {
    onLoadingProgress?.({
      stage: 'loading',
      progress: progress.payload.progress ?? 0,
      message: progress.payload.message ?? 'Loading Gemma local model',
      ...(progress.payload.file ? { file: progress.payload.file } : {}),
    });
    return;
  }

  if (progress.payload.kind === 'stage') {
    onLoadingProgress?.({
      stage: 'generating',
      progress: 0,
      message: createGeneratingMessage(progress.payload.message),
    });
    return;
  }

  if (progress.payload.kind === 'reasoning' && progress.payload.reasoningText) {
    onReasoningSnapshot(progress.payload.reasoningText);
    return;
  }

  if (progress.payload.kind === 'text' && progress.payload.text) {
    onTextSnapshot(progress.payload.text);
  }
}

/**
 * Create a ChatModelAdapter for local browser-based LLM inference.
 * This adapter uses LocalLlmBackend which runs entirely in the browser
 * using transformers.js with WebGPU or WASM acceleration.
 */
export function createLocalModelAdapter(options: LocalRuntimeAdapterOptions): ChatModelAdapter {
  const { modelId, thinkingEnabled, onLoadingProgress, onError, runtimeData, tools } = options;
  const toolExecutor = getToolExecutor();
  const toolDefinitions = buildLocalToolDefinitions(
    tools,
    typeof toolExecutor?.execute === 'function'
  );

  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Generator handles init, conversion, streaming, and errors
    async *run({ messages, abortSignal }) {
      try {
        // Convert messages to LocalLlmMessage format
        const localMessages = convertMessages(messages);

        if (localMessages.length === 0) {
          yield {
            content: [{ type: 'text', text: 'No message content to process.' }],
          };
          return;
        }

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
        if (llmHost?.generate && !warmedDesktopModelIds.has(modelId)) {
          const warmupRequestId = crypto.randomUUID();
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
            await llmHost.warmup?.({ modelId, requestId: warmupRequestId });
          } finally {
            unsubscribeWarmupProgress?.();
          }
          warmedDesktopModelIds.add(modelId);
        }
        if (!llmHost?.generate) {
          const backend = await getBackend();
          if (!backend.isReady() || currentModelId !== modelId) {
            await backend.initialize({
              modelId,
              ...(onLoadingProgress ? { onProgress: onLoadingProgress } : {}),
            });
            currentModelId = modelId;
          }
        }

        currentModelId = modelId;
        const conversationMessages = [...localMessages];
        const maxToolRounds = 4;
        let accumulatedToolParts: AssistantToolCallContentPart[] = [];

        for (let toolRound = 0; toolRound < maxToolRounds; toolRound += 1) {
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
            enqueueUpdate(buildAssistantContentParts(streamedReasoningText, streamedText, []));
          };
          const updateTextSnapshot = (text: string) => {
            streamedText = text;
            deliveredStreamSnapshot = true;
            enqueueUpdate(buildAssistantContentParts(streamedReasoningText, streamedText, []));
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
            const backend = await getBackend();
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
            accumulatedToolParts
          );
          if (!deliveredStreamSnapshot || accumulatedToolParts.length > 0) {
            yield {
              content: finalContent,
            };
          }

          if (!(result.toolCalls && result.toolCalls.length > 0)) {
            onLoadingProgress?.({
              stage: 'ready',
              progress: 100,
              message: createReadyMessage(),
            });
            return;
          }

          if (!toolDefinitions?.length) {
            throw new Error(
              'Local model returned a tool call, but no runnable local tools are configured.'
            );
          }

          onLoadingProgress?.({
            stage: 'generating',
            progress: 0,
            message: 'Running tool...',
          });
          const executedTools = await executeToolCalls(result.toolCalls, runtimeData);
          accumulatedToolParts = mergeToolCallParts(accumulatedToolParts, executedTools.parts);
          yield {
            content: buildAssistantContentParts(
              result.reasoningText,
              result.text,
              accumulatedToolParts
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
          onLoadingProgress?.({
            stage: 'ready',
            progress: 100,
            message: 'Generation stopped.',
          });
          yield {
            content: [{ type: 'text', text: 'Generation cancelled.' }],
          };
          return;
        }

        onError?.(error instanceof Error ? error : new Error(errorMessage));

        yield {
          content: [
            {
              type: 'text',
              text: `Local model error: ${errorMessage}. Make sure the model is downloaded and WebGPU is available.`,
            },
          ],
        };
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

  // Create a promise that callers can wait on
  disposalState.promise = (async () => {
    try {
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
      warmedDesktopModelIds.clear();
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
