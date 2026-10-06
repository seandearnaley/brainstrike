/**
 * Node-side request preparation at the AI SDK 7 provider boundary (BST-1927).
 * The host supplies provenance and already-projected messages; this module
 * owns neither transcript persistence, credentials, tools nor an agent loop.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import { resolveTokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import type { MastraDBMessage } from '@mastra/core/agent';
import { type ProcessLLMRequestArgs, type Processor, TokenLimiter } from '@mastra/core/processors';
import { buildBedrockMessageHygieneInputProcessor } from './mastra/bedrock-message-hygiene';
import { buildProviderHistoryCompatInputProcessor } from './mastra/error-processors';
import { buildOpenAIDuplicateItemCompatInputProcessor } from './mastra/openai-duplicate-item-compat';
import { buildOpenAIToolSearchHistoryCompatInputProcessor } from './mastra/openai-tool-search-history-compat';
import { ProjectionSafeToolCallFilter } from './mastra/projection-safe-tool-call-filter';
import {
  createPreparedTokenMeasurement,
  type PreparedTokenMeasurement,
  serializeModelOutputForTokenMeasurement,
} from './mastra/token-measurement';
import { rewriteToolProjectionPrompt } from './mastra/tool-projection-rewrite-processor';
import {
  buildGenerationProviderOptionsOption,
  buildModelSettingsOption,
} from './providers/generation-settings';
import { classifyOpenAIStoredItemError } from './providers/openai-expired-item';
import {
  assertProviderRequestBoundaries,
  dropAbortedOpenAIItems,
  healInterruptedToolCalls,
} from './providers/request-history';
import type { SupportedProvider } from './providers/types';
import type { RuntimeData, ToolProjectionRewriteEntry } from './types';

export {
  buildGenerationProviderOptionsOption,
  buildModelSettingsOption,
} from './providers/generation-settings';
export {
  isOpenAIStoredItemExpiredError,
  OpenAIStoredItemExpiredError,
} from './providers/openai-expired-item';
export {
  type CanonicalProviderSchemaLayer,
  prepareProviderToolInputSchema,
} from './providers/provider-tool-schema';
export {
  healInterruptedModelMessages,
  ProviderRequestBoundaryError,
} from './providers/request-history';

export interface ProviderRequestContext {
  /** Host provenance: every item of the aborted step, not a guessed last item. */
  readonly abortedItemIds?: ReadonlySet<string>;
  /** Replay provenance for canonical eligibility and signed-reasoning rules. */
  readonly history?: readonly MastraDBMessage[];
  readonly inputTokenLimit?: number;
  readonly interruptedToolCallIds?: ReadonlySet<string>;
  readonly provider: SupportedProvider;
  readonly rewrites?: ReadonlyMap<string, ToolProjectionRewriteEntry>;
  readonly runtimeData?: Pick<RuntimeData, 'model' | 'modelSettings' | 'providerOptions'>;
  readonly tokenMeasurement?: PreparedTokenMeasurement;
  readonly toolNameMap?: ReadonlyMap<string, string>;
}

export interface ProviderRequestAccounting {
  readonly measurement: PreparedTokenMeasurement['capability'];
  readonly promptTokens: number;
  readonly removedMessages: number;
  readonly toolTokens: number;
  readonly totalTokens: number;
  readonly usedBackstop: boolean;
}

export interface PreparedProviderRequest {
  /** Measures exactly params.prompt and params.tools, including injected memory. */
  readonly accounting: ProviderRequestAccounting;
  readonly params: LanguageModelV4CallOptions;
  /** After projection/filter/compatibility, before contiguous token limiting. */
  readonly projectedPrompt: LanguageModelV4Prompt;
}

export class ProviderRequestContextOverflowError extends Error {
  readonly code = 'provider_request_context_overflow';
  readonly retryable = false;

  constructor(
    readonly accounting: ProviderRequestAccounting,
    readonly inputTokenLimit: number,
    options?: ErrorOptions
  ) {
    super('The protected provider prompt exceeds the selected input token limit.', options);
    this.name = 'ProviderRequestContextOverflowError';
  }
}

type LegacyPrompt = ProcessLLMRequestArgs['prompt'];

