/**
 * Mastra agent streaming (BST-742): the public stream entry points
 * (`streamMastraAgent`, `streamMastraToolApprovalAction`,
 * `streamMastraToolResumeAction`), the R6 stream-part dispatch
 * (`processMastraStreamPart`), and the per-attempt chunk generator
 * (`streamAttemptChunks`). Runtime ASSEMBLY (the factory + tool pipeline)
 * lives in `agent-runtime.ts` / `runtime-assembly/`; this module depends on
 * it, never the reverse.
 *
 * The mapping concerns the dispatch delegates to (BST-986): run-event minting in
 * `stream-run-event-chunks.ts`, tool-lifecycle state + tool/delegation mapping in
 * `tool-lifecycle-processors.ts`, approval/suspend pauses in
 * `tool-approval-chunks.ts`, and abnormal-ending policy in
 * `stream-termination.ts`. The pure decoders live in `mastra-chunk-decoding.ts`
 * (BST-985). What stays HERE is pinned by path in
 * `scripts/mastra-stream-chunk-contract.mjs`: the `ChunkType` import, the static
 * disposition inventory, `processMastraStreamPart`, and
 * `warnForUnrecognizedMastraStreamPart`.
 *
 * BST-1649 split four concerns out of what was one 3,731-line file:
 * thread-title generation (`thread-title-generation.ts`, called from
 * `streamAttemptChunks` via `ensureMastraThreadTitleGeneration`), the
 * stream-option builders (`runtime-assembly/stream-options.ts`), the
 * turn/attempt model + three attempt-leg factories (`turn-attempts.ts` /
 * `attempt-legs.ts`, whose entry points this module imports and which import
 * `streamAttemptChunks` back — see `turn-attempts.ts`'s module doc), and
 * suspended-run discovery (`suspended-run-discovery.ts`, including
 * `listSuspendedMastraRuns`).
 *
 * See docs/agents/assistant-runtime.md and docs/agents/mastra-boundary.md R6.
 */
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AssistantContextBreakdown } from '@brainstrike/assistant-contract/context-breakdown';
import { SUBAGENT_DELEGATION_TOOL_PREFIX } from '@brainstrike/assistant-contract/personas';
import type { AssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import type { AssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/logging';
import { generateUUID } from '@brainstrike/utils';
import type { MastraMemory } from '@mastra/core/memory';
import type { ChunkType } from '@mastra/core/stream';
import { isContextOverflowProviderErrorCode } from '../provider-error-metadata';
import { createListingOnlyModel } from '../providers/listing-only-model';
import {
  providerSupportsNativeWebSearch,
  WEB_SEARCH_TOOL_ID,
} from '../providers/native-web-search';
import { getDefaultModel } from '../providers/provider-factory';
import { formatDiagnosticChunkType } from '../stream/diagnostic-chunk-type';
import { readableStreamIterator } from '../stream/readable-stream-iterator';
import { withInactivityTimeout } from '../stream/with-inactivity-timeout';
import { withToolCallInputTimeout } from '../stream/with-tool-call-input-timeout';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type {
  AgentMessage,
  RuntimeData,
  StreamChunk,
  StreamChunkTool,
  StreamIterator,
} from '../types';
import type { AbortedTurnPersistence } from './aborted-turn-persistence';
import {
  createMastraAgentRuntime,
  type MastraAgentRuntime,
  type MastraAgentRuntimeOptions,
} from './agent-runtime';
import {
  createStreamIteratorFromRuntime,
  createToolApprovalIteratorFromRuntime,
  createToolResumeIteratorFromRuntime,
  readResumedApprovalToolCall,
  validateToolApprovalAction,
  validateToolResumeAction,
} from './attempt-legs';
import { createDelegatedStreamProjection } from './delegated-stream-projection';
import { captureDelegatedSystemContext } from './delegated-system-context';
import { createMastraAgentError, isMastraAgentError } from './mastra-agent-error';
import {
  asMastraStreamPart,
  getDeltaText,
  isObservationalMemoryDataChunkType,
  type MastraStreamPart,
  makeStepMetadata,
  OM_FAILURE_DETAIL_MAX_CHARS,
  readFinishReason,
  readOmTokenCount,
  resolveProviderError,
  resolveTripwire,
  truncateStreamDetail,
} from './mastra-chunk-decoding';
import { MCP_PROGRESS_STREAM_PART_TYPE, mapMcpProgressStreamPart } from './mcp-runtime-client';
import type { PermissionAskToolMetadata } from './permission-tool-gate';
import { drainProviderCallWarningChunks } from './provider-warning-run-events';
import { assertNoUnsupportedDirectStreamOptions } from './runtime-assembly/stream-options';
import {
  accumulateSteppedUsage,
  readOpenRouterBilledCost,
  readStreamPartUsage,
} from './runtime-assembly/usage-metering';
import {
  type ResolvedRuntimeConfiguration,
  resolveRuntimeConfiguration,
} from './runtime-configuration';
import { mapShellOutputStreamPart, SHELL_OUTPUT_STREAM_PART_TYPE } from './shell-output-stream';
import { makeRunEventChunk } from './stream-run-event-chunks';
import {
  drainDelegationUsageChunks,
  drainTokenEstimateCalibrationChunk,
  drainToolCallTelemetryChunks,
  logStreamOutcome,
  logTokenDiagnostics,
  makeMissingFinishStreamChunks,
} from './stream-telemetry-drains';
import {
  EmptyModelResponseError,
  isStreamWatchdogError,
  makeDelegatedStreamTermination,
  makeProviderErrorTermination,
  makeTripwireTermination,
} from './stream-termination';
import { ensureMastraThreadTitleGeneration } from './thread-title-generation';
import { makeApprovalRequiredChunks, makeToolSuspendRequiredChunks } from './tool-approval-chunks';
import {
  COMPLETED_FINISH_REASONS,
  type DelegationUsageCapture,
  makeCancelledDelegationRunEventChunks,
  makeFinishChunk,
  makeLifecycleStepMetadata,
  makePendingToolOutputRunEventChunks,
  makeTerminalRunEvent,
  makeToolLifecycleRunEventChunk,
  mapDelegationToolOutput,
  mapGenericToolEvent,
  mapToolLifecyclePart,
  type ProcessStreamPartResult,
  recordFirstTextLatency,
  resolveDelegationPersona,
  type ToolLifecycleState,
} from './tool-lifecycle-processors';
import { createTurnAttemptLifecycleState, type StreamAbortContext } from './turn-attempts';

const logger = createLogger('MastraAgent');

type DynamicMastraChunkType =
  | `agent-execution-event-${string}`
  | `data-${string}`
  | `workflow-execution-event-${string}`;
type MastraChunkTypeMustStayLiteral = string extends ChunkType['type'] ? never : unknown;
type StaticMastraChunkType = Exclude<ChunkType['type'], DynamicMastraChunkType>;
type MastraStaticChunkDisposition = 'ignored' | 'mapped';

/**
 * A complete disposition inventory for Mastra's exported static chunk union.
 * `satisfies` makes a newly-added literal chunk type a type-check failure at
 * upgrade time. `ignored` is a deliberate no-output decision; `mapped` means
 * the switch below must consume the type. Dynamic chunk families remain
 * observable at runtime because an unhandled member has no disposition.
 */
const MASTRA_STATIC_CHUNK_DISPOSITIONS = {
  abort: 'ignored',
  'agent-execution-abort': 'ignored',
  'agent-execution-approval': 'ignored',
  'agent-execution-end': 'ignored',
  'agent-execution-start': 'ignored',
  'agent-execution-suspended': 'ignored',
  'background-task-cancelled': 'ignored',
  'background-task-completed': 'ignored',
  'background-task-failed': 'ignored',
  'background-task-output': 'ignored',
  'background-task-progress': 'ignored',
  'background-task-resumed': 'ignored',
  'background-task-running': 'ignored',
  'background-task-started': 'ignored',
  'background-task-suspended': 'ignored',
  custom: 'ignored',
  error: 'mapped',
  file: 'ignored',
  finish: 'mapped',
  goal: 'ignored',
  'is-task-complete': 'ignored',
  'network-execution-event-finish': 'ignored',
  'network-execution-event-step-finish': 'ignored',
  'network-object': 'ignored',
  'network-object-result': 'ignored',
  'network-validation-end': 'ignored',
  'network-validation-start': 'ignored',
  object: 'ignored',
  'object-result': 'ignored',
  raw: 'ignored',
  'reasoning-delta': 'mapped',
  'reasoning-end': 'ignored',
  'reasoning-file': 'ignored',
  'reasoning-signature': 'ignored',
  'reasoning-start': 'ignored',
  'redacted-reasoning': 'ignored',
  'response-metadata': 'ignored',
  'routing-agent-abort': 'ignored',
  'routing-agent-end': 'ignored',
  'routing-agent-start': 'ignored',
  'routing-agent-text-delta': 'ignored',
  'routing-agent-text-start': 'ignored',
  source: 'ignored',
  start: 'mapped',
  'step-finish': 'mapped',
  'step-output': 'ignored',
  'step-start': 'mapped',
  'text-delta': 'mapped',
  'text-end': 'ignored',
  'text-start': 'ignored',
  'tool-call': 'mapped',
  'tool-call-approval': 'mapped',
  'tool-call-delta': 'mapped',
  'tool-call-input-streaming-end': 'mapped',
  'tool-call-input-streaming-start': 'mapped',
  'tool-call-suspended': 'mapped',
  'tool-error': 'mapped',
  'tool-execution-abort': 'ignored',
  'tool-execution-approval': 'ignored',
  'tool-execution-end': 'ignored',
  'tool-execution-start': 'ignored',
  'tool-execution-suspended': 'ignored',
  'tool-output': 'mapped',
  'tool-output-denied': 'mapped',
  'tool-result': 'mapped',
  tripwire: 'mapped',
  watch: 'ignored',
  'workflow-canceled': 'ignored',
  'workflow-execution-abort': 'ignored',
  'workflow-execution-end': 'ignored',
  'workflow-execution-start': 'ignored',
  'workflow-execution-suspended': 'ignored',
  'workflow-finish': 'ignored',
  'workflow-paused': 'ignored',
  'workflow-start': 'ignored',
  'workflow-step-finish': 'ignored',
  'workflow-step-output': 'ignored',
  'workflow-step-progress': 'ignored',
  'workflow-step-result': 'ignored',
  'workflow-step-start': 'ignored',
  'workflow-step-suspended': 'ignored',
  'workflow-step-waiting': 'ignored',
} satisfies MastraChunkTypeMustStayLiteral &
  Record<StaticMastraChunkType, MastraStaticChunkDisposition>;

function readStaticMastraChunkDisposition(type: string): MastraStaticChunkDisposition | undefined {
  if (!Object.hasOwn(MASTRA_STATIC_CHUNK_DISPOSITIONS, type)) {
    return;
  }
  return MASTRA_STATIC_CHUNK_DISPOSITIONS[type as keyof typeof MASTRA_STATIC_CHUNK_DISPOSITIONS];
}

function warnForUnrecognizedMastraStreamPart(
  type: string,
  lifecycleState: ToolLifecycleState
): void {
  if (readStaticMastraChunkDisposition(type) === 'ignored') {
    return;
  }
  if (lifecycleState.warnedUnknownChunkTypes.has(type)) {
    return;
  }
  lifecycleState.warnedUnknownChunkTypes.add(type);
  logger.warn('mastra emitted an unrecognized stream chunk', {
    chunkType: formatDiagnosticChunkType(type),
    code: 'mastra_agent_unrecognized_stream_chunk',
  });
}

async function makeRecoveredProviderErrorTermination(
  part: unknown,
  error: unknown,
  lifecycleState: ToolLifecycleState,
  runtimeData?: RuntimeData
): Promise<ProcessStreamPartResult> {
  const providerError = resolveProviderError(error, runtimeData);
  let detail = providerError.detail;
  if (
    isContextOverflowProviderErrorCode(providerError.runError.code) &&
    runtimeData?.contextOverflowRecovery
  ) {
    try {
      const recovery = await runtimeData.contextOverflowRecovery();
      if (recovery.applied) {
        detail =
          'A deterministic compaction was applied after the provider reported a context overflow. Please resend this message or continue the conversation; the next request now has additional headroom.';
      }
    } catch (recoveryError) {
      logger.warn('Deterministic context-overflow compaction failed', {
        code: 'deterministic_compaction_failed',
        error: recoveryError,
      });
    }
  }
  return makeProviderErrorTermination(
    detail,
    lifecycleState,
    part,
    runtimeData,
    providerError.runError
  );
}

/**
 * Whether a delta contains anything a reader could actually SEE.
 *
 * Whitespace is not contribution: a bubble containing only spaces or newlines
 * is visually empty, which is the exact outcome the empty-response guard
 * exists to prevent (review of #2624). The delta is still STREAMED either way
 * — formatting whitespace between real tokens is meaningful — only the
 * contribution flag is withheld.
 */
const VISIBLE_CHARACTER_PATTERN = /\S/;

/**
 * Part types whose mere ARRIVAL proves the model contributed to the turn.
 *
 * DERIVED, never hand-listed (review of #2624). A hand-mirrored copy of the
 * switch's tool cases is exactly the drift `COMPLETED_FINISH_REASONS` was
 * extracted to prevent one gate over, and the failure mode here is the loud
 * one: a tool part type added to the switch but forgotten here would make a
 * real tool-using turn get re-streamed and then failed as "empty".
 * `MASTRA_STATIC_CHUNK_DISPOSITIONS` already `satisfies
 * Record<StaticMastraChunkType, …>`, so a new Mastra chunk type is a
 * type-check failure at upgrade time until it is classified there — and a
 * `mapped` tool part then lands here automatically.
 *
 * `tool-execution-*` is framework scaffolding, dispositioned `ignored`, and
 * correctly excluded. Text/reasoning deltas are handled in their own cases:
 * a delta with no visible character paints nothing and must not count.
 */
const MODEL_CONTRIBUTION_PART_TYPES: ReadonlySet<string> = new Set(
  Object.entries(MASTRA_STATIC_CHUNK_DISPOSITIONS)
    .filter(([type, disposition]) => disposition === 'mapped' && type.startsWith('tool-'))
    .map(([type]) => type)
);

/**
 * Map a text or reasoning delta, recording whether the model has now
 * contributed something a reader could SEE.
 *
 * The two kinds differ only in the chunk type they emit and in first-text
 * latency being a text-only measurement, so they share this body rather than
 * two near-identical switch arms whose whitespace rules could drift apart.
 */
function mapContentDelta(
  part: unknown,
  lifecycleState: ToolLifecycleState,
  type: 'reasoning-delta' | 'text-delta'
): ProcessStreamPartResult {
  const delta = getDeltaText(part);
  if (type === 'text-delta') {
    recordFirstTextLatency(delta, lifecycleState);
  }
  if (delta.length === 0) {
    return { chunks: [], finished: false };
  }
  if (VISIBLE_CHARACTER_PATTERN.test(delta)) {
    lifecycleState.sawModelContribution = true;
  }
  return { chunks: [{ type, value: delta }], finished: false };
}

/**
 * A finish that would otherwise COMPLETE a turn the model contributed NOTHING
 * to (the 2026-08-23 stealth/ox-alpha field case: HTTP 200, one instant step,
 * zero usage) is an attempt fault, not a success — thrown so it rides the
 * BST-1409 attempt-recovery rails exactly like a stall: retried, then
 * terminated visibly. Mapping it to `run.finished` painted an empty assistant
 * bubble marked "success", which is a silent fallback. An ABNORMAL finish
 * reason is deliberately NOT re-classified: the terminal-event mapping already
 * fails the run with its own, more precise truth (e.g. `length`).
 */
function throwIfEmptyModelResponse(part: unknown, lifecycleState: ToolLifecycleState): void {
  if (lifecycleState.sawModelContribution) {
    return;
  }
  const finishReason = readFinishReason(part);
  if (!COMPLETED_FINISH_REASONS.has(finishReason)) {
    return;
  }
  absorbEmptyAttemptSpend(part, lifecycleState);
  throw new EmptyModelResponseError(finishReason, lifecycleState.stepCount);
}

/**
 * Record what the empty attempt actually SPENT before ending it.
 *
 * BILLING IS PER TURN (see `createTurnAttemptLifecycleState`): a recovered
 * turn really did spend the replaced attempt's tokens, and `carried*` seeds
 * the continuation from `stepped*`. A stalled attempt has already banked its
 * spend through `step-finish`; an EMPTY attempt frequently has not — its only
 * usage report is on the terminal `finish` this guard is about to throw past.
 * Without this, an empty attempt that consumed a 12k-token prompt vanished
 * from the ledger and the user was billed for a run row that never recorded it
 * (review of #2624).
 *
 * Both absorptions are guarded against DOUBLE-COUNTING, because Mastra's
 * terminal numbers restate rather than extend the per-step ones: its finish
 * usage is the cumulative sum across the stream's steps, and it copies
 * `providerMetadata` from the FINAL model step. So each is taken only when the
 * step path did not already bank the same figure.
 */
function absorbEmptyAttemptSpend(part: unknown, lifecycleState: ToolLifecycleState): void {
  const p = asMastraStreamPart(part);
  if (lifecycleState.stepCount === 0) {
    accumulateSteppedUsage(lifecycleState, readStreamPartUsage(p));
  }
  if (lifecycleState.sawStepBilledCost) {
    return;
  }
  const reading = readOpenRouterBilledCost(p);
  if (reading.kind === 'reported') {
    lifecycleState.sawStepBilledCost = true;
    lifecycleState.stepBilledCostUsd += reading.usd;
    return;
  }
  // Absent or malformed: the same "this attempt's cost is unknown" fact the
  // step path records, which resolves the TURN total to unknown rather than
  // letting a later attempt's cost masquerade as the whole turn's.
  lifecycleState.sawStepWithoutBilledCost = true;
}

export async function processMastraStreamPart(
  part: unknown,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState,
  sanitizedNameMap?: Map<string, string>,
  askTools?: ReadonlyMap<string, PermissionAskToolMetadata>,
  delegationToolPersonas: ReadonlyMap<string, string> = new Map(),
  runtimeData?: RuntimeData
): Promise<ProcessStreamPartResult> {
  const p = asMastraStreamPart(part);

  // Dynamic OM bookkeeping branches before the typed switch: failure variants
  // surface as run events (BST-947 — the only runtime evidence of a broken
  // observer), the rest stay silent without unrecognized-chunk warnings.
  if (isObservationalMemoryDataChunkType(p.type)) {
    return mapObservationalMemoryDataPart(p);
  }

  if (MODEL_CONTRIBUTION_PART_TYPES.has(p.type)) {
    lifecycleState.sawModelContribution = true;
  }

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
    case 'text-delta':
      return mapContentDelta(part, lifecycleState, 'text-delta');
    case 'reasoning-delta':
      return mapContentDelta(part, lifecycleState, 'reasoning-delta');
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
      const stepCost = readOpenRouterBilledCost(p);
      if (stepCost.kind === 'malformed') {
        // ERROR, not a throw. A broken provider contract must stay impossible
        // to miss, but it is still telemetry: failing here destroyed the
        // completed turn, which is the trade this path no longer makes. The
        // step counts as cost-less, so the turn total resolves to UNKNOWN
        // rather than silently omitting this step's spend from a sum.
        logger.error('Provider reported a malformed billed cost; treating the step as unpriced', {
          code: 'provider_billed_cost_malformed',
          reason: stepCost.reason,
        });
      }
      if (stepCost.kind === 'reported') {
        lifecycleState.sawStepBilledCost = true;
        lifecycleState.stepBilledCostUsd += stepCost.usd;
      } else {
        lifecycleState.sawStepWithoutBilledCost = true;
      }
      // Same usage-candidate order as makeFinishChunk (top-level, then payload).
      accumulateSteppedUsage(lifecycleState, readStreamPartUsage(p));
      lifecycleState.stepCount += 1;
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
      throwIfEmptyModelResponse(part, lifecycleState);
      const terminalUsage = readStreamPartUsage(p);
      const terminalPromptTokens = terminalUsage?.promptTokens ?? terminalUsage?.inputTokens;
      if (typeof terminalPromptTokens === 'number' && Number.isFinite(terminalPromptTokens)) {
        // Mastra's terminal usage is the CROSS-STEP SUM, so this re-stamp is
        // consistent with the step path's accumulation (and is the only
        // source on a zero-step stream). It is spend, not context size — see
        // the field's doc comment.
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
    // @mastra/core 1.59: the DECLINE terminal of the approval lifecycle. A
    // `requireApproval` call the user declined never reaches the tool and never
    // produces a later `tool-result`/`tool-error` for the same id, so this part
    // is the ONLY chance to settle it. `'ignored'` would reproduce the hang
    // mastra shipped this chunk to fix: the renderer's tool part stays pending
    // forever and the durable `tool.started` never pairs off. It sits with the
    // other TERMINALS on purpose — a declined DELEGATION (`agent-<persona>`,
    // reachable under an explicit global approval gate) must also pair off the
    // `subagent.started` its own `tool-call` emitted, so the decline cannot
    // take a path that skips the subagent lifecycle.
    case 'tool-output-denied':
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
      return makeRecoveredProviderErrorTermination(
        part,
        p.error ?? p.payload?.error,
        lifecycleState,
        runtimeData
      );
    }
    case 'tripwire': {
      // Same rationale as `'error'`: surface tripwires (content policy
      // violations, etc.) as a visible message + terminal run-event so the user
      // sees the reason and the thread does not hang.
      const tripwire = resolveTripwire(part);
      return makeTripwireTermination(tripwire, lifecycleState, part, runtimeData);
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
      warnForUnrecognizedMastraStreamPart(p.type, lifecycleState);
      return { chunks: [], finished: false };
  }
}

/**
 * Map a successful OM cycle end marker to estimated child usage (BST-953).
 * `data-om-observation-end` carries `tokensObserved` (observer input) /
 * `observationTokens` (output); `data-om-buffering-end` carries the same pair
 * as `tokensBuffered` / `bufferedTokens` — the token KEYS follow the part
 * type, while the `source` label follows `operationType` (both part types can
 * carry either an observation or a reflection cycle). An unrecognized
 * operationType or a malformed count is dropped with a WARN, never defaulted
 * into the wrong run_kind bucket (review fix). Both figures are Mastra's
 * LOCAL tokenx estimates of the content sizes (the observer's own system
 * prompt is not included), so the chunk is flagged `estimated` and must never
 * be presented as billed truth. `data-om-activation` is an instant buffered
 * swap with no LLM call — it must never fabricate usage.
 */
function mapObservationalMemoryCycleEnd(
  part: MastraStreamPart,
  payload: Record<string, unknown> | undefined
): StreamChunk | undefined {
  const isBufferingEnd = part.type === 'data-om-buffering-end';
  if (!(isBufferingEnd || part.type === 'data-om-observation-end')) {
    return;
  }
  const operationType = payload?.['operationType'];
  if (operationType !== 'observation' && operationType !== 'reflection') {
    logger.warn('OM cycle end without a recognizable operationType; usage not metered', {
      code: 'mastra_agent_om_usage_operation_type_unrecognized',
      omChunkType: part.type,
    });
    return;
  }
  const inputTokens = readOmTokenCount(
    payload,
    isBufferingEnd ? 'tokensBuffered' : 'tokensObserved'
  );
  const outputTokens = readOmTokenCount(
    payload,
    isBufferingEnd ? 'bufferedTokens' : 'observationTokens'
  );
  if (inputTokens === undefined || outputTokens === undefined) {
    logger.warn('OM cycle end carried malformed token counts; usage not metered', {
      code: 'mastra_agent_om_usage_counts_malformed',
      omChunkType: part.type,
    });
    return;
  }
  if (inputTokens === 0 && outputTokens === 0) {
    // Genuinely zero figures have nothing to meter — a zero row would just
    // dilute the by-source breakdown.
    return;
  }
  return {
    type: 'child-run-usage',
    value: {
      estimated: true,
      inputTokens,
      outputTokens,
      source: operationType === 'reflection' ? 'om-reflection' : 'om-observation',
    },
  };
}

function mapObservationalMemoryDataPart(part: MastraStreamPart): {
  chunks: StreamChunk[];
  finished: boolean;
} {
  const successPayload = (part.payload ?? (part as { data?: unknown }).data) as
    | Record<string, unknown>
    | undefined;
  if (!part.type.endsWith('-failed')) {
    const usageChunk = mapObservationalMemoryCycleEnd(part, successPayload);
    return { chunks: usageChunk ? [usageChunk] : [], finished: false };
  }
  const payload = successPayload;
  const rawError = payload?.['error'];
  const errorText =
    typeof rawError === 'string' && rawError.length > 0
      ? truncateStreamDetail(rawError, OM_FAILURE_DETAIL_MAX_CHARS)
      : 'Observation cycle failed without a reported reason.';
  const operationType =
    typeof payload?.['operationType'] === 'string' ? payload['operationType'] : undefined;
  return {
    chunks: [
      {
        event: {
          detail: errorText,
          id: `run-event-${generateUUID()}`,
          kind: 'memory.observation.failed',
          label: 'Observational memory failed',
          metadata: {
            omChunkType: part.type,
            ...(operationType === undefined ? {} : { operationType }),
          },
          status: 'failed',
          timestamp: new Date().toISOString(),
        },
        type: 'run-event',
      },
    ],
    finished: false,
  };
}

interface RuntimeInitializationResult {
  runtime: MastraAgentRuntime;
  sanitizedNameMap?: Map<string, string>;
}

export async function initializeMastraRuntime(
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

interface StreamGeneratorParams {
  abortedTurnPersistence: AbortedTurnPersistence | undefined;
  /** Child-usage bridge for this leg's delegation config (personas enabled only). */
  delegationUsage?: DelegationUsageCapture;
  /**
   * Owned by the TURN, not the attempt (BST-1409): after a recoverable stall
   * the turn still has to settle this attempt's in-flight delegations, and a
   * state the attempt created privately would be gone by then.
   */
  lifecycleState: ToolLifecycleState;
  memory?: MastraMemory;
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
  titleMessages?: AgentMessage[];
}

export interface ResumedToolCallStart {
  args: unknown;
  displayToolName: string;
  registeredToolName: string;
  toolCallId: string;
}

export interface ResumedApprovalToolCall extends ResumedToolCallStart {
  /** Actual approved tool, which may be inside the displayed delegation call. */
  readonly approvedToolName: string;
  /**
   * The suspended step's OTHER pending calls (2026-08-24 field failure).
   * Mastra resume legs never replay the step's `tool-call` parts, and the
   * synthetic start used to cover only the approved call — so a sibling
   * delegation in the same step ran for minutes with no card and no
   * `subagent.started`, and the UI pinned the whole wait on the stale
   * approved-tool card. Every pending call gets its start back.
   */
  siblings: readonly ResumedToolCallStart[];
}

/**
 * Synthetic `start` chunks for EVERY pending call of a resumed suspended step
 * (2026-08-24 field failure — see {@link ResumedApprovalToolCall.siblings}).
 * Delegation (`agent-*`) siblings also get their `subagent.started`,
 * registered with the lifecycle tracker so aborts still drain them and later
 * subagent terminals have a mate.
 *
 * Each synthetic start is routed through {@link makeToolLifecycleRunEventChunk}
 * — the SAME seam the mainline `tool-call` part reaches through
 * `mapGenericToolEvent` — so the durable `tool.started` run event travels with
 * the chunk instead of being minted (or, as until BST-1440, forgotten) here.
 * That run event is what clears the Threads panel's "needs you" glyph the
 * moment the user ANSWERS: `use-threads-awaiting-approval.ts` counts
 * `tool.started` as a resolution, and this start occurs AFTER the pause row it
 * answers (the pause was written by an earlier leg). Without it the glyph
 * stayed lit — for a call the user had already approved — until
 * `tool.completed` landed, and masked the truthful Running state meanwhile.
 * Ordering per call is therefore identical to the mainline's:
 * tool event, then `tool.started`, then any `subagent.started`.
 *
 * SIBLINGS EMIT IT TOO, deliberately. A sibling pending in the same suspended
 * step is a real in-flight call the moment the step resumes — it is why the
 * synthetic start chunk exists for siblings at all — so suppressing only its
 * run event would re-open the exact producer/UI split this seam closes.
 *
 * A sibling here can NOT be an unanswered approval pause, which is what makes
 * that safe: Mastra's `foreach(toolCallStep)` is sequential, so a step with two
 * gated calls pauses on the FIRST alone and the second never enters the
 * suspended snapshot until the first resolves. Siblings are therefore the
 * step's non-gated pending work (delegations, in-flight calls) — pinned against
 * the live loop by "PAUSES ONE CALL AT A TIME" in
 * `packages/agent/src/__tests__/mastra-tool-approval-suspend.integration.spec.ts`,
 * which also records the consequence for the projection's ordering guard.
 */
function* makeResumedStartChunks(
  resumed: ResumedApprovalToolCall,
  toolNames: Map<string, string>,
  lifecycleState: ToolLifecycleState
): Generator<StreamChunk> {
  const starts: readonly ResumedToolCallStart[] = [resumed, ...resumed.siblings];
  for (const start of starts) {
    toolNames.set(start.toolCallId, start.registeredToolName);
    const toolEvent: StreamChunkTool = {
      name: start.displayToolName,
      payload: {
        args: start.args,
        callId: start.toolCallId,
        input: start.args,
        toolCallId: start.toolCallId,
      },
      status: 'start',
      type: 'tool-event',
    };
    yield toolEvent;
    // `'tool-call'` is the Mastra part this synthetic start stands in for.
    const startRunEvent = makeToolLifecycleRunEventChunk(toolEvent, 'tool-call', lifecycleState);
    if (startRunEvent) {
      yield startRunEvent;
    }
    if (start.registeredToolName.startsWith(SUBAGENT_DELEGATION_TOOL_PREFIX)) {
      const delegationMetadata = {
        parentToolCallId: start.toolCallId,
        personaId: start.registeredToolName.slice(SUBAGENT_DELEGATION_TOOL_PREFIX.length),
        toolName: start.displayToolName,
      };
      lifecycleState.delegationLifecycle.started(start.toolCallId, delegationMetadata);
      yield makeRunEventChunk(
        'subagent.started',
        'running',
        'Subagent started',
        delegationMetadata
      );
    }
  }
}

/**
 * Name a raw Mastra part for the stall diagnostic. Knowing WHAT the provider
 * last sent before going quiet (`reasoning-delta` vs `tool-call-delta` vs
 * `step-start`) is the difference between diagnosing a stall from a debug
 * bundle and reconstructing it by inference (BST-1408).
 */
function describeMastraStreamPartType(part: unknown): string | undefined {
  if (typeof part !== 'object' || part === null) {
    return;
  }
  const type = (part as { type?: unknown }).type;
  // Bounded through the shared diagnostic formatter: the value is provider
  // data, and a stall breadcrumb must not carry an unbounded string.
  return typeof type === 'string' ? formatDiagnosticChunkType(type) : undefined;
}

/**
 * Mastra part types the FRAMEWORK emits at stream/step open, before the
 * provider is asked for anything.
 *
 * Measured through the real loop (review of #2586): `start` lands at t+0ms and
 * `step-start` ~7ms later, while the provider's first real part follows
 * hundreds of milliseconds afterwards — and a fresh `step-start` opens every
 * subsequent step too. Counting these as "the provider started" would end the
 * wide first-output window within milliseconds and measure every real
 * time-to-first-token against the tight inter-output one, which is precisely
 * the failure this split exists to prevent.
 *
 * Deliberately a CLOSED list of scaffolding rather than an allowlist of output
 * kinds: a Mastra release that adds a new provider part type must default to
 * "this is output" (tightening the window on a part we know arrived from the
 * provider), never to "this is free" (silently widening it forever).
 */
const MASTRA_SCAFFOLDING_PART_TYPES: ReadonlySet<string> = new Set(['start', 'step-start']);

function isMastraProviderOutputPart(part: unknown): boolean {
  const type = describeMastraStreamPartType(part);
  return type === undefined || !MASTRA_SCAFFOLDING_PART_TYPES.has(type);
}

/**
 * Mastra part types that carry REASONING rather than an answer.
 *
 * These are unambiguously provider output — they must never be mistaken for
 * framework scaffolding — but they are the model THINKING, so the silence
 * around them is measured against the wide reasoning window instead of the
 * tight inter-output one (see `StreamStallPhase` in
 * ../stream/with-inactivity-timeout.ts).
 *
 * CONTENT vs MARKER is load-bearing. A thinking delta ENTERS the reasoning
 * phase; block bookkeeping only PRESERVES the phase already in effect.
 * Providers exist that emit `text-start` BEFORE `reasoning-end`, so treating
 * the end marker as content would widen the window back out exactly as the
 * answer began. Preserving keeps a not-yet-answering stream wide (the gap
 * between `reasoning-end` and the first `text-delta` is still "has it begun
 * answering?") and an already-answering stream tight.
 *
 * Typed as `StaticMastraChunkType`, the union DERIVED FROM MASTRA'S OWN
 * `ChunkType['type']` that `MASTRA_STATIC_CHUNK_DISPOSITIONS` is checked
 * against. A Mastra release that renames one of these fails to compile here
 * rather than silently dropping a type out of the set and re-arming the tight
 * window against high-effort reasoning — the exact regression this prevents.
 */
const MASTRA_REASONING_PART_KINDS = {
  'reasoning-delta': 'content',
  'reasoning-end': 'marker',
  'reasoning-signature': 'marker',
  'reasoning-start': 'content',
  'redacted-reasoning': 'content',
} as const satisfies Partial<Record<StaticMastraChunkType, 'content' | 'marker'>>;

function readMastraReasoningPartKind(part: unknown): 'content' | 'marker' | undefined {
  const type = describeMastraStreamPartType(part);
  if (type === undefined || !Object.hasOwn(MASTRA_REASONING_PART_KINDS, type)) {
    return;
  }
  return MASTRA_REASONING_PART_KINDS[type as keyof typeof MASTRA_REASONING_PART_KINDS];
}

export function createAttemptDelegatedProjection({
  runtime,
  runtimeData,
  lifecycleState,
  sanitizedNameMap,
}: {
  runtime: Pick<
    MastraAgentRuntime,
    'conversationBinding' | 'personasById' | 'delegationToolPersonas' | 'askTools'
  >;
  runtimeData: RuntimeData | undefined;
  lifecycleState: ToolLifecycleState;
  sanitizedNameMap: Map<string, string> | undefined;
}): {
  decorate(chunk: StreamChunk): StreamChunk;
  preparePart(part: unknown): unknown;
  project(part: unknown, toolNames: Map<string, string>): Promise<StreamChunk[]>;
  settle(): StreamChunk[];
} {
  const delegatedProjection = createDelegatedStreamProjection({
    authorize: runtime.conversationBinding?.bindRun,
    createState: (personaId, threadId) => {
      const provider =
        runtime.personasById.get(personaId)?.model?.provider ?? runtimeData?.provider;
      // Children own their execution scope and must not consume parent steering.
      return createTurnAttemptLifecycleState(
        { ...(provider ? { provider } : {}), memory: { threadId } },
        undefined,
        lifecycleState.toolExecutionDurations
      );
    },
    mapPart: async (childPart, state, childToolNames) => {
      const result = await processMastraStreamPart(
        childPart,
        childToolNames,
        state,
        sanitizedNameMap,
        runtime.askTools,
        runtime.delegationToolPersonas
      );
      return {
        chunks: result.chunks.map((chunk) => {
          if (chunk.type === 'delegated-conversation-chunk') {
            throw new Error('Child projection cannot contain an already-scoped chunk.');
          }
          return chunk;
        }),
        finished: result.finished,
      };
    },
    personas: runtime.delegationToolPersonas,
  });
  const settle = () =>
    delegatedProjection?.finalize((state) =>
      makeDelegatedStreamTermination(state, Boolean(runtimeData?.signal?.aborted)).map((chunk) => {
        if (chunk.type === 'delegated-conversation-chunk') {
          throw new Error('A child terminal cannot contain an already-scoped chunk.');
        }
        return chunk;
      })
    ) ?? [];

  return {
    decorate: (chunk) =>
      chunk.type === 'delegated-conversation-chunk'
        ? chunk
        : (delegatedProjection?.decorate(chunk) ?? chunk),
    preparePart: (part) => delegatedProjection?.preparePart(part) ?? part,
    project: async (part, toolNames) => (await delegatedProjection?.project(part, toolNames)) ?? [],
    settle,
  };
}

export async function* streamAttemptChunks({
  abortedTurnPersistence,
  delegationUsage,
  lifecycleState,
  promptBreakdown,
  memory,
  runtime,
  runtimeData,
  stream,
  streamAbortContext,
  sanitizedNameMap,
  resumedApprovalToolCall,
  titleMessages,
}: StreamGeneratorParams): AsyncIterableIterator<StreamChunk> {
  let titleGenerationTask: Promise<void> | undefined;
  const calibrationState = { emitted: false };
  const toolCallTelemetryState = { emitted: false };
  const toolNames = new Map<string, string>();

  const delegatedProjection = createAttemptDelegatedProjection({
    lifecycleState,
    runtime,
    runtimeData,
    sanitizedNameMap,
  });

  try {
    // Run-start prompt breakdown (transient, display-only). Emitted BEFORE the
    // first Mastra part so the mapper ships it ahead of any streaming text
    // (the mapper still applies the text-part deferral defensively).
    if (promptBreakdown) {
      yield { breakdown: promptBreakdown, type: 'context-breakdown' };
    }
    if (resumedApprovalToolCall) {
      yield* makeResumedStartChunks(resumedApprovalToolCall, toolNames, lifecycleState);
    }
    const rawSource = readableStreamIterator(stream, streamAbortContext.signal);
    const toolInputBoundedSource = withToolCallInputTimeout(
      rawSource,
      runtime.resilienceConfig.toolCallInputMs,
      (error) => streamAbortContext.abort(error)
    );
    const source = withInactivityTimeout(
      toolInputBoundedSource,
      {
        firstOutputMs: runtime.resilienceConfig.streamFirstOutputMs,
        interOutputMs: runtime.resilienceConfig.streamInactivityMs,
        reasoningGapMs: runtime.resilienceConfig.streamReasoningGapMs,
      },
      {
        countsAsProviderOutput: isMastraProviderOutputPart,
        describePart: describeMastraStreamPartType,
        onTimeout: (error) => streamAbortContext.abort(error),
        reasoningPartKind: readMastraReasoningPartKind,
      }
    );
    for await (const part of source) {
      // BST-1701. The provider's own report about the request it just served
      // (a dropped `temperature`, a deprecated setting) is recorded UNDER
      // Mastra by the model observer, because Mastra drops the adapter's
      // `stream-start` part and never carries `warnings` onto this stream.
      // Drained here, per part, so the row lands as soon as the adapter opens
      // its stream - ahead of the first token, and never after the finish
      // chunk that stops the consumer from pulling.
      yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
      yield* await delegatedProjection.project(part, toolNames);
      const { chunks, finished } = await processMastraStreamPart(
        delegatedProjection.preparePart(part),
        toolNames,
        lifecycleState,
        sanitizedNameMap,
        runtime.askTools,
        runtime.delegationToolPersonas,
        runtimeData
      );
      // Start the canonical Mastra title request BEFORE yielding the terminal
      // finish. Downstream stops pulling at that chunk; the finally block still
      // awaits this detached task before shutting the per-run Mastra instance
      // down, so the main response is not held up by title latency.
      titleGenerationTask = ensureMastraThreadTitleGeneration({
        eligible: asMastraStreamPart(part).type === 'finish',
        memory,
        messages: titleMessages,
        runtime,
        runtimeData,
        task: titleGenerationTask,
      });
      // Bound usage waits for its parent terminal, after child publication
      // authorized the native run. Fast producers can queue completion while
      // this consumer is still reading earlier parts. Drain before finish closes it.
      yield* drainDelegationUsageChunks(delegationUsage, part);
      yield* drainTokenEstimateCalibrationChunk(
        finished,
        runtime,
        runtimeData,
        lifecycleState,
        calibrationState,
        promptBreakdown
      );
      yield* drainToolCallTelemetryChunks(finished, runtime, toolCallTelemetryState);
      if (finished) {
        yield* delegatedProjection.settle();
        // Publishing child terminal chunks yields to the consumer. Flush warnings
        // recorded during publication before downstream stops at the finish.
        yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
      }
      for (const chunk of chunks) {
        yield delegatedProjection.decorate(chunk);
      }
      if (finished) {
        abortedTurnPersistence?.markNormalFinish();
        runtime.assertAssistantMessageIdPersisted?.();
        return;
      }
    }
    // A stream that ended without a finish (or was aborted) may still have
    // recorded a warning after its last part - or produced no part at all.
    yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
    yield* drainDelegationUsageChunks(delegationUsage);
    yield* delegatedProjection.settle();
    yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
    // Aborted mid-run: settle any orphaned delegations (a cancelled parent must
    // never leave a forever-"running" subagent.started). Otherwise finalize a
    // missing-finish stream with pending tool output + a synthetic finish.
    const aborted = Boolean(runtimeData?.signal?.aborted);
    titleGenerationTask = ensureMastraThreadTitleGeneration({
      eligible: !aborted,
      memory,
      messages: titleMessages,
      runtime,
      runtimeData,
      task: titleGenerationTask,
    });
    const endChunks = aborted
      ? makeCancelledDelegationRunEventChunks(lifecycleState)
      : makeMissingFinishStreamChunks(lifecycleState);
    yield* drainToolCallTelemetryChunks(true, runtime, toolCallTelemetryState);
    for (const chunk of endChunks) {
      yield chunk;
    }
  } catch (error) {
    // The provider can report stream-start warnings and then fail before
    // Mastra yields any mapped part. Preserve those facts before propagating
    // the original stream failure, including cancellation/watchdog paths.
    yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
    yield* delegatedProjection.settle();
    yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
    // Best-effort telemetry must not be lost on an ordinary stream/projector
    // failure after earlier tool calls already completed — drain whatever was
    // accumulated before propagating the failure (review fix). Since BST-1409
    // a WATCHDOG error propagates too: whether it ends the attempt or the whole
    // turn is the turn layer's decision, not this generator's.
    yield* drainToolCallTelemetryChunks(true, runtime, toolCallTelemetryState);
    if (isStreamWatchdogError(error) && runtimeData?.signal?.aborted) {
      // A user Stop that raced the watchdog is a cancellation, not a stall:
      // settle the delegations and end quietly, exactly as before.
      for (const chunk of makeCancelledDelegationRunEventChunks(lifecycleState)) {
        yield chunk;
      }
      return;
    }
    throw error;
  } finally {
    if (titleGenerationTask) {
      await titleGenerationTask;
    }
    streamAbortContext.abort(new Error('Mastra stream consumption ended.'));
    streamAbortContext.dispose();
    logTokenDiagnostics(runtime, runtimeData, lifecycleState);
    logStreamOutcome(Boolean(runtimeData?.signal?.aborted));
    // NOTE: `runtime.dispose()` is deliberately NOT here. The runtime outlives
    // a single attempt so a recovered turn can stream again on it; the turn
    // layer disposes exactly once (BST-1409).
  }
}

export async function streamMastraAgent(
  messages: AgentMessage[],
  options: MastraAgentRuntimeOptions = {}
): Promise<StreamIterator> {
  assertNoUnsupportedDirectStreamOptions(options);

  const runtimeData = options.runtime;
  const initialSystemMessages = structuredClone(
    messages.filter((message) => message.role === 'system')
  );
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData, options.authInput);
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(
    {
      ...options,
      getDelegatedSystemContext: () => captureDelegatedSystemContext(initialSystemMessages),
    },
    runtimeResolution
  );

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
export function withRuntimeDerivedStreamOptions(
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
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData, options.authInput);
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
      preserveExecuteBackedWebSearch = suspendedToolCall.approvedToolName === WEB_SEARCH_TOOL_ID;
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
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData, options.authInput);
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
