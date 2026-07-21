import { isGuardedToolError, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/utils';
import type { MastraDBMessage } from '@mastra/core/agent';
import type {
  ProcessInputStepArgs,
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';

type LanguageModelV2Prompt = ProcessLLMRequestArgs['prompt'];
type LanguageModelV2Message = LanguageModelV2Prompt[number];
type LanguageModelV2ToolCallPart = Extract<
  Extract<LanguageModelV2Message, { role: 'assistant' }>['content'][number],
  { type: 'tool-call' }
>;
type LanguageModelV2ToolResultPart = Extract<
  Extract<LanguageModelV2Message, { role: 'tool' }>['content'][number],
  { type: 'tool-result' }
>;
type LanguageModelV2ToolResultOutput = LanguageModelV2ToolResultPart['output'];

const logger = createLogger('MastraToolHistoryFilter');
const FILTER_STATE_KEY = 'brainstrikeProjectionSafeToolCallFilter';
const MULTIMODAL_PART_TYPES = new Set([
  'audio',
  'audio-data',
  'audio-url',
  'file',
  'file-data',
  'file-url',
  'image',
  'image-data',
  'image-url',
  'media',
]);

/**
 * A deliberately narrow allowlist. Verification, execution, mutation, task,
 * approval, discovery, skill, session, and unknown MCP tools stay verbatim.
 */
const FILTERABLE_NATIVE_TOOL_IDS = new Set<string>([
  NATIVE_TOOL_ID.findWorkspaceSymbol,
  NATIVE_TOOL_ID.globWorkspace,
  NATIVE_TOOL_ID.grepSearch,
  NATIVE_TOOL_ID.hybridSearch,
  NATIVE_TOOL_ID.listEmbeddingSpaces,
  NATIVE_TOOL_ID.listWorkspaceContext,
  NATIVE_TOOL_ID.queryEmbeddingSpace,
  NATIVE_TOOL_ID.readToolOutputArtifact,
  NATIVE_TOOL_ID.readWorkspaceContext,
  NATIVE_TOOL_ID.readWorkspaceDirectory,
  NATIVE_TOOL_ID.readWorkspaceFile,
  NATIVE_TOOL_ID.webExtract,
  NATIVE_TOOL_ID.webSearch,
]);

export const TOOL_HISTORY_FILTER_RECENT_TOOL_STEPS = 2;

interface FilterLogger {
  info(metadata: Record<string, unknown>, message: string): void;
}

interface MutableToolCall {
  id?: unknown;
}

interface MutableToolInvocation {
  result?: unknown;
  state?: unknown;
  toolCall?: MutableToolCall;
  toolCallId?: unknown;
  toolName?: unknown;
}

interface ToolInvocationPart {
  providerMetadata?: unknown;
  toolInvocation: MutableToolInvocation;
  type: 'tool-invocation';
}

interface ToolCallGroup {
  hasSafeResult: boolean;
  unsafe: boolean;
}

interface FilterState {
  readonly ineligibleToolCallCount: number;
  readonly recentToolCallCount: number;
  readonly safeToolCallIds: readonly string[];
}

const MESSAGE_BOUNDARY = Symbol('message-boundary');

export interface ProjectionSafeToolCallFilterOptions {
  readonly filterAfterToolSteps?: number;
  readonly logger?: FilterLogger;
  readonly toolNameMap: ReadonlyMap<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readToolInvocationPart(value: unknown): ToolInvocationPart | undefined {
  if (!(isRecord(value) && value['type'] === 'tool-invocation')) {
    return;
  }
  const invocation = value['toolInvocation'];
  if (!isRecord(invocation)) {
    return;
  }
  return value as unknown as ToolInvocationPart;
}

function readToolCallId(invocation: MutableToolInvocation): string | undefined {
  if (typeof invocation.toolCallId === 'string' && invocation.toolCallId.length > 0) {
    return invocation.toolCallId;
  }
  const nestedId = invocation.toolCall?.id;
  return typeof nestedId === 'string' && nestedId.length > 0 ? nestedId : undefined;
}

function readMessageInvocationParts(message: MastraDBMessage): ToolInvocationPart[] {
  const parts = isRecord(message.content) ? message.content['parts'] : undefined;
  if (!Array.isArray(parts)) {
    return [];
  }
  return parts.flatMap((part) => {
    const invocationPart = readToolInvocationPart(part);
    return invocationPart ? [invocationPart] : [];
  });
}

function readMessageParts(message: MastraDBMessage): unknown[] {
  const parts = isRecord(message.content) ? message.content['parts'] : undefined;
  return Array.isArray(parts) ? parts : [];
}

function* iterateHistoryPartsReverse(
  messages: readonly MastraDBMessage[]
): Generator<typeof MESSAGE_BOUNDARY | unknown> {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message) {
      continue;
    }
    const parts = readMessageParts(message);
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      yield parts[partIndex];
    }
    yield MESSAGE_BOUNDARY;
  }
}

function hasNonEmptyFailureValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === '') {
    return false;
  }
  if (typeof value === 'number') {
    return value > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function isErrorBearingResult(value: unknown): boolean {
  if (value instanceof Error || isGuardedToolError(value)) {
    return true;
  }
  if (!isRecord(value)) {
    return false;
  }
  if (value['ok'] === false || value['available'] === false) {
    return true;
  }
  return (
    hasNonEmptyFailureValue(value['error']) ||
    hasNonEmptyFailureValue(value['errors']) ||
    hasNonEmptyFailureValue(value['failed'])
  );
}

function containsMultimodalOutput(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'string') {
    return value.startsWith('data:');
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsMultimodalOutput(entry, seen));
  }
  const record = value as Record<string, unknown>;
  if (typeof record['type'] === 'string' && MULTIMODAL_PART_TYPES.has(record['type'])) {
    return true;
  }
  return Object.values(record).some((entry) => containsMultimodalOutput(entry, seen));
}

function modelOutputCanBePreserved(value: unknown): boolean {
  if (value === undefined || value === null || containsMultimodalOutput(value)) {
    return false;
  }
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value !== 'object') {
    return false;
  }
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function readStoredModelOutput(part: ToolInvocationPart): unknown {
  if (!isRecord(part.providerMetadata)) {
    return;
  }
  const mastraMetadata = part.providerMetadata['mastra'];
  if (!(isRecord(mastraMetadata) && Object.hasOwn(mastraMetadata, 'modelOutput'))) {
    return;
  }
  return mastraMetadata['modelOutput'];
}

/**
 * Strict provider-boundary equivalent of Mastra 1.51 ToolCallFilter.
 *
 * Mastra's processInput/processInputStep message transforms are applied back to
 * the live MessageList. Eligibility is therefore computed without mutation in
 * processInputStep, while the actual rewrite runs in processLLMRequest, the
 * documented transient hook after stored model projections are resolved.
 */
export class ProjectionSafeToolCallFilter implements Processor<'tool-call-filter'> {
  readonly id = 'tool-call-filter';
  readonly name = 'Projection-safe tool call filter';
  readonly #filterAfterToolSteps: number;
  readonly #logger: FilterLogger;
  readonly #toolNameMap: ReadonlyMap<string, string>;