/**
 * The shipped processors use Mastra's V2 declaration, but operate only on
 * text/reasoning/tool parts shared with V4. V4-only parts pass through intact.
 * Keep this structural bridge in one place. The read-only provenance view
 * exposes only get.all.db used by the installed signed-reasoning rule; it
 * owns no mutable MessageList or copy of the compatibility algorithms.
 */
async function applyCanonicalProcessor(
  processor: Processor | undefined,
  prompt: LanguageModelV4Prompt,
  model: LanguageModelV4,
  history?: readonly MastraDBMessage[]
): Promise<LanguageModelV4Prompt> {
  const result = await processor?.processLLMRequest?.({
    abort: (reason) => {
      throw new Error(reason ?? 'Provider preparation aborted.');
    },
    model: model as unknown as ProcessLLMRequestArgs['model'],
    ...(history
      ? {
          messageList: {
            get: { all: { db: () => history } },
          } as unknown as NonNullable<ProcessLLMRequestArgs['messageList']>,
        }
      : {}),
    prompt: prompt as unknown as LegacyPrompt,
    retryCount: 0,
    state: {},
    stepNumber: 0,
    steps: [],
  });
  return (result?.prompt as unknown as LanguageModelV4Prompt | undefined) ?? prompt;
}

function isOpenAI(provider: SupportedProvider): boolean {
  return provider === 'openai' || provider === 'openai-codex';
}

async function compatiblePrompt(
  prompt: LanguageModelV4Prompt,
  model: LanguageModelV4,
  provider: SupportedProvider,
  history?: readonly MastraDBMessage[]
): Promise<LanguageModelV4Prompt> {
  // Runs AFTER projection and stale-history filtering: those transforms can
  // orphan reasoning even in the absence of duplicated stored item IDs.
  let compatible = await applyCanonicalProcessor(
    buildProviderHistoryCompatInputProcessor(provider),
    prompt,
    model,
    history
  );
  if (isOpenAI(provider)) {
    compatible = await applyCanonicalProcessor(
      buildOpenAIToolSearchHistoryCompatInputProcessor('openai'),
      compatible,
      model
    );
    compatible = await applyCanonicalProcessor(
      buildOpenAIDuplicateItemCompatInputProcessor('openai'),
      compatible,
      model
    );
  }
  return applyCanonicalProcessor(
    buildBedrockMessageHygieneInputProcessor(provider),
    compatible,
    model
  );
}

function countRequest(
  params: LanguageModelV4CallOptions,
  measurement: PreparedTokenMeasurement,
  removedMessages: number
): ProviderRequestAccounting {
  const prompt = measurement.measure(serializeModelOutputForTokenMeasurement(params.prompt));
  const tools = measurement.measure(
    params.tools?.length ? serializeModelOutputForTokenMeasurement(params.tools) : ''
  );
  const promptTokens = prompt.status === 'measured' ? prompt.tokenCount : prompt.backstopTokens;
  const toolTokens = tools.status === 'measured' ? tools.tokenCount : tools.backstopTokens;
  return {
    measurement: measurement.capability,
    promptTokens,
    removedMessages,
    toolTokens,
    totalTokens: promptTokens + toolTokens,
    usedBackstop: prompt.status === 'failed' || tools.status === 'failed',
  };
}

