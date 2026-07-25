/**
 * Mastra agent streaming (BST-742): the stream entry points
 * (`streamMastraAgent`, `streamMastraToolApprovalAction`,
 * `streamMastraToolResumeAction`, `listSuspendedMastraRuns`) plus the private
 * stream-part mapping, provider-error termination, and tool-loop option
 * machinery they share. Runtime ASSEMBLY (the factory + tool pipeline) lives
 * in `agent-runtime.ts` / `runtime-assembly/`; this module depends on it,
 * never the reverse. See docs/agents/assistant-runtime.md.
 */
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  getLlmModelDefinition,
  resolveOpenRouterCodingMaxOutputTokens,
} from '@brainstrike/assistant-contract';
import type { AssistantContextBreakdown } from '@brainstrike/assistant-contract/context-breakdown';
import type { AssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import type { AssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
import {
  hasRegisteredSuspendResumeUi,
  REGISTERED_SUSPEND_RESUME_TOOL_IDS,
} from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger, generateUUID } from '@brainstrike/utils';
import type { Agent, AgentMemoryOption, DelegationConfig } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import { SkillsProcessor } from '@mastra/core/processors';
import { createListingOnlyModel } from '../providers/listing-only-model';
import { LOCAL_TOOL_CALL_ARGUMENTS_INVALID } from '../providers/local/local-tool-call-validation';
import {
  providerSupportsNativeWebSearch,
  WEB_SEARCH_TOOL_ID,
} from '../providers/native-web-search';
import { getDefaultModel } from '../providers/provider-factory';
import type {
  AssistantRunEventKind,
  AssistantRunEventMetadata,
  AssistantRunEventStatus,
} from '../run-events';
import { readableStreamIterator } from '../stream/readable-stream-iterator';
import { StreamStalledError, withInactivityTimeout } from '../stream/with-inactivity-timeout';
import {
  ToolCallInputStreamingTimeoutError,
  withToolCallInputTimeout,
} from '../stream/with-tool-call-input-timeout';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type {
  AgentMessage,
  RuntimeData,
  StreamChunk,
  StreamChunkTool,
  StreamFinishReason,
  StreamIterator,
} from '../types';
import {
  convertMessagesToMastra,
  createMastraAgentRuntime,
  type MastraAgentRuntime,
  type MastraAgentRuntimeOptions,
} from './agent-runtime';
import { buildProviderHistoryCompatInputProcessor } from './error-processors';
import { isApprovalExemptInternalTool } from './internal-approval-exempt-tools';
import { createMastraAgentError, isMastraAgentError } from './mastra-agent-error';
import { MCP_PROGRESS_STREAM_PART_TYPE, mapMcpProgressStreamPart } from './mcp-runtime-client';
import { buildOpenAIToolSearchHistoryCompatInputProcessor } from './openai-tool-search-history-compat';
import { type PermissionAskToolMetadata, resolveAskToolMetadata } from './permission-tool-gate';
import { ProjectionAwareTokenLimiter } from './projection-aware-token-limiter';
import type { ProjectionSafeToolCallFilter } from './projection-safe-tool-call-filter';
import { computePromptBreakdown } from './prompt-breakdown';
import { createAssistantMessageIdGenerator } from './runtime-assembly/assistant-message-id';
import {
  accumulateSteppedUsage,
  readCacheTokenCount,
  readOpenRouterBilledCost,
  readOpenRouterDiagnostics,
  type UsageLike,
} from './runtime-assembly/usage-metering';
import {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from './runtime-configuration';
import { mapShellOutputStreamPart, SHELL_OUTPUT_STREAM_PART_TYPE } from './shell-output-stream';
import {
  createDelegationConfig,
  createDelegationLifecycleTracker,
  type DelegationLifecycleTracker,
} from './subagent-delegation';
import {
  mapMastraToolEvent,
  readMastraStreamPartString,
  readMastraStreamPartValue,
  readNestedToolOutputChunk,
} from './tool-event-mapper';
import type { BrainstrikeToolSearchProcessor } from './tool-search-runtime';

const logger = createLogger('MastraAgent');

/** Shape of a Mastra stream part with potential usage/text/tool payload fields. */
interface MastraStreamPart {
  delta?: string;
  error?: unknown;
  finishReason?: unknown;
  messageId?: unknown;
  payload?: {
    text?: string;
    textDelta?: string;
    delta?: string;
    error?: unknown;
    tripwireReason?: string;
    stepResult?: { reason?: unknown };
    output?: { usage?: UsageLike };
    metadata?: { providerMetadata?: unknown; usage?: UsageLike };
  };
  providerMetadata?: unknown;
  runId?: unknown;
  text?: string;
  textDelta?: string;
  tripwireReason?: string;
  type: string;
  usage?: UsageLike;
}

function asMastraStreamPart(part: unknown): MastraStreamPart {
  if (part && typeof part === 'object') {
    return part as MastraStreamPart;
  }
  return { type: 'unknown' };
}

function makeFinishChunk(part: unknown, lifecycleState: ToolLifecycleState): StreamChunk {
  const p = asMastraStreamPart(part);
  const usageCandidates: Array<UsageLike | undefined> = [
    p.usage,
    p.payload?.output?.usage,
    p.payload?.metadata?.usage,
  ];
  const usage = usageCandidates.find((candidate) => candidate !== undefined) ?? {};
  const promptTokensRaw = usage.promptTokens ?? usage.inputTokens;
  const promptTokens = Number.isFinite(promptTokensRaw) ? (promptTokensRaw ?? 0) : 0;
  const completionTokensRaw = usage.completionTokens ?? usage.outputTokens;
  const completionTokens = Number.isFinite(completionTokensRaw) ? (completionTokensRaw ?? 0) : 0;
  const contextInputTokens = lifecycleState.latestStepPromptTokens ?? promptTokens;
  const contextOutputTokens = lifecycleState.latestStepCompletionTokens ?? completionTokens;
  const finishCost = readOpenRouterBilledCost(p);
  if (lifecycleState.requiresBilledCost && lifecycleState.sawStepWithoutBilledCost) {
    // Mastra makes terminal token usage cumulative, but copies providerMetadata
    // from only the final model step. A terminal cost therefore cannot repair a
    // missing earlier step without silently undercounting the provider bill.
    throw new Error('OpenRouter model step omitted required provider-reported billed cost.');
  }
  if (
    lifecycleState.requiresBilledCost &&
    !lifecycleState.sawStepBilledCost &&
    finishCost === undefined
  ) {
    throw new Error('OpenRouter completion omitted required provider-reported billed cost.');
  }
  const billedCostUsd = lifecycleState.sawStepBilledCost
    ? lifecycleState.stepBilledCostUsd
    : finishCost;
  const cacheReadInputTokens = lifecycleState.includeCacheTokenClasses
    ? readCacheTokenCount(usage.cachedInputTokens)
    : undefined;
  const cacheCreationInputTokens = lifecycleState.includeCacheTokenClasses
    ? readCacheTokenCount(usage.cacheCreationInputTokens)
    : undefined;
  return {
    ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
    finishReason: readFinishReason(part),
    path: [],
    type: 'message-finish',
    usage: {
      completionTokens,
      contextInputTokens,
      contextOutputTokens,
      promptTokens,
      ...(cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens }),
      ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    },
  };
}

function makeSyntheticFinishChunk(): StreamChunk {
  return {
    finishReason: 'other',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

function makeErrorFinishChunk(): StreamChunk {
  return {
    finishReason: 'error',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

function makeToolCallsFinishChunk(): StreamChunk {
  return {
    finishReason: 'tool-calls',
    path: [],
    type: 'message-finish',
    usage: { completionTokens: 0, promptTokens: 0 },
  };
}

function normalizeFinishReason(reason: string): StreamFinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content-filter':
    case 'tool-calls':
    case 'error':
    case 'other':
    case 'unknown':
      return reason;
    case 'tool_calls':
      return 'tool-calls';
    default:
      return 'unknown';
  }
}

function readFinishReason(part: unknown): StreamFinishReason {
  const p = asMastraStreamPart(part);
  const direct = p.finishReason;
  if (typeof direct === 'string' && direct.length > 0) {
    return normalizeFinishReason(direct);
  }
  const nested = p.payload?.stepResult?.reason;
  if (typeof nested === 'string' && nested.length > 0) {
    return normalizeFinishReason(nested);
  }
  return 'unknown';
}

function getDeltaText(part: unknown): string {
  const p = asMastraStreamPart(part);
  const payloadText = p.payload?.text ?? p.payload?.textDelta ?? p.payload?.delta;
  return p.text ?? p.textDelta ?? p.delta ?? payloadText ?? '';
}

function isRunEventMetadata(value: unknown): value is AssistantRunEventMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function makeRunEventChunk(
  kind: AssistantRunEventKind,
  status: AssistantRunEventStatus,
  label: string,
  metadata?: AssistantRunEventMetadata,
  timestamp?: string
): StreamChunk {
  return {
    event: {
      id: `run-event-${generateUUID()}`,
      kind,
      label,
      status,
      timestamp: timestamp ?? new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    },
    type: 'run-event',
  };
}

function makeStepMetadata(part: unknown): AssistantRunEventMetadata | undefined {
  const p = asMastraStreamPart(part);
  const metadata: AssistantRunEventMetadata = {};
  if (typeof p.messageId === 'string' && p.messageId.length > 0) {
    metadata['messageId'] = p.messageId;
  }
  if (p.usage) {
    const promptTokens = p.usage.promptTokens ?? p.usage.inputTokens;
    if (typeof promptTokens === 'number' && Number.isFinite(promptTokens)) {
      metadata['promptTokens'] = promptTokens;
    }
    if (typeof p.usage.completionTokens === 'number' && Number.isFinite(p.usage.completionTokens)) {
      metadata['completionTokens'] = p.usage.completionTokens;
    }
  }
  const openRouterDiagnostics = readOpenRouterDiagnostics(p);
  if (openRouterDiagnostics?.provider) {
    metadata['openRouterProvider'] = openRouterDiagnostics.provider;
  }
  if (openRouterDiagnostics?.reasoningTokens !== undefined) {
    metadata['reasoningTokens'] = openRouterDiagnostics.reasoningTokens;
  }
  return isRunEventMetadata(metadata) && Object.keys(metadata).length > 0 ? metadata : undefined;
}

type TerminalToolCallState = 'completed' | 'failed';

interface OutputOnlyToolEvent {
  timestamp: string;
  toolEvent: StreamChunkTool;
}

interface ToolLifecycleState {
  delegationLifecycle: DelegationLifecycleTracker;
  firstTextLatencyMs?: number;
  /**
   * Cache token classes are an Anthropic pricing contract (read 0.1×,
   * write 1.25×). Other providers report auto-discounted cached tokens whose
   * rates we do not model — dropping the classes keeps their estimates on the
   * documented conservative full-rate path instead of mispricing them.
   * Keyed off the PARENT run's provider: Mastra does not fold a delegated
   * subagent's model-step usage into the parent finish counter, so a child
   * pinned to a different provider cannot leak foreign cache classes here
   * (review nit, BST-587).
   */
  includeCacheTokenClasses: boolean;
  /** Provider usage for the latest completed step, kept separate from billed sums. */
  latestStepCompletionTokens?: number;
  latestStepPromptTokens?: number;
  outputOnlyToolEvents: Map<string, OutputOnlyToolEvent>;
  /** Actual provider/Mastra prompt usage, absent when the stream never reported it. */
  providerReportedPromptTokens?: number;
  requiresBilledCost: boolean;
  sawStepBilledCost: boolean;
  sawStepWithoutBilledCost: boolean;
  /**
   * Mid-run steering (BST-588): polled at each step boundary. When true after
   * a step-finish, the run ends gracefully (run.steered + run.finished events
   * + normal finish) so the queued steer message dispatches as the next turn.
   * Absent control = steering not offered for this run.
   */
  steering?: { stopRequested(): boolean } | undefined;
  stepBilledCostUsd: number;
  /**
   * Per-step token usage accumulated across step-finish parts (mirrors
   * stepBilledCostUsd). A steered run's finish reports THIS sum — the
   * boundary step's own usage alone would under-count every earlier step
   * (Mastra's natural terminal usage is the same cross-step sum).
   */
  steppedCompletionTokens: number;
  steppedPromptTokens: number;
  streamStartedAtMs: number;
  terminalToolCallStates: Map<string, TerminalToolCallState>;
}

function makeLifecycleStepMetadata(
  part: unknown,
  lifecycleState: ToolLifecycleState
): AssistantRunEventMetadata | undefined {
  const metadata: AssistantRunEventMetadata = {
    ...(makeStepMetadata(part) ?? {}),
    ...(lifecycleState.firstTextLatencyMs === undefined
      ? {}
      : { firstTextLatencyMs: lifecycleState.firstTextLatencyMs }),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function recordFirstTextLatency(delta: string, lifecycleState: ToolLifecycleState): void {
  if (delta.length === 0 || lifecycleState.firstTextLatencyMs !== undefined) {
    return;
  }
  lifecycleState.firstTextLatencyMs = Math.max(0, Date.now() - lifecycleState.streamStartedAtMs);
}

function makeTerminalRunEvent(part: unknown, lifecycleState: ToolLifecycleState): StreamChunk {
  const finishReason = readFinishReason(part);
  const terminalMetadata: AssistantRunEventMetadata = {
    ...(makeLifecycleStepMetadata(part, lifecycleState) ?? {}),
    finishReason,
  };
  if (finishReason === 'stop' || finishReason === 'tool-calls') {
    return makeRunEventChunk(
      'run.finished',
      'completed',
      'Assistant run completed',
      terminalMetadata
    );
  }
  const label =
    finishReason === 'length'
      ? 'Assistant run reached the model output token limit'
      : `Assistant run ended abnormally (${finishReason})`;
  return makeRunEventChunk('run.failed', 'failed', label, terminalMetadata);
}

/**
 * Terminal `subagent.failed` (cancelled) chunks for every delegation still in
 * flight when the parent run aborts — so a cancelled parent never leaves an
 * orphaned `subagent.started` with no counterpart.
 */
function makeCancelledDelegationRunEventChunks(lifecycleState: ToolLifecycleState): StreamChunk[] {
  return lifecycleState.delegationLifecycle
    .drainInFlight()
    .map((metadata) =>
      makeRunEventChunk('subagent.failed', 'cancelled', 'Subagent cancelled', metadata)
    );
}

function getToolEventPayload(toolEvent: StreamChunkTool): AssistantRunEventMetadata | undefined {
  return isRunEventMetadata(toolEvent.payload) ? toolEvent.payload : undefined;
}

function getToolCallIdFromToolEvent(toolEvent: StreamChunkTool): string | undefined {
  const payload = getToolEventPayload(toolEvent);
  return typeof payload?.['toolCallId'] === 'string'
    ? payload['toolCallId']
    : typeof payload?.['callId'] === 'string'
      ? payload['callId']
      : undefined;
}

function makeToolEventMetadata(toolEvent: StreamChunkTool): AssistantRunEventMetadata {
  const payload = getToolEventPayload(toolEvent);
  const toolCallId = getToolCallIdFromToolEvent(toolEvent);
  const metadata: AssistantRunEventMetadata = {
    toolName: toolEvent.name,
    ...(toolCallId ? { toolCallId } : {}),
  };
  if (typeof payload?.['providerExecuted'] === 'boolean') {
    metadata['providerExecuted'] = payload['providerExecuted'];
  }
  if (typeof payload?.['dynamic'] === 'boolean') {
    metadata['dynamic'] = payload['dynamic'];
  }
  return metadata;
}

function makeToolLifecycleRunEventChunk(
  toolEvent: StreamChunkTool,
  mastraPartType: string | undefined,
  lifecycleState: ToolLifecycleState
): StreamChunk | undefined {
  const toolCallId = getToolCallIdFromToolEvent(toolEvent);
  const metadata = makeToolEventMetadata(toolEvent);

  switch (toolEvent.status) {
    case 'start':
      if (!toolCallId) {
        return;
      }
      return makeRunEventChunk('tool.started', 'running', 'Tool started', metadata);
    case 'success': {
      if (!toolCallId) {
        // Mastra terminal tool parts must carry the same stable call id as their
        // start part. Name-based matching would be ambiguous for concurrent
        // same-name tool calls, so durable terminal events are not guessed.
        return;
      }
      if (mastraPartType === 'tool-output') {
        if (!lifecycleState.terminalToolCallStates.has(toolCallId)) {
          lifecycleState.outputOnlyToolEvents.set(toolCallId, {
            timestamp: new Date().toISOString(),
            toolEvent,
          });
        }
        return;
      }
      if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
        return;
      }
      lifecycleState.terminalToolCallStates.set(toolCallId, 'completed');
      lifecycleState.outputOnlyToolEvents.delete(toolCallId);
      return makeRunEventChunk('tool.completed', 'completed', 'Tool completed', metadata);
    }
    case 'error': {
      if (!toolCallId) {
        return;
      }
      if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
        return;
      }
      lifecycleState.terminalToolCallStates.set(toolCallId, 'failed');
      lifecycleState.outputOnlyToolEvents.delete(toolCallId);
      return makeRunEventChunk('tool.failed', 'failed', 'Tool failed', metadata);
    }
    case 'progress':
      return;
  }
}

function makePendingToolOutputRunEventChunks(lifecycleState: ToolLifecycleState): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [toolCallId, outputOnlyToolEvent] of lifecycleState.outputOnlyToolEvents) {
    if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
      continue;
    }
    lifecycleState.terminalToolCallStates.set(toolCallId, 'completed');
    // Sequence remains the ordering source of truth; this timestamp preserves
    // when the output-only terminal observation happened for duration metrics.
    chunks.push(
      makeRunEventChunk(
        'tool.completed',
        'completed',
        'Tool completed',
        makeToolEventMetadata(outputOnlyToolEvent.toolEvent),
        outputOnlyToolEvent.timestamp
      )
    );
  }
  lifecycleState.outputOnlyToolEvents.clear();
  return chunks;
}

