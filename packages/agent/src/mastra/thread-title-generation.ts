/**
 * Mastra thread-title generation (BST-1649 split from `agent-streaming.ts`):
 * the bounded lifecycle that requests a title from the provider after a turn
 * finishes and persists it, gated by `canOverwriteThreadTitle`.
 *
 * `agent-streaming.ts` keeps two call sites — both through
 * {@link ensureMastraThreadTitleGeneration}, invoked from `streamAttemptChunks`
 * once on the terminal `finish` part and once on stream end/abort. Nothing else
 * in this module is reachable from outside it.
 *
 * See docs/agents/assistant-runtime.md and docs/agents/mastra-boundary.md.
 */

import { createLogger } from '@brainstrike/logging';
import type { MastraMemory } from '@mastra/core/memory';
import { RequestContext } from '@mastra/core/request-context';
import { canOverwriteThreadTitle } from '../pglite-mastra-memory/thread-title-policy';
import { attachThreadTitleSaveAbortSignal } from '../pglite-mastra-memory/thread-title-save-cancellation';
import { extractProviderRunError } from '../provider-error-metadata';
import {
  type ModelProviderOptions,
  wrapModelWithCallTransform,
} from '../providers/prompt-transform-proxy';
import type { AgentMessage, RuntimeData } from '../types';
import type { MastraAgentRuntime } from './agent-runtime';
import {
  buildGenerationProviderOptionsOption,
  buildModelSettingsOption,
} from './runtime-assembly/stream-options';

const logger = createLogger('MastraAgent');

const MASTRA_THREAD_TITLE_LIFECYCLE_TIMEOUT_MS = 30_000;

class MastraThreadTitleTimeoutError extends Error {
  constructor() {
    super('Mastra thread title generation exceeded its lifecycle budget.');
    this.name = 'MastraThreadTitleTimeoutError';
  }
}

function startMastraThreadTitleGeneration({
  memory,
  messages,
  runtime,
  runtimeData,
}: {
  memory: MastraMemory | undefined;
  messages: AgentMessage[] | undefined;
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
}): Promise<void> | undefined {
  if (!(memory && messages?.length)) {
    return;
  }
  return runBoundedMastraThreadTitleGeneration({ memory, messages, runtime, runtimeData });
}

export function ensureMastraThreadTitleGeneration({
  eligible,
  memory,
  messages,
  runtime,
  runtimeData,
  task,
}: {
  eligible: boolean;
  memory: MastraMemory | undefined;
  messages: AgentMessage[] | undefined;
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
  task: Promise<void> | undefined;
}): Promise<void> | undefined {
  if (!(eligible && !task)) {
    return task;
  }
  return startMastraThreadTitleGeneration({ memory, messages, runtime, runtimeData });
}

async function runBoundedMastraThreadTitleGeneration(options: {
  memory: MastraMemory;
  messages: AgentMessage[];
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
}): Promise<void> {
  const controller = new AbortController();
  const lifecycle = { signal: controller.signal };
  const operation = generateMastraThreadTitle({ ...options, lifecycle });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new MastraThreadTitleTimeoutError();
          controller.abort(error);
          reject(error);
        }, MASTRA_THREAD_TITLE_LIFECYCLE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error instanceof MastraThreadTitleTimeoutError) {
      logger.error('Mastra thread title generation timed out', {
        code: 'mastra_thread_title_generation_timeout',
        ...(options.runtimeData?.model ? { model: options.runtimeData.model } : {}),
        ...(options.runtimeData?.provider ? { provider: options.runtimeData.provider } : {}),
        resourceId: options.runtimeData?.memory?.resourceId,
        stage: 'provider',
        threadId: options.runtimeData?.memory?.threadId,
      });
      return;
    }
    logger.error('Mastra thread title lifecycle failed', {
      code: 'mastra_thread_title_lifecycle_failed',
      errorName: readMastraThreadTitleErrorName(error),
      resourceId: options.runtimeData?.memory?.resourceId,
      stage: 'lifecycle',
      threadId: options.runtimeData?.memory?.threadId,
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (!controller.signal.aborted) {
      controller.abort(new Error('Mastra thread title lifecycle settled.'));
    }
    // Observe a late rejection if a non-compliant provider ignores AbortSignal.
    void operation.catch(() => undefined);
  }
}

