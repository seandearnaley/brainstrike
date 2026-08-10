import { randomUUID } from 'node:crypto';
import {
  AgenticCompactionSummarySchemaError,
  type AgentMessage,
  type CompactionMessage,
  type CompactionRangeEntry,
  estimateCompactionMessageTokens,
  extractProviderRunError,
  filterMessagesByCompactionRanges,
  generateAgenticCompactionSummary,
  getDefaultModel,
  isContextOverflowProviderErrorCode,
  projectCompactionMessages,
  projectCompactionMessagesForSummarizer,
  type RuntimeData,
  type ToolProjectionRewriteEntry,
} from '@brainstrike/agent';
import type { PgliteMemoryStore } from '@brainstrike/agent/pglite-mastra-memory';
import {
  COMPACTION_SUMMARY_METADATA_KEY,
  type CompactionSummaryPayload,
} from '@brainstrike/assistant-contract/compaction-summary';
import { deriveEffectiveInputBudget } from '@brainstrike/assistant-contract/context-budget';
import {
  findLlmModelDefinition,
  type ProviderId,
} from '@brainstrike/assistant-contract/provider-registry';
import type { AssistantChildRunUsage } from '@brainstrike/assistant-contract/run-usage';
import {
  createPgliteAssistantThreadRepository,
  type RecordAssistantMessageParentInput,
} from '@brainstrike/assistant-data';
import type { DbHandle } from '@brainstrike/db/react';
import { createLogger } from '@brainstrike/logging';
import { getDatabase } from '../db-main';
import { recordCompactionRange, selectProtectedMessageIds } from './compaction-range-repository';
import { runRecencyPruneScan } from './tool-projection-rewrite-repository';

const logger = createLogger('ConversationCompaction');
export const COMPACTION_TRIGGER_RATIO = 0.9;
export const COMPACTION_TARGET_RATIO = 0.7;

type StoredMessage = Awaited<ReturnType<PgliteMemoryStore['listMessages']>>['messages'][number];
type MemoryStore = Pick<PgliteMemoryStore, 'listMessages' | 'saveMessages'>;

export interface ConversationCompactionInput {
  readonly memoryStore: MemoryStore;
  readonly runtimeData: RuntimeData;
}

export interface PreRequestCompactionInput extends ConversationCompactionInput {
  readonly requestMessages: readonly AgentMessage[];
  readonly runId: string | undefined;
  readonly signal: AbortSignal;
}

export type PreRequestCompactionResult =
  | { readonly kind: 'noop' }
  | {
      readonly kind: 'agentic' | 'deterministic';
      readonly usage?: AssistantChildRunUsage;
    };

interface ConversationCompactionDependencies {
  readonly estimateVisibleTokens: (messages: readonly CompactionMessage[]) => number;
  readonly generateSummary: typeof generateAgenticCompactionSummary;
  readonly listCompactionRanges: (
    threadId: string,
    runtimeData: RuntimeData
  ) => Promise<readonly CompactionRangeEntry[]>;
  readonly listToolProjectionRewrites: (
    threadId: string,
    runtimeData: RuntimeData
  ) => Promise<ReadonlyMap<string, ToolProjectionRewriteEntry>>;
  readonly makeId: () => string;
  readonly now: () => Date;
  readonly projectMessages: typeof projectCompactionMessages;
  readonly recordMessageParent: (input: RecordAssistantMessageParentInput) => Promise<void>;
  readonly recordRange: typeof recordCompactionRange;
  readonly resolveInputBudget: typeof resolveCompactionInputBudget;
  readonly runRecencyPrune: typeof runRecencyPruneScan;
}

type PartialConversationCompactionDependencies = Partial<ConversationCompactionDependencies>;

interface CompactionMessageState {
  readonly messages: readonly CompactionMessage[];
  readonly usageTokens: number;
}

interface ProjectedCompactionState extends CompactionMessageState {
  readonly projectedMessages: readonly CompactionMessage[];
}

