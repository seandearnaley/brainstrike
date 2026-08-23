/**
 * BST-986: the TOOL-LIFECYCLE half of the Mastra stream boundary — the mutable
 * per-run record plus every mapper that reads or advances it.
 *
 * {@link ToolLifecycleState} is deliberately a mutable record shared by the
 * chunk mappers AND read by the orchestration loop after the loop ends
 * (token diagnostics, missing-finish finalization). Purifying it is explicitly
 * NOT part of this split; the concern being separated here is ownership, so the
 * state and the only code allowed to advance it now live together.
 *
 * The R6 dispatch itself (`processMastraStreamPart`), the static chunk
 * disposition inventory, and `warnForUnrecognizedMastraStreamPart` stay in
 * `agent-streaming.ts` — `scripts/mastra-stream-chunk-contract.mjs` pins all
 * three to that file BY PATH. See docs/agents/mastra-boundary.md R6.
 */
import {
  type AssistantPersonaDefinition,
  SUBAGENT_NO_ANSWER_OUTCOME,
} from '@brainstrike/assistant-contract/personas';
import type { AssistantRunEventMetadata } from '../run-events';
import type { ToolExecutionDurations } from '../tools/tool-execution-durations';
import type { RuntimeData, StreamChunk, StreamChunkTool } from '../types';
import {
  asMastraStreamPart,
  getToolCallIdFromToolEvent,
  makeStepMetadata,
  makeToolEventMetadata,
  readFinishReason,
} from './mastra-chunk-decoding';
import {
  readCacheTokenCount,
  readOpenRouterBilledCost,
  readStreamPartUsage,
} from './runtime-assembly/usage-metering';
import { makeRunEventChunk } from './stream-run-event-chunks';
import type {
  DelegationLifecycleTracker,
  DelegationOutcomeCapture,
  SubagentChildUsageReport,
} from './subagent-delegation';
import {
  mapMastraToolEvent,
  readMastraStreamPartString,
  readNestedToolOutputChunk,
} from './tool-event-mapper';

type TerminalToolCallState = 'completed' | 'failed';

interface OutputOnlyToolEvent {
  timestamp: string;
  toolEvent: StreamChunkTool;
}

export interface ToolLifecycleState {
  /**
   * Token totals from EARLIER attempts of the same turn (BST-1409), zero on a
   * turn that never stalled.
   *
   * Mastra's finish usage is cumulative across the steps of ONE stream, so a
   * continuation's finish reports only its own attempt. These are added back in
   * {@link makeFinishChunk} so the ledger a recovered turn persists is the
   * turn's real spend rather than its last attempt's. Kept separate from
   * `stepped*` because those retain their per-stream meaning for the steered
   * finish, which reads them directly.
   */
  carriedCompletionTokens: number;
  carriedPromptTokens: number;
  delegationLifecycle: DelegationLifecycleTracker;
  /**
   * Which delegations returned no written answer (BST-1410). Absent when the
   * run registered no personas. Read when mapping a delegation `tool-result`:
   * emptiness is invisible on that part, because `resultText` has already
   * replaced the empty text with its explanation by then.
   */
  delegationOutcomes?: DelegationOutcomeCapture;
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
  /** Number of completed provider steps observed in this run. */
  stepCount: number;
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
  /**
   * Real per-call execution time from the guard wrapper, stamped onto terminal
   * tool run events. Absent on a runtime that did not record (tests, older
   * callers) — then the event carries no `durationMs` and consumers fall back
   * to the timestamp delta, which is the pre-existing behaviour rather than a
   * fabricated number.
   */
  toolExecutionDurations?: ToolExecutionDurations;
  warnedUnknownChunkTypes: Set<string>;
}

export interface ProcessStreamPartResult {
  chunks: StreamChunk[];
  finished: boolean;
}

