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
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract';
import type {
  AssistantContextBreakdown,
  AssistantToolCallUsage,
  PromptToolCall,
} from '@brainstrike/assistant-contract/context-breakdown';
import { resolveTokenMeasurementCapability } from '@brainstrike/assistant-contract/provider-registry';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import { countTokensHeuristic } from '@brainstrike/tokenization';
import { type MastraDBMessage, TripWire } from '@mastra/core/agent';
import {
  type ProcessLLMRequestArgs,
  type Processor,
  ProviderHistoryCompat,
  TokenLimiter,
} from '@mastra/core/processors';
import { ProjectionSafeToolCallFilter } from './mastra-processors/projection-safe-tool-call-filter.ts';
import { cleanBedrockPrompt } from './providers/bedrock-message-hygiene.ts';
import { createCanonicalLimiterView } from './providers/canonical-provider-limiter.ts';
import {
  collectProviderCallProvenance,
  type ProviderCallProvenance,
  stripForeignExecutedToolPairs,
} from './providers/foreign-provider-history.ts';
import { buildModelSettingsOption } from './providers/generation-settings.ts';
import { canonicalizeOpenAIDuplicateItems } from './providers/openai-duplicate-item-compat.ts';
import { classifyOpenAIStoredItemError } from './providers/openai-expired-item.ts';
import { canonicalizeOpenAIToolSearchHistory } from './providers/openai-tool-search-history-compat.ts';
import {
  assertProviderRequestBoundaries,
  dropAbortedOpenAIItems,
  healInterruptedToolCalls,
  ProviderRequestBoundaryError,
} from './providers/request-history.ts';
import { rewriteToolProjectionPrompt } from './providers/tool-projection-rewrite.ts';
import type { SupportedProvider } from './providers/types.ts';
import {
  createPreparedTokenMeasurement,
  type PreparedTokenMeasurement,
  serializeModelOutputForTokenMeasurement,
} from './token-measurement.ts';
import type { RuntimeData, ToolProjectionRewriteEntry } from './types.ts';

export { buildModelSettingsOption } from './providers/generation-settings.ts';
export {
  isOpenAIStoredItemExpiredError,
  OpenAIStoredItemExpiredError,
} from './providers/openai-expired-item.ts';
export {
  type CanonicalProviderSchemaLayer,
  prepareProviderToolInputSchema,
} from './providers/provider-tool-schema.ts';
export {
  healInterruptedModelMessages,
  ProviderRequestBoundaryError,
} from './providers/request-history.ts';

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
  /** Tool calls whose result this request replaced with a committed rewrite marker. */
  readonly rewrittenToolCallIds: ReadonlySet<string>;
}

type PromptPart = Exclude<LanguageModelV4Prompt[number]['content'], string>[number];
type ToolResultOutput = Extract<PromptPart, { type: 'tool-result' }>['output'];

/** The text a provider receives for one tool result, for the chars/4 heuristic. */
function toolResultOutputText(output: ToolResultOutput): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value;
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value) ?? '';
    case 'execution-denied':
      return output.reason ?? '';
    case 'content':
      // An inline file counts as its label, never its bytes (as attachments do).
      return output.value
        .map((item) => (item.type === 'text' ? item.text : `[attachment ${item.type}]`))
        .join('\n');
    default:
      return '';
  }
}

function toolCallInputText(input: unknown): string {
  return typeof input === 'string' ? input : (JSON.stringify(input) ?? '');
}

/**
 * Every tool call the prepared request carries, in prompt order: its input,
 * its result as sent (a committed rewrite counts as its marker), measured with
 * the shared chars/4 heuristic on the exact prompt after limiting.
 */
export function preparedPromptToolCalls(
  prepared: Pick<PreparedProviderRequest, 'params' | 'rewrittenToolCallIds'>
): PromptToolCall[] {
  const calls = new Map<
    string,
    {
      inputTokens: number;
      output: PromptToolCall['output'];
      outputTokens: number;
      toolName: string;
    }
  >();
  const entry = (toolCallId: string, toolName: string) => {
    let call = calls.get(toolCallId);
    if (!call) {
      call = {
        inputTokens: 0,
        output: 'absent',
        outputTokens: 0,
        toolName: denormalizeNativeToolName(toolName),
      };
      calls.set(toolCallId, call);
    }
    return call;
  };
  for (const message of prepared.params.prompt) {
    if (message.role !== 'assistant' && message.role !== 'tool') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        entry(part.toolCallId, part.toolName).inputTokens += countTokensHeuristic(
          toolCallInputText(part.input)
        );
      } else if (part.type === 'tool-result') {
        const call = entry(part.toolCallId, part.toolName);
        call.outputTokens += countTokensHeuristic(toolResultOutputText(part.output));
        call.output = prepared.rewrittenToolCallIds.has(part.toolCallId) ? 'marker' : 'full';
      }
    }
  }
  return [...calls].map(([toolCallId, call]) => ({ ...call, toolCallId }));
}