function defaultDependencies(
  overrides: PartialConversationCompactionDependencies
): ConversationCompactionDependencies {
  return {
    estimateVisibleTokens: estimateCompactionMessageTokens,
    generateSummary: generateAgenticCompactionSummary,
    listCompactionRanges: async (threadId, runtimeData) => {
      const lookup = runtimeData.compactionOverlayLookup;
      if (!lookup) {
        throw new Error('Conversation compaction requires the trusted compaction overlay lookup.');
      }
      return await lookup.listActiveCompactionRanges(threadId);
    },
    listToolProjectionRewrites: async (threadId, runtimeData) => {
      const lookup = runtimeData.toolProjectionRewriteLookup;
      if (!lookup) {
        throw new Error('Conversation compaction requires the trusted tool projection lookup.');
      }
      return await lookup.listActiveRewrites(threadId);
    },
    makeId: randomUUID,
    now: () => new Date(),
    projectMessages: projectCompactionMessages,
    recordMessageParent: async (input) => {
      const database = await getDatabase();
      const repository = createPgliteAssistantThreadRepository(database as unknown as DbHandle);
      if (!repository.recordMessageParent) {
        throw new Error('Conversation compaction requires durable assistant message topology.');
      }
      await repository.recordMessageParent(input);
    },
    recordRange: recordCompactionRange,
    resolveInputBudget: resolveCompactionInputBudget,
    runRecencyPrune: runRecencyPruneScan,
    ...overrides,
  };
}

function requireThreadContext(runtimeData: RuntimeData):
  | {
      readonly resourceId: string;
      readonly threadId: string;
    }
  | undefined {
  const resourceId = runtimeData.memory?.resourceId;
  const threadId = runtimeData.memory?.threadId;
  if (!(resourceId && threadId)) {
    return;
  }
  return { resourceId, threadId };
}

export function resolveCompactionInputBudget(runtimeData: RuntimeData): number {
  const provider = runtimeData.provider?.trim();
  const model = runtimeData.model?.trim() || (provider ? getDefaultModel(provider) : '');
  if (!(provider && model)) {
    throw new Error('Conversation compaction requires the run provider and model.');
  }
  const definition = findLlmModelDefinition(provider as ProviderId, model);
  if (!definition) {
    const explicitBudget = runtimeData.agentLoop?.inputTokenLimit;
    if (Number.isSafeInteger(explicitBudget) && (explicitBudget ?? 0) > 0) {
      return explicitBudget as number;
    }
    throw new Error(`Unknown compaction input budget for ${provider}/${model}.`);
  }
  return deriveEffectiveInputBudget(definition.contextWindow, definition.maxOutputTokens);
}

function isAtTrigger(usageTokens: number, inputBudget: number): boolean {
  return usageTokens >= COMPACTION_TRIGGER_RATIO * inputBudget;
}

function isNonRetryableSummarizerFailure(error: unknown): boolean {
  if (error instanceof AgenticCompactionSummarySchemaError) {
    return true;
  }
  return isContextOverflowProviderErrorCode(extractProviderRunError(error).code);
}

async function loadMessages(
  input: ConversationCompactionInput,
  dependencies: ConversationCompactionDependencies,
  requestMessages: readonly AgentMessage[] = []
): Promise<readonly CompactionMessage[]> {
  const context = requireThreadContext(input.runtimeData);
  if (!context) {
    return [];
  }
  const [listed, ranges] = await Promise.all([
    input.memoryStore.listMessages({
      orderBy: { direction: 'ASC', field: 'createdAt' },
      perPage: false,
      resourceId: context.resourceId,
      threadId: context.threadId,
    }),
    dependencies.listCompactionRanges(context.threadId, input.runtimeData),
  ]);
  const durableMessages = filterMessagesByCompactionRanges(
    listed.messages,
    ranges
  ) as readonly StoredMessage[];
  const durableIds = new Set(durableMessages.map(({ id }) => id));
  const messages: CompactionMessage[] = [...durableMessages];
  for (const message of requestMessages) {
    if (!durableIds.has(message.id)) {
      messages.push({
        content: { format: 2, parts: message.parts },
        id: message.id,
        role: message.role,
      });
    }
  }
  return messages;
}

async function loadUnprojectedState(
  input: ConversationCompactionInput,
  dependencies: ConversationCompactionDependencies,
  requestMessages: readonly AgentMessage[] = []
): Promise<CompactionMessageState> {
  const messages = await loadMessages(input, dependencies, requestMessages);
  return { messages, usageTokens: dependencies.estimateVisibleTokens(messages) };
}

async function loadProjectedState(
  input: ConversationCompactionInput,
  dependencies: ConversationCompactionDependencies,
  requestMessages: readonly AgentMessage[] = []
): Promise<ProjectedCompactionState> {
  const context = requireThreadContext(input.runtimeData);
  if (!context) {
    return { messages: [], projectedMessages: [], usageTokens: 0 };
  }
  const [messages, rewrites] = await Promise.all([
    loadMessages(input, dependencies, requestMessages),
    dependencies.listToolProjectionRewrites(context.threadId, input.runtimeData),
  ]);
  const projectedMessages = dependencies.projectMessages(messages, rewrites);
  return {
    messages,
    projectedMessages,
    usageTokens: dependencies.estimateVisibleTokens(projectedMessages),
  };
}

