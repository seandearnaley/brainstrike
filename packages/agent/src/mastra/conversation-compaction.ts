import { countTokensHeuristic } from '@brainstrike/tokenization';
import {
  COMPACTION_SUMMARIZER_INSTRUCTIONS,
  hasCompactionSummarySchema,
} from '../compaction-summary-schema';
import type { RuntimeData, ToolProjectionRewriteEntry } from '../types';
import type { MastraAgentRuntime } from './agent-runtime';
import { createMastraAgentRuntime } from './agent-runtime';

export interface CompactionMessage {
  readonly content: unknown;
  readonly createdAt?: Date;
  readonly id: string;
  readonly role: string;
}

export interface AgenticCompactionSummary {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly text: string;
}

export class AgenticCompactionSummarySchemaError extends Error {
  readonly usage: Pick<AgenticCompactionSummary, 'inputTokens' | 'outputTokens'>;

  constructor(usage: Pick<AgenticCompactionSummary, 'inputTokens' | 'outputTokens'>) {
    super('Compaction summarizer response violated the required five-section schema.');
    this.name = 'AgenticCompactionSummarySchemaError';
    this.usage = usage;
  }
}

interface GenerateCompactionSummaryDependencies {
  readonly createRuntime?: typeof createMastraAgentRuntime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return;
  }
}

function contentParts(content: unknown): readonly unknown[] {
  if (!isRecord(content)) {
    return [];
  }
  if (Array.isArray(content['parts'])) {
    return content['parts'];
  }
  const flattened = content['content'];
  if (Array.isArray(flattened)) {
    return flattened;
  }
  return typeof flattened === 'string' ? [{ text: flattened, type: 'text' }] : [];
}

export function collectCompactionToolCallIds(content: unknown): Set<string> {
  const present = new Set<string>();
  const pending: unknown[] = [content];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!(value && typeof value === 'object')) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    const invocation = isRecord(value['toolInvocation']) ? value['toolInvocation'] : undefined;
    const toolCallId = invocation?.['toolCallId'] ?? value['toolCallId'];
    if (typeof toolCallId === 'string' && toolCallId.length > 0) {
      present.add(toolCallId);
    }
    pending.push(...Object.values(value));
  }
  return present;
}

function collectPresentToolCallIds(messages: readonly CompactionMessage[]): Set<string> {
  const present = new Set<string>();
  for (const message of messages) {
    for (const toolCallId of collectCompactionToolCallIds(message.content)) {
      present.add(toolCallId);
    }
  }
  return present;
}

function activeRewrite(
  toolCallId: unknown,
  rewrites: ReadonlyMap<string, ToolProjectionRewriteEntry>,
  presentToolCallIds: ReadonlySet<string>
): ToolProjectionRewriteEntry | undefined {
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    return;
  }
  const rewrite = rewrites.get(toolCallId);
  if (!rewrite) {
    return;
  }
  if (!rewrite.markerText.trim()) {
    throw new Error('Tool projection rewrite marker must be non-empty.');
  }
  if (rewrite.kind === 'supersession' && !presentToolCallIds.has(rewrite.supersededByToolCallId)) {
    return;
  }
  return rewrite;
}

function markerModelOutput(markerText: string): { readonly type: 'text'; readonly value: string } {
  return { type: 'text', value: markerText };
}

function projectNode(
  value: unknown,
  rewrites: ReadonlyMap<string, ToolProjectionRewriteEntry>,
  presentToolCallIds: ReadonlySet<string>,
  seen: WeakMap<object, unknown>
): unknown {
  if (!(value && typeof value === 'object')) {
    return value;
  }
  const prior = seen.get(value);
  if (prior !== undefined) {
    return prior;
  }
  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    seen.set(value, projected);
    projected.push(...value.map((entry) => projectNode(entry, rewrites, presentToolCallIds, seen)));
    return projected;
  }
  if (!isRecord(value)) {
    return value;
  }

  const projected: Record<string, unknown> = {};
  seen.set(value, projected);
  for (const [key, entry] of Object.entries(value)) {
    projected[key] = projectNode(entry, rewrites, presentToolCallIds, seen);
  }

  const invocation = isRecord(value['toolInvocation']) ? value['toolInvocation'] : undefined;
  const toolCallId = invocation?.['toolCallId'] ?? value['toolCallId'];
  const rewrite = activeRewrite(toolCallId, rewrites, presentToolCallIds);
  if (!rewrite) {
    return projected;
  }

  if (invocation) {
    const projectedInvocation = isRecord(projected['toolInvocation'])
      ? projected['toolInvocation']
      : {};
    projectedInvocation['result'] = rewrite.markerText;
    projectedInvocation['output'] = markerModelOutput(rewrite.markerText);
    projected['toolInvocation'] = projectedInvocation;
    projected['result'] = rewrite.markerText;
    projected['output'] = markerModelOutput(rewrite.markerText);
    projected['providerMetadata'] = {
      mastra: { modelOutput: markerModelOutput(rewrite.markerText) },
    };
    return projected;
  }

  if (value['type'] === 'tool-result') {
    projected['output'] = markerModelOutput(rewrite.markerText);
    projected['result'] = rewrite.markerText;
  }
  return projected;
}

