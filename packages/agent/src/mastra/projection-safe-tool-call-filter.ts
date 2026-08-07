import { isGuardedToolError, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/logging';
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

export const TOOL_HISTORY_FILTER_RECENT_TOOL_STEPS = 1;

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

/**
 * Replacement text for a stale assistant tool-call part. Keeps the assistant
 * message non-empty so OpenAI's reasoning→following-item pairing stays valid,
 * without naming the tool or carrying result content: assistant-authored
 * `<toolName> result:` text taught GPT-5.x Harmony models to fabricate
 * tool-result dumps in their visible commentary output.
 */
const STALE_TOOL_CALL_STUB_TEXT =
  '[Stale tool call elided. Its result is replayed in a following user message.]';

function formatStaleToolResultReplay(toolName: string, projection: string): string {
  return `[Replayed context] Result of the assistant's earlier ${toolName} tool call:\n${projection}`;
}

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

function readMessageParts(message: MastraDBMessage): unknown[] {
  const parts = isRecord(message.content) ? message.content['parts'] : undefined;
  return Array.isArray(parts) ? parts : [];
}

function collectPromptToolParts(
  prompt: LanguageModelV2Prompt,
  safeIds: ReadonlySet<string>
): {
  calls: Map<string, LanguageModelV2ToolCallPart>;
  results: Map<string, LanguageModelV2ToolResultPart>;
} {
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
  return { calls, results };
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

  private collectRecentToolCallIds(
    messages: readonly MastraDBMessage[],
    eligibleIds: ReadonlySet<string>
  ): Set<string> {
    const recentIds = new Set<string>();
    if (this.#filterAfterToolSteps === 0) {
      return recentIds;
    }
    const pendingStepIds = new Set<string>();
    let toolSteps = 0;

    const finishPendingStep = (): boolean => {
      let hasNewId = false;
      for (const id of pendingStepIds) {
        if (!recentIds.has(id)) {
          hasNewId = true;
          break;
        }
      }
      if (hasNewId) {
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
        if (toolCallId && eligibleIds.has(toolCallId)) {
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
    const groups = new Map<string, ToolCallGroup>();
    for (const message of messages) {
      for (const part of readMessageParts(message)) {
        const invocationPart = readToolInvocationPart(part);
        if (invocationPart) {
          this.updateToolCallGroup(groups, invocationPart);
        }
      }
    }
    const eligibleIds = new Set<string>();
    for (const [toolCallId, group] of groups) {
      if (group.hasSafeResult && !group.unsafe) {
        eligibleIds.add(toolCallId);
      }
    }
    const recentIds = this.collectRecentToolCallIds(messages, eligibleIds);

    const safeIds = new Set<string>();
    let ineligibleToolCallCount = 0;
    let recentToolCallCount = 0;
    for (const [toolCallId, group] of groups) {
      if (recentIds.has(toolCallId)) {
        recentToolCallCount += 1;
      }
      if (group.hasSafeResult && !group.unsafe && !recentIds.has(toolCallId)) {
        safeIds.add(toolCallId);
        continue;
      }
      ineligibleToolCallCount += 1;
    }
    return {
      ineligibleToolCallCount,
      recentToolCallCount,
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
    const { calls, results } = collectPromptToolParts(prompt, safeIds);
    const projections = new Map<string, string>();
    for (const toolCallId of safeIds) {
      const result = results.get(toolCallId);
      if (!(calls.has(toolCallId) && result)) {
        continue;
      }
      const projection = this.modelOutputToText(result.output);
      if (projection) {
        projections.set(toolCallId, formatStaleToolResultReplay(result.toolName, projection));
      }
    }
    if (projections.size === 0) {
      return { filteredToolCallCount: 0, prompt };
    }

    const filteredPrompt: LanguageModelV2Prompt = [];
    for (const message of prompt) {
      const { message: filtered, replays } = this.filterPromptMessage(message, projections);
      if (filtered) {
        filteredPrompt.push(filtered);
      }
      if (replays.length > 0) {
        filteredPrompt.push({
          content: replays.map((text) => ({ text, type: 'text' as const })),
          role: 'user',
        } as LanguageModelV2Message);
      }
    }
    return { filteredToolCallCount: projections.size, prompt: filteredPrompt };
  }

  private filterPromptMessage(
    message: LanguageModelV2Message,
    projections: ReadonlyMap<string, string>
  ): { message: LanguageModelV2Message | undefined; replays: string[] } {
    if (!Array.isArray(message.content)) {
      return { message, replays: [] };
    }
    const content: unknown[] = [];
    const replays: string[] = [];
    for (const part of message.content) {
      if (part.type === 'tool-call' && projections.has(part.toolCallId)) {
        content.push({ text: STALE_TOOL_CALL_STUB_TEXT, type: 'text' });
        continue;
      }
      if (part.type === 'tool-result' && projections.has(part.toolCallId)) {
        const replay = projections.get(part.toolCallId);
        if (replay) {
          replays.push(replay);
        }
        continue;
      }
      content.push(part);
    }
    if (content.length === 0) {
      return { message: undefined, replays };
    }
    return { message: { ...message, content } as LanguageModelV2Message, replays };
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
