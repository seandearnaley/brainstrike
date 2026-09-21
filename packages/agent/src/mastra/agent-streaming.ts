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
import {
  AdmittedChildConfigurationError,
  readAssistantChildSignalContents,
  readAssistantRunEvent,
} from '@brainstrike/assistant-contract';
import type { AssistantChildFollowupAction } from '@brainstrike/assistant-contract/child-followup';
import type { AssistantContextBreakdown } from '@brainstrike/assistant-contract/context-breakdown';
import { SUBAGENT_DELEGATION_TOOL_PREFIX } from '@brainstrike/assistant-contract/personas';
import {
  type AssistantToolApprovalAction,
  isAssistantToolApprovalAnswered,
} from '@brainstrike/assistant-contract/tool-approval';
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
import {
  type StreamInactivityOptions,
  type StreamStalledError,
  withInactivityTimeout,
} from '../stream/with-inactivity-timeout';
import { withToolCallInputTimeout } from '../stream/with-tool-call-input-timeout';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type {
  AgentMessage,
  ConversationStreamChunk,
  RuntimeData,
  StreamChunk,
  StreamChunkTool,
  StreamChunkToolApprovalAnswered,
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
import { readTaskEvent } from './background-idle-loop';
import { projectBackgroundStream } from './background-stream';
import {
  createChildContinuationDecisionStream,
  createChildFollowupStream,
} from './child-continuation';
import { readChildContinuationUserMessage } from './child-continuation-user-message';
import { withDelegatedPersonaSnapshots } from './delegated-persona-snapshots';
import { DELEGATED_STEP_USAGE_PART } from './delegated-step-usage';
import { createDelegatedStreamProjection } from './delegated-stream-projection';
import { DELEGATED_SYNTHESIS_PART } from './delegated-synthesis-outcomes';
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
import { buildRootLegPromptManifest } from './prompt-manifest-root-leg';
import { drainProviderCallWarningChunks } from './provider-warning-run-events';
import { withRootPauseNotices } from './root-pause-notices';
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
import { makeRunEventChunk, makeToolCallsFinishChunk } from './stream-run-event-chunks';
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
import { readMastraStreamPartString, readMastraStreamPartValue } from './tool-event-mapper';
import {
  COMPLETED_FINISH_REASONS,
  type DelegationUsageCapture,
  makeCancelledDelegationRunEventChunks,
  makeFinishChunk,
  makeLifecycleStepMetadata,
  makePendingToolOutputRunEventChunks,
  makeStepFinishedMetadata,
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
import {
  createTurnAttemptLifecycleState,
  type StreamAbortContext,
  settleStreamCleanup,
} from './turn-attempts';

const logger = createLogger('MastraAgent');

type DynamicMastraChunkType =
  | `agent-execution-event-${string}`
  | `data-${string}`
  | `workflow-execution-event-${string}`;
type MastraChunkTypeMustStayLiteral = string extends ChunkType['type'] ? never : unknown;
type StaticMastraChunkType = Exclude<ChunkType['type'], DynamicMastraChunkType>;
type MastraStaticChunkDisposition = 'ignored' | 'mapped' | 'normalized';

/**
 * A complete disposition inventory for Mastra's exported static chunk union.
 * `satisfies` makes a newly-added literal chunk type a type-check failure at
 * upgrade time. `ignored` is a deliberate no-output decision; `mapped` means
 * the switch below must consume the type. `normalized` must be consumed by
 * the native background transport adapter before this dispatch; an escaped
 * normalized part receives the same coded diagnostic as an unmapped part.
 * Dynamic chunk families remain
 * observable at runtime because an unhandled member has no disposition.
 */
const MASTRA_STATIC_CHUNK_DISPOSITIONS = {
  abort: 'ignored',
  'agent-execution-abort': 'ignored',
  'agent-execution-approval': 'ignored',
  'agent-execution-end': 'ignored',
  'agent-execution-start': 'ignored',
  'agent-execution-suspended': 'ignored',
  'background-task-cancelled': 'normalized',
  'background-task-completed': 'normalized',
  'background-task-failed': 'normalized',
  'background-task-output': 'normalized',
  'background-task-progress': 'ignored',
  'background-task-resumed': 'normalized',
  'background-task-running': 'normalized',
  'background-task-started': 'normalized',
  'background-task-suspended': 'normalized',
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

/**
 * A host-owned run event published into the running leg (the background
 * ledger row, `background-ledger.ts`). Mastra never emits this type; a
 * malformed one is refused rather than forwarded.
 */
function mapHostRunEventPart(rawEvent: unknown): ProcessStreamPartResult {
  const event = readAssistantRunEvent(rawEvent);
  if (!event) {
    throw new Error('A host run-event chunk is malformed.');
  }
  return { chunks: [{ event, type: 'run-event' }], finished: false };
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
    // The delegated projection has already validated and metered this published child.
    case DELEGATED_STEP_USAGE_PART:
    // ...and turned this reserved-synthesis outcome into the owner child's
    // `delegation.budget.exhausted` run event; the root stream carries nothing.
    case DELEGATED_SYNTHESIS_PART:
      return { chunks: [], finished: false };
    // A background child's task is parked in storage; its withheld card is
    // released by `releaseParkedNotices` on this same part. Its resume drops
    // the held pause terminal (`dropHeldPauseFinish`).
    case 'background-task-suspended':
    case 'background-task-resumed':
      return { chunks: [], finished: false };
    // The host's own answer to a card, published into the running leg by a
    // live decision (`live-decisions.ts`); the same chunk an approval leg
    // yields ahead of its resumed children.
    case 'tool-approval-answered': {
      const { type: _type, ...answered } = p as { type: string } & Record<string, unknown>;
      if (!isAssistantToolApprovalAnswered(answered)) {
        throw new Error('A live tool-approval-answered chunk is malformed.');
      }
      return { chunks: [{ ...answered, type: 'tool-approval-answered' }], finished: false };
    }
    case 'run-event':
      return mapHostRunEventPart((p as { event?: unknown }).event);
    case 'data-signal':
      // Native notifications are persisted as model context. Their actual model
      // response follows on this stream; they are not an extra user/assistant row.
      return { chunks: [], finished: false };
    case 'data-user-message': {
      const data = readMastraStreamPartValue(p, 'data');
      const continuation = readChildContinuationUserMessage(data);
      if (!continuation) {
        return { chunks: [], finished: false };
      }
      return {
        chunks: [
          {
            createdAt: continuation.createdAt,
            id: continuation.id,
            ...readAssistantChildSignalContents(continuation.contents),
            type: 'child-user-message',
          },
        ],
        finished: false,
      };
    }
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
        makeStepFinishedMetadata(part, lifecycleState)
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
      // The pause is the terminal of its OWNER's leg: a child's pause finishes
      // that child's projected stream. The ROOT loop (`streamAttemptChunks`)
      // surfaces the notice and keeps reading, because Mastra's foreach runs
      // the step's remaining calls after one suspends; the leg ends once, at
      // native close.
      return {
        chunks: [
          ...makePendingToolOutputRunEventChunks(lifecycleState),
          ...makeApprovalRequiredChunks(part, toolNames, sanitizedNameMap, askTools),
        ],
        finished: true,
      };
    case 'tool-call-suspended':
      // A suspending tool (submitPlan/askUser) paused via suspend(). Surface the
      // resumable suspend metadata; the root loop reads on to native close, the
      // same as an approval pause (an explicit resume answers it later).
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
    if (err instanceof AdmittedChildConfigurationError || isMastraAgentError(err)) {
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
  /** Parked sibling approvals this leg answered under a session grant. */
  answeredApprovals?: readonly StreamChunkToolApprovalAnswered[];
  completeNativeStream: () => Promise<unknown>;
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
  /**
   * Mastra's synchronous run status, read at native close. `suspended` there
   * means the run is parked on the user even when this leg raised no pause of
   * its own (a resumed leg whose sibling calls stay suspended), so the leg ends
   * as a `tool-calls` pause rather than a missing finish.
   */
  readNativeStatus: () => string | undefined;
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
 * The ids of every call that will EXECUTE on a resume leg (BST-1777 final
 * review, I1) — the approved call itself, plus its siblings (the suspended
 * step's other pending, non-gated work; see {@link ResumedApprovalToolCall}).
 * Mastra never replays the step's `tool-call` part on a resume leg, so
 * without this the watchdog has no `started` boundary to observe and measures
 * the whole execution against the provider's own silence budget instead of
 * the tool-executing backstop.
 *
 * Filtered through the SAME allow-list rule as
 * {@link createMastraToolExecutionPartKindReader} (a call this excludes rides
 * the ordinary provider windows and stays recoverable, which is correct for
 * it): a resumed call can never be provider-executed (a provider-executed
 * tool has no local `execute` and therefore no suspend point to resume
 * from), so this is really just the guarded-name membership check —
 * `registeredToolName` must be a key of `guardedToolNames`.
 */
function collectResumedGuardedToolCallIds(
  resumed: ResumedApprovalToolCall,
  guardedToolNames: ReadonlySet<string>
): readonly string[] {
  const calls: readonly ResumedToolCallStart[] = [resumed, ...resumed.siblings];
  return calls
    .filter((call) =>
      hasExecutionGuardBehindToolCall(call.registeredToolName, false, guardedToolNames)
    )
    .map((call) => call.toolCallId);
}

/**
 * The Mastra-specific `withInactivityTimeout` options for one leg, including
 * this leg's seed (absent on a fresh turn) — split out so
 * `streamAttemptChunks` calls this once rather than carrying the branch
 * itself (`exactOptionalPropertyTypes` forbids an explicit `undefined` on
 * `initialToolCallIds`, so the branch has to live in a function that can omit
 * the key entirely).
 */
function resolveMastraInactivityOptions(
  resumedApprovalToolCall: ResumedApprovalToolCall | undefined,
  guardedToolNames: ReadonlySet<string>,
  onTimeout: (error: StreamStalledError) => void
): StreamInactivityOptions<unknown> {
  return {
    countsAsProviderOutput: isMastraProviderOutputPart,
    describePart: describeMastraStreamPartType,
    ...(resumedApprovalToolCall
      ? {
          initialToolCallIds: collectResumedGuardedToolCallIds(
            resumedApprovalToolCall,
            guardedToolNames
          ),
        }
      : {}),
    onTimeout,
    reasoningPartKind: readMastraReasoningPartKind,
    toolExecutionPartKind: createMastraToolExecutionPartKindReader(guardedToolNames),
  };
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

/**
 * Mastra part types that START or SETTLE one tool execution (BST-1777).
 *
 * Pinned against the compiled @mastra/core 1.64.0 loop: `tool-execution-start`
 * / `tool-execution-end` look like the obvious boundary but are emitted only
 * `from: "NETWORK"` (agent networks) and never reach this stream. The agent
 * loop's boundary is `tool-call` -> `tool-result` | `tool-error`.
 *
 * `tool-call-approval` and `tool-call-suspended` SETTLE: the call is waiting
 * on a human, not executing, and a human wait must never inherit the wide
 * tool-executing backstop. `tool-output-denied` is the declined outcome.
 *
 * Typed against `StaticMastraChunkType` for the same reason the reasoning map
 * is: a Mastra rename fails to compile here instead of silently dropping a
 * boundary and leaving a running tool on the tight window.
 */
const MASTRA_TOOL_EXECUTION_PART_KINDS = {
  'tool-call': 'started',
  'tool-call-approval': 'settled',
  'tool-call-suspended': 'settled',
  'tool-error': 'settled',
  'tool-output-denied': 'settled',
  'tool-result': 'settled',
} as const satisfies Partial<Record<StaticMastraChunkType, 'started' | 'settled'>>;

/**
 * Whether a tool call has a per-call execution guard behind it (BST-1777
 * final re-review, I2-C). `tool-executing`'s wide window is only safe to
 * enter because a guard ALWAYS fires first and turns a wedge into a bounded,
 * recoverable failure — the terminal "this is a Brainstrike bug" message
 * `isRecoverableStall` attaches to this phase is only honest under that
 * premise.
 *
 * This is deliberately an ALLOW-list, not a deny-list: `guardedToolNames` is
 * exactly the key set of `runtime.toolNameMap`, which is populated (in
 * `tool-pipeline.ts`, `sanitizeTools` + `collectCombinedTools`) BEFORE
 * `applyToolGuards` runs over `combinedTools`, and nothing is added to it
 * afterwards for a tool that skipped the guard. So membership in this set IS
 * "went through `applyToolGuards`" — an unknown or future-unguarded tool name
 * defaults to `false` and stays on the tight window, per the file's own
 * closed-list rule (unknown -> tighten), rather than requiring every new
 * unguarded kind to be named here as it is discovered. Three kinds are
 * deliberately never in the set and therefore always ride the ordinary
 * provider-silence windows instead of `tool-executing`:
 *
 * - Provider-executed tools (native web search): injected AFTER
 *   `sanitizeTools`/`applyToolGuards` (see `../providers/native-web-search.ts`),
 *   so Mastra marks the part `payload.providerExecuted === true` — kept as an
 *   explicit check because that entry REPLACES a sanitized local name that IS
 *   still a key in `toolNameMap`, so a name match alone is not enough.
 * - Subagent delegation tools (`agent-<personaId>`): the parent registers them
 *   directly on `new Agent({ agents: subAgents })` (`agent-runtime.ts`), never
 *   through `combinedTools`/`sanitizeTools`, so they are never a key in
 *   `toolNameMap` and the allow-list already excludes them.
 * - Mastra-injected memory tools (`updateWorkingMemory`, `setWorkingMemory`,
 *   `recall` — see `internal-approval-exempt-tools.ts`): Mastra merges these
 *   into the run's tool map itself, after this pipeline runs, so they too are
 *   never a key in `toolNameMap`.
 *
 * A call this returns `false` for must NOT enter `tool-executing`: it keeps
 * riding the ordinary provider-silence windows it always has, so a wedge
 * there is diagnosed (and, where recoverable, retried) honestly instead of
 * being reported as a broken guard that was never there.
 */
function hasExecutionGuardBehindToolCall(
  toolName: string | undefined,
  providerExecuted: unknown,
  guardedToolNames: ReadonlySet<string>
): boolean {
  return providerExecuted !== true && toolName !== undefined && guardedToolNames.has(toolName);
}

/**
 * The part type a FOREGROUND delegation wraps every child chunk in on the
 * PARENT stream, and the deepest nesting the classifier will unwrap.
 *
 * Shape (see `resolveChildDelegation` in `delegated-stream-projection.ts`,
 * which is the production reader of exactly this envelope):
 *
 *     { type: 'tool-output',
 *       runId: <parent run id>,
 *       payload: { output: <the child's own Mastra part>,
 *                  toolCallId, toolName: 'agent-<personaId>' } }
 *
 * A grandchild arrives as an envelope inside an envelope, so the unwrap
 * recurses — bounded, because `output` is ultimately provider/tool data and an
 * unbounded walk over it is not something a watchdog may do. The bound is one
 * past `DELEGATION_LIMITS.maxDepth`'s reach in practice; a structure deeper
 * than this yields `undefined`, which TIGHTENS (the call rides the ordinary
 * provider windows) rather than widening.
 */
const MASTRA_DELEGATED_CHILD_ENVELOPE_TYPE = 'tool-output';
const MAX_DELEGATED_ENVELOPE_UNWRAPS = 8;

/**
 * Builds the `toolExecutionPartKind` classifier for one leg, closed over that
 * leg's guarded-name allow-list (`runtime.toolNameMap`'s keys). A factory
 * rather than a bare function because the classifier is already constructed
 * per leg (see `resolveMastraInactivityOptions`) and the guarded set is
 * per-runtime, not global.
 *
 * DELEGATED CHILD CALLS (BST-1777 PR review, Codex P1). Mastra carries a
 * foreground child's parts INSIDE the parent delegation's `tool-output`
 * envelope; the child has no watchdog of its own, and the parent's delegation
 * `tool-call` is deliberately NOT guarded (the allow-list excludes
 * `agent-<personaId>`), so classifying only the outer part left a child's
 * guarded execution measured against the parent's `streaming` window. Before
 * this ticket the flat 60s guard kept that under the window; now a child
 * command may legitimately run to its own 600s budget, so the envelope must be
 * unwrapped. Children select their tools from the parent's ALREADY-GUARDED map
 * by sanitized id (`build-persona-subagents.ts`, `selectCandidateTools` over
 * `params.guardedTools`), so a child's tool name is a key of the same
 * `toolNameMap` and the allow-list applies unchanged.
 *
 * Only a NON-guarded envelope tool name is unwrapped: a delegation tool is
 * never in the guarded set, while `executeCommand`/`runSkillScript` emit their
 * own `tool-output` parts whose `output` is arbitrary tool data that must
 * never be read as a boundary.
 *
 * Two consequences, both deliberate:
 * - The in-flight set is keyed by tool-call id alone, so a child id colliding
 *   with a parent id makes a nested `settled` release the parent's entry
 *   early. That TIGHTENS the window (back to the provider phases), which is
 *   the safe direction, and is the same "a lost settle can only tighten"
 *   guarantee the scaffolding clear already relies on.
 * - A child's nested `step-start` does NOT reach the generic
 *   scaffolding-clear: the OUTER part is `tool-output`, which counts as
 *   provider output (`MASTRA_SCAFFOLDING_PART_TYPES` is the closed set
 *   `{start, step-start}`). So a lost nested `settled` is not cleared by the
 *   child's own step boundary — it is cleared at the PARENT's next
 *   `step-start`, which is the same bound every other in-flight id has.
 *
 * @internal exported for tests
 */
export function createMastraToolExecutionPartKindReader(
  guardedToolNames: ReadonlySet<string>
): (part: unknown) => { kind: 'started' | 'settled'; toolCallId: string } | undefined {
  return (rawPart: unknown) => {
    let part = rawPart;
    let type = describeMastraStreamPartType(part);
    for (let depth = 0; type === MASTRA_DELEGATED_CHILD_ENVELOPE_TYPE; depth += 1) {
      const envelopeToolName = readMastraStreamPartString(part, 'toolName');
      if (
        depth >= MAX_DELEGATED_ENVELOPE_UNWRAPS ||
        envelopeToolName === undefined ||
        guardedToolNames.has(envelopeToolName)
      ) {
        return;
      }
      part = readMastraStreamPartValue(part, 'output');
      type = describeMastraStreamPartType(part);
    }
    if (type === undefined || !Object.hasOwn(MASTRA_TOOL_EXECUTION_PART_KINDS, type)) {
      return;
    }
    const payload = (part as { payload?: unknown }).payload;
    const toolCallId =
      typeof payload === 'object' && payload !== null
        ? (payload as { toolCallId?: unknown }).toolCallId
        : undefined;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      return;
    }
    const kind =
      MASTRA_TOOL_EXECUTION_PART_KINDS[type as keyof typeof MASTRA_TOOL_EXECUTION_PART_KINDS];
    if (kind === 'started') {
      const toolName = readMastraStreamPartString(part, 'toolName');
      const providerExecuted = readMastraStreamPartValue(part, 'providerExecuted');
      if (!hasExecutionGuardBehindToolCall(toolName, providerExecuted, guardedToolNames)) {
        return;
      }
    }
    return { kind, toolCallId };
  };
}

export function createAttemptDelegatedProjection({
  delegationUsage,
  runtime,
  runtimeData,
  lifecycleState,
  sanitizedNameMap,
}: {
  delegationUsage?: DelegationUsageCapture | undefined;
  runtime: Pick<
    MastraAgentRuntime,
    | 'conversationBinding'
    | 'personasById'
    | 'delegationToolPersonas'
    | 'askTools'
    | 'delegatedExecutionOptions'
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
    createState: (personaId, threadId, identity) => {
      const provider =
        runtime.personasById.get(personaId)?.model?.provider ?? runtimeData?.provider;
      // Children own their execution scope and must not consume parent steering.
      const childState = createTurnAttemptLifecycleState(
        { ...(provider ? { provider } : {}), memory: { threadId } },
        undefined,
        lifecycleState.toolExecutionDurations
      );
      if (lifecycleState.delegationOutcomes) {
        childState.delegationOutcomes = lifecycleState.delegationOutcomes;
      }
      // A `length` finish on this child's reserved synthesis is a truncated
      // completion only when the budget processor recorded it here.
      const synthesisOutcomes = runtime.delegatedExecutionOptions?.synthesisOutcomes;
      if (synthesisOutcomes) {
        childState.synthesisOutcomes = synthesisOutcomes;
      }
      return {
        ...childState,
        cancellationSignal: runtime.conversationBinding?.getInvocationAbortSignal?.(identity),
        get executionSignal() {
          return runtime.conversationBinding?.getExecutionAbortSignal?.(identity);
        },
      };
    },
    mapPart: async (childPart, state, childToolNames) => {
      const executionSignal = state.executionSignal;
      const result =
        state.cancellationSignal?.aborted || runtimeData?.signal?.aborted
          ? { chunks: makeDelegatedStreamTermination(state, true), finished: true }
          : executionSignal?.aborted
            ? {
                chunks: makeDelegatedStreamTermination(
                  state,
                  false,
                  String(executionSignal.reason)
                ),
                finished: true,
              }
            : await processMastraStreamPart(
                childPart,
                childToolNames,
                state,
                sanitizedNameMap,
                runtime.askTools,
                runtime.delegationToolPersonas
              );
      return {
        chunks: result.chunks.map((chunk) => {
          if (
            chunk.type === 'delegated-conversation-chunk' ||
            chunk.type === 'child-continuation-chunk'
          ) {
            throw new Error('Child projection cannot contain an already-scoped chunk.');
          }
          return chunk;
        }),
        finished: result.finished,
      };
    },
    onUsage: delegationUsage?.onPublishedChildUsage,
    personas: runtime.delegationToolPersonas,
  });
  const settle = () =>
    delegatedProjection?.finalize((state) =>
      makeDelegatedStreamTermination(
        state,
        Boolean(state.cancellationSignal?.aborted || runtimeData?.signal?.aborted),
        state.executionSignal?.aborted ? String(state.executionSignal.reason) : undefined
      ).map((chunk) => {
        if (
          chunk.type === 'delegated-conversation-chunk' ||
          chunk.type === 'child-continuation-chunk'
        ) {
          throw new Error('A child terminal cannot contain an already-scoped chunk.');
        }
        return chunk;
      })
    ) ?? [];

  return {
    decorate: (chunk) =>
      chunk.type === 'delegated-conversation-chunk' || chunk.type === 'child-continuation-chunk'
        ? chunk
        : (delegatedProjection?.decorate(chunk) ?? chunk),
    preparePart: (part) => delegatedProjection?.preparePart(part) ?? part,
    project: async (part, toolNames) => (await delegatedProjection?.project(part, toolNames)) ?? [],
    settle,
  };
}

/**
 * A resumable pause maps to its notice chunks plus a `tool-calls` finish. The
 * finish belongs to the LEG, not to the pause: one leg can carry several pauses
 * (a parallel delegation step pauses each child that hits its gate) and ends
 * once, at native close. A resumable pause therefore resolves to its notice
 * chunks alone with `finished: false`; every other part, including a malformed
 * pause that terminates the leg with its own error chunks, passes unchanged.
 */
function resolveLegPart(
  part: unknown,
  mapped: { readonly chunks: readonly StreamChunk[]; readonly finished: boolean }
): {
  readonly chunks: readonly StreamChunk[];
  readonly finished: boolean;
  readonly paused: boolean;
} {
  const type = asMastraStreamPart(part).type;
  const last = mapped.chunks.at(-1);
  if (
    !(mapped.finished && (type === 'tool-call-approval' || type === 'tool-call-suspended')) ||
    last?.type !== 'message-finish' ||
    last.finishReason !== 'tool-calls'
  ) {
    return { ...mapped, paused: false };
  }
  return { chunks: mapped.chunks.slice(0, -1), finished: false, paused: true };
}

/** Which projected child a scoped chunk belongs to. */
function scopedOwnerKey(chunk: StreamChunk): string | undefined {
  switch (chunk.type) {
    case 'delegated-conversation-chunk':
      return JSON.stringify([chunk.identity.parentRuntimeRunId, chunk.identity.parentToolCallId]);
    case 'child-continuation-chunk':
      return chunk.continuationId;
    default:
      return;
  }
}

/**
 * Chunks that EXPOSE a decision: the pause notice, its durable "awaiting your
 * approval" row, and — for a paused CHILD's projected stream — the `tool-calls`
 * finish that closes that child's leg behind the notice. A decision the user
 * can act on must find a durable snapshot behind it, so these are withheld
 * until the leg ends and its native completion join has succeeded
 * (`docs/agents/assistant-runtime.md`, "Native suspension completion"). The
 * root's own `tool-calls` finish never reaches this predicate: the leg strips
 * it (`resolveLegPart`) and emits one at native close.
 *
 * Provenance comes from the stream itself: the pause builder emits a child's
 * notice and its `tool-calls` finish together, so a scoped finish is withheld
 * only for a child whose notice this leg already withheld (`pausedOwners`). A
 * child that legitimately ends on `tool-calls` without pausing (step cap with
 * pending calls) keeps its finish live.
 *
 * Scoped chunks never nest here: a child leg withholds its own children's
 * notices inside its own loop, and the continuation layer wraps chunks only
 * AFTER that loop published them (`mapPart` rejects an already-scoped chunk).
 */
function isPauseNoticeChunk(chunk: StreamChunk, pausedOwners: Set<string>): boolean {
  const owner = scopedOwnerKey(chunk);
  const inner = owner === undefined ? chunk : (chunk as { chunk: ConversationStreamChunk }).chunk;
  switch (inner.type) {
    case 'tool-approval-required':
    case 'tool-suspend-required':
      if (owner !== undefined) {
        pausedOwners.add(owner);
      }
      return true;
    case 'run-event':
      return inner.event.kind === 'tool.approval.requested';
    case 'message-finish':
      return owner !== undefined && inner.finishReason === 'tool-calls' && pausedOwners.has(owner);
    default:
      return false;
  }
}

/**
 * Publish every chunk except the decision-exposing ones, which land in `held`
 * for the leg's exit path. `pausedOwners` carries pause provenance across
 * calls within one leg; see {@link isPauseNoticeChunk}.
 */
export function* withholdPauseNotices(
  chunks: Iterable<StreamChunk>,
  held: StreamChunk[],
  pausedOwners: Set<string>,
  backgroundOwners: ReadonlySet<string> = new Set(),
  parked: Map<string, StreamChunk[]> = new Map()
): Generator<StreamChunk> {
  for (const chunk of chunks) {
    if (!isPauseNoticeChunk(chunk, pausedOwners)) {
      yield chunk;
      continue;
    }
    const owner = scopedOwnerKey(chunk);
    // A BACKGROUND child's pause parks its own task and suspends nothing in
    // this run, so its notice needs no completion join: it publishes as soon
    // as its task is durably parked (`releaseParkedNotices`), as Claude Code
    // surfaces a background subagent's prompt in the main session at once
    // (settled 2026-09-14: thread-4f14436f held three cards for 77 s until
    // the last sibling returned). Not one tick earlier: the child's pause
    // chunk streams BEFORE the task's storage row is suspended, and a decision
    // delivered into the leg in that window finds nothing to resume.
    if (owner !== undefined && backgroundOwners.has(owner)) {
      const notices = parked.get(owner) ?? [];
      notices.push(chunk);
      parked.set(owner, notices);
      continue;
    }
    held.push(chunk);
  }
}

/** The `[runId, toolCallId]` owner key of a background lifecycle part, if any. */
function readLifecycleOwnerKey(part: unknown, type: string): string | undefined {
  const event = readTaskEvent(part);
  if (event?.type !== type) {
    return;
  }
  const runId = readMastraStreamPartString(part, 'runId');
  const toolCallId = typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : '';
  return runId && toolCallId ? JSON.stringify([runId, toolCallId]) : undefined;
}

function isChildPauseFinish(chunk: StreamChunk): boolean {
  return chunk.type === 'delegated-conversation-chunk' && chunk.chunk.type === 'message-finish';
}

/**
 * Publish a background child's parked notices, with the ROOT card behind
 * them, the moment the native `background-task-suspended` part for that
 * child arrives — the task is now in storage as suspended and a decision on
 * the card can be applied (live or on a new leg).
 *
 * The child's pause FINISH is not published with them: it is the child
 * view's terminal frame (the receiver closes the child on it and rejects
 * every later frame), and a parked child is not finished. Its parallel
 * allowed calls still return after the pause, and a live decision resumes
 * it in this very leg — either emits child frames after that terminal, and
 * the renderer tore the whole stream down on the first one (thread-834924c1,
 * 2026-09-14: the pause at :16, a sibling read returned at :26, the client
 * aborted, the host recorded the run finished, every child died with
 * `delegation-root-not-running`). The finish is HELD for the leg's end
 * (`held`), where a still-parked child receives it behind everything else,
 * and dropped when the child resumes (`dropHeldPauseFinish`).
 */
export function* releaseParkedNotices(
  part: unknown,
  parked: Map<string, StreamChunk[]>,
  held: StreamChunk[]
): Generator<StreamChunk> {
  const owner = readLifecycleOwnerKey(part, 'background-task-suspended');
  const notices = owner === undefined ? undefined : parked.get(owner);
  if (!(owner && notices)) {
    return;
  }
  parked.delete(owner);
  held.push(...notices.filter(isChildPauseFinish));
  yield* withRootPauseNotices(notices.filter((chunk) => !isChildPauseFinish(chunk)));
}

/** A resumed child continues in this leg: its held pause terminal must never publish. */
export function dropHeldPauseFinish(part: unknown, held: StreamChunk[]): void {
  const owner = readLifecycleOwnerKey(part, 'background-task-resumed');
  if (owner === undefined) {
    return;
  }
  for (let index = held.length - 1; index >= 0; index -= 1) {
    const chunk = held[index];
    if (chunk && isChildPauseFinish(chunk) && scopedOwnerKey(chunk) === owner) {
      held.splice(index, 1);
    }
  }
}

/** Parked notices whose suspension part never arrived publish with the held ones at the leg's seam. */
function flushParkedNotices(parked: Map<string, StreamChunk[]>, held: StreamChunk[]): void {
  for (const notices of parked.values()) {
    held.push(...notices);
  }
  parked.clear();
}

/**
 * The native stream closed without a terminal part the loop acted on. Mastra
 * closes a suspended run's stream with no finish part once its foreach
 * settles, and a resumed leg whose sibling calls stay suspended closes the
 * same way while raising no pause part of its own (the leg that raised them
 * already surfaced the notices) — its native status is still `suspended`.
 * Either way the run is parked on the user, so the leg ends as the pause it
 * is, never as a missing finish. Otherwise settle an aborted run's delegations
 * or finalize a genuinely missing finish. Returns the title task the caller
 * still awaits.
 */
async function* concludeClosedStream(params: {
  abortedTurnPersistence: AbortedTurnPersistence | undefined;
  calibrationState: { emitted: boolean };
  completeNativeStream: () => Promise<unknown>;
  delegatedProjection: ReturnType<typeof createAttemptDelegatedProjection>;
  delegationUsage: DelegationUsageCapture | undefined;
  /** Drained (`splice(0)`) wherever published, so no exit can repeat a notice. */
  heldPauseNotices: StreamChunk[];
  lifecycleState: ToolLifecycleState;
  memory: MastraMemory | undefined;
  pausePart: unknown;
  promptBreakdown: AssistantContextBreakdown | undefined;
  readNativeStatus: () => string | undefined;
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
  titleGenerationTask: Promise<void> | undefined;
  titleMessages: AgentMessage[] | undefined;
  toolCallTelemetryState: { emitted: boolean };
  // An async generator awaits a returned promise, so the title task travels
  // wrapped: the caller joins it in its own `finally`, not here.
}): AsyncGenerator<StreamChunk, { titleGenerationTask: Promise<void> | undefined }> {
  const { delegatedProjection, delegationUsage, lifecycleState, runtime, runtimeData } = params;
  const aborted = Boolean(runtimeData?.signal?.aborted);
  // A stream that ended without a finish (or was aborted) may still have
  // recorded a warning after its last part - or produced no part at all.
  yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
  yield* drainDelegationUsageChunks(delegationUsage);
  if (!aborted && (params.pausePart !== undefined || params.readNativeStatus() === 'suspended')) {
    yield* drainTokenEstimateCalibrationChunk(
      true,
      runtime,
      runtimeData,
      lifecycleState,
      params.calibrationState,
      params.promptBreakdown
    );
    yield* drainToolCallTelemetryChunks(true, runtime, params.toolCallTelemetryState);
    // Only a pause raised in THIS leg joins snapshot storage through the
    // native full output: Mastra rejects that read for a leg that closes on
    // its siblings' suspension (the suspend payload it awaits was resolved by
    // an earlier leg's stream). The turn layer settles the closed stream.
    if (params.pausePart !== undefined) {
      try {
        await completeNativeTerminal(params.pausePart, params.completeNativeStream);
      } catch (error) {
        // A failed snapshot write fails the stream instead of exposing an
        // unresumable decision: discard the notices before the failure path
        // publishes whatever it still holds.
        params.heldPauseNotices.length = 0;
        throw error;
      }
    }
    yield* delegatedProjection.settle();
    yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
    yield* withRootPauseNotices(params.heldPauseNotices.splice(0));
    yield makeToolCallsFinishChunk();
    params.abortedTurnPersistence?.markNormalFinish();
    runtime.assertAssistantMessageIdPersisted?.();
    return { titleGenerationTask: params.titleGenerationTask };
  }
  yield* delegatedProjection.settle();
  yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
  // Aborted mid-run: settle any orphaned delegations (a cancelled parent must
  // never leave a forever-"running" subagent.started). Otherwise finalize a
  // missing-finish stream with pending tool output + a synthetic finish.
  const titleGenerationTask = ensureMastraThreadTitleGeneration({
    eligible: !aborted,
    memory: params.memory,
    messages: params.titleMessages,
    runtime,
    runtimeData,
    task: params.titleGenerationTask,
  });
  const endChunks = aborted
    ? makeCancelledDelegationRunEventChunks(lifecycleState)
    : makeMissingFinishStreamChunks(lifecycleState);
  // No completion join exists on a missing finish; the notices stream as they
  // did before they were withheld, ahead of the synthetic ending. An explicit
  // root Stop cancels paused work (`background-stop.ts`), so a decision that
  // surfaced before the Stop is unresumable and its notice — and the durable
  // "awaiting your approval" row that would flag the thread — must not appear.
  if (!aborted) {
    yield* withRootPauseNotices(params.heldPauseNotices.splice(0));
  }
  yield* drainToolCallTelemetryChunks(true, runtime, params.toolCallTelemetryState);
  yield* endChunks;
  return { titleGenerationTask };
}

async function completeNativeTerminal(
  part: unknown,
  complete: () => Promise<unknown>
): Promise<void> {
  // Only native terminal parts join snapshot storage. A synthetic steered
  // step-finish must abort immediately, without consuming later native work;
  // provider error parts already carry their mapped terminal outcome.
  switch (asMastraStreamPart(part).type) {
    case 'finish':
    case 'tool-call-approval':
    case 'tool-call-suspended':
      await complete();
      return;
    default:
      return;
  }
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
  answeredApprovals,
  titleMessages,
  completeNativeStream,
  readNativeStatus,
}: StreamGeneratorParams): AsyncIterableIterator<StreamChunk> {
  let titleGenerationTask: Promise<void> | undefined;
  let streamFailure: unknown;
  let pausePart: unknown;
  const heldPauseNotices: StreamChunk[] = [];
  const pausedOwners = new Set<string>();
  const backgroundOwners = new Set<string>();
  const parkedNotices = new Map<string, StreamChunk[]>();
  const calibrationState = { emitted: false };
  const toolCallTelemetryState = { emitted: false };
  const toolNames = new Map<string, string>();

  const delegatedProjection = createAttemptDelegatedProjection({
    delegationUsage,
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
    // The answered siblings lock their cards before any of their children
    // stream, so no stale button is clickable while a child already runs.
    yield* answeredApprovals ?? [];
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
        toolExecutingMs: runtime.resilienceConfig.toolExecutingMs,
      },
      resolveMastraInactivityOptions(
        resumedApprovalToolCall,
        new Set(runtime.toolNameMap.keys()),
        (error) => streamAbortContext.abort(error)
      )
    );
    const projectedSource = projectBackgroundStream(
      source,
      Boolean(runtime.backgroundTaskManager),
      backgroundOwners
    );
    for await (const part of projectedSource) {
      // BST-1701. The provider's own report about the request it just served
      // (a dropped `temperature`, a deprecated setting) is recorded UNDER
      // Mastra by the model observer, because Mastra drops the adapter's
      // `stream-start` part and never carries `warnings` onto this stream.
      // Drained here, per part, so the row lands as soon as the adapter opens
      // its stream - ahead of the first token, and never after the finish
      // chunk that stops the consumer from pulling.
      yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
      yield* withholdPauseNotices(
        await delegatedProjection.project(part, toolNames),
        heldPauseNotices,
        pausedOwners,
        backgroundOwners,
        parkedNotices
      );
      yield* releaseParkedNotices(part, parkedNotices, heldPauseNotices);
      dropHeldPauseFinish(part, heldPauseNotices);
      const { chunks, finished, paused } = resolveLegPart(
        part,
        await processMastraStreamPart(
          delegatedProjection.preparePart(part),
          toolNames,
          lifecycleState,
          sanitizedNameMap,
          runtime.askTools,
          runtime.delegationToolPersonas,
          runtimeData
        )
      );
      if (paused) {
        // A pause does not end the native stream. Mastra's foreach kills only
        // its QUEUED calls when one suspends; the calls already running carry
        // on, so a parallel delegation step pauses several children in ONE
        // leg. Its notice is withheld below until native close, where the leg
        // ends once behind its completion join and its finish belongs.
        // Returning here lost every later sibling's binding and pause
        // (thread-f6be9761, 2026-09-14). The join keys on the part's type
        // alone, so the FIRST pause pins it, whatever order siblings arrive in.
        pausePart ??= part;
      }
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
        await completeNativeTerminal(part, completeNativeStream);
        yield* delegatedProjection.settle();
        // Publishing child terminal chunks yields to the consumer. Flush warnings
        // recorded during publication before downstream stops at the finish.
        yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
        // A background child's pause parks that task, not this run: its
        // withheld notice publishes behind the run's own completion join.
        flushParkedNotices(parkedNotices, heldPauseNotices);
        yield* withRootPauseNotices(heldPauseNotices.splice(0));
      }
      yield* withholdPauseNotices(
        chunks.map((chunk) => delegatedProjection.decorate(chunk)),
        heldPauseNotices,
        pausedOwners,
        backgroundOwners,
        parkedNotices
      );
      if (finished) {
        abortedTurnPersistence?.markNormalFinish();
        runtime.assertAssistantMessageIdPersisted?.();
        return;
      }
    }
    flushParkedNotices(parkedNotices, heldPauseNotices);
    ({ titleGenerationTask } = yield* concludeClosedStream({
      abortedTurnPersistence,
      calibrationState,
      completeNativeStream,
      delegatedProjection,
      delegationUsage,
      heldPauseNotices,
      lifecycleState,
      memory,
      pausePart,
      promptBreakdown,
      readNativeStatus,
      runtime,
      runtimeData,
      titleGenerationTask,
      titleMessages,
      toolCallTelemetryState,
    }));
  } catch (error) {
    streamFailure = error;
    yield* drainDelegationUsageChunks(delegationUsage);
    // The provider can report stream-start warnings and then fail before
    // Mastra yields any mapped part. Preserve those facts before propagating
    // the original stream failure, including cancellation/watchdog paths.
    yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
    yield* delegatedProjection.settle();
    yield* drainProviderCallWarningChunks(runtime.providerCallWarnings);
    // A failure elsewhere in the leg (a sibling's stream or projection) leaves
    // a pause that already reached Mastra parked and durable. Publish it so the
    // thread is not stuck waiting for reload rediscovery; only a rejected
    // completion join discards (it clears the array before throwing) and only
    // a Stop cancels the paused work.
    if (!runtimeData?.signal?.aborted) {
      flushParkedNotices(parkedNotices, heldPauseNotices);
      yield* withRootPauseNotices(heldPauseNotices.splice(0));
    }
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
    await settleStreamCleanup(
      [titleGenerationTask, streamAbortContext.dispose()],
      streamFailure,
      () => {
        logTokenDiagnostics(runtime, runtimeData, lifecycleState);
        logStreamOutcome(Boolean(runtimeData?.signal?.aborted));
      }
    );
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
  // Debug-pack evidence for a FRESH turn only: resume legs replay the prompt
  // their snapshot carries. The host logs a failed write and resolves.
  const rootManifest = buildRootLegPromptManifest({
    messages: initialSystemMessages,
    registeredToolNames: runtime.registeredToolNames,
    runtime: runtimeResolution.runtime,
  });
  if (rootManifest) {
    await runtime.conversationBinding?.recordPromptManifest?.(rootManifest);
  }

  // Per-call approval for `'ask'` tools comes from each ask tool's FUNCTION-form
  // `requireApproval` (approval-gate.ts, evaluated by Mastra on every call),
  // NOT from the run-wide `requireToolApproval` — a truthy run-wide gate would
  // suspend EVERY tool call and force sequential steps. We therefore only pass
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

  if (action.continuationId) {
    return createChildContinuationDecisionStream(action, withRuntimeDerivedStreamOptions(options));
  }
  const resumeOptions = await withDelegatedPersonaSnapshots(action, options);
  const runtimeData = resumeOptions.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData, options.authInput);
  let preserveExecuteBackedWebSearch = false;
  if (providerSupportsNativeWebSearch(runtimeResolution.provider)) {
    // The action's optional toolName is display-only and client-controlled. Use
    // Mastra's storage-backed snapshot as the authority before deciding whether
    // this immutable resumed leg must keep the execute-backed web-search tool.
    const { runtime: discoveryRuntime } = await initializeMastraRuntime(
      withRuntimeDerivedStreamOptions({
        ...resumeOptions,
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
      ...withRuntimeDerivedStreamOptions(resumeOptions),
      approvalResumeLeg: true,
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

  if (action.continuationId) {
    return createChildContinuationDecisionStream(action, withRuntimeDerivedStreamOptions(options));
  }
  const resumeOptions = await withDelegatedPersonaSnapshots(action, options);
  const runtimeData = resumeOptions.runtime;
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData, options.authInput);
  const { runtime, sanitizedNameMap } = await initializeMastraRuntime(
    { ...withRuntimeDerivedStreamOptions(resumeOptions), hydrateToolDiscoveryFromMemory: true },
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

export function streamMastraChildFollowup(
  input: AssistantChildFollowupAction,
  options: MastraAgentRuntimeOptions
): Promise<StreamIterator> {
  return createChildFollowupStream(input, withRuntimeDerivedStreamOptions(options));
}