function toolCallUsageByTool(calls: readonly PromptToolCall[]): AssistantToolCallUsage[] {
  const byTool = new Map<string, { calls: number; tokens: number }>();
  for (const call of calls) {
    const usage = byTool.get(call.toolName) ?? { calls: 0, tokens: 0 };
    usage.calls += 1;
    usage.tokens += call.inputTokens + call.outputTokens;
    byTool.set(call.toolName, usage);
  }
  return [...byTool]
    .map(([toolName, usage]) => ({ ...usage, toolName }))
    .sort((a, b) => b.tokens - a.tokens || a.toolName.localeCompare(b.toolName));
}

/**
 * The context popover's prompt breakdown for one prepared request, measured on
 * the exact prompt the provider receives (after memory recall and projection).
 * System and message figures use the shared chars/4 heuristic; the tool
 * definition total is the request's own accounting, `measured` only when the
 * selected model's tokenizer counted it. A task list note is part of the
 * composed system prompt here, so it has no separate row.
 */
export function preparedPromptBreakdown(
  prepared: Pick<PreparedProviderRequest, 'accounting' | 'params' | 'rewrittenToolCallIds'>,
  toolCalls: readonly PromptToolCall[] = preparedPromptToolCalls(prepared)
): AssistantContextBreakdown {
  let systemInstructionsTokens = 0;
  let historyMessagesTokens = 0;
  let attachmentsCount = 0;
  for (const message of prepared.params.prompt) {
    if (message.role === 'system') {
      systemInstructionsTokens += countTokensHeuristic(message.content);
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'text') {
        historyMessagesTokens += countTokensHeuristic(part.text);
      } else if (part.type === 'file') {
        attachmentsCount += 1;
      }
    }
  }
  const { accounting } = prepared;
  return {
    attachmentsCount,
    historyMessagesTokens,
    provenance: 'heuristic',
    systemInstructionsTokens,
    toolCallsByTool: toolCallUsageByTool(toolCalls),
    toolCallsTokens: toolCalls.reduce(
      (total, call) => total + call.inputTokens + call.outputTokens,
      0
    ),
    toolDefinitionsProvenance:
      accounting.measurement.mode === 'exact-selected-model' && !accounting.usedBackstop
        ? 'measured'
        : 'heuristic',
    toolDefinitionsTokens: accounting.toolTokens,
  };
}

/**
 * The request does not fit the selected model's input budget. Core recovers it
 * by compacting; when nothing can be dropped (a model whose window cannot hold
 * the run's own instructions and tools), the run fails with this refusal,
 * naming both numbers.
 */
export class ProviderRequestContextOverflowError extends BoundaryFailureError {
  readonly retryable = false;

  readonly accounting: ProviderRequestAccounting;
  readonly inputTokenLimit: number;

  constructor(
    accounting: ProviderRequestAccounting,
    inputTokenLimit: number,
    options?: ErrorOptions
  ) {
    super(
      refusal({
        category: 'configuration',
        code: 'provider.context-overflow',
        message: `This request needs about ${accounting.totalTokens.toLocaleString('en-US')} input tokens, but the selected model accepts ${inputTokenLimit.toLocaleString('en-US')}.`,
        remedy: 'Choose a model with a larger context window, or start a new thread.',
      }),
      options
    );
    this.accounting = accounting;
    this.inputTokenLimit = inputTokenLimit;
    this.name = 'ProviderRequestContextOverflowError';
  }
}

type LegacyPrompt = ProcessLLMRequestArgs['prompt'];

/**
 * Run one of Mastra's request processors (`ProviderHistoryCompat`,
 * `TokenLimiter`), which are declared on its V2 prompt. They read only the
 * text/reasoning/tool parts V2 shares with V4; V4-only parts pass through
 * intact. The read-only provenance view exposes only `get.all.db`, which the
 * vendor's signed-reasoning rule reads. Brainstrike's own fixes are plain V4
 * functions and never cross here.
 */
async function runMastraProcessor(
  processor: Processor,
  prompt: LegacyPrompt,
  model: LanguageModelV4,
  history?: readonly MastraDBMessage[]
): Promise<LegacyPrompt> {
  const result = await processor.processLLMRequest?.({
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
    prompt,
    retryCount: 0,
    state: {},
    stepNumber: 0,
    steps: [],
  });
  return result?.prompt ?? prompt;
}

function isOpenAI(provider: SupportedProvider): boolean {
  return provider === 'openai';
}

/**
 * Provider fixes, after projection and stale-history filtering: those
 * transforms can orphan reasoning even without duplicated stored item IDs.
 */