async function generateMastraThreadTitle({
  lifecycle,
  memory,
  messages,
  runtime,
  runtimeData,
}: {
  lifecycle: { signal: AbortSignal };
  memory: MastraMemory;
  messages: AgentMessage[];
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
}): Promise<void> {
  const threadId = runtimeData?.memory?.threadId;
  const resourceId = runtimeData?.memory?.resourceId;
  if (!(threadId && resourceId)) {
    return;
  }
  const preflight = await readMastraThreadTitlePreflight({
    lifecycle,
    memory,
    resourceId,
    runtimeData,
    threadId,
  });
  if (!preflight) {
    return;
  }
  const userMessages = makeMastraThreadTitleMessages(messages);
  if (userMessages.length === 0) {
    return;
  }
  const titleRequest = {
    messages: userMessages,
    ...(typeof preflight.titleConfig === 'object' && preflight.titleConfig.instructions
      ? { instructions: preflight.titleConfig.instructions }
      : {}),
    ...(typeof preflight.titleConfig === 'object' && preflight.titleConfig.model
      ? { model: preflight.titleConfig.model }
      : {}),
  };
  const normalizedTitle = await requestMastraThreadTitle({
    lifecycle,
    resourceId,
    runtime,
    runtimeData,
    threadId,
    titleRequest,
  });
  if (!normalizedTitle) {
    return;
  }
  await persistMastraThreadTitle({
    lifecycle,
    memory,
    normalizedTitle,
    preflight,
    resourceId,
    threadId,
  });
}

async function readMastraThreadTitlePreflight({
  lifecycle,
  memory,
  resourceId,
  runtimeData,
  threadId,
}: {
  lifecycle: { signal: AbortSignal };
  memory: MastraMemory;
  resourceId: string;
  runtimeData: RuntimeData | undefined;
  threadId: string;
}): Promise<
  | {
      memoryConfig: NonNullable<RuntimeData['memory']>['memoryOptions'];
      thread: NonNullable<Awaited<ReturnType<MastraMemory['getThreadById']>>>;
      titleConfig: NonNullable<ReturnType<MastraMemory['getMergedThreadConfig']>['generateTitle']>;
    }
  | undefined
> {
  const memoryConfig = runtimeData?.memory?.memoryOptions;
  let titleConfig: ReturnType<MastraMemory['getMergedThreadConfig']>['generateTitle'];
  try {
    titleConfig = memory.getMergedThreadConfig(memoryConfig).generateTitle;
  } catch (error) {
    logMastraThreadTitleFailure(lifecycle.signal, 'Mastra thread title configuration is invalid', {
      code: 'mastra_thread_title_config_invalid',
      errorName: readMastraThreadTitleErrorName(error),
      resourceId,
      stage: 'config',
      threadId,
    });
    return;
  }
  if (!titleConfig) {
    return;
  }
  try {
    const thread = await memory.getThreadById({ threadId });
    if (lifecycle.signal.aborted || !(thread && canOverwriteThreadTitle(thread))) {
      return;
    }
    return { memoryConfig, thread, titleConfig };
  } catch (error) {
    logMastraThreadTitlePersistenceFailure({
      error,
      resourceId,
      signal: lifecycle.signal,
      stage: 'persistence-read',
      threadId,
    });
    return;
  }
}

function makeMastraThreadTitleMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => ({
      ...message,
      // Mastra's title formatter accepts textual UI parts. File/tool parts are
      // not title input and some versions attempt text-only operations on them.
      parts: message.parts.filter((part) => part.type === 'text'),
    }))
    .filter((message) => message.parts.length > 0);
}

async function requestMastraThreadTitle({
  lifecycle,
  resourceId,
  runtime,
  runtimeData,
  threadId,
  titleRequest,
}: {
  lifecycle: { signal: AbortSignal };
  resourceId: string;
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
  threadId: string;
  titleRequest: Parameters<MastraAgentRuntime['agent']['generateTitleFromUserMessage']>[0];
}): Promise<string | undefined> {
  const maxAttempts = runtimeData?.provider === 'openrouter' ? 2 : 1;
  const requestContext = new RequestContext();
  let titleModel: Awaited<ReturnType<MastraAgentRuntime['agent']['getModel']>>;
  try {
    titleModel = await runtime.agent.getModel({
      requestContext,
      ...(titleRequest.model ? { modelConfig: titleRequest.model } : {}),
    });
  } catch (error) {
    if (!lifecycle.signal.aborted) {
      logMastraThreadTitleProviderFailure({
        attempt: 1,
        error,
        lifecycle,
        resourceId,
        runtimeData,
        threadId,
      });
    }
    return;
  }
  const activeProviderOptions = buildGenerationProviderOptionsOption(runtimeData).providerOptions;
  const maxOutputTokens = buildModelSettingsOption(runtimeData).modelSettings?.maxOutputTokens;
  const cancellableModel = wrapModelWithCallTransform(titleModel, (params) => ({
    ...params,
    abortSignal: lifecycle.signal,
    ...(params.maxOutputTokens === undefined && maxOutputTokens !== undefined
      ? { maxOutputTokens }
      : {}),
    ...mergeMastraThreadTitleProviderOptions(params.providerOptions, activeProviderOptions),
  }));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let title: string | undefined;
    try {
      title = await runtime.agent.generateTitleFromUserMessage({
        ...titleRequest,
        model: cancellableModel,
        requestContext,
      });
    } catch (error) {
      if (lifecycle.signal.aborted) {
        return;
      }
      logMastraThreadTitleProviderFailure({
        attempt,
        error,
        lifecycle,
        resourceId,
        runtimeData,
        threadId,
      });
      return;
    }
    if (lifecycle.signal.aborted) {
      return;
    }
    if (title?.trim()) {
      return title.trim();
    }
    logger.warn('Mastra thread title generation returned no text', {
      attempt,
      code: 'mastra_thread_title_invalid_output',
      maxAttempts,
      ...(runtimeData?.model ? { model: runtimeData.model } : {}),
      ...(runtimeData?.provider ? { provider: runtimeData.provider } : {}),
      resourceId,
      retrying: attempt < maxAttempts,
      stage: 'invalid-output',
      threadId,
    });
  }
  return;
}