function readTripwireReason(part: unknown): string | undefined {
  const p = asMastraStreamPart(part);
  return p.tripwireReason ?? p.payload?.tripwireReason;
}

function getUnsupportedApprovalDetail(
  isSuspended: boolean,
  missingToolCallId: boolean,
  missingRunId: boolean
): string {
  if (missingToolCallId) {
    return `Mastra ${isSuspended ? 'suspended a tool call' : 'requires tool approval'} without a tool call id, so Brainstrike cannot safely resume it.`;
  }
  if (missingRunId && !isSuspended) {
    return 'Mastra requires tool approval without a run id, so Brainstrike cannot safely approve or decline it.';
  }
  if (isSuspended) {
    return 'Mastra suspended a tool call, but this Brainstrike client cannot resume suspended tool calls yet.';
  }
  return 'Mastra requires tool approval, but this Brainstrike client cannot approve or decline tool calls yet.';
}

function makeUnsupportedApprovalChunks(
  part: unknown,
  toolNames: Map<string, string>,
  sanitizedNameMap: Map<string, string> | undefined,
  eventType: 'tool-call-approval' | 'tool-call-suspended'
): StreamChunk[] {
  const upstreamToolCallId =
    readMastraStreamPartString(part, 'toolCallId') ?? readMastraStreamPartString(part, 'id');
  const missingToolCallId = upstreamToolCallId === undefined;
  const toolCallId = upstreamToolCallId ?? `mastra-${eventType}-missing-tool-call-id`;
  const rawToolName =
    readMastraStreamPartString(part, 'toolName') ??
    readMastraStreamPartString(part, 'name') ??
    (upstreamToolCallId ? toolNames.get(upstreamToolCallId) : undefined) ??
    'unknown-tool';
  const toolName = sanitizedNameMap?.get(rawToolName) ?? rawToolName;
  const runId = readMastraStreamPartString(part, 'runId');
  const missingRunId = runId === undefined;
  const args = readMastraStreamPartValue(part, 'args');
  const resumeSchema = readMastraStreamPartValue(part, 'resumeSchema');
  const suspendPayload = readMastraStreamPartValue(part, 'suspendPayload');
  const isSuspended = eventType === 'tool-call-suspended';
  const detail = getUnsupportedApprovalDetail(isSuspended, missingToolCallId, missingRunId);
  const label = isSuspended ? 'Tool resume required' : 'Tool approval required';

  logger.warn('mastra tool approval pause requires unsupported client action', {
    code: 'mastra_agent_tool_action_required',
    eventType,
    missingRunId,
    missingToolCallId,
    ...(runId ? { runId } : {}),
    toolCallId,
    toolName,
  });

  return [
    {
      name: toolName,
      payload: {
        actionRequired: true,
        approvalRequired: !isSuspended,
        callId: toolCallId,
        detail,
        error: detail,
        ...(missingToolCallId ? { missingToolCallId: true } : {}),
        ...(missingRunId ? { missingRunId: true } : {}),
        toolCallId,
        ...(args === undefined ? {} : { args, input: args }),
        ...(runId ? { runId } : {}),
        ...(resumeSchema === undefined ? {} : { resumeSchema }),
        ...(suspendPayload === undefined ? {} : { suspendPayload }),
        suspended: isSuspended,
      },
      status: 'error',
      type: 'tool-event',
    },
    makeRunEventChunk('run.failed', 'failed', label, {
      actionRequired: true,
      approvalRequired: !isSuspended,
      resumeSupported: false,
      ...(runId ? { runId } : {}),
      ...(isSuspended ? { suspended: true } : {}),
      ...(missingToolCallId ? { missingToolCallId: true } : {}),
      ...(missingRunId ? { missingRunId: true } : {}),
      toolCallId,
      toolName,
    }),
    makeErrorFinishChunk(),
  ];
}

/**
 * Terminate a well-formed suspend pause whose tool has NO registered typed
 * resume UI (`REGISTERED_SUSPEND_RESUME_TOOL_IDS`). Emitting a
 * `tool-suspend-required` chunk here would strand the run: the renderer refuses
 * to guess a typed action for an unknown `resumeSchema` (no-silent-wrong-render),
 * so the pause would sit inert forever with no error surface.
 *
 * Follows the {@link makeUnsupportedApprovalChunks} idiom for an unrecoverable
 * pause — a failed tool event, a DURABLE terminal `run.failed` run event
 * carrying `resumeSupported:false` plus the diagnostic flags, then an error
 * finish. The tool-defined `suspendPayload` is deliberately EXCLUDED from that
 * durable metadata (it is arbitrary tool content; run-event metadata is
 * allowlist-by-denial, not a content channel); the live tool event keeps the
 * bounded human-readable detail instead.
 */
function makeUnregisteredSuspendResumeChunks(input: {
  runId: string;
  toolCallId: string;
  toolName: string;
}): StreamChunk[] {
  const detail = `${input.toolName} suspended the run for user input, but this Brainstrike client has no registered resume UI for its resume schema, so the run cannot be resumed and was stopped.`;

  logger.error('suspending tool has no registered resume UI', {
    code: 'mastra_agent_suspend_resume_schema_unregistered',
    registeredSuspendResumeTools: [...REGISTERED_SUSPEND_RESUME_TOOL_IDS],
    runId: input.runId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  });

  return [
    {
      name: input.toolName,
      payload: {
        actionRequired: true,
        approvalRequired: false,
        callId: input.toolCallId,
        detail,
        error: detail,
        resumeSupported: false,
        runId: input.runId,
        suspended: true,
        toolCallId: input.toolCallId,
        unregisteredResumeSchema: true,
      },
      status: 'error',
      type: 'tool-event',
    },
    makeRunEventChunk('run.failed', 'failed', 'Tool resume unsupported', {
      actionRequired: true,
      resumeSupported: false,
      runId: input.runId,
      suspended: true,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      unregisteredResumeSchema: true,
    }),
    makeErrorFinishChunk(),
  ];
}

