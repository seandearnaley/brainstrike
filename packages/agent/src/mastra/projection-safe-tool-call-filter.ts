import { isGuardedToolError, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/utils';
import { type MastraDBMessage, MessageList } from '@mastra/core/agent';
import {
  type ProcessInputArgs,
  type ProcessInputStepArgs,
  type ProcessInputStepResult,
  type Processor,
  ToolCallFilter,
} from '@mastra/core/processors';

const logger = createLogger('MastraToolHistoryFilter');
const PROTECTED_TOOL_NAME_PREFIX = '__brainstrike_preserve_tool_history__';
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

function readMutableInvocations(message: MastraDBMessage): MutableToolInvocation[] {
  const content = isRecord(message.content) ? message.content : undefined;
  if (!content) {
    return [];
  }
  const containers: unknown[] = [
    ...(Array.isArray(content['parts']) ? content['parts'] : []),
    ...(Array.isArray(content['toolInvocations']) ? content['toolInvocations'] : []),
  ];
  return containers.flatMap((container) => {
    const invocationPart = readToolInvocationPart(container);
    const invocation =
      invocationPart?.toolInvocation ?? (isRecord(container) ? container : undefined);
    return invocation ? [invocation] : [];
  });
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

function protectToolName(toolName: string): string {
  return `${PROTECTED_TOOL_NAME_PREFIX}${toolName}`;
}

function restoreToolName(toolName: unknown): unknown {
  if (!(typeof toolName === 'string' && toolName.startsWith(PROTECTED_TOOL_NAME_PREFIX))) {
    return toolName;
  }
  return toolName.slice(PROTECTED_TOOL_NAME_PREFIX.length);
}

/**
 * Strict eligibility/window shell around Mastra 1.51 ToolCallFilter.
 *
 * Mastra filters by name, not call id, and its recent-step state starts fresh
 * on every request. We protect every ineligible call on a provider-input clone,
 * then let the stock filter replace only safe completed results with their
 * stored model projection. The original MessageList is never mutated.
 */
export class ProjectionSafeToolCallFilter implements Processor<'tool-call-filter'> {
  readonly id = 'tool-call-filter';
  readonly name = 'Projection-safe tool call filter';
  readonly #delegate: ToolCallFilter;
  readonly #filterAfterToolSteps: number;
  readonly #filterableRegisteredNames: readonly string[];
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
    this.#filterableRegisteredNames = this.resolveFilterableRegisteredNames();
    this.#delegate = new ToolCallFilter({
      exclude: [...this.#filterableRegisteredNames],
      preserveModelOutput: true,
    });
  }

  async processInput(args: ProcessInputArgs): Promise<MastraDBMessage[]> {
    return await this.filterProviderInput(args.messages, args);
  }

  async processInputStep(args: ProcessInputStepArgs): Promise<ProcessInputStepResult> {
    return { messages: await this.filterProviderInput(args.messages, args) };
  }

  private resolveFilterableRegisteredNames(): readonly string[] {
    const names = new Set<string>();
    for (const nativeId of FILTERABLE_NATIVE_TOOL_IDS) {
      names.add(nativeId);
      names.add(nativeId.replace(/[^a-zA-Z0-9_-]/gu, '_'));
    }
    for (const [registeredName, originalName] of this.#toolNameMap) {
      if (FILTERABLE_NATIVE_TOOL_IDS.has(originalName)) {
        names.add(registeredName);
      }
    }
    return [...names];
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

  private shouldProtectInvocation(
    invocation: MutableToolInvocation,
    safeIds: ReadonlySet<string>
  ): boolean {
    const toolCallId = readToolCallId(invocation);
    const toolName = typeof invocation.toolName === 'string' ? invocation.toolName : undefined;
    if (!(toolCallId && toolName && !safeIds.has(toolCallId))) {
      return false;
    }
    return FILTERABLE_NATIVE_TOOL_IDS.has(this.resolveOriginalToolName(toolName));
  }

  private cloneWithIneligibleCallsProtected(
    messages: readonly MastraDBMessage[],
    safeIds: ReadonlySet<string>
  ): MastraDBMessage[] {
    const cloned = structuredClone(messages) as MastraDBMessage[];
    for (const message of cloned) {
      for (const invocation of readMutableInvocations(message)) {
        const toolName = typeof invocation.toolName === 'string' ? invocation.toolName : undefined;
        if (!(toolName && this.shouldProtectInvocation(invocation, safeIds))) {
          continue;
        }
        invocation.toolName = protectToolName(toolName);
      }
    }
    return cloned;
  }

  private restoreProtectedToolNames(messages: readonly MastraDBMessage[]): MastraDBMessage[] {
    for (const message of messages) {
      for (const invocation of readMutableInvocations(message)) {
        invocation.toolName = restoreToolName(invocation.toolName);
      }
    }
    return [...messages];
  }

  private async filterProviderInput(
    messages: readonly MastraDBMessage[],
    args: Pick<ProcessInputArgs, 'abort' | 'requestContext'>
  ): Promise<MastraDBMessage[]> {
    const { ineligibleToolCallCount, recentToolCallCount, safeIds } =
      this.collectSafeToolCallIds(messages);
    if (safeIds.size === 0) {
      return [...messages];
    }

    const protectedMessages = this.cloneWithIneligibleCallsProtected(messages, safeIds);
    const filteredMessageList = new MessageList();
    for (const message of protectedMessages) {
      filteredMessageList.add(message, 'memory');
    }
    const filtered = await this.#delegate.processInput({
      abort: args.abort,
      messageList: filteredMessageList,
      messages: filteredMessageList.get.all.db(),
      ...(args.requestContext ? { requestContext: args.requestContext } : {}),
    });
    if (!Array.isArray(filtered)) {
      throw new TypeError('Mastra ToolCallFilter returned an unexpected MessageList result');
    }
    const restored = this.restoreProtectedToolNames(filtered);
    this.#logger.info(
      {
        code: 'mastra_agent_tool_history_filtered',
        filteredToolCallCount: safeIds.size,
        ineligibleToolCallCount,
        preservedRecentToolCallCount: recentToolCallCount,
        preservedRecentToolStepLimit: this.#filterAfterToolSteps,
      },
      'filtered stale tool history from provider input'
    );
    return restored;
  }
}