/**
 * Build the auxiliary summarizer's transcript from the same active rewrite
 * semantics as ToolProjectionRewriteProcessor, without entering a live Mastra
 * request pipeline. Raw rewritten tool results are removed before serialization.
 */
export function projectCompactionMessages(
  messages: readonly CompactionMessage[],
  rewrites: ReadonlyMap<string, ToolProjectionRewriteEntry>
): readonly CompactionMessage[] {
  const presentToolCallIds = collectPresentToolCallIds(messages);
  return messages.map((message) => ({
    ...message,
    content: projectNode(message.content, rewrites, presentToolCallIds, new WeakMap()),
  }));
}

export function projectCompactionMessagesForSummarizer(
  messages: readonly CompactionMessage[],
  rewrites: ReadonlyMap<string, ToolProjectionRewriteEntry>
): string {
  return projectCompactionMessages(messages, rewrites)
    .map((message) =>
      JSON.stringify({
        content: message.content,
        createdAt: message.createdAt?.toISOString(),
        id: message.id,
        role: message.role,
      })
    )
    .join('\n');
}

function countSerialized(value: unknown): number {
  const serialized = safeStringify(value);
  return serialized ? countTokensHeuristic(serialized) : 0;
}

function estimateCompactionPartTokens(partValue: unknown): number {
  if (!isRecord(partValue)) {
    return 0;
  }
  if (
    (partValue['type'] === 'text' || partValue['type'] === 'reasoning') &&
    typeof partValue['text'] === 'string'
  ) {
    return countTokensHeuristic(partValue['text']);
  }
  if (partValue['type'] === 'tool-invocation' && isRecord(partValue['toolInvocation'])) {
    const invocation = partValue['toolInvocation'];
    return (
      countSerialized(invocation['args']) +
      countSerialized(invocation['result'] ?? invocation['output'])
    );
  }
  if (partValue['type'] === 'tool-call' || partValue['type'] === 'tool-result') {
    return (
      countSerialized(partValue['args'] ?? partValue['input']) +
      countSerialized(partValue['result'] ?? partValue['output'])
    );
  }
  if (partValue['type'] === 'file' || partValue['type'] === 'image') {
    return countTokensHeuristic(
      `[attachment ${String(partValue['mediaType'] ?? 'unknown')} ${String(partValue['filename'] ?? '')}]`
    );
  }
  return 0;
}

/**
 * Server-side mirror of BST-940's renderer conversation walk. This deliberately
 * uses the shared chars/4 counter, while walking persisted Mastra v2 parts.
 */
export function estimateCompactionMessageTokens(messages: readonly CompactionMessage[]): number {
  let total = 0;
  for (const message of messages) {
    for (const partValue of contentParts(message.content)) {
      total += estimateCompactionPartTokens(partValue);
    }
  }
  return total;
}

function requireProviderUsage(value: unknown, field: 'inputTokens' | 'outputTokens'): number {
  if (!isRecord(value)) {
    throw new Error('Compaction summarizer omitted provider-reported usage.');
  }
  const count = value[field];
  if (!(typeof count === 'number' && Number.isFinite(count) && count >= 0)) {
    throw new Error(`Compaction summarizer omitted provider-reported ${field}.`);
  }
  return count;
}

export async function generateAgenticCompactionSummary(
  input: {
    readonly projectedInput: string;
    readonly runtimeData: RuntimeData;
    readonly signal: AbortSignal;
  },
  dependencies: GenerateCompactionSummaryDependencies = {}
): Promise<AgenticCompactionSummary> {
  const createRuntime = dependencies.createRuntime ?? createMastraAgentRuntime;
  const {
    agentLoop: _agentLoop,
    compactionOverlayLookup: _compactionOverlayLookup,
    contextOverflowRecovery: _contextOverflowRecovery,
    hookRunner: _hookRunner,
    memory: _memory,
    mastraTools: _mastraTools,
    mcpConfig: _mcpConfig,
    personas: _personas,
    permissionPolicy: _permissionPolicy,
    taskList: _taskList,
    toolProjectionRewriteLookup: _toolProjectionRewriteLookup,
    workspaceSkills: _workspaceSkills,
    ...summaryRuntimeData
  } = input.runtimeData;
  let runtime: MastraAgentRuntime | undefined;
  try {
    runtime = await createRuntime({
      instructions: COMPACTION_SUMMARIZER_INSTRUCTIONS,
      runtime: summaryRuntimeData,
      tools: {},
    });
    const result = await runtime.agent.generate(input.projectedInput, {
      abortSignal: input.signal,
      activeTools: [],
      maxSteps: 1,
    });
    const usage = {
      inputTokens: requireProviderUsage(result.totalUsage, 'inputTokens'),
      outputTokens: requireProviderUsage(result.totalUsage, 'outputTokens'),
    };
    if (!hasCompactionSummarySchema(result.text)) {
      throw new AgenticCompactionSummarySchemaError(usage);
    }
    return {
      ...usage,
      text: result.text,
    };
  } finally {
    await runtime?.dispose();
  }
}