function makeApprovalRequiredChunks(
  part: unknown,
  toolNames: Map<string, string>,
  sanitizedNameMap: Map<string, string> | undefined,
  askTools: ReadonlyMap<string, PermissionAskToolMetadata> | undefined
): StreamChunk[] {
  const toolCallId =
    readMastraStreamPartString(part, 'toolCallId') ?? readMastraStreamPartString(part, 'id');
  const runId = readMastraStreamPartString(part, 'runId');
  if (!(toolCallId && runId)) {
    return makeUnsupportedApprovalChunks(part, toolNames, sanitizedNameMap, 'tool-call-approval');
  }

  const rawToolName =
    readMastraStreamPartString(part, 'toolName') ??
    readMastraStreamPartString(part, 'name') ??
    toolNames.get(toolCallId) ??
    'unknown-tool';
  const toolName = sanitizedNameMap?.get(rawToolName) ?? rawToolName;
  const args = readMastraStreamPartValue(part, 'args');
  const resumeSchema = readMastraStreamPartValue(part, 'resumeSchema');
  // The Mastra approval part names the tool by its registered (sanitized) id
  // today, which is how `askTools` is keyed by the permission gate — but the
  // lookup accepts EITHER name form (sanitized key or originalName) so a part
  // carrying the original dotted name still resolves. When the pause was driven
  // by a permission 'ask', surface the risk reason so the UI can say WHY.
  const askMetadata = askTools ? resolveAskToolMetadata(askTools, rawToolName) : undefined;
  if (!askMetadata && askTools && askTools.size > 0) {
    // Policy-driven run (non-empty ask set) with an approval pause we cannot
    // attribute: surface the pause WITHOUT metadata (never fabricate a
    // riskCategory) and log LOUDLY — a silent drop here removes the notice's
    // reason line and grant actions with no trace (no-silent-fallbacks).
    logger.error('approval pause tool not found in ask-tool metadata under either name form', {
      code: 'mastra_agent_approval_metadata_unresolved',
      knownAskTools: Array.from(askTools.keys()),
      rawToolName,
      runId,
      toolCallId,
      toolName,
    });
  }

  logger.info('mastra tool approval pause surfaced for client approval', {
    code: 'mastra_agent_tool_approval_required',
    runId,
    toolCallId,
    toolName,
    ...(askMetadata ? { riskCategory: askMetadata.riskCategory } : {}),
  });

  return [
    {
      runId,
      toolCallId,
      toolName,
      type: 'tool-approval-required',
      ...(askMetadata ? { policyDecision: 'ask', riskCategory: askMetadata.riskCategory } : {}),
      ...(args === undefined ? {} : { args }),
      ...(resumeSchema === undefined ? {} : { resumeSchema }),
    },
    makeToolCallsFinishChunk(),
  ];
}

/**
 * Turn a `tool-call-suspended` stream part (emitted when a suspending tool calls
 * `suspend()`) into the resumable `tool-suspend-required` chunk + a tool-calls
 * finish. Mirrors {@link makeApprovalRequiredChunks} but carries the tool-defined
 * `suspendPayload` (plan body / question) instead of approval-risk metadata. When
 * the pause is malformed (missing toolCallId/runId) we fall back to the existing
 * unsupported-termination so a bad pause fails visibly rather than silently, and
 * when the tool has no registered typed resume UI we terminate through
 * {@link makeUnregisteredSuspendResumeChunks} for the same reason.
 */
function makeToolSuspendRequiredChunks(
  part: unknown,
  toolNames: Map<string, string>,
  sanitizedNameMap: Map<string, string> | undefined
): StreamChunk[] {
  const toolCallId =
    readMastraStreamPartString(part, 'toolCallId') ?? readMastraStreamPartString(part, 'id');
  const runId = readMastraStreamPartString(part, 'runId');
  if (!(toolCallId && runId)) {
    return makeUnsupportedApprovalChunks(part, toolNames, sanitizedNameMap, 'tool-call-suspended');
  }

  const rawToolName =
    readMastraStreamPartString(part, 'toolName') ??
    readMastraStreamPartString(part, 'name') ??
    toolNames.get(toolCallId) ??
    'unknown-tool';
  const toolName = sanitizedNameMap?.get(rawToolName) ?? rawToolName;
  if (!hasRegisteredSuspendResumeUi(toolName)) {
    return makeUnregisteredSuspendResumeChunks({ runId, toolCallId, toolName });
  }
  const suspendPayload = readMastraStreamPartValue(part, 'suspendPayload');
  const resumeSchema = readMastraStreamPartValue(part, 'resumeSchema');

  logger.info('mastra tool suspend pause surfaced for client resume', {
    code: 'mastra_agent_tool_suspend_required',
    runId,
    toolCallId,
    toolName,
  });

  return [
    {
      runId,
      toolCallId,
      toolName,
      type: 'tool-suspend-required',
      ...(suspendPayload === undefined ? {} : { suspendPayload }),
      ...(resumeSchema === undefined ? {} : { resumeSchema }),
    },
    makeToolCallsFinishChunk(),
  ];
}

interface ProcessStreamPartResult {
  chunks: StreamChunk[];
  finished: boolean;
}

/**
 * Resolve the delegation persona id for a parent `tool-call`/`tool-result`/
 * `tool-error` part whose tool is an `agent-<key>` delegation tool, or undefined
 * when it is an ordinary tool. Delegation tool names are Mastra-constructed
 * (`agent-<personaId>`) and never enter the sanitized name map, so the raw
 * toolName equals the key we look up.
 */
function resolveDelegationPersona(
  part: unknown,
  toolNames: Map<string, string>,
  delegationToolPersonas: ReadonlyMap<string, string>
): { parentToolCallId: string | undefined; personaId: string; toolName: string } | undefined {
  if (delegationToolPersonas.size === 0) {
    return;
  }
  const callId =
    readMastraStreamPartString(part, 'toolCallId') ?? readMastraStreamPartString(part, 'id');
  const rawToolName =
    readMastraStreamPartString(part, 'toolName') ??
    readMastraStreamPartString(part, 'name') ??
    (callId ? toolNames.get(callId) : undefined);
  if (!rawToolName) {
    return;
  }
  const personaId = delegationToolPersonas.get(rawToolName);
  if (!personaId) {
    return;
  }
  return { parentToolCallId: callId, personaId, toolName: rawToolName };
}

/**
 * Map a delegation `tool-output` part (nested child chunk forwarded on the parent
 * stream, §2.5) into `subagent.tool.*` run events. The generic `mapMastraToolEvent`
 * path is deliberately BYPASSED for these parts (it would emit a bogus
 * successful tool event + `toolCallResult` frame per nested chunk). Child
 * text/reasoning/step/finish chunks produce NOTHING.
 */
function mapDelegationToolOutput(
  part: unknown,
  parentToolCallId: string | undefined,
  personaId: string,
  delegationToolName: string
): StreamChunk[] {
  const nested = readNestedToolOutputChunk(part);
  if (!nested) {
    return [];
  }
  const baseMetadata: AssistantRunEventMetadata = {
    personaId,
    ...(parentToolCallId ? { parentToolCallId } : {}),
    toolName: delegationToolName,
  };
  const childMetadata: AssistantRunEventMetadata = {
    ...baseMetadata,
    ...(nested.toolCallId ? { toolCallId: nested.toolCallId } : {}),
    ...(nested.toolName ? { childToolName: nested.toolName } : {}),
  };
  if (nested.type === 'tool-call') {
    return [
      makeRunEventChunk('subagent.tool.started', 'running', 'Subagent tool started', childMetadata),
    ];
  }
  if (nested.type === 'tool-result') {
    return [
      nested.isError
        ? makeRunEventChunk('subagent.tool.failed', 'failed', 'Subagent tool failed', childMetadata)
        : makeRunEventChunk(
            'subagent.tool.completed',
            'completed',
            'Subagent tool completed',
            childMetadata
          ),
    ];
  }
  if (nested.type === 'tool-error') {
    return [
      makeRunEventChunk('subagent.tool.failed', 'failed', 'Subagent tool failed', childMetadata),
    ];
  }
  return [];
}

/** The generic (non-delegation) tool-event mapping shared by every tool part. */
function mapGenericToolEvent(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  partType: string,
  sanitizedNameMap?: Map<string, string>
): ProcessStreamPartResult {
  const evt = mapMastraToolEvent(part, toolNames, sanitizedNameMap);
  if (!(evt && evt.type === 'tool-event')) {
    return { chunks: [], finished: false };
  }
  const runEvent = makeToolLifecycleRunEventChunk(evt, partType, lifecycleState);
  return {
    chunks: runEvent ? [evt, runEvent] : [evt],
    finished: false,
  };
}

/** The subagent.* run event that mirrors a delegation tool-call/result/error. */
function makeSubagentLifecycleChunk(
  partType: 'tool-call' | 'tool-error' | 'tool-result',
  metadata: AssistantRunEventMetadata
): StreamChunk {
  if (partType === 'tool-call') {
    return makeRunEventChunk('subagent.started', 'running', 'Subagent started', metadata);
  }
  if (partType === 'tool-error') {
    return makeRunEventChunk('subagent.failed', 'failed', 'Subagent failed', metadata);
  }
  return makeRunEventChunk('subagent.finished', 'completed', 'Subagent completed', metadata);
}

/**
 * A delegation tool-call/result/error part: the generic tool event PLUS a
 * mirrored subagent.* run event, while tracking the delegation's in-flight
 * lifecycle so an aborted run can emit a terminal event for orphans.
 */
function mapToolLifecyclePart(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  partType: 'tool-call' | 'tool-error' | 'tool-result',
  sanitizedNameMap: Map<string, string> | undefined,
  delegationToolPersonas: ReadonlyMap<string, string>
): ProcessStreamPartResult {
  const delegation = resolveDelegationPersona(part, toolNames, delegationToolPersonas);
  const generic = mapGenericToolEvent(part, toolNames, lifecycleState, partType, sanitizedNameMap);
  if (!delegation) {
    return generic;
  }
  const metadata: AssistantRunEventMetadata = {
    personaId: delegation.personaId,
    toolName: delegation.toolName,
    ...(delegation.parentToolCallId ? { parentToolCallId: delegation.parentToolCallId } : {}),
  };
  if (delegation.parentToolCallId) {
    if (partType === 'tool-call') {
      lifecycleState.delegationLifecycle.started(delegation.parentToolCallId, metadata);
    } else {
      lifecycleState.delegationLifecycle.settled(delegation.parentToolCallId);
    }
  }
  return {
    chunks: [...generic.chunks, makeSubagentLifecycleChunk(partType, metadata)],
    finished: false,
  };
}