export async function prepareProviderRequest(
  params: LanguageModelV4CallOptions,
  model: LanguageModelV4,
  context: ProviderRequestContext
): Promise<PreparedProviderRequest> {
  params.abortSignal?.throwIfAborted();
  const runtimeData: RuntimeData = { ...context.runtimeData, provider: context.provider };
  const selected = buildGenerationProviderOptionsOption(runtimeData).providerOptions;
  const sanitized = buildGenerationProviderOptionsOption({
    providerOptions: { ...params.providerOptions, ...selected },
  }).providerOptions;
  const providerOptions = isOpenAI(context.provider)
    ? { ...sanitized, openai: { ...sanitized?.openai, store: context.provider === 'openai' } }
    : sanitized;
  let prompt =
    isOpenAI(context.provider) && context.abortedItemIds
      ? dropAbortedOpenAIItems(params.prompt, context.abortedItemIds)
      : params.prompt;
  prompt = healInterruptedToolCalls(prompt, context.interruptedToolCallIds ?? new Set());
  if (
    context.history &&
    context.provider !== 'local' &&
    context.provider !== 'ollama' &&
    context.provider !== 'lmstudio'
  ) {
    prompt = new ProjectionSafeToolCallFilter({
      toolNameMap: context.toolNameMap ?? new Map(),
    }).preparePrompt(
      prompt as unknown as LegacyPrompt,
      context.history
    ) as unknown as LanguageModelV4Prompt;
  }
  if (context.rewrites) {
    prompt = rewriteToolProjectionPrompt(prompt as unknown as LegacyPrompt, context.rewrites)
      .prompt as unknown as LanguageModelV4Prompt;
  }
  prompt = await compatiblePrompt(prompt, model, context.provider, context.history);
  assertProviderRequestBoundaries(prompt);
  const projectedPrompt = prompt;
  const modelSettings = buildModelSettingsOption(runtimeData).modelSettings;
  const { providerOptions: _transportOptions, ...callParams } = params;
  let prepared: LanguageModelV4CallOptions = {
    ...callParams,
    ...modelSettings,
    prompt,
    ...(providerOptions ? { providerOptions } : {}),
  };
  const measurement =
    context.tokenMeasurement ??
    (await createPreparedTokenMeasurement(
      resolveTokenMeasurementCapability(context.provider, model.modelId)
    ));
  let accounting = countRequest(prepared, measurement, 0);
  const limit = context.inputTokenLimit;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    throw new RangeError('inputTokenLimit must be a positive integer');
  }
  if (limit !== undefined) {
    // BST-1927: run the installed canonical limiter AFTER projection and memory
    // injection, reserving the actual outgoing tool surface. Measurement stays
    // observational; Mastra owns grouping, contiguous trimming and safety counts.
    const promptLimit = limit - accounting.toolTokens;
    if (promptLimit <= 0) {
      throw new ProviderRequestContextOverflowError(accounting, limit);
    }
    try {
      prompt = await applyCanonicalProcessor(
        new TokenLimiter({ limit: promptLimit, trimMode: 'contiguous' }),
        prepared.prompt,
        model
      );
      // A native contiguous cut can leave an old assistant/tool group at the
      // start. Drop that prefix through the first surviving user turn, retaining
      // every system message. If no user survives, ask the host to compact.
      const firstUser = prompt.findIndex((message) => message.role === 'user');
      if (firstUser > 0) {
        prompt = prompt.filter((message, index) => message.role === 'system' || index >= firstUser);
      }
      prompt = await compatiblePrompt(prompt, model, context.provider, context.history);
      assertProviderRequestBoundaries(prompt);
    } catch (cause) {
      throw new ProviderRequestContextOverflowError(accounting, limit, { cause });
    }
    prepared = { ...prepared, prompt };
    accounting = countRequest(prepared, measurement, projectedPrompt.length - prompt.length);
  }
  params.abortSignal?.throwIfAborted();
  return { accounting, params: prepared, projectedPrompt };
}

/** Use with installed ai@7.0.126 wrapLanguageModel; the host retains its one streamText loop. */
export function createProviderRequestMiddleware(options: {
  readonly context: () => ProviderRequestContext | Promise<ProviderRequestContext>;
  readonly onPrepared?: (prepared: PreparedProviderRequest) => void | Promise<void>;
}): LanguageModelV4Middleware {
  const classify = (error: unknown, context: ProviderRequestContext): unknown =>
    isOpenAI(context.provider) ? classifyOpenAIStoredItemError(error) : error;
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params, model }) => {
      const prepared = await prepareProviderRequest(params, model, await options.context());
      await options.onPrepared?.(prepared);
      return prepared.params;
    },
    wrapGenerate: async ({ doGenerate }) => {
      try {
        return await doGenerate();
      } catch (error) {
        throw classify(error, await options.context());
      }
    },
    wrapStream: async ({ doStream }) => {
      const context = await options.context();
      try {
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform: (part, controller) => {
                controller.enqueue(
                  part.type === 'error' ? { ...part, error: classify(part.error, context) } : part
                );
              },
            })
          ),
        };
      } catch (error) {
        throw classify(error, context);
      }
    },
  };
}