  constructor(options: ProjectionSafeToolCallFilterOptions) {
    const filterAfterToolSteps =
      options.filterAfterToolSteps ?? TOOL_HISTORY_FILTER_RECENT_TOOL_STEPS;
    if (!(Number.isInteger(filterAfterToolSteps) && filterAfterToolSteps >= 0)) {
      throw new RangeError('filterAfterToolSteps must be a non-negative integer');
    }
    this.#filterAfterToolSteps = filterAfterToolSteps;
    this.#toolNameMap = options.toolNameMap;
    this.#logger = options.logger ?? {
      info: (metadata, message) => logger.info(metadata, message),
    };
  }

  processInputStep(args: ProcessInputStepArgs): void {
    const { ineligibleToolCallCount, recentToolCallCount, safeIds } = this.collectSafeToolCallIds(
      args.messages
    );
    args.state[FILTER_STATE_KEY] = {
      ineligibleToolCallCount,
      recentToolCallCount,
      safeToolCallIds: [...safeIds],
    } satisfies FilterState;
  }

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult | undefined {
    const filterState = this.readFilterState(args.state);
    if (!filterState || filterState.safeToolCallIds.length === 0) {
      return;
    }
    const { filteredToolCallCount, prompt } = this.filterPrompt(
      args.prompt,
      new Set(filterState.safeToolCallIds)
    );
    if (filteredToolCallCount === 0) {
      return;
    }
    this.#logger.info(
      {
        code: 'mastra_agent_tool_history_filtered',
        filteredToolCallCount,
        ineligibleToolCallCount: filterState.ineligibleToolCallCount,
        preservedRecentToolCallCount: filterState.recentToolCallCount,
        preservedRecentToolStepLimit: this.#filterAfterToolSteps,
      },
      'filtered stale tool history from provider input'
    );
    return { prompt };
  }

  private resolveOriginalToolName(registeredName: string): string {
    return this.#toolNameMap.get(registeredName) ?? denormalizeNativeToolName(registeredName);
  }

  private collectRecentToolCallIds(messages: readonly MastraDBMessage[]): Set<string> {
    const recentIds = new Set<string>();
    if (this.#filterAfterToolSteps === 0) {
      return recentIds;
    }
    const pendingStepIds = new Set<string>();
    let toolSteps = 0;

    const finishPendingStep = (): boolean => {
      const newIds = [...pendingStepIds].filter((id) => !recentIds.has(id));
      if (newIds.length > 0) {
        for (const id of pendingStepIds) {
          recentIds.add(id);
        }
        toolSteps += 1;
      }
      pendingStepIds.clear();
      return toolSteps >= this.#filterAfterToolSteps;
    };

    for (const part of iterateHistoryPartsReverse(messages)) {
      const invocationPart = readToolInvocationPart(part);
      if (invocationPart) {
        const toolCallId = readToolCallId(invocationPart.toolInvocation);
        if (toolCallId) {
          pendingStepIds.add(toolCallId);
        }
        continue;
      }
      const atStepBoundary =
        part === MESSAGE_BOUNDARY || (isRecord(part) && part['type'] === 'step-start');
      if (atStepBoundary && pendingStepIds.size > 0 && finishPendingStep()) {
        return recentIds;
      }
    }
    return recentIds;
  }

  private collectSafeToolCallIds(messages: readonly MastraDBMessage[]): {
    ineligibleToolCallCount: number;
    recentToolCallCount: number;
    safeIds: ReadonlySet<string>;
  } {
    const recentIds = this.collectRecentToolCallIds(messages);
    const groups = new Map<string, ToolCallGroup>();
    for (const message of messages) {
      for (const part of readMessageInvocationParts(message)) {
        this.updateToolCallGroup(groups, part);
      }
    }

    const safeIds = new Set<string>();
    let ineligibleToolCallCount = 0;
    for (const [toolCallId, group] of groups) {
      if (group.hasSafeResult && !group.unsafe && !recentIds.has(toolCallId)) {
        safeIds.add(toolCallId);
        continue;
      }
      ineligibleToolCallCount += 1;
    }
    return {
      ineligibleToolCallCount,
      recentToolCallCount: [...groups.keys()].filter((id) => recentIds.has(id)).length,
      safeIds,
    };
  }

  private updateToolCallGroup(groups: Map<string, ToolCallGroup>, part: ToolInvocationPart): void {
    const { toolInvocation } = part;
    const toolCallId = readToolCallId(toolInvocation);
    const toolName =
      typeof toolInvocation.toolName === 'string' ? toolInvocation.toolName : undefined;
    if (!(toolCallId && toolName)) {
      return;
    }
    if (!FILTERABLE_NATIVE_TOOL_IDS.has(this.resolveOriginalToolName(toolName))) {
      return;
    }
    const group = groups.get(toolCallId) ?? { hasSafeResult: false, unsafe: false };
    if (toolInvocation.state === 'result') {
      const modelOutput = readStoredModelOutput(part);
      const safeResult =
        !isErrorBearingResult(toolInvocation.result) && modelOutputCanBePreserved(modelOutput);
      group.hasSafeResult ||= safeResult;
      group.unsafe ||= !safeResult;
    } else if (toolInvocation.state !== 'call') {
      group.unsafe = true;
    }
    groups.set(toolCallId, group);
  }

  private readFilterState(state: Record<string, unknown>): FilterState | undefined {
    const value = state[FILTER_STATE_KEY];
    if (!(isRecord(value) && Array.isArray(value['safeToolCallIds']))) {
      return;
    }
    const safeToolCallIds = value['safeToolCallIds'].filter(
      (candidate): candidate is string => typeof candidate === 'string'
    );
    const ineligibleToolCallCount = value['ineligibleToolCallCount'];
    const recentToolCallCount = value['recentToolCallCount'];
    if (typeof ineligibleToolCallCount !== 'number' || typeof recentToolCallCount !== 'number') {
      return;
    }
    return { ineligibleToolCallCount, recentToolCallCount, safeToolCallIds };
  }

  private filterPrompt(
    prompt: LanguageModelV2Prompt,
    safeIds: ReadonlySet<string>
  ): { filteredToolCallCount: number; prompt: LanguageModelV2Prompt } {
    const calls = new Map<string, LanguageModelV2ToolCallPart>();
    const results = new Map<string, LanguageModelV2ToolResultPart>();
    for (const message of prompt) {
      if (!Array.isArray(message.content)) {
        continue;
      }
      for (const part of message.content) {
        if (part.type === 'tool-call' && safeIds.has(part.toolCallId)) {
          calls.set(part.toolCallId, part);
        } else if (part.type === 'tool-result' && safeIds.has(part.toolCallId)) {
          results.set(part.toolCallId, part);
        }
      }
    }

    const filterableIds = new Set(
      [...safeIds].filter((toolCallId) => calls.has(toolCallId) && results.has(toolCallId))
    );
    if (filterableIds.size === 0) {
      return { filteredToolCallCount: 0, prompt };
    }

    const filteredPrompt: LanguageModelV2Prompt = [];
    for (const message of prompt) {
      const filtered = this.filterPromptMessage(message, filterableIds, results);
      if (filtered) {
        filteredPrompt.push(filtered);
      }
    }
    return { filteredToolCallCount: filterableIds.size, prompt: filteredPrompt };
  }

  private filterPromptMessage(
    message: LanguageModelV2Message,
    filterableIds: ReadonlySet<string>,
    results: ReadonlyMap<string, LanguageModelV2ToolResultPart>
  ): LanguageModelV2Message | undefined {
    if (!Array.isArray(message.content)) {
      return message;
    }
    const content = message.content.flatMap((part) => {
      if (part.type === 'tool-call' && filterableIds.has(part.toolCallId)) {
        const result = results.get(part.toolCallId);
        const projection = result ? this.modelOutputToText(result.output) : undefined;
        return projection
          ? [{ text: `${part.toolName} result:\n${projection}`, type: 'text' as const }]
          : [part];
      }
      if (part.type === 'tool-result' && filterableIds.has(part.toolCallId)) {
        return [];
      }
      return [part];
    });
    if (content.length === 0) {
      return;
    }
    return { ...message, content } as LanguageModelV2Message;
  }

  private modelOutputToText(output: LanguageModelV2ToolResultOutput): string | undefined {
    if (output.type === 'text') {
      return output.value || undefined;
    }
    if (output.type === 'json') {
      return JSON.stringify(output.value);
    }
    if (output.type !== 'content') {
      return;
    }
    if (output.value.some((part) => part.type !== 'text')) {
      return;
    }
    const text = output.value.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
    return text || undefined;
  }
}