function processMastraStreamPart(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  sanitizedNameMap?: Map<string, string>,
  askTools?: ReadonlyMap<string, PermissionAskToolMetadata>,
  delegationToolPersonas: ReadonlyMap<string, string> = new Map(),
  runtimeData?: RuntimeData
): ProcessStreamPartResult {
  const p = asMastraStreamPart(part);

  switch (p.type) {
    case 'start':
      return {
        chunks: [
          makeRunEventChunk(
            'run.started',
            'running',
            'Assistant run started',
            makeStepMetadata(part)
          ),
        ],
        finished: false,
      };
    case 'text-delta': {
      const delta = getDeltaText(part);
      recordFirstTextLatency(delta, lifecycleState);
      return delta.length > 0
        ? { chunks: [{ type: 'text-delta', value: delta }], finished: false }
        : { chunks: [], finished: false };
    }
    case 'reasoning-delta': {
      const delta = getDeltaText(part);
      return delta.length > 0
        ? { chunks: [{ type: 'reasoning-delta', value: delta }], finished: false }
        : { chunks: [], finished: false };
    }
    case 'step-start':
      return {
        chunks: [
          makeRunEventChunk(
            'run.step.started',
            'running',
            'Generation step started',
            makeStepMetadata(part)
          ),
        ],
        finished: false,
      };
    case 'step-finish': {
      const billedCostUsd = readOpenRouterBilledCost(p);
      if (billedCostUsd === undefined) {
        lifecycleState.sawStepWithoutBilledCost = true;
      } else {
        lifecycleState.sawStepBilledCost = true;
        lifecycleState.stepBilledCostUsd += billedCostUsd;
      }
      // Same usage-candidate order as makeFinishChunk (top-level, then payload).
      accumulateSteppedUsage(
        lifecycleState,
        p.usage ?? p.payload?.output?.usage ?? p.payload?.metadata?.usage
      );
      const stepFinishedChunk = makeRunEventChunk(
        'run.step.finished',
        'completed',
        'Generation step completed',
        makeLifecycleStepMetadata(part, lifecycleState)
      );
      if (lifecycleState.steering?.stopRequested()) {
        // NOTE: an OpenRouter run whose boundary step omitted its billed cost
        // throws here (same terminal contract the natural finish enforces —
        // a steer cannot fake an exact cost the provider never reported).
        const steeredBaseFinish = makeFinishChunk(part, lifecycleState) as Extract<
          StreamChunk,
          { type: 'message-finish' }
        >;
        // Graceful steer stop (BST-588): the just-finished step is complete
        // (its tool results are persisted by Mastra's per-step saves), so end
        // the run here with a visible marker and a NORMAL finish — including
        // run.finished, so every terminal-event consumer (timeline status,
        // run notifications, hydration weaving) sees the run complete. The
        // queued steer message dispatches as the next turn via the follow-up
        // queue's run-end bridge. The generator's early return cancels the
        // underlying Mastra stream; a partial NEXT step may already have been
        // dispatched (push-based fullStream) — bounded to one step, its
        // output is discarded.
        return {
          chunks: [
            stepFinishedChunk,
            // Drain tools that terminated via `tool-output` (no later
            // `tool-result`) exactly like the natural finish does — otherwise
            // the run completes while those tool cards stay stuck "running"
            // and the durable timeline never receives their tool.completed.
            ...makePendingToolOutputRunEventChunks(lifecycleState),
            makeRunEventChunk(
              'run.steered',
              'completed',
              'Run steered: stopped at step boundary for a new user message',
              makeStepMetadata(part)
            ),
            makeRunEventChunk(
              'run.finished',
              'completed',
              'Assistant run completed',
              makeLifecycleStepMetadata(part, lifecycleState)
            ),
            // A steer is a deliberate, successful stop: override the mapped
            // 'unknown' (a step part has no finishReason) and report the
            // ACCUMULATED cross-step usage, matching Mastra's own terminal sum.
            {
              ...steeredBaseFinish,
              finishReason: 'stop',
              usage: {
                ...steeredBaseFinish.usage,
                completionTokens: lifecycleState.steppedCompletionTokens,
                promptTokens: lifecycleState.steppedPromptTokens,
              },
            },
          ],
          finished: true,
        };
      }
      return {
        chunks: [stepFinishedChunk],
        finished: false,
      };
    }
    case 'finish': {
      const terminalUsage = p.usage ?? p.payload?.output?.usage ?? p.payload?.metadata?.usage;
      const terminalPromptTokens = terminalUsage?.promptTokens ?? terminalUsage?.inputTokens;
      if (typeof terminalPromptTokens === 'number' && Number.isFinite(terminalPromptTokens)) {
        lifecycleState.providerReportedPromptTokens = terminalPromptTokens;
      }
      return {
        chunks: [
          ...makePendingToolOutputRunEventChunks(lifecycleState),
          makeTerminalRunEvent(part, lifecycleState),
          makeFinishChunk(part, lifecycleState),
        ],
        finished: true,
      };
    }
    case 'tool-output': {
      // Delegation `tool-output` = a nested child chunk forwarded on the parent
      // stream. BYPASS the generic tool-event path (it would emit a bogus
      // successful tool event + a `toolCallResult` frame per nested chunk,
      // flooding the UI) and translate to `subagent.tool.*` run events instead.
      const delegation = resolveDelegationPersona(part, toolNames, delegationToolPersonas);
      if (delegation) {
        return {
          chunks: mapDelegationToolOutput(
            part,
            delegation.parentToolCallId,
            delegation.personaId,
            delegation.toolName
          ),
          finished: false,
        };
      }
      return mapGenericToolEvent(part, toolNames, lifecycleState, p.type, sanitizedNameMap);
    }
    case 'tool-call':
    case 'tool-result':
    case 'tool-error':
      return mapToolLifecyclePart(
        part,
        toolNames,
        lifecycleState,
        p.type,
        sanitizedNameMap,
        delegationToolPersonas
      );
    case 'tool-call-input-streaming-start':
    case 'tool-call-delta':
    case 'tool-call-input-streaming-end':
      return mapGenericToolEvent(part, toolNames, lifecycleState, p.type, sanitizedNameMap);
    case 'tool-call-approval':
      // Stop at the first approval pause and surface resumable metadata. Later
      // stream parts are only valid after an explicit approve/decline action.
      return {
        chunks: [
          ...makePendingToolOutputRunEventChunks(lifecycleState),
          ...makeApprovalRequiredChunks(part, toolNames, sanitizedNameMap, askTools),
        ],
        finished: true,
      };
    case 'tool-call-suspended':
      // A suspending tool (submitPlan/askUser) paused via suspend(). Surface the
      // resumable suspend metadata and STOP at the pause; later stream parts are
      // only valid after an explicit resume (streamMastraToolResumeAction).
      return {
        chunks: [
          ...makePendingToolOutputRunEventChunks(lifecycleState),
          ...makeToolSuspendRequiredChunks(part, toolNames, sanitizedNameMap),
        ],
        finished: true,
      };
    case 'error': {
      // Top-level provider errors (e.g. Anthropic returning HTTP 404 for an
      // unavailable model, or Ollama HTTP 400 because the model can't satisfy
      // the registered tool set) arrive as `'error'` parts. We terminate the
      // run gracefully: a visible assistant message with the reason, a terminal
      // `run.failed` run-event (which clears any in-flight "started" spinners),
      // and an error finish so the thread reaches a terminal state. Previously
      // we threw here; the throw produced a data-stream error frame that the
      // renderer did not surface, leaving the thread hung on a forever-spinning
      // "Generation step started" (the "large white pause"). See docs/agents/assistant-runtime.md.
      const providerError = resolveProviderError(p.error ?? p.payload?.error, runtimeData);
      return makeProviderErrorTermination(
        providerError.detail,
        lifecycleState,
        part,
        providerError.metadata
      );
    }
    case 'tripwire': {
      // Same rationale as `'error'`: surface tripwires (content policy
      // violations, etc.) as a visible message + terminal run-event so the user
      // sees the reason and the thread does not hang.
      return makeProviderErrorTermination(
        readTripwireReason(part) ?? 'tripwire',
        lifecycleState,
        part
      );
    }
    case SHELL_OUTPUT_STREAM_PART_TYPE: {
      // A live shell-output slice streamed by executeCommand via `writer.custom`.
      // Transient (never persisted): it rides its own StreamChunk type so the
      // server's run-event persistence tap ignores it. A malformed slice is
      // dropped rather than mis-attributed.
      const shellOutput = mapShellOutputStreamPart(part);
      return { chunks: shellOutput ? [shellOutput] : [], finished: false };
    }
    case MCP_PROGRESS_STREAM_PART_TYPE: {
      const progress = mapMcpProgressStreamPart(part);
      return { chunks: progress ? [progress] : [], finished: false };
    }
    default:
      return { chunks: [], finished: false };
  }
}

/**
 * Terminate a run gracefully after a provider/model error part.
 *
 * Emits a user-visible assistant message with the reason, flushes any pending
 * tool-output run-events, marks the run `run.failed` (which clears in-flight
 * "started" spinners in the renderer), and finishes with reason `error`. This
 * replaces throwing on the error part: the throw surfaced a data-stream error
 * frame the renderer never rendered, leaving the thread hung on a spinner.
 */
/** Cap the provider error detail rendered as visible assistant text. Provider
 * error bodies can be verbose; the full detail is preserved in the log. */
const MAX_VISIBLE_PROVIDER_ERROR_CHARS = 600;

const OPENROUTER_TOKEN_ERROR_TYPES = new Set([
  'context_length_exceeded',
  'max_tokens_exceeded',
  'token_limit_exceeded',
]);

interface ResolvedProviderError {
  detail: string;
  metadata?: AssistantRunEventMetadata;
}

interface OpenRouterTokenErrorMetadata extends AssistantRunEventMetadata {
  errorType: string;
  httpStatus?: number;
  providerCode?: string;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}

function readBoundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return;
  }
  return trimmed.slice(0, maximumLength);
}

function readHttpStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

/**
 * OpenRouter's documented canonical error type is carried in
 * `error.metadata.error_type` on Chat Completions, `error.error_type` on the
 * Anthropic skin, and top-level `error_type` on Responses. Mastra's official
 * OpenRouter router currently uses Chat Completions, but pre-stream failures
 * can be wrapped in an AI SDK `APICallError.data` envelope. Inspect only those
 * documented/wrapper locations and retain only the token-limit vocabulary this
 * runtime can act on; arbitrary provider metadata is never persisted.
 */
function readOpenRouterTokenError(value: unknown): OpenRouterTokenErrorMetadata | undefined {
  const root = readObject(value);
  if (!root) {
    return;
  }

  const data = readObject(root['data']);
  const candidates = [
    root,
    readObject(root['error']),
    data,
    readObject(data?.['error']),
    readObject(readObject(root['cause'])?.['data']),
    readObject(readObject(readObject(root['cause'])?.['data'])?.['error']),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const providerMetadata = readObject(candidate['metadata']);
    const errorType = readBoundedString(
      providerMetadata?.['error_type'] ?? candidate['error_type'],
      80
    );
    if (!(errorType && OPENROUTER_TOKEN_ERROR_TYPES.has(errorType))) {
      continue;
    }
    const providerCode = readBoundedString(providerMetadata?.['provider_code'], 120);
    const httpStatus =
      readHttpStatus(candidate['code']) ??
      readHttpStatus(root['statusCode']) ??
      readHttpStatus(readObject(root['cause'])?.['statusCode']);
    return {
      errorType,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(providerCode ? { providerCode } : {}),
    };
  }
  return;
}

function resolveProviderError(
  value: unknown,
  runtimeData: RuntimeData | undefined
): ResolvedProviderError {
  const detail = extractErrorMessage(value) ?? 'agent_stream_error';
  const provider = runtimeData?.provider?.trim().toLowerCase();
  if (provider === 'local') {
    const root = readObject(value);
    const codeCandidates = [
      root?.['code'],
      readObject(root?.['error'])?.['code'],
      readObject(root?.['cause'])?.['code'],
      readObject(readObject(root?.['cause'])?.['cause'])?.['code'],
    ];
    const errorType = codeCandidates
      .map((candidate) => readBoundedString(candidate, 80))
      .find((candidate) => candidate === LOCAL_TOOL_CALL_ARGUMENTS_INVALID);
    if (errorType) {
      const model = runtimeData?.model?.trim() || getDefaultModel('local');
      return {
        detail,
        metadata: {
          errorType,
          ...(model ? { model } : {}),
          provider: 'local',
        },
      };
    }
    return { detail };
  }
  if (provider !== 'openrouter') {
    return { detail };
  }
  const typedMetadata = readOpenRouterTokenError(value);
  if (!typedMetadata) {
    return { detail };
  }
  const model = runtimeData?.model?.trim() || getDefaultModel('openrouter');
  return {
    detail: `[${typedMetadata.errorType}] ${detail}`,
    metadata: {
      ...typedMetadata,
      ...(model ? { model } : {}),
      provider: 'openrouter',
    },
  };
}