function candidateIds(messages: readonly CompactionMessage[]): Set<string> {
  const protectedIds = selectProtectedMessageIds({ messages });
  const ids = new Set<string>();
  for (const message of messages) {
    if (!protectedIds.has(message.id)) {
      ids.add(message.id);
    }
  }
  return ids;
}

function orderedProjectedCandidates(
  state: ProjectedCompactionState,
  ids: ReadonlySet<string>
): readonly CompactionMessage[] {
  return state.projectedMessages.filter((message) => ids.has(message.id));
}

function requireCreatedAt(message: CompactionMessage): Date {
  if (!(message.createdAt instanceof Date && Number.isFinite(message.createdAt.getTime()))) {
    throw new Error(`Compaction candidate ${message.id} has no valid creation time.`);
  }
  return message.createdAt;
}

function selectDeterministicCandidates(
  state: ProjectedCompactionState,
  inputBudget: number,
  dependencies: ConversationCompactionDependencies
): readonly CompactionMessage[] {
  const ids = candidateIds(state.messages);
  const candidates = orderedProjectedCandidates(state, ids);
  if (candidates.length === 0) {
    return [];
  }
  const target = COMPACTION_TARGET_RATIO * inputBudget;
  const reclaimNeeded = Math.max(1, state.usageTokens - target);
  let reclaimed = 0;
  const selected: CompactionMessage[] = [];
  for (const candidate of candidates) {
    selected.push(candidate);
    reclaimed += dependencies.estimateVisibleTokens([candidate]);
    if (reclaimed >= reclaimNeeded) {
      break;
    }
  }
  return selected;
}

function usageForSummary(
  summary: { readonly inputTokens: number; readonly outputTokens: number },
  runtimeData: RuntimeData
): AssistantChildRunUsage {
  const provider = runtimeData.provider?.trim();
  const model = runtimeData.model?.trim() || (provider ? getDefaultModel(provider) : '');
  if (!(provider && model)) {
    throw new Error('Compaction usage attribution requires the run provider and model.');
  }
  return {
    estimated: false,
    inputTokens: summary.inputTokens,
    model,
    outputTokens: summary.outputTokens,
    provider,
    source: 'compaction-summary',
  };
}

async function commitSummary(input: {
  readonly candidates: readonly CompactionMessage[];
  readonly dependencies: ConversationCompactionDependencies;
  readonly droppedSummaryLine?: string;
  readonly kind: 'agentic' | 'deterministic';
  readonly memoryStore: MemoryStore;
  readonly runtimeData: RuntimeData;
  readonly text: string;
}): Promise<void> {
  const context = requireThreadContext(input.runtimeData);
  const first = input.candidates[0];
  const last = input.candidates.at(-1);
  if (!(context && first && last)) {
    return;
  }
  const createdAt = input.dependencies.now();
  const compactionMessageId = input.dependencies.makeId();
  const rewriteId = input.dependencies.makeId();
  const payload: CompactionSummaryPayload = {
    createdAt: createdAt.toISOString(),
    ...(input.droppedSummaryLine ? { droppedSummaryLine: input.droppedSummaryLine } : {}),
    fallbackKind: input.kind,
    firstCompactedMessageId: first.id,
    lastCompactedMessageId: last.id,
    rewriteId,
  };
  const message: StoredMessage = {
    content: {
      format: 2,
      metadata: { custom: { [COMPACTION_SUMMARY_METADATA_KEY]: payload } },
      parts: [{ text: input.text, type: 'text' }],
    },
    createdAt,
    id: compactionMessageId,
    resourceId: context.resourceId,
    role: 'assistant',
    threadId: context.threadId,
    type: 'v2',
  };
  await input.memoryStore.saveMessages({ messages: [message] });
  await input.dependencies.recordMessageParent({
    messageId: compactionMessageId,
    parentId: null,
    resourceId: context.resourceId,
    threadId: context.threadId,
  });
  await input.dependencies.recordRange({
    compactedMessageIds: input.candidates.map(({ id }) => id),
    compactionMessageId,
    kind: input.kind,
    rewriteId,
    runtimeData: input.runtimeData,
  });
}