function mergeMastraThreadTitleProviderOptions(
  current: ModelProviderOptions | undefined,
  active: unknown
): Pick<{ providerOptions?: ModelProviderOptions }, 'providerOptions'> {
  const activeOptions = readMastraThreadTitleProviderOptions(active);
  const namespaces = new Set([...Object.keys(current ?? {}), ...Object.keys(activeOptions)]);
  if (namespaces.size === 0) {
    return {};
  }
  const providerOptions: ModelProviderOptions = {};
  for (const namespace of namespaces) {
    providerOptions[namespace] = {
      ...(current?.[namespace] ?? {}),
      ...(activeOptions[namespace] ?? {}),
    };
  }
  return { providerOptions };
}

function readMastraThreadTitleProviderOptions(value: unknown): ModelProviderOptions {
  if (!(value && typeof value === 'object' && !Array.isArray(value))) {
    return {};
  }
  const providerOptions: ModelProviderOptions = {};
  for (const [namespace, options] of Object.entries(value)) {
    if (options && typeof options === 'object' && !Array.isArray(options)) {
      providerOptions[namespace] = { ...(options as Record<string, unknown>) };
    }
  }
  return providerOptions;
}

function logMastraThreadTitleProviderFailure({
  attempt,
  error,
  lifecycle,
  resourceId,
  runtimeData,
  threadId,
}: {
  attempt: number;
  error: unknown;
  lifecycle: { signal: AbortSignal };
  resourceId: string;
  runtimeData: RuntimeData | undefined;
  threadId: string;
}): void {
  if (lifecycle.signal.aborted) {
    return;
  }
  const providerError = extractProviderRunError(error);
  logger.error('Mastra thread title provider request failed', {
    attempt,
    code: 'mastra_thread_title_provider_failed',
    ...(providerError.httpStatus === undefined ? {} : { httpStatus: providerError.httpStatus }),
    ...(runtimeData?.model ? { model: runtimeData.model } : {}),
    ...(runtimeData?.provider ? { provider: runtimeData.provider } : {}),
    providerErrorCode: providerError.code,
    ...(providerError.providerRequestId
      ? { providerRequestId: providerError.providerRequestId }
      : {}),
    resourceId,
    stage: 'provider',
    threadId,
  });
}

async function persistMastraThreadTitle({
  lifecycle,
  memory,
  normalizedTitle,
  preflight,
  resourceId,
  threadId,
}: {
  lifecycle: { signal: AbortSignal };
  memory: MastraMemory;
  normalizedTitle: string;
  preflight: {
    memoryConfig: NonNullable<RuntimeData['memory']>['memoryOptions'];
    thread: NonNullable<Awaited<ReturnType<MastraMemory['getThreadById']>>>;
  };
  resourceId: string;
  threadId: string;
}): Promise<void> {
  try {
    await memory.saveThread({
      ...(preflight.memoryConfig ? { memoryConfig: preflight.memoryConfig } : {}),
      thread: attachThreadTitleSaveAbortSignal(
        {
          ...preflight.thread,
          title: normalizedTitle,
          updatedAt: new Date(),
        },
        lifecycle.signal
      ),
    });
  } catch (error) {
    logMastraThreadTitlePersistenceFailure({
      error,
      resourceId,
      signal: lifecycle.signal,
      stage: 'persistence-write',
      threadId,
    });
  }
}

function logMastraThreadTitlePersistenceFailure({
  error,
  resourceId,
  signal,
  stage,
  threadId,
}: {
  error: unknown;
  resourceId: string;
  signal: AbortSignal;
  stage: 'persistence-read' | 'persistence-write';
  threadId: string;
}): void {
  logMastraThreadTitleFailure(signal, 'Mastra thread title persistence failed', {
    code: 'mastra_thread_title_persistence_failed',
    ...readMastraThreadTitleDatabaseDiagnostic(error),
    errorName: readMastraThreadTitleErrorName(error),
    resourceId,
    stage,
    threadId,
  });
}

function logMastraThreadTitleFailure(
  signal: AbortSignal,
  message: string,
  diagnostic: Record<string, unknown>
): void {
  if (!signal.aborted) {
    logger.error(message, diagnostic);
  }
}

function readMastraThreadTitleErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function readMastraThreadTitleDatabaseDiagnostic(error: unknown): { databaseCode?: string } {
  if (!(error && typeof error === 'object')) {
    return {};
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length <= 64 ? { databaseCode: code } : {};
}