function makeProviderErrorTermination(
  detail: string,
  lifecycleState: ToolLifecycleState,
  part: unknown,
  providerErrorMetadata?: AssistantRunEventMetadata
): ProcessStreamPartResult {
  // Preserve the server-side breadcrumb. We terminate the run gracefully here
  // (visible message + run.failed) instead of throwing through
  // handleStreamFailure, so without this log the provider failure would be
  // invisible server-side — the `mastra_agent_stream_finished` success line in
  // the finally block would be the only record. Log at error level with a
  // distinct code so these stay diagnosable even though the user sees a clean
  // message. (Per AGENTS.md's observability working rule.) The FULL detail goes to
  // the log; the visible message is clamped below.
  logger.error('mastra stream terminated by provider error', {
    code: 'mastra_agent_stream_provider_error',
    detail,
  });
  // Clamp the user-visible detail: provider error bodies can be arbitrarily long
  // (and occasionally echo request context), which reads poorly as persisted
  // assistant text. The full detail stays in the log breadcrumb above.
  const visibleDetail =
    detail.length > MAX_VISIBLE_PROVIDER_ERROR_CHARS
      ? `${detail.slice(0, MAX_VISIBLE_PROVIDER_ERROR_CHARS)}…`
      : detail;
  const stepMetadata = makeStepMetadata(part);
  const runMetadata =
    stepMetadata || providerErrorMetadata
      ? { ...stepMetadata, ...providerErrorMetadata }
      : undefined;
  return {
    chunks: [
      ...makePendingToolOutputRunEventChunks(lifecycleState),
      { type: 'text-delta', value: `The model request failed: ${visibleDetail}` },
      makeRunEventChunk('run.failed', 'failed', 'Assistant run failed', runMetadata),
      makeErrorFinishChunk(),
    ],
    finished: true,
  };
}

function makeStreamStalledTermination(
  error: StreamStalledError,
  lifecycleState: ToolLifecycleState,
  runtimeData: RuntimeData | undefined
): StreamChunk[] {
  const provider = runtimeData?.provider?.trim().toLowerCase();
  const model = runtimeData?.model?.trim();
  const localRuntimeName =
    provider === 'ollama' ? 'Ollama' : provider === 'lmstudio' ? 'LM Studio' : null;
  const diagnosticContext = {
    inactivityMs: error.inactivityMs,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
  logger.error(
    {
      code: 'mastra_agent_stream_inactivity_timeout',
      ...diagnosticContext,
    },
    'mastra stream stalled by inactivity timeout'
  );
  const visibleMessage =
    localRuntimeName && model
      ? `${localRuntimeName} model "${model}" produced no stream output for ${error.inactivityMs}ms. Verify the ${localRuntimeName} server and model runner, then retry.`
      : `The model stream stalled after ${error.inactivityMs}ms without output.`;
  return [
    // A stall mid-delegation must never leave an orphaned `subagent.started`
    // with no terminal counterpart — mirror the abort branches' drain.
    ...makeCancelledDelegationRunEventChunks(lifecycleState),
    ...makePendingToolOutputRunEventChunks(lifecycleState),
    {
      type: 'text-delta',
      value: visibleMessage,
    },
    makeRunEventChunk('run.failed', 'failed', 'Assistant run failed', {
      code: error.code,
      ...diagnosticContext,
    }),
    makeErrorFinishChunk(),
  ];
}

function makeToolCallInputTimeoutTermination(
  error: ToolCallInputStreamingTimeoutError,
  lifecycleState: ToolLifecycleState,
  runtimeData: RuntimeData | undefined
): StreamChunk[] {
  const provider = runtimeData?.provider?.trim().toLowerCase();
  const model = runtimeData?.model?.trim();
  const diagnosticContext = {
    timeoutMs: error.timeoutMs,
    toolCallId: error.toolCallId,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  };
  logger.error(
    {
      code: 'mastra_agent_tool_call_input_streaming_timeout',
      ...diagnosticContext,
    },
    'mastra tool call input exceeded its streaming deadline'
  );
  return [
    ...makeCancelledDelegationRunEventChunks(lifecycleState),
    ...makePendingToolOutputRunEventChunks(lifecycleState),
    {
      type: 'text-delta',
      value: `The model did not finish streaming a tool call's arguments within ${error.timeoutMs}ms. The incomplete tool call was cancelled before execution.`,
    },
    makeRunEventChunk('run.failed', 'failed', 'Assistant run failed', {
      code: error.code,
      ...diagnosticContext,
    }),
    makeErrorFinishChunk(),
  ];
}

type StreamWatchdogError = StreamStalledError | ToolCallInputStreamingTimeoutError;

function isStreamWatchdogError(error: unknown): error is StreamWatchdogError {
  return error instanceof StreamStalledError || error instanceof ToolCallInputStreamingTimeoutError;
}

function makeStreamWatchdogTermination(
  error: StreamWatchdogError,
  lifecycleState: ToolLifecycleState,
  runtimeData: RuntimeData | undefined
): StreamChunk[] {
  if (error instanceof ToolCallInputStreamingTimeoutError) {
    return makeToolCallInputTimeoutTermination(error, lifecycleState, runtimeData);
  }
  return makeStreamStalledTermination(error, lifecycleState, runtimeData);
}

function extractErrorMessage(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === 'string') {
    return value.length > 0 ? value : undefined;
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) {
      return message;
    }
  }
  try {
    return String(value);
  } catch {
    return;
  }
}

interface RuntimeInitializationResult {
  runtime: MastraAgentRuntime;
  sanitizedNameMap?: Map<string, string>;
}

async function initializeMastraRuntime(
  options: MastraAgentRuntimeOptions,
  runtimeResolution: ResolvedRuntimeConfiguration
): Promise<RuntimeInitializationResult> {
  try {
    const instance = await createMastraAgentRuntime({
      ...options,
      resolved: runtimeResolution,
      runtime: runtimeResolution.runtime,
    });
    const resolvedModel =
      options.model && options.model.length > 0
        ? options.model
        : (runtimeResolution.runtime.model ?? getDefaultModel(runtimeResolution.provider) ?? '');
    logger.info(
      {
        code: 'mastra_agent_runtime_initialized',
        // Empty string means the caller did not specify a model AND the
        // provider has no static default (e.g. local runtimes whose models are
        // discovered dynamically). This is a real failure mode worth logging.
        model: resolvedModel.length > 0 ? resolvedModel : '<unset>',
        provider: runtimeResolution.provider,
        toolCount: Object.keys(options.tools ?? {}).length,
      },
      'mastra runtime initialized'
    );
    return { runtime: instance, sanitizedNameMap: instance.toolNameMap };
  } catch (err) {
    logger.error('mastra runtime init failed', {
      code: 'mastra_agent_runtime_init_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    if (isMastraAgentError(err)) {
      throw err;
    }
    const errorDetail = err instanceof Error ? err.message : undefined;
    throw createMastraAgentError(
      'mastra_agent_runtime_init_failed',
      errorDetail ? { cause: err, detail: errorDetail } : { cause: err }
    );
  }
}

interface StreamIterationParams {
  memory?: MastraMemory;
  messages: AgentMessage[];
  requireToolApproval?: boolean;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
}

interface StreamGeneratorParams {
  /**
   * Run-start prompt breakdown to emit as the first StreamChunk (initial turn
   * only — the approval-resume legs have no wire messages to measure, so they
   * honestly omit it rather than re-emitting a partial figure).
   */
  promptBreakdown?: AssistantContextBreakdown;
  resumedApprovalToolCall?: ResumedApprovalToolCall;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
  stream: NodeReadableStream<unknown> | ReadableStream<unknown>;
  streamAbortContext: StreamAbortContext;
}

interface StreamAbortContext {
  abort: (reason: Error) => void;
  dispose: () => void;
  signal: AbortSignal;
}

function createStreamAbortContext(externalSignal: AbortSignal | undefined): StreamAbortContext {
  const controller = new AbortController();
  const forwardExternalAbort = (): void => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    forwardExternalAbort();
  } else {
    externalSignal?.addEventListener('abort', forwardExternalAbort, { once: true });
  }

  return {
    abort: (reason) => {
      if (!controller.signal.aborted) {
        controller.abort(reason);
      }
    },
    dispose: () => {
      externalSignal?.removeEventListener('abort', forwardExternalAbort);
    },
    signal: controller.signal,
  };
}

interface StreamResultLike {
  fullStream?: NodeReadableStream<unknown> | ReadableStream<unknown>;
}

// Derived from Agent.stream's 2-arg overload (introduced in @mastra/core 1.25 -- the
// 1-arg overload now refuses `undefined` as the second arg, so callers must either
// omit the second arg or pass real options). If a future Mastra bump exposes a
// stable public StreamOptions type, prefer importing that directly over deriving it
// from Parameters<>; the `as AgentStreamOptions` cast at the call sites is what
// keeps this file from reaching across the overload boundary.
type AgentStreamOptions = Exclude<
  Extract<Parameters<Agent['stream']>, [unknown, unknown]>[1],
  undefined
>;
type AgentToolApprovalOptions = Parameters<Agent['approveToolCall']>[0];

interface ToolApprovalIterationParams {
  action: AssistantToolApprovalAction;
  memory?: MastraMemory;
  requireToolApproval?: boolean;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
}

interface ResumedApprovalToolCall {
  args: unknown;
  displayToolName: string;
  registeredToolName: string;
  toolCallId: string;
}

/**
 * Per-call approval decision, matching Mastra's `RequireToolApproval` union
 * (`boolean | (ctx) => boolean`). The function form gates approval per tool call;
 * the resume leg uses it to exempt Mastra-internal tools (see
 * {@link resolveResumeApprovalGate}).
 */
type ApprovalGate = boolean | ((ctx: { toolName: string }) => boolean);

interface BrainstrikeAgentStreamOptions {
  abortSignal?: AbortSignal;
  delegation?: DelegationConfig;
  // biome-ignore lint/style/useNamingConvention: Mastra's public stream option.
  experimental_generateMessageId?: () => string;
  inputProcessors?: unknown[];
  maxSteps?: number;
  memory?: AgentMemoryOption;
  modelSettings?: RuntimeData['modelSettings'];
  providerOptions?: RuntimeData['providerOptions'];
  requireToolApproval?: ApprovalGate;
}

function buildModelSettingsOption(
  runtimeData: RuntimeData | undefined
): Pick<BrainstrikeAgentStreamOptions, 'modelSettings'> {
  let modelSettings = runtimeData?.modelSettings;
  if (runtimeData?.provider === 'openrouter') {
    modelSettings = {
      maxOutputTokens: resolveOpenRouterCodingMaxOutputTokens(),
      ...modelSettings,
    };
  } else if (runtimeData?.provider === 'local') {
    const modelId = runtimeData.model?.trim() || getDefaultModel('local');
    const definition = getLlmModelDefinition('local', modelId);
    if (definition.maxOutputTokens === undefined) {
      throw createMastraAgentError('mastra_agent_runtime_init_failed', {
        context: { model: modelId, provider: 'local' },
        detail: `Local model ${modelId} has no maxOutputTokens registry budget`,
      });
    }
    modelSettings = {
      maxOutputTokens: definition.maxOutputTokens,
      ...modelSettings,
    };
  }
  return modelSettings ? { modelSettings } : {};
}

/**
 * Keep Brainstrike's local-server transport settings out of Mastra generation
 * options. Mastra namespaces compatible-provider options by the model id's
 * first segment, so forwarding `providerOptions.ollama` or `.lmstudio` would
 * serialize `baseUrl` and `apiToken` into the chat-completions request body.
 */
function buildGenerationProviderOptionsOption(
  runtimeData: RuntimeData | undefined
): Pick<BrainstrikeAgentStreamOptions, 'providerOptions'> {
  const providerOptions = runtimeData?.providerOptions;
  if (!providerOptions) {
    return {};
  }
  if (providerOptions.ollama === undefined && providerOptions.lmstudio === undefined) {
    return { providerOptions };
  }

  const generationProviderOptions = Object.fromEntries(
    Object.entries(providerOptions).filter(
      ([namespace]) => namespace !== 'ollama' && namespace !== 'lmstudio'
    )
  ) as NonNullable<RuntimeData['providerOptions']>;
  if (Object.keys(generationProviderOptions).length === 0) {
    return {};
  }
  return { providerOptions: generationProviderOptions };
}