function deterministicDropLine(
  candidates: readonly CompactionMessage[],
  reason: 'agentic summarizer failure' | 'provider context-overflow error'
): string {
  const first = candidates[0];
  const last = candidates.at(-1);
  if (!(first && last)) {
    throw new Error('Deterministic compaction requires at least one candidate.');
  }
  return `Deterministic fallback: dropped ${candidates.length} messages spanning ${requireCreatedAt(first).toISOString()} to ${requireCreatedAt(last).toISOString()} after a ${reason}; no summarization model ran.`;
}

async function commitDeterministicFallback(input: {
  readonly dependencies: ConversationCompactionDependencies;
  readonly inputBudget: number;
  readonly memoryStore: MemoryStore;
  readonly reason: 'agentic summarizer failure' | 'provider context-overflow error';
  readonly runtimeData: RuntimeData;
  readonly state: ProjectedCompactionState;
}): Promise<boolean> {
  const candidates = selectDeterministicCandidates(
    input.state,
    input.inputBudget,
    input.dependencies
  );
  if (candidates.length === 0) {
    return false;
  }
  const line = deterministicDropLine(candidates, input.reason);
  await commitSummary({
    candidates,
    dependencies: input.dependencies,
    droppedSummaryLine: line,
    kind: 'deterministic',
    memoryStore: input.memoryStore,
    runtimeData: input.runtimeData,
    text: line,
  });
  return true;
}

export async function runPreRequestCompaction(
  input: PreRequestCompactionInput,
  dependencyOverrides: PartialConversationCompactionDependencies = {}
): Promise<PreRequestCompactionResult> {
  const context = requireThreadContext(input.runtimeData);
  if (!context) {
    return { kind: 'noop' };
  }
  const dependencies = defaultDependencies(dependencyOverrides);
  const inputBudget = dependencies.resolveInputBudget(input.runtimeData);
  const triggerState = await loadUnprojectedState(input, dependencies, input.requestMessages);
  if (!isAtTrigger(triggerState.usageTokens, inputBudget)) {
    return { kind: 'noop' };
  }

  await dependencies.runRecencyPrune(
    { runtimeData: input.runtimeData, threadId: context.threadId },
    {}
  );
  const state = await loadProjectedState(input, dependencies, input.requestMessages);
  if (!isAtTrigger(state.usageTokens, inputBudget)) {
    return { kind: 'noop' };
  }

  const ids = candidateIds(state.messages);
  const candidates = orderedProjectedCandidates(state, ids);
  if (candidates.length === 0) {
    return { kind: 'noop' };
  }
  const projectedInput = projectCompactionMessagesForSummarizer(candidates, new Map());
  try {
    const summary = await dependencies.generateSummary({
      projectedInput,
      runtimeData: input.runtimeData,
      signal: input.signal,
    });
    await commitSummary({
      candidates,
      dependencies,
      kind: 'agentic',
      memoryStore: input.memoryStore,
      runtimeData: input.runtimeData,
      text: summary.text,
    });
    return { kind: 'agentic', usage: usageForSummary(summary, input.runtimeData) };
  } catch (error) {
    if (input.signal.aborted || !isNonRetryableSummarizerFailure(error)) {
      logger.warn('Agentic compaction failed; leaving history intact for a later retry', {
        code: 'agentic_compaction_retryable_failure',
        error,
        threadId: context.threadId,
      });
      return { kind: 'noop' };
    }
    logger.warn('Agentic compaction failed; applying deterministic fallback', {
      code: 'agentic_compaction_failed',
      error,
      threadId: context.threadId,
    });
    const usage =
      error instanceof AgenticCompactionSummarySchemaError
        ? usageForSummary(error.usage, input.runtimeData)
        : undefined;
    const applied = await commitDeterministicFallback({
      dependencies,
      inputBudget,
      memoryStore: input.memoryStore,
      reason: 'agentic summarizer failure',
      runtimeData: input.runtimeData,
      state,
    });
    return applied ? { kind: 'deterministic', ...(usage ? { usage } : {}) } : { kind: 'noop' };
  }
}

export function createContextOverflowRecovery(
  input: ConversationCompactionInput,
  dependencyOverrides: PartialConversationCompactionDependencies = {}
): () => Promise<{ readonly applied: boolean }> {
  const dependencies = defaultDependencies(dependencyOverrides);
  return async () => {
    const inputBudget = dependencies.resolveInputBudget(input.runtimeData);
    const state = await loadProjectedState(input, dependencies);
    const applied = await commitDeterministicFallback({
      dependencies,
      inputBudget,
      memoryStore: input.memoryStore,
      reason: 'provider context-overflow error',
      runtimeData: input.runtimeData,
      state,
    });
    return { applied };
  };
}