export function makeFinishChunk(part: unknown, lifecycleState: ToolLifecycleState): StreamChunk {
  const p = asMastraStreamPart(part);
  const usage = readStreamPartUsage(p) ?? {};
  const promptTokensRaw = usage.promptTokens ?? usage.inputTokens;
  const attemptPromptTokens = Number.isFinite(promptTokensRaw) ? (promptTokensRaw ?? 0) : 0;
  const promptTokens = attemptPromptTokens + lifecycleState.carriedPromptTokens;
  const completionTokensRaw = usage.completionTokens ?? usage.outputTokens;
  const attemptCompletionTokens = Number.isFinite(completionTokensRaw)
    ? (completionTokensRaw ?? 0)
    : 0;
  const completionTokens = attemptCompletionTokens + lifecycleState.carriedCompletionTokens;
  // CONTEXT sizes describe the latest step's prompt, not the turn's spend, so
  // they stay on this attempt's numbers — adding earlier attempts would claim a
  // context window that never existed.
  const contextInputTokens = lifecycleState.latestStepPromptTokens ?? attemptPromptTokens;
  const contextOutputTokens = lifecycleState.latestStepCompletionTokens ?? attemptCompletionTokens;
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

export function makeLifecycleStepMetadata(
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

export function recordFirstTextLatency(delta: string, lifecycleState: ToolLifecycleState): void {
  if (delta.length === 0 || lifecycleState.firstTextLatencyMs !== undefined) {
    return;
  }
  lifecycleState.firstTextLatencyMs = Math.max(0, Date.now() - lifecycleState.streamStartedAtMs);
}

export function makeTerminalRunEvent(
  part: unknown,
  lifecycleState: ToolLifecycleState
): StreamChunk {
  const finishReason = readFinishReason(part);
  const terminalMetadata: AssistantRunEventMetadata = {
    ...(makeLifecycleStepMetadata(part, lifecycleState) ?? {}),
    finishReason,
  };
  if (
    finishReason === 'absent' ||
    finishReason === 'stop' ||
    finishReason === 'tool-calls' ||
    finishReason === 'unknown'
  ) {
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
export function makeCancelledDelegationRunEventChunks(
  lifecycleState: ToolLifecycleState
): StreamChunk[] {
  return lifecycleState.delegationLifecycle
    .drainInFlight()
    .map((metadata) =>
      makeRunEventChunk('subagent.failed', 'cancelled', 'Subagent cancelled', metadata)
    );
}

/**
 * Stamp the terminal tool run event with the time `execute` actually ran.
 *
 * `AssistantRunEvent.durationMs` already exists in the contract; tool events
 * simply never populated it, leaving consumers to subtract `tool.started`'s
 * timestamp. That subtraction is wrong for an approval-gated call: the gate
 * suspends BEFORE `execute` is invoked, so the gap spans the human approval
 * wait — a two-second script behind a five-minute approval read as five
 * minutes. Only the guard wrapper sees the real window.
 *
 * No recorded duration leaves the event unchanged rather than inventing one.
 */
function withToolExecutionDuration(
  chunk: StreamChunk,
  lifecycleState: ToolLifecycleState,
  toolCallId: string
): StreamChunk {
  const durationMs = lifecycleState.toolExecutionDurations?.read(toolCallId);
  if (durationMs === undefined) {
    return chunk;
  }
  const runEvent = chunk as Extract<StreamChunk, { type: 'run-event' }>;
  return { ...runEvent, event: { ...runEvent.event, durationMs } };
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
      return withToolExecutionDuration(
        makeRunEventChunk('tool.completed', 'completed', 'Tool completed', metadata),
        lifecycleState,
        toolCallId
      );
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
      return withToolExecutionDuration(
        makeRunEventChunk('tool.failed', 'failed', 'Tool failed', metadata),
        lifecycleState,
        toolCallId
      );
    }
    case 'declined': {
      if (!toolCallId) {
        return;
      }
      if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
        return;
      }
      lifecycleState.terminalToolCallStates.set(toolCallId, 'failed');
      lifecycleState.outputOnlyToolEvents.delete(toolCallId);
      // A declined `requireApproval` call (@mastra/core 1.59 `tool-output-denied`)
      // keeps the `tool.failed` KIND deliberately, and only relabels. The kind is
      // what `getMatchingFailedKind` pairs `tool.started` against and what
      // `collectToolDurations` / `RUN_LEDGER_AGGREGATION_SQL` close a call out
      // on — and here the call really IS over: the framework consumed the
      // decline, the tool never runs, and no later terminal part carries this id.
      // That is the opposite of `tool.resume.unsupported` (BST-558), whose run
      // stays suspended and can still emit the real terminal later.
      return makeRunEventChunk('tool.failed', 'failed', 'Tool call declined', metadata);
    }
    case 'progress':
      return;
  }
}

export function makePendingToolOutputRunEventChunks(
  lifecycleState: ToolLifecycleState
): StreamChunk[] {
  const chunks: StreamChunk[] = [];
  for (const [toolCallId, outputOnlyToolEvent] of lifecycleState.outputOnlyToolEvents) {
    if (lifecycleState.terminalToolCallStates.has(toolCallId)) {
      continue;
    }
    lifecycleState.terminalToolCallStates.set(toolCallId, 'completed');
    // Sequence remains the ordering source of truth; this timestamp preserves
    // when the output-only terminal observation happened for duration metrics.
    chunks.push(
      // Stamped here too: this is a SUPPORTED terminal shape (a `tool-output`
      // success with no following `tool-result`), and a stamp applied only on
      // the tool-result path would leave it falling back to the
      // start-to-terminal gap — approval wait included.
      withToolExecutionDuration(
        makeRunEventChunk(
          'tool.completed',
          'completed',
          'Tool completed',
          makeToolEventMetadata(outputOnlyToolEvent.toolEvent),
          outputOnlyToolEvent.timestamp
        ),
        lifecycleState,
        toolCallId
      )
    );
  }
  lifecycleState.outputOnlyToolEvents.clear();
  return chunks;
}

/**
 * Resolve the delegation persona id for a parent `tool-call`/`tool-result`/
 * `tool-error` part whose tool is an `agent-<key>` delegation tool, or undefined
 * when it is an ordinary tool. Delegation tool names are Mastra-constructed
 * (`agent-<personaId>`) and never enter the sanitized name map, so the raw
 * toolName equals the key we look up.
 */
export function resolveDelegationPersona(
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
export function mapDelegationToolOutput(
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
export function mapGenericToolEvent(
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

/**
 * Per-leg bridge from `onDelegationComplete` (a Mastra callback OUTSIDE the
 * chunk loop) to the stream: completed child usage queues here and the
 * generator drains it into `child-run-usage` chunks on the next loop
 * iteration (the delegation tool-result part always follows the completion
 * callback) with a post-loop drain as the backstop. Model attribution is the
 * persona's model pin when present, else the parent run's model — the same
 * resolution the child actually executed with (never a guess).
 */
export interface DelegationUsageCapture {
  drain: () => StreamChunk[];
  onChildUsage: (report: SubagentChildUsageReport) => void;
}

export function createDelegationUsageCapture(
  personasById: ReadonlyMap<string, AssistantPersonaDefinition>,
  runtimeData: RuntimeData | undefined
): DelegationUsageCapture {
  const pending: StreamChunk[] = [];
  return {
    drain: () => pending.splice(0, pending.length),
    onChildUsage: (report) => {
      const pin = personasById.get(report.personaId)?.model;
      const model = pin?.modelId ?? runtimeData?.model;
      const provider = pin?.provider ?? runtimeData?.provider;
      pending.push({
        type: 'child-run-usage',
        value: {
          estimated: false,
          inputTokens: report.inputTokens,
          ...(model ? { model } : {}),
          outputTokens: report.outputTokens,
          personaId: report.personaId,
          ...(provider ? { provider } : {}),
          source: 'subagent',
        },
      });
    },
  };
}

/** Every Mastra part type that carries a delegation's own lifecycle. */
export type DelegationLifecyclePartType =
  | 'tool-call'
  | 'tool-error'
  | 'tool-output-denied'
  | 'tool-result';

/** The subagent.* run event that mirrors a delegation tool-call/result/error/decline. */
function makeSubagentLifecycleChunk(
  partType: DelegationLifecyclePartType,
  metadata: AssistantRunEventMetadata,
  returnedNoAnswer: boolean
): StreamChunk {
  if (partType === 'tool-call') {
    return makeRunEventChunk('subagent.started', 'running', 'Subagent started', metadata);
  }
  if (partType === 'tool-error') {
    return makeRunEventChunk('subagent.failed', 'failed', 'Subagent failed', metadata);
  }
  if (partType === 'tool-output-denied') {
    // The user declined the delegation at its approval gate, so the child never
    // ran. It is still a TERMINAL for the `subagent.started` the parent's
    // `tool-call` already emitted — the same "never leave an orphan" rule
    // `makeCancelledDelegationRunEventChunks` enforces on the abort path — so
    // the decline must not be the one delegation terminal that goes unemitted.
    // `'cancelled'`, not `'failed'`: nothing broke, the user chose.
    return makeRunEventChunk(
      'subagent.failed',
      'cancelled',
      'Subagent delegation declined',
      metadata
    );
  }
  if (returnedNoAnswer) {
    // BST-1410. The tool call returned, but the delegation did not do its job:
    // the child wrote no summary, so the parent got tool results nobody
    // analysed. Reporting that as `completed` is the silent success that made
    // the supervisor abandon delegation for a whole turn. `'failed'`, not
    // `'cancelled'`: nothing was cancelled and nobody chose this.
    //
    // `outcome` is the MACHINE-READABLE discriminator. Both this case and a
    // hard child `tool-error` are `subagent.failed`/`failed`, so the card must
    // not have to tell them apart by sniffing the label. It is a bounded enum
    // string, not args or results, so it respects the ids/labels-only rule for
    // subagent metadata.
    return makeRunEventChunk('subagent.failed', 'failed', 'Subagent returned no answer', {
      ...metadata,
      outcome: SUBAGENT_NO_ANSWER_OUTCOME,
    });
  }
  return makeRunEventChunk('subagent.finished', 'completed', 'Subagent completed', metadata);
}

/**
 * A delegation tool-call/result/error/decline part: the generic tool event PLUS
 * a mirrored subagent.* run event, while tracking the delegation's in-flight
 * lifecycle so an aborted run can emit a terminal event for orphans.
 */
export function mapToolLifecyclePart(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  partType: DelegationLifecyclePartType,
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
  const returnedNoAnswer = Boolean(
    partType === 'tool-result' &&
      delegation.parentToolCallId &&
      lifecycleState.delegationOutcomes?.returnedNoAnswer(delegation.parentToolCallId)
  );
  return {
    chunks: [...generic.chunks, makeSubagentLifecycleChunk(partType, metadata, returnedNoAnswer)],
    finished: false,
  };
}
