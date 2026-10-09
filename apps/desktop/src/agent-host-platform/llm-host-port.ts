import { randomUUID } from 'node:crypto';
import type {
  LocalLlmGenerationResult,
  LocalLlmHostClient,
  LocalLlmHostGenerateRequest,
  LocalLlmHostProgress,
} from '@brainstrike/agent/local-llm';
import {
  type CancellationToken,
  CancellationTokenSource,
  type Disposable,
  type MessageConnection,
  ResponseError,
} from 'vscode-jsonrpc/node';
import { z } from 'zod';

/**
 * The desktop's hidden-renderer inference, lent to the Node host over its
 * private Main port (ADR-0007: models load and run only in the llm-host
 * renderer; the host and Main only relay). The same seam the legacy server
 * used, `generateForMain`/`warmupForMain`, now crossing one process boundary.
 */
export const LLM_HOST_PORT_METHODS = {
  generate: 'llm-host/generate',
  progress: 'llm-host/progress',
  warmup: 'llm-host/warmup',
} as const;

/** A typed failure code (for example `local_tool_call_arguments_invalid`) survives the hop. */
const FAILURE_CODE = -32_090;

/** Main's existing manager surface; the port depends on nothing Electron-bound. */
export interface DesktopLlmHostInference {
  generateForMain(
    payload: LocalLlmHostGenerateRequest,
    options: { onProgress?: (progress: LocalLlmHostProgress) => void; signal?: AbortSignal }
  ): Promise<unknown>;
  warmupForMain(
    modelId: string,
    options: { onProgress?: (progress: LocalLlmHostProgress) => void; signal?: AbortSignal }
  ): Promise<void>;
}

const RequestId = z.string().uuid();
const GenerateParams = z.strictObject({
  request: z.custom<LocalLlmHostGenerateRequest>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { modelId?: unknown }).modelId === 'string' &&
      Array.isArray((value as { messages?: unknown }).messages)
  ),
  requestId: RequestId,
});
const WarmupParams = z.strictObject({ modelId: z.string().min(1), requestId: RequestId });
const ProgressParams = z.strictObject({
  // Main's payload also carries its own correlation fields; only these cross.
  progress: z.object({
    file: z.string().optional(),
    kind: z.enum(['loading', 'reasoning', 'stage', 'text']),
    message: z.string().optional(),
    progress: z.number().optional(),
    reasoningText: z.string().optional(),
    text: z.string().optional(),
  }),
  requestId: RequestId,
});
/** The provider seam's result fields; anything else a backend reports stays behind. */
const GenerationResultSchema = z.object({
  finishReason: z.enum(['length', 'stop', 'tool_calls']),
  reasoningText: z.string().optional(),
  text: z.string(),
  toolCalls: z
    .array(
      z.strictObject({
        function: z.strictObject({ arguments: z.string(), name: z.string() }),
        id: z.string(),
        type: z.literal('function'),
      })
    )
    .optional(),
  usage: z.strictObject({
    completionTokens: z.number(),
    promptTokens: z.number(),
    totalTokens: z.number(),
  }),
});
const FailureData = z.strictObject({ code: z.string().min(1) });

function toProgress(input: z.output<typeof ProgressParams>['progress']): LocalLlmHostProgress {
  return {
    kind: input.kind,
    ...(input.file === undefined ? {} : { file: input.file }),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    ...(input.reasoningText === undefined ? {} : { reasoningText: input.reasoningText }),
    ...(input.text === undefined ? {} : { text: input.text }),
  };
}

function toGenerationResult(input: unknown): LocalLlmGenerationResult {
  const result = GenerationResultSchema.parse(input);
  return {
    finishReason: result.finishReason,
    text: result.text,
    usage: result.usage,
    ...(result.reasoningText === undefined ? {} : { reasoningText: result.reasoningText }),
    ...(result.toolCalls === undefined ? {} : { toolCalls: result.toolCalls }),
  };
}