function buildAssistantStreamMessageIdOption(runtimeData: RuntimeData | undefined): {
  // biome-ignore lint/style/useNamingConvention: Mastra's public stream option.
  experimental_generateMessageId?: () => string;
} {
  const assistantMessageId = runtimeData?.assistantMessageId;
  if (!assistantMessageId) {
    return {};
  }
  return {
    // The stream and persistence paths each consume their own one-shot
    // generator. Sharing one would make whichever Mastra path runs first force
    // the other to a UUID, breaking visible/persisted identity alignment.
    // biome-ignore lint/style/useNamingConvention: Mastra's public stream option.
    experimental_generateMessageId: createAssistantMessageIdGenerator(assistantMessageId).generate,
  };
}

/**
 * Matches the maximum user-selectable loop limit. The settings UI labels an
 * unset value as the default, so the runtime must not substitute a smaller
 * hidden cap that ends real coding tasks after only a handful of tool calls.
 */
const DEFAULT_AGENT_MAX_STEPS = 100;
const UNSUPPORTED_DIRECT_STREAM_OPTION_KEYS = [
  'activeTools',
  'clientTools',
  'inputProcessors',
  'outputProcessors',
  'prepareStep',
  'structuredOutput',
  'toolChoice',
  'toolsets',
] as const;

function assertNoUnsupportedDirectStreamOptions(options: MastraAgentRuntimeOptions): void {
  const providedUnsupportedKeys = UNSUPPORTED_DIRECT_STREAM_OPTION_KEYS.filter((key) =>
    Object.hasOwn(options, key)
  );
  if (providedUnsupportedKeys.length === 0) {
    return;
  }

  throw createMastraAgentError('mastra_agent_unsupported_stream_option', {
    context: { unsupportedOptions: providedUnsupportedKeys },
    detail: `Unsupported Mastra stream option(s): ${providedUnsupportedKeys.join(', ')}`,
  });
}

function resolvePositiveIntegerOption(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      context: { fieldName, value },
      detail: `${fieldName} must be a positive finite number`,
    });
  }
  return Math.floor(value);
}

function buildToolLoopOptions(
  runtimeData: RuntimeData | undefined,
  toolSearchProcessor: BrainstrikeToolSearchProcessor | undefined,
  toolHistoryFilter: ProjectionSafeToolCallFilter | undefined
): Pick<BrainstrikeAgentStreamOptions, 'inputProcessors' | 'maxSteps'> {
  const agentLoop = runtimeData?.agentLoop;
  const maxSteps = resolvePositiveIntegerOption(agentLoop?.maxSteps, 'agentLoop.maxSteps');
  const inputTokenLimit = resolvePositiveIntegerOption(
    agentLoop?.inputTokenLimit,
    'agentLoop.inputTokenLimit'
  );
  // ProviderHistoryCompat's PREEMPTIVE `processLLMRequest` rules (strip
  // foreign/unsupported reasoning before a provider that would reject it — the
  // only place cross-provider reasoning incompatibility is handled) fire ONLY
  // from `inputProcessors`, never `errorProcessors` (verified against the
  // compiled loop). It rides the SAME per-call array as the TokenLimiter so the
  // per-call replacement doesn't drop either; their hooks are disjoint stages,
  // so token trimming is unaffected. Excluded for the local provider.
  const historyCompat = buildProviderHistoryCompatInputProcessor(runtimeData?.provider ?? '');
  const openAIToolSearchHistoryCompat = buildOpenAIToolSearchHistoryCompatInputProcessor(
    runtimeData?.provider ?? ''
  );
  const tokenLimiter = inputTokenLimit
    ? new ProjectionAwareTokenLimiter({
        limit: inputTokenLimit,
        strategy: 'truncate',
        trimMode: 'contiguous',
      })
    : undefined;
  // Agent Skills metadata injection (progressive disclosure level 1): Mastra's
  // own SkillsProcessor puts the <available_skills> block into the system
  // message each input step. It rides the SAME per-call inputProcessors array
  // as the TokenLimiter (per-call options REPLACE the Agent-config array, so it
  // cannot live on the Agent config) and runs FIRST so the limiter counts the
  // injected block. Excluded for the built-in local provider — mirrors the
  // tool-map gate in createMastraAgentRuntime.
  const skillsProcessor =
    runtimeData?.workspaceSkills && runtimeData.provider !== 'local'
      ? new SkillsProcessor({ skills: runtimeData.workspaceSkills })
      : undefined;
  const inputProcessors: unknown[] = [
    skillsProcessor,
    toolSearchProcessor,
    toolHistoryFilter,
    historyCompat,
    openAIToolSearchHistoryCompat,
    tokenLimiter,
  ].filter((processor): processor is NonNullable<typeof processor> => processor !== undefined);

  return {
    maxSteps: maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
    ...(inputProcessors.length > 0 ? { inputProcessors } : {}),
  };
}

const resolveFullStream = (
  result: unknown
): NodeReadableStream<unknown> | ReadableStream<unknown> | undefined => {
  if (!result || typeof result !== 'object') {
    return;
  }
  return (result as StreamResultLike).fullStream;
};

function resolveMemoryOption(
  runtimeData: RuntimeData | undefined,
  memory: MastraMemory | undefined
): AgentMemoryOption | undefined {
  const memoryContext = runtimeData?.memory;
  if (!memoryContext) {
    return;
  }
  if (!memory) {
    throw createMastraAgentError('mastra_agent_memory_unavailable', {
      detail: 'runtime memory context was provided but no Mastra memory instance is configured',
    });
  }
  if (!memoryContext.threadId.trim()) {
    throw createMastraAgentError('mastra_agent_memory_unavailable', {
      detail: 'memory.threadId is required',
    });
  }
  if (!memoryContext.resourceId.trim()) {
    throw createMastraAgentError('mastra_agent_memory_unavailable', {
      detail: 'memory.resourceId is required',
    });
  }
  return {
    resource: memoryContext.resourceId,
    thread: memoryContext.threadId,
    ...(memoryContext.memoryOptions ? { options: memoryContext.memoryOptions } : {}),
  };
}

async function* streamChunksFromMastra({
  promptBreakdown,
  runtime,
  runtimeData,
  stream,
  streamAbortContext,
  sanitizedNameMap,
  resumedApprovalToolCall,
}: StreamGeneratorParams): AsyncIterableIterator<StreamChunk> {
  const toolNames = new Map<string, string>();
  const lifecycleState: ToolLifecycleState = {
    delegationLifecycle: createDelegationLifecycleTracker(),
    includeCacheTokenClasses: runtimeData?.provider === 'anthropic',
    outputOnlyToolEvents: new Map(),
    requiresBilledCost: runtimeData?.provider === 'openrouter',
    ...(runtimeData?.steering ? { steering: runtimeData.steering } : {}),
    sawStepBilledCost: false,
    sawStepWithoutBilledCost: false,
    stepBilledCostUsd: 0,
    steppedCompletionTokens: 0,
    steppedPromptTokens: 0,
    streamStartedAtMs: Date.now(),
    terminalToolCallStates: new Map(),
  };

  try {
    // Run-start prompt breakdown (transient, display-only). Emitted BEFORE the
    // first Mastra part so the mapper ships it ahead of any streaming text
    // (the mapper still applies the text-part deferral defensively).
    if (promptBreakdown) {
      yield { breakdown: promptBreakdown, type: 'context-breakdown' };
    }
    if (resumedApprovalToolCall) {
      toolNames.set(resumedApprovalToolCall.toolCallId, resumedApprovalToolCall.registeredToolName);
      yield {
        name: resumedApprovalToolCall.displayToolName,
        payload: {
          args: resumedApprovalToolCall.args,
          callId: resumedApprovalToolCall.toolCallId,
          input: resumedApprovalToolCall.args,
          toolCallId: resumedApprovalToolCall.toolCallId,
        },
        status: 'start',
        type: 'tool-event',
      };
    }
    const rawSource = readableStreamIterator(stream, streamAbortContext.signal);
    const toolInputBoundedSource = withToolCallInputTimeout(
      rawSource,
      runtime.resilienceConfig.streamInactivityMs,
      (error) => streamAbortContext.abort(error)
    );
    const source = withInactivityTimeout(
      toolInputBoundedSource,
      runtime.resilienceConfig.streamInactivityMs,
      (error) => streamAbortContext.abort(error)
    );
    for await (const part of source) {
      const { chunks, finished } = processMastraStreamPart(
        part,
        toolNames,
        lifecycleState,
        sanitizedNameMap,
        runtime.askTools,
        runtime.delegationToolPersonas,
        runtimeData
      );
      for (const chunk of chunks) {
        yield chunk;
      }

      if (finished) {
        runtime.assertAssistantMessageIdPersisted?.();
        return;
      }
    }
    // Aborted mid-run: settle any orphaned delegations (a cancelled parent must
    // never leave a forever-"running" subagent.started). Otherwise finalize a
    // missing-finish stream with pending tool output + a synthetic finish.
    const endChunks = runtimeData?.signal?.aborted
      ? makeCancelledDelegationRunEventChunks(lifecycleState)
      : makeMissingFinishStreamChunks(lifecycleState);
    for (const chunk of endChunks) {
      yield chunk;
    }
  } catch (error) {
    if (!isStreamWatchdogError(error)) {
      throw error;
    }
    const terminalChunks = runtimeData?.signal?.aborted
      ? makeCancelledDelegationRunEventChunks(lifecycleState)
      : makeStreamWatchdogTermination(error, lifecycleState, runtimeData);
    for (const chunk of terminalChunks) {
      yield chunk;
    }
    return;
  } finally {
    streamAbortContext.abort(new Error('Mastra stream consumption ended.'));
    streamAbortContext.dispose();
    logTokenDiagnostics(runtime, runtimeData, lifecycleState);
    logStreamOutcome(Boolean(runtimeData?.signal?.aborted));
    await runtime.dispose();
  }
}

/** Post-loop chunks when a stream ends WITHOUT a finish event (not aborted). */
function makeMissingFinishStreamChunks(lifecycleState: ToolLifecycleState): StreamChunk[] {
  logger.warn('mastra stream ended without finish event', {
    code: 'mastra_agent_stream_missing_finish',
  });
  return [...makePendingToolOutputRunEventChunks(lifecycleState), makeSyntheticFinishChunk()];
}

function logStreamOutcome(aborted: boolean): void {
  if (aborted) {
    logger.info('mastra stream aborted', { code: 'mastra_agent_stream_aborted' });
    return;
  }
  logger.info('mastra stream finished', { code: 'mastra_agent_stream_finished' });
}

function logTokenDiagnostics(
  runtime: MastraAgentRuntime,
  runtimeData: RuntimeData | undefined,
  lifecycleState: ToolLifecycleState
): void {
  const fields = runtime.tokenDiagnostics.toLogFields({
    ...(lifecycleState.providerReportedPromptTokens === undefined
      ? {}
      : { providerReportedPromptTokens: lifecycleState.providerReportedPromptTokens }),
  });
  const context = {
    code: 'mastra_agent_token_measurement',
    ...(runtimeData?.model ? { model: runtimeData.model } : {}),
    ...(runtimeData?.provider ? { provider: runtimeData.provider } : {}),
    ...fields,
  };
  if (fields['measurementStatus'] === 'failed') {
    logger.warn(context, 'mastra run token measurement failed visibly');
    return;
  }
  logger.info(context, 'mastra run token measurement recorded');
}