async function compatiblePrompt(
  input: LanguageModelV4Prompt,
  model: LanguageModelV4,
  provider: SupportedProvider,
  provenance: ProviderCallProvenance,
  history?: readonly MastraDBMessage[]
): Promise<LanguageModelV4Prompt> {
  const paired = stripForeignExecutedToolPairs(input, provider, provenance);
  let prompt = (await runMastraProcessor(
    new ProviderHistoryCompat(),
    paired as unknown as LegacyPrompt,
    model,
    history
  )) as unknown as LanguageModelV4Prompt;
  if (isOpenAI(provider)) {
    prompt = canonicalizeOpenAIDuplicateItems(canonicalizeOpenAIToolSearchHistory(prompt));
  }
  return provider === 'bedrock' ? cleanBedrockPrompt(prompt) : prompt;
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

async function limitProviderPrompt(
  input: LanguageModelV4Prompt,
  model: LanguageModelV4,
  context: ProviderRequestContext,
  provenance: ProviderCallProvenance,
  accounting: ProviderRequestAccounting,
  limit: number
): Promise<LanguageModelV4Prompt> {
  // Reuse native grouping and contiguous trimming after memory/projection,
  // reserving the actual outgoing tool surface. The V4 view is counting-only.
  const promptLimit = limit - accounting.toolTokens;
  if (promptLimit <= 0) {
    throw new ProviderRequestContextOverflowError(accounting, limit);
  }
  try {
    const counting = createCanonicalLimiterView(input);
    const limited = await runMastraProcessor(
      new TokenLimiter({ limit: promptLimit, trimMode: 'contiguous' }),
      counting.prompt,
      model
    );
    let prompt = counting.restore(limited);
    // A native contiguous cut can leave an old assistant/tool group at the
    // start. Drop that prefix through the first surviving user turn, retaining
    // every system message. If no user survives, ask the host to compact.
    const firstUser = prompt.findIndex((message) => message.role === 'user');
    if (firstUser > 0) {
      prompt = prompt.filter((message, index) => message.role === 'system' || index >= firstUser);
    }
    prompt = await compatiblePrompt(prompt, model, context.provider, provenance, context.history);
    assertProviderRequestBoundaries(prompt);
    return prompt;
  } catch (cause) {
    if (cause instanceof TripWire || cause instanceof ProviderRequestBoundaryError) {
      throw new ProviderRequestContextOverflowError(accounting, limit, { cause });
    }
    // Programming/shape failures are not token overflows.
    throw cause;
  }
}

export async function prepareProviderRequest(
  params: LanguageModelV4CallOptions,
  model: LanguageModelV4,
  context: ProviderRequestContext
): Promise<PreparedProviderRequest> {
  params.abortSignal?.throwIfAborted();
  const provenance = collectProviderCallProvenance(params.prompt, context.history ?? []);
  const runtimeData: RuntimeData = { ...context.runtimeData, provider: context.provider };
  const requested: NonNullable<RuntimeData['providerOptions']> = {
    ...params.providerOptions,
    ...context.runtimeData?.providerOptions,
  };
  const providerOptions = isOpenAI(context.provider)
    ? { ...requested, openai: { ...requested.openai, store: context.provider === 'openai' } }
    : requested;
  let prompt =
    isOpenAI(context.provider) && context.abortedItemIds
      ? dropAbortedOpenAIItems(params.prompt, context.abortedItemIds)
      : params.prompt;
  prompt = healInterruptedToolCalls(prompt, context.interruptedToolCallIds ?? new Set());
  if (context.history) {
    prompt = new ProjectionSafeToolCallFilter({
      toolNameMap: context.toolNameMap ?? new Map(),
    }).preparePrompt(
      prompt as unknown as LegacyPrompt,
      context.history
    ) as unknown as LanguageModelV4Prompt;
  }
  let rewrittenToolCallIds: ReadonlySet<string> = new Set();
  if (context.rewrites) {
    const rewritten = rewriteToolProjectionPrompt(prompt, context.rewrites);
    prompt = rewritten.prompt;
    rewrittenToolCallIds = rewritten.rewrittenToolCallIds;
  }
  prompt = await compatiblePrompt(prompt, model, context.provider, provenance, context.history);
  assertProviderRequestBoundaries(prompt);
  const projectedPrompt = prompt;
  const modelSettings = buildModelSettingsOption(runtimeData).modelSettings;
  const { providerOptions: _transportOptions, ...callParams } = params;
  let prepared: LanguageModelV4CallOptions = {
    ...callParams,
    ...modelSettings,
    prompt,
    providerOptions,
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
    prompt = await limitProviderPrompt(
      prepared.prompt,
      model,
      context,
      provenance,
      accounting,
      limit
    );
    prepared = { ...prepared, prompt };
    accounting = countRequest(prepared, measurement, projectedPrompt.length - prompt.length);
    if (accounting.totalTokens > limit) {
      // BST-1927 review: a native media safety estimate can undercount inline
      // text/custom V4 payloads. Never dispatch a measured over-budget prompt.
      throw new ProviderRequestContextOverflowError(accounting, limit);
    }
  }
  params.abortSignal?.throwIfAborted();
  return { accounting, params: prepared, projectedPrompt, rewrittenToolCallIds };
}

/** Use with installed ai@7.0.142 wrapLanguageModel; the host retains its one streamText loop. */
export function createProviderRequestMiddleware(options: {
  readonly context: () => ProviderRequestContext | Promise<ProviderRequestContext>;
  readonly onPrepared?: (prepared: PreparedProviderRequest) => void | Promise<void>;
}): LanguageModelV4Middleware {
  // Below the SDK request retry: a typed non-retryable error is never re-sent.
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