function progressRelay(
  connection: MessageConnection,
  requestId: string
): (progress: LocalLlmHostProgress) => void {
  return (progress) => {
    // Progress is advisory; a lost relay never fails the generation itself.
    connection
      .sendNotification(LLM_HOST_PORT_METHODS.progress, { progress, requestId })
      .catch(() => undefined);
  };
}

function signalOf(token: CancellationToken): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() =>
    controller.abort(new Error('Local model request cancelled by the host'))
  );
  if (token.isCancellationRequested) {
    controller.abort(new Error('Local model request cancelled by the host'));
  }
  return { dispose: () => subscription.dispose(), signal: controller.signal };
}

async function withTypedFailure<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    const code =
      typeof cause === 'object' &&
      cause !== null &&
      typeof (cause as { code?: unknown }).code === 'string'
        ? (cause as { code: string }).code
        : undefined;
    throw new ResponseError(
      FAILURE_CODE,
      cause instanceof Error ? cause.message : String(cause),
      code === undefined ? undefined : { code }
    );
  }
}

/** Main: answer the host's local-model requests with the existing hidden-host manager. */
export function serveLlmHostPort(
  connection: MessageConnection,
  inference: DesktopLlmHostInference
): Disposable {
  const disposables = [
    connection.onRequest(
      LLM_HOST_PORT_METHODS.generate,
      async (input: unknown, token: CancellationToken) => {
        const { request, requestId } = GenerateParams.parse(input);
        const cancellation = signalOf(token);
        try {
          return await withTypedFailure(() =>
            inference.generateForMain(request, {
              onProgress: progressRelay(connection, requestId),
              signal: cancellation.signal,
            })
          );
        } finally {
          cancellation.dispose();
        }
      }
    ),
    connection.onRequest(
      LLM_HOST_PORT_METHODS.warmup,
      async (input: unknown, token: CancellationToken) => {
        const { modelId, requestId } = WarmupParams.parse(input);
        const cancellation = signalOf(token);
        try {
          await withTypedFailure(() =>
            inference.warmupForMain(modelId, {
              onProgress: progressRelay(connection, requestId),
              signal: cancellation.signal,
            })
          );
          return { warmed: true };
        } finally {
          cancellation.dispose();
        }
      }
    ),
  ];
  return {
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  };
}

/** Node: the provider seam's client, whose inference runs in the desktop's hidden renderer. */
export function createRemoteLlmHostClient(connection: MessageConnection): LocalLlmHostClient {
  const progressListeners = new Map<string, (progress: LocalLlmHostProgress) => void>();
  connection.onNotification(LLM_HOST_PORT_METHODS.progress, (input: unknown) => {
    const { progress, requestId } = ProgressParams.parse(input);
    progressListeners.get(requestId)?.(toProgress(progress));
  });
  const send = async (
    method: string,
    params: unknown,
    requestId: string,
    options: { onProgress?: (progress: LocalLlmHostProgress) => void; signal?: AbortSignal }
  ): Promise<unknown> => {
    options.signal?.throwIfAborted();
    const cancellation = new CancellationTokenSource();
    const cancel = (): void => cancellation.cancel();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.onProgress) {
      progressListeners.set(requestId, options.onProgress);
    }
    try {
      return await connection.sendRequest(method, params, cancellation.token);
    } catch (cause) {
      options.signal?.throwIfAborted();
      if (cause instanceof ResponseError) {
        const failure = new Error(cause.message);
        const data = FailureData.safeParse(cause.data);
        if (data.success) {
          (failure as Error & { code: string }).code = data.data.code;
        }
        throw failure;
      }
      throw cause;
    } finally {
      progressListeners.delete(requestId);
      options.signal?.removeEventListener('abort', cancel);
      cancellation.dispose();
    }
  };
  return {
    generate: async (request, options = {}) => {
      const requestId = randomUUID();
      return toGenerationResult(
        await send(LLM_HOST_PORT_METHODS.generate, { request, requestId }, requestId, options)
      );
    },
    warmup: async (modelId, options = {}) => {
      const requestId = randomUUID();
      z.strictObject({ warmed: z.literal(true) }).parse(
        await send(LLM_HOST_PORT_METHODS.warmup, { modelId, requestId }, requestId, options)
      );
    },
  };
}