async function createStreamIteratorFromRuntime({
  runtime,
  runtimeData,
  messages,
  memory,
  requireToolApproval,
  sanitizedNameMap,
}: StreamIterationParams): Promise<StreamIterator> {
  const mastraMessages = convertMessagesToMastra(messages);
  const streamAbortContext = createStreamAbortContext(runtimeData?.signal);

  try {
    const streamInput = mastraMessages as unknown as Parameters<typeof runtime.agent.stream>[0];
    const memoryOption = resolveMemoryOption(runtimeData, memory);

    const streamOptions: BrainstrikeAgentStreamOptions = {
      ...buildToolLoopOptions(runtimeData, runtime.toolSearchProcessor, runtime.toolHistoryFilter),
      abortSignal: streamAbortContext.signal,
      ...buildAssistantStreamMessageIdOption(runtimeData),
      ...(memoryOption ? { memory: memoryOption } : {}),
      ...buildModelSettingsOption(runtimeData),
      ...buildGenerationProviderOptionsOption(runtimeData),
      // Delegation safety rails: per-run caps + maxSteps clamp + unknown-persona
      // rejection (only when the run has registered personas).
      ...(runtime.personasById.size > 0
        ? { delegation: createDelegationConfig({ logger, personasById: runtime.personasById }) }
        : {}),
      // When enabled, Mastra pauses before tool execution and emits resumable
      // approval metadata for the UI action bridge.
      ...(requireToolApproval === undefined ? {} : { requireToolApproval }),
    };
    const resolvedStreamOptions = Object.keys(streamOptions).length > 0 ? streamOptions : undefined;

    const streamResult = resolvedStreamOptions
      ? await runtime.agent.stream(streamInput, resolvedStreamOptions as AgentStreamOptions)
      : await runtime.agent.stream(streamInput);
    logger.info(
      {
        code: 'mastra_agent_stream_started',
        ...(runtimeData?.model ? { model: runtimeData.model } : {}),
        ...(runtimeData?.provider ? { provider: runtimeData.provider } : {}),
      },
      'mastra stream started'
    );

    const fullStream = resolveFullStream(streamResult);
    if (!fullStream) {
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: 'empty_stream',
      });
    }

    // Prompt breakdown for the context usage popover: instruction-side counts
    // were captured at Agent construction; the message-side counts (wire text +
    // attachments) join here, where the outgoing messages are in scope.
    // Memory-backed runs omit the history figure — Mastra recalls durable
    // history AFTER this seam, so the wire is not the conversation.
    const promptBreakdown = computePromptBreakdown({
      instructionBreakdown: runtime.instructionBreakdown,
      memoryBacked: Boolean(memoryOption),
      messages,
    });

    return streamChunksFromMastra({
      promptBreakdown,
      runtime,
      stream: fullStream,
      streamAbortContext,
      ...(runtimeData ? { runtimeData } : {}),
      ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
    });
  } catch (err) {
    streamAbortContext.abort(new Error('Mastra stream construction failed.'));
    streamAbortContext.dispose();
    return await handleStreamFailure(err, runtime);
  }
}

function validateToolApprovalAction(action: AssistantToolApprovalAction): void {
  if (!action.runId.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'tool approval action requires runId',
    });
  }
  if (!action.toolCallId.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'tool approval action requires toolCallId',
    });
  }
}

/**
 * The approval RESUME leg passes Mastra's run-wide `requireToolApproval: true`
 * (the resume API needs it — see docs/agents/assistant-runtime.md PERMISSION ENGINE). A blanket `true`
 * gates EVERY tool call on the resumed run. Substitute the FUNCTION form so the
 * rebuilt runtime reuses the permission gate's authoritative `askTools` set:
 * allowed read/state tools run free, ask-gated mutations can suspend again, and
 * Mastra's internal memory tools remain exempt. A caller-supplied function or a
 * non-`true` value passes through unchanged.
 *
 * An empty `askTools` is AMBIGUOUS and MUST be disambiguated by `permissionEnforced`:
 *  - `permissionEnforced === true` → a policy WAS enforced but resolved nothing
 *    to `'ask'`, i.e. every remaining tool is ALLOWED (e.g. "Allow all tools
 *    this session" granted all categories; denied tools were already omitted
 *    from the map). This is an all-allowed posture → gate NOTHING, so a later
 *    mutation tool in the same resumed run is NOT re-prompted.
 *  - `permissionEnforced === false` → NO policy was enforced yet the caller set
 *    run-wide `requireToolApproval: true` → a genuine explicit GLOBAL approval
 *    request → keep gating every non-internal tool (the pre-permission-engine
 *    behavior). Per-tool DENY still wins in both cases: a denied tool never
 *    reaches the map, so it never reaches this gate.
 */
function resolveResumeApprovalGate(
  requireToolApproval: ApprovalGate | undefined,
  askTools: ReadonlyMap<string, PermissionAskToolMetadata>,
  permissionEnforced: boolean
): ApprovalGate {
  if (requireToolApproval !== true) {
    return requireToolApproval ?? false;
  }
  // Global-gate ONLY when the empty ask set is a genuine global-approval request
  // (no policy enforced). An empty ask set UNDER an enforced policy is the
  // all-allowed posture: the function below then gates nothing (askTools.has is
  // always false), honoring "Allow all tools this session".
  const isExplicitGlobalApproval = askTools.size === 0 && !permissionEnforced;
  return ({ toolName }: { toolName: string }): boolean =>
    !isApprovalExemptInternalTool(toolName) && (isExplicitGlobalApproval || askTools.has(toolName));
}

async function readResumedApprovalToolCall(
  runtime: MastraAgentRuntime,
  runtimeData: RuntimeData | undefined,
  action: AssistantToolApprovalAction
): Promise<ResumedApprovalToolCall> {
  const memoryContext = runtimeData?.memory;
  const { runs } = await runtime.agent.listSuspendedRuns(
    memoryContext
      ? { resourceId: memoryContext.resourceId, threadId: memoryContext.threadId }
      : undefined
  );
  const run = runs.find((candidate) => candidate.runId === action.runId);
  const toolCall = run?.toolCalls.find(
    (candidate) => candidate.toolCallId === action.toolCallId && candidate.requiresApproval
  );
  if (!(toolCall?.toolName && toolCall.args !== undefined)) {
    throw createMastraAgentError('mastra_agent_stream_failure', {
      context: { runId: action.runId, toolCallId: action.toolCallId },
      detail: 'Suspended approval snapshot is missing the requested tool call or its arguments.',
    });
  }

  return {
    args: toolCall.args,
    displayToolName: resolveDiscoveredApprovalToolName(
      toolCall.toolName,
      runtime.toolNameMap,
      action.runId
    ),
    registeredToolName: toolCall.toolName,
    toolCallId: action.toolCallId,
  };
}

async function createToolApprovalIteratorFromRuntime({
  runtime,
  runtimeData,
  action,
  memory,
  requireToolApproval,
  sanitizedNameMap,
}: ToolApprovalIterationParams): Promise<StreamIterator> {
  const streamAbortContext = createStreamAbortContext(runtimeData?.signal);
  try {
    validateToolApprovalAction(action);
    const memoryOption = resolveMemoryOption(runtimeData, memory);
    const resumedApprovalToolCall = await readResumedApprovalToolCall(runtime, runtimeData, action);
    const approvalOptions: BrainstrikeAgentStreamOptions & {
      runId: string;
      toolCallId: string;
    } = {
      ...buildToolLoopOptions(runtimeData, runtime.toolSearchProcessor, runtime.toolHistoryFilter),
      abortSignal: streamAbortContext.signal,
      runId: action.runId,
      toolCallId: action.toolCallId,
      ...buildAssistantStreamMessageIdOption(runtimeData),
      ...(memoryOption ? { memory: memoryOption } : {}),
      ...buildModelSettingsOption(runtimeData),
      ...buildGenerationProviderOptionsOption(runtimeData),
      // Resume keeps the delegation rails so a resumed run still caps/rejects
      // subagent delegations consistently with the initial turn.
      ...(runtime.personasById.size > 0
        ? { delegation: createDelegationConfig({ logger, personasById: runtime.personasById }) }
        : {}),
      // Reapply the per-tool permission decisions instead of letting Mastra's
      // run-wide resume flag gate every subsequent tool call.
      ...(requireToolApproval === undefined
        ? {}
        : {
            requireToolApproval: resolveResumeApprovalGate(
              requireToolApproval,
              runtime.askTools,
              runtime.permissionEnforced
            ),
          }),
    };

    const streamResult =
      action.action === 'approve'
        ? await runtime.agent.approveToolCall(approvalOptions as AgentToolApprovalOptions)
        : await runtime.agent.declineToolCall(approvalOptions as AgentToolApprovalOptions);

    logger.info('mastra tool approval resume stream started', {
      action: action.action,
      code: 'mastra_agent_tool_approval_resume_started',
      runId: action.runId,
      toolCallId: action.toolCallId,
    });

    const fullStream = resolveFullStream(streamResult);
    if (!fullStream) {
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: 'empty_stream',
      });
    }

    return streamChunksFromMastra({
      runtime,
      stream: fullStream,
      streamAbortContext,
      ...(action.action === 'approve' ? { resumedApprovalToolCall } : {}),
      ...(runtimeData ? { runtimeData } : {}),
      ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
    });
  } catch (err) {
    streamAbortContext.abort(new Error('Mastra approval-resume stream construction failed.'));
    streamAbortContext.dispose();
    return await handleStreamFailure(err, runtime);
  }
}

async function handleStreamFailure(err: unknown, runtime: MastraAgentRuntime): Promise<never> {
  logger.error('mastra stream failed', {
    code: 'mastra_agent_stream_failed',
    error: err instanceof Error ? err.message : String(err),
  });
  try {
    await runtime.dispose();
  } catch (disposeError) {
    logger.warn('dispose after stream failure failed', {
      code: 'mastra_agent_runtime_dispose_failed',
      error: disposeError instanceof Error ? disposeError.message : String(disposeError),
    });
  }
  if (isMastraAgentError(err)) {
    throw err;
  }
  const errorDetail = err instanceof Error ? err.message : undefined;
  throw createMastraAgentError(
    'mastra_agent_stream_failure',
    errorDetail ? { cause: err, detail: errorDetail } : { cause: err }
  );
}

export async function streamMastraAgent(
  messages: AgentMessage[],
  options: MastraAgentRuntimeOptions = {}
): Promise<StreamIterator> {
  assertNoUnsupportedDirectStreamOptions(options);

  const runtimeData = options.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData);
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(options, runtimeResolution);

  // Per-call approval for `'ask'` tools comes from the PER-TOOL `requireApproval`
  // flag the permission gate set (see permission-tool-gate.ts), NOT from the
  // run-wide `requireToolApproval` — the global flag would suspend EVERY tool
  // call, including allowed read/mcp tools. We therefore only pass
  // `requireToolApproval` when the caller explicitly set it (e.g. a deliberate
  // approve-all run); an unset option leaves the run on the per-tool gate.
  const requireToolApproval = options.requireToolApproval;

  return createStreamIteratorFromRuntime({
    messages,
    runtime,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(requireToolApproval === undefined ? {} : { requireToolApproval }),
    runtimeData: runtimeResolution.runtime,
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}

/**
 * Derive the native tool map + selected model from the runtime when the caller
 * did not set them explicitly on the options.
 *
 * The initial-turn path does this in `toAiSdkStyleStream` (message-utils.ts):
 * `runtime.mastraTools -> options.tools` and `runtime.model -> options.model`.
 * The approval RESUME (`streamMastraToolApprovalAction`) calls
 * `initializeMastraRuntime` DIRECTLY, so without this it rebuilds the Agent with
 * an EMPTY native tool map — the model then sees only Mastra's memory tools (e.g.
 * `updateWorkingMemory`) and reports the approved tool "missing" (the desktop
 * write-on-approval bug) — and would silently fall back to the provider's DEFAULT
 * model instead of the user's selected one. `mcpConfig` needs no threading here:
 * `createMastraAgentRuntime` already falls back to `sanitizedRuntime.mcpConfig`.
 */
function withRuntimeDerivedStreamOptions(
  options: MastraAgentRuntimeOptions
): MastraAgentRuntimeOptions {
  const runtimeData = options.runtime;
  if (!runtimeData) {
    return options;
  }
  const derived: MastraAgentRuntimeOptions = { ...options };
  if (derived.tools === undefined && runtimeData.mastraTools) {
    derived.tools = runtimeData.mastraTools;
  }
  if (derived.model === undefined && runtimeData.model) {
    derived.model = runtimeData.model;
  }
  // Personas ride the same resume-parity seam: without this, the approval-resume
  // path rebuilds the supervisor WITHOUT its `agent-<id>` delegation tools (the
  // documented write-on-approval bug class applied to delegation).
  if (derived.personas === undefined && runtimeData.personas) {
    derived.personas = runtimeData.personas;
  }
  return derived;
}

export async function streamMastraToolApprovalAction(
  action: AssistantToolApprovalAction,
  options: MastraAgentRuntimeOptions = {}
): Promise<StreamIterator> {
  assertNoUnsupportedDirectStreamOptions(options);
  validateToolApprovalAction(action);
  if (!options.storage) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'Mastra workflow storage is required to resume tool approval.',
    });
  }

  const runtimeData = options.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData);
  let preserveExecuteBackedWebSearch = false;
  if (providerSupportsNativeWebSearch(runtimeResolution.provider)) {
    // The action's optional toolName is display-only and client-controlled. Use
    // Mastra's storage-backed snapshot as the authority before deciding whether
    // this immutable resumed leg must keep the execute-backed web-search tool.
    const { runtime: discoveryRuntime } = await initializeMastraRuntime(
      withRuntimeDerivedStreamOptions({
        ...options,
        modelOverride: createListingOnlyModel(),
      }),
      runtimeResolution
    );
    try {
      const suspendedToolCall = await readResumedApprovalToolCall(
        discoveryRuntime,
        runtimeResolution.runtime,
        action
      );
      preserveExecuteBackedWebSearch = suspendedToolCall.displayToolName === WEB_SEARCH_TOOL_ID;
    } finally {
      await discoveryRuntime.dispose();
    }
  }
  // Thread runtime.mastraTools/model into the options so the rebuilt Agent keeps
  // the native tools on resume (see withRuntimeDerivedStreamOptions).
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(
    {
      ...withRuntimeDerivedStreamOptions(options),
      hydrateToolDiscoveryFromMemory: true,
      // The durable run suspended against the execute-backed tool. A session
      // grant changes authorization for this leg, not the stored invocation's
      // implementation. The next fresh turn may select provider-native search.
      preserveExecuteBackedWebSearch,
    },
    runtimeResolution
  );

  return createToolApprovalIteratorFromRuntime({
    action,
    runtime,
    ...(options.memory ? { memory: options.memory } : {}),
    ...(options.requireToolApproval === undefined
      ? {}
      : { requireToolApproval: options.requireToolApproval }),
    runtimeData: runtimeResolution.runtime,
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}

export interface DiscoveredSuspendedApproval {
  readonly args?: unknown;
  readonly runId: string;
  /** ISO-8601 instant the run suspended (AgentRun.suspendedAt). */
  readonly suspendedAt: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface ListSuspendedApprovalsResult {
  readonly approvals: readonly DiscoveredSuspendedApproval[];
}

/**
 * Map a suspended tool call's REGISTERED (Mastra-sanitized) id back to the
 * ORIGINAL name every client-facing approval surface is keyed by (riskByTool
 * lookups, per-tool overrides, the notice label). Resolution order:
 * 1. the discovery runtime's `toolNameMap` (authoritative when the tool is
 *    registered on this runtime — covers custom/MCP dotted names), then
 * 2. the static native reverse map (`denormalizeNativeToolName`) — covers the
 *    desktop KEYLESS discovery route, which registers NO tools, for every
 *    known native id (the confirmed `brainstrike_executeCommand` live bug).
 * When neither resolves, the registered id is returned unchanged with a LOUD
 * warning: the pause still surfaces (the user can approve/decline), but risk
 * metadata / grant actions will be honestly unavailable downstream — never a
 * silent drop, never a fabricated mapping (no-silent-fallbacks).
 */
function resolveDiscoveredApprovalToolName(
  registeredToolName: string,
  toolNameMap: ReadonlyMap<string, string>,
  runId: string
): string {
  const mapped = toolNameMap.get(registeredToolName);
  if (mapped !== undefined) {
    return mapped;
  }
  const nativeDotted = denormalizeNativeToolName(registeredToolName);
  if (nativeDotted !== registeredToolName) {
    return nativeDotted;
  }
  logger.warn('suspended approval tool name could not be mapped to an original name', {
    code: 'mastra_agent_suspended_tool_name_unmapped',
    runId,
    toolName: registeredToolName,
  });
  return registeredToolName;
}

/**
 * Restart-safe discovery of pending tool approvals for a thread. Rebuilds a
 * FRESH runtime (like {@link streamMastraToolApprovalAction}) and calls the
 * sanctioned `agent.listSuspendedRuns` — it holds no in-memory stream handle, so
 * it works after a process restart / renderer reload given only the thread
 * context. It is INERT: listing performs no inference and never resumes a run.
 *
 * Returns ONLY approval-gated tool calls (`requiresApproval === true`) that carry
 * a `toolCallId` + `toolName`. Non-approval `suspend()` pauses (submitPlan/askUser)
 * and delegation-thread runs are tolerated and skipped without error (logged at
 * debug) — a unified suspend rediscovery is a follow-up. Storage is REQUIRED (no
 * storage ⇒ no discovery, never a silent empty result).
 */
export async function listSuspendedMastraRuns(
  filter: { readonly threadId: string; readonly resourceId: string },
  options: MastraAgentRuntimeOptions = {}
): Promise<ListSuspendedApprovalsResult> {
  assertNoUnsupportedDirectStreamOptions(options);
  if (!options.storage) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'Mastra workflow storage is required to discover suspended approvals.',
    });
  }

  const runtimeResolution = resolveRuntimeConfiguration(options.runtime);
  // Listing performs NO inference: build the runtime with an inert model so no
  // provider/model is resolved. This is why the discovery route can pass a
  // keyless provider with no static default (e.g. ollama) without the
  // `No default model configured` init throw (the D1 fix).
  const { runtime } = await initializeMastraRuntime(
    withRuntimeDerivedStreamOptions({ ...options, modelOverride: createListingOnlyModel() }),
    runtimeResolution
  );

  try {
    const { runs } = await runtime.agent.listSuspendedRuns({
      resourceId: filter.resourceId,
      threadId: filter.threadId,
    });

    const approvals: DiscoveredSuspendedApproval[] = [];
    for (const run of runs) {
      const suspendedAt = run.suspendedAt.toISOString();
      for (const toolCall of run.toolCalls) {
        if (!(toolCall.requiresApproval && toolCall.toolCallId && toolCall.toolName)) {
          logger.debug('skipping non-approval suspended tool call', {
            code: 'mastra_agent_suspended_run_skipped',
            requiresApproval: toolCall.requiresApproval,
            runId: run.runId,
            toolName: toolCall.toolName,
          });
          continue;
        }
        approvals.push({
          runId: run.runId,
          suspendedAt,
          toolCallId: toolCall.toolCallId,
          // Snapshots store the REGISTERED (sanitized) id; every client-facing
          // surface is keyed by the ORIGINAL name — map it back here so the
          // desktop route's riskByTool lookup and per-tool overrides match.
          toolName: resolveDiscoveredApprovalToolName(
            toolCall.toolName,
            runtime.toolNameMap,
            run.runId
          ),
          ...(toolCall.args === undefined ? {} : { args: toolCall.args }),
        });
      }
    }

    approvals.sort((a, b) => Date.parse(a.suspendedAt) - Date.parse(b.suspendedAt));

    logger.info('discovered suspended approvals', {
      approvalCount: approvals.length,
      code: 'mastra_agent_suspended_runs_discovered',
      runCount: runs.length,
      threadId: filter.threadId,
    });

    return { approvals };
  } finally {
    await runtime.dispose();
  }
}

// resumeStream's resumeData param is typed `any` by Mastra; we cast a typed
// `unknown` through this alias at the single call site (no other `any` here).
type AgentResumeStreamOptions = Parameters<Agent['resumeStream']>[1];

interface ToolResumeIterationParams {
  action: AssistantToolResumeAction;
  memory?: MastraMemory;
  runtime: MastraAgentRuntime;
  runtimeData?: RuntimeData;
  sanitizedNameMap?: Map<string, string>;
}

function validateToolResumeAction(action: AssistantToolResumeAction): void {
  if (!action.runId.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'tool resume action requires runId',
    });
  }
  if (!action.toolCallId.trim()) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'tool resume action requires toolCallId',
    });
  }
}

async function createToolResumeIteratorFromRuntime({
  runtime,
  runtimeData,
  action,
  memory,
  sanitizedNameMap,
}: ToolResumeIterationParams): Promise<StreamIterator> {
  const streamAbortContext = createStreamAbortContext(runtimeData?.signal);
  try {
    validateToolResumeAction(action);
    const memoryOption = resolveMemoryOption(runtimeData, memory);
    const resumeOptions = {
      ...buildToolLoopOptions(runtimeData, runtime.toolSearchProcessor, runtime.toolHistoryFilter),
      abortSignal: streamAbortContext.signal,
      runId: action.runId,
      toolCallId: action.toolCallId,
      ...buildAssistantStreamMessageIdOption(runtimeData),
      ...(memoryOption ? { memory: memoryOption } : {}),
      ...buildModelSettingsOption(runtimeData),
      ...buildGenerationProviderOptionsOption(runtimeData),
      // Resume keeps the delegation rails so a resumed run (e.g. an askUser
      // pause→answer that then delegates) still caps/rejects subagent
      // delegations consistently with the initial + approval-resume iterators.
      ...(runtime.personasById.size > 0
        ? { delegation: createDelegationConfig({ logger, personasById: runtime.personasById }) }
        : {}),
    };

    // resumeData is validated by Mastra against the suspended tool's resumeSchema.
    const streamResult = await runtime.agent.resumeStream(
      action.resumeData as Parameters<typeof runtime.agent.resumeStream>[0],
      resumeOptions as AgentResumeStreamOptions
    );

    logger.info('mastra tool resume stream started', {
      code: 'mastra_agent_tool_resume_started',
      runId: action.runId,
      toolCallId: action.toolCallId,
    });

    const fullStream = resolveFullStream(streamResult);
    if (!fullStream) {
      throw createMastraAgentError('mastra_agent_stream_failure', {
        detail: 'empty_stream',
      });
    }

    return streamChunksFromMastra({
      runtime,
      stream: fullStream,
      streamAbortContext,
      ...(runtimeData ? { runtimeData } : {}),
      ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
    });
  } catch (err) {
    streamAbortContext.abort(new Error('Mastra suspended-tool stream construction failed.'));
    streamAbortContext.dispose();
    return await handleStreamFailure(err, runtime);
  }
}

/**
 * Resume a SUSPENDED tool call (submitPlan/askUser) via
 * `agent.resumeStream(resumeData, { runId, toolCallId })`. Parallels
 * {@link streamMastraToolApprovalAction} but for the generic suspend transport:
 * `action.resumeData` is arbitrary (a plan decision or an answer) and validated
 * by Mastra against the tool's resumeSchema. Workflow storage is REQUIRED (the
 * snapshot must exist to resume — no silent fallback). `withRuntimeDerivedStreamOptions`
 * is mandatory so the rebuilt Agent keeps its native tools (the same desktop
 * write-on-approval fix). Stateless: it holds no in-memory runId, so a future
 * `listSuspendedRuns` rehydrator can call it with a discovered runId unchanged.
 * Does NOT pass `requireToolApproval` (that is approval-specific).
 */
export async function streamMastraToolResumeAction(
  action: AssistantToolResumeAction,
  options: MastraAgentRuntimeOptions = {}
): Promise<StreamIterator> {
  assertNoUnsupportedDirectStreamOptions(options);
  validateToolResumeAction(action);
  if (!options.storage) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'Mastra workflow storage is required to resume a suspended tool.',
    });
  }

  const runtimeData = options.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData);
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(
    { ...withRuntimeDerivedStreamOptions(options), hydrateToolDiscoveryFromMemory: true },
    runtimeResolution
  );

  return createToolResumeIteratorFromRuntime({
    action,
    runtime,
    ...(options.memory ? { memory: options.memory } : {}),
    runtimeData: runtimeResolution.runtime,
    ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
  });
}
