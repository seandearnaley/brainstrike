/**
 * Mastra agent streaming (BST-742): the stream entry points
 * (`streamMastraAgent`, `streamMastraToolApprovalAction`,
 * `streamMastraToolResumeAction`, `listSuspendedMastraRuns`), the R6 stream-part
 * dispatch, and the tool-loop option machinery they share. Runtime ASSEMBLY
 * (the factory + tool pipeline) lives in `agent-runtime.ts` /
 * `runtime-assembly/`; this module depends on it, never the reverse.
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
 * See docs/agents/assistant-runtime.md and docs/agents/mastra-boundary.md R6.
 */
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  getLlmModelDefinition,
  listProviderLlmModels,
  resolveOpenRouterCodingMaxOutputTokens,
  resolveOpenRouterOutputWindow,
  resolveOpenRouterReasoningActive,
} from '@brainstrike/assistant-contract';
import type { AssistantContextBreakdown } from '@brainstrike/assistant-contract/context-breakdown';
import type { AssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import type { AssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/logging';
import { generateUUID } from '@brainstrike/utils';
import type {
  Agent,
  AgentMemoryOption,
  DelegationConfig,
  MastraDBMessage,
} from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import { SkillsProcessor } from '@mastra/core/processors';
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
import { type StreamStalledError, withInactivityTimeout } from '../stream/with-inactivity-timeout';
import {
  ToolCallInputStreamingTimeoutError,
  withToolCallInputTimeout,
} from '../stream/with-tool-call-input-timeout';
// TextStreamPart generic in `ai` is constrained to a ToolSet; avoid it here to keep types generic.
import type { AgentMessage, RuntimeData, StreamChunk, StreamIterator } from '../types';
import {
  convertMessagesToMastra,
  createMastraAgentRuntime,
  type MastraAgentRuntime,
  type MastraAgentRuntimeOptions,
} from './agent-runtime';
import { buildBedrockMessageHygieneInputProcessor } from './bedrock-message-hygiene';
import { buildCompactionOverlayInputProcessor } from './compaction-overlay-processor';
import { buildProviderHistoryCompatInputProcessor } from './error-processors';
import { isApprovalExemptInternalTool } from './internal-approval-exempt-tools';
import { createMastraAgentError, isMastraAgentError } from './mastra-agent-error';
import {
  asMastraStreamPart,
  getDeltaText,
  isObservationalMemoryDataChunkType,
  type MastraStreamPart,
  makeStepMetadata,
  OM_FAILURE_DETAIL_MAX_CHARS,
  readOmTokenCount,
  resolveProviderError,
  resolveTripwire,
  truncateStreamDetail,
} from './mastra-chunk-decoding';
import { MCP_PROGRESS_STREAM_PART_TYPE, mapMcpProgressStreamPart } from './mcp-runtime-client';
import { buildOpenAIDuplicateItemCompatInputProcessor } from './openai-duplicate-item-compat';
import { buildOpenAIToolSearchHistoryCompatInputProcessor } from './openai-tool-search-history-compat';
import type { PermissionAskToolMetadata } from './permission-tool-gate';
import { ProjectionAwareTokenLimiter } from './projection-aware-token-limiter';
import type { ProjectionSafeToolCallFilter } from './projection-safe-tool-call-filter';
import { computePromptBreakdown } from './prompt-breakdown';
import { createAssistantMessageIdGenerator } from './runtime-assembly/assistant-message-id';
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
import {
  makeErrorFinishChunk,
  makeRunDetailEventChunk,
  makeRunEventChunk,
  makeRunFailedChunk,
  makeSyntheticFinishChunk,
} from './stream-run-event-chunks';
import {
  isStreamWatchdogError,
  makeProviderErrorTermination,
  makeStreamWatchdogTermination,
  makeTripwireTermination,
} from './stream-termination';
import {
  CHILD_SYNTHESIS_PROMPT,
  createDelegationConfig,
  createDelegationLifecycleTracker,
  createDelegationOutcomeCapture,
  type DelegationOutcomeCapture,
} from './subagent-delegation';
import { makeApprovalRequiredChunks, makeToolSuspendRequiredChunks } from './tool-approval-chunks';
import {
  createDelegationUsageCapture,
  type DelegationUsageCapture,
  makeCancelledDelegationRunEventChunks,
  makeFinishChunk,
  makeLifecycleStepMetadata,
  makePendingToolOutputRunEventChunks,
  makeTerminalRunEvent,
  mapDelegationToolOutput,
  mapGenericToolEvent,
  mapToolLifecyclePart,
  type ProcessStreamPartResult,
  recordFirstTextLatency,
  resolveDelegationPersona,
  type ToolLifecycleState,
} from './tool-lifecycle-processors';
import { buildToolProjectionRewriteInputProcessor } from './tool-projection-rewrite-processor';
import type { BrainstrikeToolSearchProcessor } from './tool-search-runtime';

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

async function processMastraStreamPart(
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
      const terminalUsage = readStreamPartUsage(p);
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

/**
 * Default OpenRouter output window when the client sent no explicit
 * `modelSettings.maxOutputTokens` (BST-1170). Reasoning tokens are output
 * tokens on OpenRouter, so the window is sized for the reasoning state the
 * request actually carries: an active-reasoning request on a catalogued model
 * with a vendor-documented completion window reserves that window; everything
 * else keeps the coding ceiling. Undeclared routes have no recorded facts and
 * keep the ceiling — the base contract, not a per-model guess.
 */
function resolveOpenRouterBackstopMaxOutputTokens(runtimeData: RuntimeData): number {
  const modelId = runtimeData.model?.trim() || getDefaultModel('openrouter');
  const definition = listProviderLlmModels('openrouter').find(({ id }) => id === modelId);
  if (!definition) {
    return resolveOpenRouterCodingMaxOutputTokens();
  }
  const reasoning = runtimeData.providerOptions?.openrouter?.reasoning;
  const explicitEffort = reasoning?.enabled === false ? 'none' : reasoning?.effort;
  return resolveOpenRouterOutputWindow(
    definition,
    resolveOpenRouterReasoningActive(definition, explicitEffort)
  );
}

function buildModelSettingsOption(
  runtimeData: RuntimeData | undefined
): Pick<BrainstrikeAgentStreamOptions, 'modelSettings'> {
  let modelSettings = runtimeData?.modelSettings;
  if (runtimeData?.provider === 'openrouter') {
    modelSettings = {
      maxOutputTokens: resolveOpenRouterBackstopMaxOutputTokens(runtimeData),
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
  // BST-1354: Converse-API shape rules (no empty text/reasoning blocks,
  // constrained tool-call ids) applied to the REPLAYED prompt only. Runs after
  // the history-compat rewrites so it also cleans whatever they produced.
  const bedrockMessageHygiene = buildBedrockMessageHygieneInputProcessor(
    runtimeData?.provider ?? ''
  );
  // Mastra's sealed-boundary re-key can leave the same assistant response
  // persisted under two message ids; OpenAI rejects any request that carries
  // an item id twice (BST-1095). Runs LAST among the compat processors so it
  // sees the item references the earlier rewrites produced.
  const openAIDuplicateItemCompat = buildOpenAIDuplicateItemCompatInputProcessor(
    runtimeData?.provider ?? ''
  );
  const toolProjectionRewrite = buildToolProjectionRewriteInputProcessor(
    runtimeData?.toolProjectionRewriteLookup,
    runtimeData?.memory?.threadId
  );
  const compactionOverlay = buildCompactionOverlayInputProcessor(
    runtimeData?.compactionOverlayLookup,
    runtimeData?.memory?.threadId
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
    toolProjectionRewrite,
    // Adjacent for readability only: processInputStep always runs before the
    // rewrite processor's processLLMRequest, independent of array position.
    compactionOverlay,
    historyCompat,
    openAIToolSearchHistoryCompat,
    openAIDuplicateItemCompat,
    bedrockMessageHygiene,
    tokenLimiter,
  ].filter((processor): processor is NonNullable<typeof processor> => processor !== undefined);

  return {
    maxSteps: maxSteps ?? DEFAULT_AGENT_MAX_STEPS,
    ...(inputProcessors.length > 0 ? { inputProcessors } : {}),
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
 * One no-tools turn on a child that ran out of steps mid-tool-loop (BST-1410).
 *
 * `toolChoice: 'none'` is what makes this bounded: the child physically cannot
 * call another tool, so the turn always terminates in text. The request ends on
 * an explicit USER message rather than the child's own trailing assistant turn
 * — a prompt ending in an assistant message is prefill, which several providers
 * reject outright (the condition `PrefillErrorHandler` exists to recover from),
 * and manufacturing it here would be gratuitous.
 */
function createChildAnswerSynthesizer(
  runtime: MastraAgentRuntime
): (input: {
  readonly messages: readonly MastraDBMessage[];
  readonly personaId: string;
}) => Promise<string | undefined> {
  return async ({ messages, personaId }) => {
    const child = runtime.subAgentsById.get(personaId);
    if (!child) {
      return;
    }
    // `stream`, not `generate`: `generate` dispatches to the model's
    // `doGenerate`, and this codebase's model paths (including the local host)
    // are driven entirely through `doStream`. Mastra's own delegation tool
    // takes the same route for v2 models, and — like it — the stream must be
    // drained before `text` resolves.
    const result = await child.stream(
      [...messages, { content: CHILD_SYNTHESIS_PROMPT, role: 'user' }],
      {
        // BOTH guards, deliberately. `toolChoice: 'none'` withholds the tool
        // DEFINITIONS, but a model that emits a tool call anyway would still
        // have it executed, because the agent's tool map is unchanged — the
        // step-capped-child spec caught exactly that (a third tool execution on
        // the synthesis turn). An empty `activeTools` makes the call
        // unresolvable in the loop instead, so compliance is not assumed.
        activeTools: [],
        disableBackgroundTasks: true,
        maxSteps: 1,
        // The AI SDK's ToolChoice union takes the bare string for the
        // non-specific modes; only `{ type: 'tool' }` is an object.
        toolChoice: 'none',
      }
    );
    for await (const _part of result.fullStream) {
      // Drain: `text` does not resolve until the stream completes.
    }
    const text = await result.text;
    return typeof text === 'string' ? text : undefined;
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

async function* streamAttemptChunks({
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
      runtime.resilienceConfig.toolCallInputMs,
      (error) => streamAbortContext.abort(error)
    );
    const source = withInactivityTimeout(
      toolInputBoundedSource,
      {
        firstOutputMs: runtime.resilienceConfig.streamFirstOutputMs,
        interOutputMs: runtime.resilienceConfig.streamInactivityMs,
      },
      {
        countsAsProviderOutput: isMastraProviderOutputPart,
        describePart: describeMastraStreamPartType,
        onTimeout: (error) => streamAbortContext.abort(error),
      }
    );
    for await (const part of source) {
      const { chunks, finished } = await processMastraStreamPart(
        part,
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
      titleGenerationTask =
        titleGenerationTask ??
        startMastraThreadTitleGeneration({
          memory,
          messages: titleMessages,
          part,
          runtime,
          runtimeData,
        });
      // Drain completed-delegation usage BEFORE the part's own chunks: the
      // completion callback fired before Mastra emitted this part, so the
      // child's usage must not land after a finishing part closes the stream.
      yield* drainDelegationUsageChunks(delegationUsage);
      yield* drainTokenEstimateCalibrationChunk(
        finished,
        runtime,
        runtimeData,
        lifecycleState,
        calibrationState,
        promptBreakdown
      );
      yield* drainToolCallTelemetryChunks(finished, runtime, toolCallTelemetryState);
      for (const chunk of chunks) {
        yield chunk;
      }
      if (finished) {
        runtime.assertAssistantMessageIdPersisted?.();
        return;
      }
    }
    yield* drainDelegationUsageChunks(delegationUsage);
    // Aborted mid-run: settle any orphaned delegations (a cancelled parent must
    // never leave a forever-"running" subagent.started). Otherwise finalize a
    // missing-finish stream with pending tool output + a synthetic finish.
    const endChunks = runtimeData?.signal?.aborted
      ? makeCancelledDelegationRunEventChunks(lifecycleState)
      : makeMissingFinishStreamChunks(lifecycleState);
    yield* drainToolCallTelemetryChunks(true, runtime, toolCallTelemetryState);
    for (const chunk of endChunks) {
      yield chunk;
    }
  } catch (error) {
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

/**
 * Build a {@link ToolLifecycleState} for ONE attempt.
 *
 * The split is deliberate and not uniform (review of #2590):
 *
 * - LATENCY and in-flight lifecycle are per attempt. `streamStartedAtMs`,
 *   `firstTextLatencyMs`, the delegation tracker, and the tool-call maps all
 *   describe one provider call; carrying them would mis-time latency and would
 *   re-settle tools the replaced attempt already settled.
 * - BILLING is per TURN. A recovered turn really did spend the stalled
 *   attempt's tokens, and the `message-finish` this state produces is what the
 *   run ledger and spend analytics persist. Starting the continuation at zero
 *   made every recovered turn under-report, so `carried` seeds those
 *   accumulators from the attempt being replaced.
 */
function createTurnAttemptLifecycleState(
  runtimeData: RuntimeData | undefined,
  delegationOutcomes: DelegationOutcomeCapture | undefined,
  carried?: ToolLifecycleState
): ToolLifecycleState {
  return {
    ...(delegationOutcomes ? { delegationOutcomes } : {}),
    // Prior attempts' totals, added back at the finish. `stepped*` is the
    // replaced attempt's own cumulative sum, so accumulating it here makes this
    // the turn's running total across every attempt so far.
    carriedCompletionTokens:
      (carried?.carriedCompletionTokens ?? 0) + (carried?.steppedCompletionTokens ?? 0),
    carriedPromptTokens: (carried?.carriedPromptTokens ?? 0) + (carried?.steppedPromptTokens ?? 0),
    delegationLifecycle: createDelegationLifecycleTracker(),
    includeCacheTokenClasses: runtimeData?.provider === 'anthropic',
    outputOnlyToolEvents: new Map(),
    requiresBilledCost: runtimeData?.provider === 'openrouter',
    ...(runtimeData?.steering ? { steering: runtimeData.steering } : {}),
    // Billing observations carry: `sawStepBilledCost` in particular gates the
    // OpenRouter "a step omitted its billed cost" throw, and a continuation
    // that forgot the earlier attempt's billed steps would resolve the turn's
    // cost from the final step alone.
    sawStepBilledCost: carried?.sawStepBilledCost ?? false,
    sawStepWithoutBilledCost: carried?.sawStepWithoutBilledCost ?? false,
    stepBilledCostUsd: carried?.stepBilledCostUsd ?? 0,
    stepCount: carried?.stepCount ?? 0,
    // PER ATTEMPT, unlike the billing fields above: the steered finish reports
    // these directly as Mastra's cross-step sum for ONE stream, and the turn's
    // multi-attempt total rides `carried*` instead.
    steppedCompletionTokens: 0,
    steppedPromptTokens: 0,
    streamStartedAtMs: Date.now(),
    terminalToolCallStates: new Map(),
    warnedUnknownChunkTypes: new Set(),
  };
}

/** One provider attempt within a turn, plus what a continuation would need. */
interface TurnAttempt {
  readonly chunks: AsyncIterableIterator<StreamChunk>;
  readonly lifecycleState: ToolLifecycleState;
  /**
   * The assistant/tool messages this attempt produced, or `undefined` when they
   * could not be read.
   *
   * The distinction is SAFETY-CRITICAL, not cosmetic. `[]` means the attempt
   * genuinely produced nothing — a stall before the first step — so continuing
   * from the original request alone is correct and re-runs nothing.
   * `undefined` means we could not tell, and continuing would re-send the user
   * request as if the turn had never started: every completed tool would run a
   * second time. A turn that cannot prove what it produced must not resume.
   */
  readProducedMessages(): readonly MastraDBMessage[] | undefined;
}

/**
 * Read the assistant/tool messages an attempt produced, from Mastra's own
 * message list on the stream result.
 *
 * Mastra's `mastra_messages` is NOT a usable source here: an aborted stream
 * persists nothing at all (BST-1415, measured — not even the user's message),
 * so the in-memory list is the only record of what the attempt did.
 *
 * Narrowed rather than asserted, and `undefined` on ANY shape surprise: see
 * {@link TurnAttempt.readProducedMessages} for why a wrong answer here would
 * re-execute tools.
 */
function readAttemptProducedMessages(
  streamResult: unknown
): readonly MastraDBMessage[] | undefined {
  if (typeof streamResult !== 'object' || streamResult === null) {
    return;
  }
  const messageList = (streamResult as { messageList?: unknown }).messageList;
  if (typeof messageList !== 'object' || messageList === null) {
    return;
  }
  const response = (messageList as { get?: { response?: unknown } }).get?.response;
  if (typeof response !== 'object' || response === null) {
    return;
  }
  const db = (response as { db?: unknown }).db;
  if (typeof db !== 'function') {
    return;
  }
  const produced = (db as () => unknown).call(response);
  return Array.isArray(produced) ? (produced as MastraDBMessage[]) : undefined;
}

/**
 * Run ONE turn across up to `maxAttempts` provider attempts, and dispose the
 * runtime exactly once when it ends (BST-1409).
 *
 * A stall ends an ATTEMPT. It ends the TURN only when the budget is spent, the
 * user cancelled, or the attempt cannot prove what it produced. Everything the
 * earlier attempts streamed has already been yielded to the consumer and stays
 * yielded — recovery never rewinds the visible transcript, it only continues it.
 *
 * Recovery is scoped to `StreamStalledError`. A
 * `ToolCallInputStreamingTimeoutError` means the model never finished writing a
 * tool call's arguments, which is a generation fault rather than a silent
 * transport, and re-sending the same prompt has no reason to change it.
 */
async function* runTurnAttempts(params: {
  /**
   * Built by the caller BEFORE the generator is returned, so a construction
   * failure still rejects the promise `streamMastraAgent` returns. A run
   * rejected before any stream part must surface as a transport rejection the
   * renderer renders as an error block, not as a mid-stream throw
   * (docs/agents/assistant-runtime.md, renderer safety net).
   */
  firstAttempt: TurnAttempt;
  makeContinuation: (input: {
    attempt: number;
    carriedLifecycleState: ToolLifecycleState;
    continuationMessages: readonly MastraDBMessage[] | undefined;
  }) => Promise<TurnAttempt>;
  maxAttempts: number;
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
}): AsyncIterableIterator<StreamChunk> {
  const { firstAttempt, makeContinuation, maxAttempts, runtime, runtimeData } = params;
  // `handleStreamFailure` disposes the runtime before it rethrows, so a
  // continuation that fails to construct must NOT be disposed again by the
  // finally below: `dispose()` has no idempotency guard, and a throw from a
  // second `mcpClient.disconnect()` would REPLACE the original error on its way
  // to the consumer (review of #2590).
  let runtimeDisposed = false;
  try {
    let continuationMessages: readonly MastraDBMessage[] | undefined;
    let carriedLifecycleState: ToolLifecycleState | undefined;
    let pending: TurnAttempt | undefined = firstAttempt;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let current: TurnAttempt;
      if (pending) {
        current = pending;
        pending = undefined;
      } else {
        try {
          current = await makeContinuation({
            attempt,
            carriedLifecycleState: carriedLifecycleState as ToolLifecycleState,
            continuationMessages,
          });
        } catch (error) {
          // Every other terminal path in this function yields the visible
          // text + durable `run.failed` + error-finish triple. A continuation
          // failure throwing mid-stream instead would end the turn with no
          // `run.failed` row and no `thread_runs.error` — the one ending whose
          // cause is invisible in the durable timeline.
          runtimeDisposed = true;
          yield* makeContinuationFailureTermination(error, runtimeData);
          return;
        }
      }
      let stall: StreamStalledError | undefined;
      try {
        // A continuation is a fresh `agent.stream`, so Mastra emits its own
        // `start` part and the mapper turns it into a SECOND `run.started`.
        // One turn starts once: the duplicate is dropped here, and `run.resumed`
        // (emitted immediately before) is what says a new attempt began. Left
        // in, the timeline shows two "Assistant run started" rows for one turn
        // and every started/finished aggregation double-counts recovered runs
        // (review of #2590).
        yield* attempt === 1 ? current.chunks : withoutDuplicateRunStarted(current.chunks);
      } catch (error) {
        if (!isStreamWatchdogError(error)) {
          throw error;
        }
        if (error instanceof ToolCallInputStreamingTimeoutError) {
          yield* makeStreamWatchdogTermination(error, current.lifecycleState, runtimeData);
          return;
        }
        stall = error;
      }
      if (!stall) {
        return;
      }
      const produced = current.readProducedMessages();
      const reason = resolveStallRecoveryRefusal({
        attempt,
        lifecycleState: current.lifecycleState,
        maxAttempts,
        produced,
        runtimeData,
      });
      yield makeStallRunEventChunk(stall, attempt, maxAttempts, reason);
      if (reason) {
        yield* makeStreamWatchdogTermination(stall, current.lifecycleState, runtimeData);
        return;
      }
      // An attempt being replaced still has to SETTLE what it started, exactly
      // as the terminal path does (`makeStreamStalledTermination` drains both):
      // an orphaned `subagent.started` would render a forever-running
      // delegation, and a tool whose only terminal observation was a
      // `tool-output` part would lose its `tool.completed` row and its duration
      // outright, because the continuation treats that tool result as INPUT and
      // never re-emits it. The whole lifecycle state is discarded with the
      // attempt, so this is the last chance to flush either.
      yield* makeCancelledDelegationRunEventChunks(current.lifecycleState);
      yield* makePendingToolOutputRunEventChunks(current.lifecycleState);
      continuationMessages = produced;
      carriedLifecycleState = current.lifecycleState;
      yield makeResumedRunEventChunk(attempt + 1, maxAttempts, produced?.length ?? 0);
    }
  } finally {
    if (!runtimeDisposed) {
      await runtime.dispose();
    }
  }
}

/**
 * Terminal chunks for a continuation that could not be constructed. Mirrors the
 * watchdog terminations' shape so every abnormal ending of a turn looks the same
 * downstream; the runtime is already disposed by `handleStreamFailure`.
 */
function* makeContinuationFailureTermination(
  error: unknown,
  runtimeData: RuntimeData | undefined
): Generator<StreamChunk> {
  const detail = error instanceof Error ? error.message : String(error);
  logger.error(
    {
      code: 'mastra_agent_stream_continuation_failed',
      detail,
      ...(runtimeData?.model ? { model: runtimeData.model } : {}),
      ...(runtimeData?.provider ? { provider: runtimeData.provider } : {}),
    },
    'mastra stream continuation could not be constructed'
  );
  const visible = 'The model stream stalled, and the continuation could not be started.';
  yield { type: 'text-delta', value: visible };
  yield makeRunFailedChunk('Assistant run failed', visible, {
    code: 'mastra_agent_stream_continuation_failed',
  });
  yield makeErrorFinishChunk();
}

/**
 * Drop the `run.started` a continuation attempt re-emits. See its call site for
 * why one turn must report one start.
 */
async function* withoutDuplicateRunStarted(
  chunks: AsyncIterableIterator<StreamChunk>
): AsyncIterableIterator<StreamChunk> {
  let dropped = false;
  for await (const chunk of chunks) {
    if (!dropped && chunk.type === 'run-event' && chunk.event.kind === 'run.started') {
      dropped = true;
      continue;
    }
    yield chunk;
  }
}

/** Why this stall may NOT be recovered, or `undefined` when it may. */
function resolveStallRecoveryRefusal(input: {
  attempt: number;
  lifecycleState: ToolLifecycleState;
  maxAttempts: number;
  produced: readonly MastraDBMessage[] | undefined;
  runtimeData: RuntimeData | undefined;
}): string | undefined {
  if (input.runtimeData?.signal?.aborted) {
    // A user Stop is a decision, not a transport fault.
    return 'cancelled';
  }
  if (input.attempt >= input.maxAttempts) {
    return 'budget-exhausted';
  }
  if (input.produced === undefined) {
    return 'produced-messages-unreadable';
  }
  // CORROBORATION, not paranoia (review of #2590). `[]` is trusted to mean "the
  // attempt produced nothing", which makes continuing from the request alone
  // safe. But that trust rests entirely on the reader, and the attempt holds
  // INDEPENDENT evidence of what it did: `terminalToolCallStates` gains an entry
  // on every completed tool call. An empty message list while tools demonstrably
  // ran is a contradiction — whatever the cause, resuming on it would re-execute
  // every one of those tools, which is the exact outcome the `undefined` branch
  // exists to prevent, reached through the branch treated as safe.
  if (input.produced.length === 0 && input.lifecycleState.terminalToolCallStates.size > 0) {
    return 'produced-messages-contradict-completed-tools';
  }
  return;
}

function makeStallRunEventChunk(
  error: StreamStalledError,
  attempt: number,
  maxAttempts: number,
  refusal: string | undefined
): StreamChunk {
  const detail = `No stream output for ${error.inactivityMs}ms (${error.phase}) on attempt ${attempt} of ${maxAttempts}.`;
  // A RECOVERED stall is followed by no `run.failed`, so this event is the only
  // durable record of it — it must therefore carry the full BST-1408 breadcrumb,
  // not a subset (review of #2590). `lastPartType` is the field that says
  // whether the provider went quiet after reasoning, a tool delta, or the
  // framework prologue.
  const diagnostic = {
    attempt,
    inactivityMs: error.inactivityMs,
    maxAttempts,
    partsSeen: error.partsSeen,
    phase: error.phase,
    ...(error.lastPartType ? { lastPartType: error.lastPartType } : {}),
    ...(refusal ? { refusal } : {}),
  };
  logger.warn(
    { code: 'mastra_agent_stream_attempt_stalled', ...diagnostic },
    'mastra stream attempt stalled'
  );
  return makeRunDetailEventChunk('run.stalled', 'info', 'Model stream stalled', detail, diagnostic);
}

function makeResumedRunEventChunk(
  attempt: number,
  maxAttempts: number,
  carriedMessages: number
): StreamChunk {
  return makeRunDetailEventChunk(
    'run.resumed',
    'info',
    'Continuing after a stall',
    `Attempt ${attempt} of ${maxAttempts}, carrying ${carriedMessages} completed message${carriedMessages === 1 ? '' : 's'} forward.`,
    { attempt, carriedMessages, maxAttempts }
  );
}

function startMastraThreadTitleGeneration({
  memory,
  messages,
  part,
  runtime,
  runtimeData,
}: {
  memory: MastraMemory | undefined;
  messages: AgentMessage[] | undefined;
  part: unknown;
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
}): Promise<void> | undefined {
  if (!(asMastraStreamPart(part).type === 'finish' && memory && messages?.length)) {
    return;
  }
  return generateMastraThreadTitle({ memory, messages, runtime, runtimeData });
}

async function generateMastraThreadTitle({
  memory,
  messages,
  runtime,
  runtimeData,
}: {
  memory: MastraMemory;
  messages: AgentMessage[];
  runtime: MastraAgentRuntime;
  runtimeData: RuntimeData | undefined;
}): Promise<void> {
  const threadId = runtimeData?.memory?.threadId;
  const resourceId = runtimeData?.memory?.resourceId;
  if (!(threadId && resourceId)) {
    return;
  }
  const memoryConfig = runtimeData?.memory?.memoryOptions;
  const config = memory.getMergedThreadConfig(memoryConfig);
  const titleConfig = config.generateTitle;
  if (!titleConfig) {
    return;
  }
  const thread = await memory.getThreadById({ threadId });
  if (!thread) {
    return;
  }
  const existingTitle = thread.title?.trim() ?? '';
  if (existingTitle && existingTitle !== 'New Thread') {
    return;
  }
  const userMessages = messages
    .filter((message) => message.role === 'user')
    .map((message) => ({
      ...message,
      // Mastra's title formatter accepts textual UI parts. File/tool parts are
      // not title input and some versions attempt text-only operations on them.
      parts: message.parts.filter((part) => part.type === 'text'),
    }))
    .filter((message) => message.parts.length > 0);
  if (userMessages.length === 0) {
    return;
  }
  try {
    const title = await runtime.agent.generateTitleFromUserMessage({
      messages: userMessages,
      ...(typeof titleConfig === 'object' && titleConfig.instructions
        ? { instructions: titleConfig.instructions }
        : {}),
      ...(typeof titleConfig === 'object' && titleConfig.model ? { model: titleConfig.model } : {}),
    });
    if (!title?.trim()) {
      return;
    }
    await memory.saveThread({
      ...(memoryConfig ? { memoryConfig } : {}),
      thread: {
        ...thread,
        title: title.trim(),
        updatedAt: new Date(),
      },
    });
  } catch (error) {
    logger.error('Mastra thread title generation failed', {
      code: 'mastra_thread_title_generation_failed',
      error,
      threadId,
    });
  }
}

/** Yield the queued child-usage chunks for this leg's delegation capture, if any. */
function* drainDelegationUsageChunks(
  capture: DelegationUsageCapture | undefined
): Generator<StreamChunk> {
  if (!capture) {
    return;
  }
  yield* capture.drain();
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

function* drainToolCallTelemetryChunks(
  terminal: boolean,
  runtime: MastraAgentRuntime,
  state: { emitted: boolean }
): Generator<StreamChunk> {
  if (!(terminal && !state.emitted)) {
    return;
  }
  state.emitted = true;
  const value = runtime.tokenDiagnostics.toolCallTelemetry();
  if (value.length > 0) {
    yield { type: 'tool-call-telemetry', value };
  }
}

/**
 * Emit one completed-run pair on the final-prompt-content basis. The numerator
 * counts model-visible tool-output projections plus tool definitions once; the
 * denominator is the latest step prompt, which contains every prior tool
 * output once through Mastra's resend behavior—not the cross-step billing sum.
 * Conversation/system-prompt text outside tool outputs and definitions is
 * excluded from both, and a run without a measured tool output is ineligible.
 */
function* drainTokenEstimateCalibrationChunk(
  terminal: boolean,
  runtime: MastraAgentRuntime,
  runtimeData: RuntimeData | undefined,
  lifecycleState: ToolLifecycleState,
  state: { emitted: boolean },
  promptBreakdown: AssistantContextBreakdown | undefined
): Generator<StreamChunk> {
  if (!(terminal && !state.emitted)) {
    return;
  }
  state.emitted = true;
  const finalStepPromptTokens = lifecycleState.latestStepPromptTokens;
  const model = runtimeData?.model;
  const provider = runtimeData?.provider;
  if (finalStepPromptTokens === undefined || !(model && provider)) {
    return;
  }
  const fields = runtime.tokenDiagnostics.toLogFields();
  if (fields['measurementStatus'] === 'failed') {
    return;
  }
  const modelVisibleProjectionCount = fields['modelVisibleProjectionCount'] as number;
  // BST-1232 review (P1): a run with zero measured tool-output projections
  // used to be entirely ineligible for this chunk, which meant an ordinary
  // tool-free chat turn NEVER persisted `promptBreakdownBaselineTokens` —
  // silently starving the next turn's compaction trigger of the one value
  // this migration exists to give it. The estimator-vs-provider RATIO this
  // chunk also carries (estimatedPromptTokens/finalStepPromptTokens) is
  // still only meaningful when real tool-output measurement happened
  // (BST-1205); that eligibility gate now lives in the consuming
  // `estimator-calibration.sql` lens (`model_visible_projection_count > 0`)
  // instead of the writer, so a zero-projection row can be written here
  // without resurrecting a meaningless ratio sample downstream. A row is
  // still skipped only when there is NOTHING new to report: no measured
  // tool output AND no prompt breakdown to source a baseline from.
  if (modelVisibleProjectionCount === 0 && !promptBreakdown) {
    return;
  }
  // Comparable final-prompt basis: the numerator counts model-visible tool
  // outputs and tool definitions once; the latest step prompt already contains
  // every prior tool output once via Mastra's resend behavior. Conversation and
  // system-prompt text outside those shares remain excluded from both figures.
  const estimatedPromptTokens =
    (fields['modelVisibleProjectionBackstopTokens'] as number) +
    ((fields['toolDefinitionBackstopTokens'] as number | undefined) ?? 0);
  yield {
    type: 'token-estimate-calibration',
    value: {
      estimatedPromptTokens,
      finalStepPromptTokens,
      model,
      modelVisibleProjectionCount,
      occurredAt: Date.now(),
      provider,
      // BST-1232 review: `taskListTokens` absent genuinely means "no task
      // list" (0 is honest), but `toolDefinitionsTokens` absent means tool-
      // definition measurement FAILED for this run (see
      // `RunTokenDiagnostics.toolDefinitionContextBreakdown()`'s own "absent,
      // never zero-faked" contract) — folding that to 0 would silently
      // understate the baseline by roughly the whole tool catalog
      // (~9.8k tokens) while looking like valid evidence to the next turn's
      // trigger. Omit the field entirely rather than persist a fabricated
      // partial sum (no-silent-fallbacks); migration 091's NULL already
      // means exactly "no trustworthy baseline for this row".
      ...(promptBreakdown && promptBreakdown.toolDefinitionsTokens !== undefined
        ? {
            promptBreakdownBaselineTokens:
              promptBreakdown.systemInstructionsTokens +
              (promptBreakdown.taskListTokens ?? 0) +
              promptBreakdown.toolDefinitionsTokens,
          }
        : {}),
      resolvedDomainBudgetTokens: runtime.resolvedToolResultBudget.domainModelResultTokens,
      resolvedTransportBudgetTokens: runtime.resolvedToolResultBudget.transportResultTokens,
      stepCount: lifecycleState.stepCount,
    },
  };
}

/**
 * The initial turn. Recovery from a stalled attempt lives HERE and only here:
 * a continuation is a plain `agent.stream` over the messages produced so far,
 * which the approval- and suspend-resume legs cannot express — their entry
 * points consume a one-shot approval/suspension that cannot be re-issued. Those
 * legs still route through {@link runTurnAttempts} with a single attempt, so
 * runtime disposal has exactly one owner across every leg.
 */
async function createStreamIteratorFromRuntime(
  params: StreamIterationParams
): Promise<StreamIterator> {
  const { runtime, runtimeData } = params;
  return runTurnAttempts({
    firstAttempt: await createInitialTurnAttempt(params, undefined),
    makeContinuation: (input) =>
      createInitialTurnAttempt(params, input.continuationMessages, input.carriedLifecycleState),
    maxAttempts: runtime.resilienceConfig.streamStallAttempts,
    runtime,
    runtimeData,
  });
}

async function createInitialTurnAttempt(
  {
    runtime,
    runtimeData,
    messages,
    memory,
    requireToolApproval,
    sanitizedNameMap,
  }: StreamIterationParams,
  continuationMessages: readonly MastraDBMessage[] | undefined,
  carriedLifecycleState?: ToolLifecycleState
): Promise<TurnAttempt> {
  const mastraMessages = convertMessagesToMastra(messages);
  const streamAbortContext = createStreamAbortContext(runtimeData?.signal);
  // Same lifetime as `delegationUsage`: written by the delegation hook, read by
  // the chunk loop when it maps the delegation's terminal run event (BST-1410).
  // Built BEFORE the lifecycle state because that state carries it.
  const delegationOutcomes =
    runtime.personasById.size > 0 ? createDelegationOutcomeCapture() : undefined;
  const lifecycleState = createTurnAttemptLifecycleState(
    runtimeData,
    delegationOutcomes,
    carriedLifecycleState
  );

  try {
    // A continuation re-sends the original request FOLLOWED BY everything the
    // stalled attempt produced, so the model continues from its own completed
    // tool results instead of starting over. Re-sending the request is safe
    // rather than duplicative: an aborted attempt persisted nothing at all
    // (BST-1415), so the continuation is the turn's only writer.
    const streamInput = [
      ...mastraMessages,
      ...(continuationMessages ?? []),
    ] as unknown as Parameters<typeof runtime.agent.stream>[0];
    const memoryOption = resolveMemoryOption(runtimeData, memory);
    const delegationUsage =
      runtime.personasById.size > 0
        ? createDelegationUsageCapture(runtime.personasById, runtimeData)
        : undefined;

    const streamOptions: BrainstrikeAgentStreamOptions = {
      ...buildToolLoopOptions(runtimeData, runtime.toolSearchProcessor, runtime.toolHistoryFilter),
      abortSignal: streamAbortContext.signal,
      ...buildAssistantStreamMessageIdOption(runtimeData),
      ...(memoryOption ? { memory: memoryOption } : {}),
      ...buildModelSettingsOption(runtimeData),
      ...buildGenerationProviderOptionsOption(runtimeData),
      // Delegation safety rails: per-run caps + maxSteps clamp + unknown-persona
      // rejection (only when the run has registered personas).
      ...(delegationUsage
        ? {
            delegation: createDelegationConfig({
              ...(delegationOutcomes ? { delegationOutcomes } : {}),
              logger,
              onChildUsage: delegationUsage.onChildUsage,
              personasById: runtime.personasById,
              synthesizeChildAnswer: createChildAnswerSynthesizer(runtime),
            }),
          }
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
      toolDefinitions: runtime.tokenDiagnostics.toolDefinitionContextBreakdown(),
    });

    return {
      chunks: streamAttemptChunks({
        ...(delegationUsage ? { delegationUsage } : {}),
        lifecycleState,
        ...(memory ? { memory } : {}),
        promptBreakdown,
        runtime,
        stream: fullStream,
        streamAbortContext,
        titleMessages: messages,
        ...(runtimeData ? { runtimeData } : {}),
        ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
      }),
      lifecycleState,
      readProducedMessages: () => readAttemptProducedMessages(streamResult),
    };
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
  // Since the @mastra/core 1.56 approval rework there is no self-approving
  // exemption: run_python is an ordinary ask-set tool (the permission gate's
  // `requireApproval` clone is its Gate A), so re-gating it on a resumed leg
  // is exactly the framework's own idiom — approve is consumed pre-execution
  // and the tool runs once, never a loop. Only Mastra-INTERNAL bookkeeping
  // tools stay exempt (the D4 defect).
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

/**
 * Approval-resume. Routed through {@link runTurnAttempts} with a SINGLE attempt:
 * an approval is consumed by `approveToolCall`/`declineToolCall` and cannot be
 * re-issued, so this leg keeps the pre-BST-1409 terminal behavior on a stall.
 * It still shares the turn runner so `runtime.dispose()` has one owner.
 */
async function createToolApprovalIteratorFromRuntime(
  params: ToolApprovalIterationParams
): Promise<StreamIterator> {
  return runTurnAttempts({
    firstAttempt: await createToolApprovalTurnAttempt(params),
    // Unreachable at maxAttempts 1; present so the runner has one shape.
    makeContinuation: () => createToolApprovalTurnAttempt(params),
    maxAttempts: 1,
    runtime: params.runtime,
    runtimeData: params.runtimeData,
  });
}

async function createToolApprovalTurnAttempt({
  runtime,
  runtimeData,
  action,
  memory,
  requireToolApproval,
  sanitizedNameMap,
}: ToolApprovalIterationParams): Promise<TurnAttempt> {
  const streamAbortContext = createStreamAbortContext(runtimeData?.signal);
  // Same lifetime as `delegationUsage`: written by the delegation hook, read by
  // the chunk loop when it maps the delegation's terminal run event (BST-1410).
  // Built BEFORE the lifecycle state because that state carries it.
  const delegationOutcomes =
    runtime.personasById.size > 0 ? createDelegationOutcomeCapture() : undefined;
  const lifecycleState = createTurnAttemptLifecycleState(runtimeData, delegationOutcomes);
  try {
    validateToolApprovalAction(action);
    const memoryOption = resolveMemoryOption(runtimeData, memory);
    const resumedApprovalToolCall = await readResumedApprovalToolCall(runtime, runtimeData, action);
    const delegationUsage =
      runtime.personasById.size > 0
        ? createDelegationUsageCapture(runtime.personasById, runtimeData)
        : undefined;
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
      ...(delegationUsage
        ? {
            delegation: createDelegationConfig({
              ...(delegationOutcomes ? { delegationOutcomes } : {}),
              logger,
              onChildUsage: delegationUsage.onChildUsage,
              personasById: runtime.personasById,
              synthesizeChildAnswer: createChildAnswerSynthesizer(runtime),
            }),
          }
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

    // BST-1232 review (P2): prompt composition is unchanged across a resume
    // (same composed instructions, same tool definitions), so the SAME
    // baseline the initial turn would have reported still applies here — it
    // was simply never computed on this leg. `messages: []` is honest for a
    // resume: no new user messages are sent, so the message-side counts this
    // breakdown also carries (attachmentsCount, and historyMessagesTokens
    // when not memory-backed) are correctly zero/omitted rather than stale.
    const promptBreakdown = computePromptBreakdown({
      instructionBreakdown: runtime.instructionBreakdown,
      memoryBacked: Boolean(memoryOption),
      messages: [],
      toolDefinitions: runtime.tokenDiagnostics.toolDefinitionContextBreakdown(),
    });

    return {
      chunks: streamAttemptChunks({
        ...(delegationUsage ? { delegationUsage } : {}),
        lifecycleState,
        promptBreakdown,
        runtime,
        stream: fullStream,
        streamAbortContext,
        ...(action.action === 'approve' ? { resumedApprovalToolCall } : {}),
        ...(runtimeData ? { runtimeData } : {}),
        ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
      }),
      lifecycleState,
      // A resume leg never recovers (see createStreamIteratorFromRuntime), so
      // this is never consulted; `undefined` states that honestly rather than
      // implying an empty continuation would be safe.
      readProducedMessages: () => undefined,
    };
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
  const runtimeResolution = resolveRuntimeConfiguration(runtimeData, options.authInput);
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

/**
 * A non-approval `suspend()` pause discovered from workflow storage
 * (BST-1084): a tool that called `suspend()` (submitPlan/askUser) whose run
 * survived a restart/reload. `suspendPayload` comes off the durable snapshot
 * (Mastra's `AgentRunToolCall.suspendPayload`), so the rediscovered notice
 * renders the real plan/question. `toolName` is the ORIGINAL dotted name,
 * mapped exactly like approvals.
 */
export interface DiscoveredSuspendedPause {
  readonly runId: string;
  readonly suspendedAt: string;
  readonly suspendPayload?: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface ListSuspendedRunsResult {
  readonly approvals: readonly DiscoveredSuspendedApproval[];
  /** Non-approval suspend() pauses (BST-1084). Same ordering as approvals. */
  readonly suspends: readonly DiscoveredSuspendedPause[];
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

type SuspendedRunsForClassification = Awaited<ReturnType<Agent['listSuspendedRuns']>>['runs'];

/**
 * Classify a suspended run's tool calls into approvals vs suspend() pauses.
 *
 * Mastra's documented contract: `run.toolCalls` contains only calls the run is
 * CURRENTLY suspended on ("A suspended tool call inside a suspended agent run
 * — either waiting on a tool-call approval or on resume data for a tool that
 * called suspend()", AgentRunToolCall). A call can be suspended for exactly
 * ONE reason at a time — even a tool that is both approval-gated and
 * suspending composes the two transports SERIALLY (pinned by the BOTH-FLAGS
 * integration proof). The id set below is a CANARY for that contract: if an
 * upstream change ever lists one call in both roles, the approval (the
 * earlier gate) wins and the duplicate is logged loudly instead of producing
 * two cards for one call. Only a call missing its ids (e.g. a
 * delegation-thread run) is tolerated + skipped.
 */
function classifySuspendedToolCalls(
  runs: SuspendedRunsForClassification,
  toolNameMap: ReadonlyMap<string, string>
): { approvals: DiscoveredSuspendedApproval[]; suspends: DiscoveredSuspendedPause[] } {
  const approvals: DiscoveredSuspendedApproval[] = [];
  const suspends: DiscoveredSuspendedPause[] = [];
  const approvalToolCallIds = new Set<string>();
  for (const run of runs) {
    const suspendedAt = run.suspendedAt.toISOString();
    for (const toolCall of run.toolCalls) {
      if (!(toolCall.toolCallId && toolCall.toolName)) {
        logger.debug('skipping suspended tool call without ids', {
          code: 'mastra_agent_suspended_run_skipped',
          requiresApproval: toolCall.requiresApproval,
          runId: run.runId,
          toolName: toolCall.toolName,
        });
        continue;
      }
      // Snapshots store the REGISTERED (sanitized) id; every client-facing
      // surface is keyed by the ORIGINAL name — map it back here so the
      // desktop route's riskByTool lookup and per-tool overrides match.
      const toolName = resolveDiscoveredApprovalToolName(toolCall.toolName, toolNameMap, run.runId);
      if (toolCall.requiresApproval) {
        approvalToolCallIds.add(toolCall.toolCallId);
        approvals.push({
          runId: run.runId,
          suspendedAt,
          toolCallId: toolCall.toolCallId,
          toolName,
          ...(toolCall.args === undefined ? {} : { args: toolCall.args }),
        });
        continue;
      }
      if (approvalToolCallIds.has(toolCall.toolCallId)) {
        logger.warn('suspended tool call listed as BOTH approval and suspend; approval wins', {
          code: 'mastra_agent_suspended_run_duplicate_tool_call',
          runId: run.runId,
          toolCallId: toolCall.toolCallId,
          toolName,
        });
        continue;
      }
      // BST-1084: a tool that called suspend() — carry its durable payload
      // so the rediscovered notice renders the real plan/question.
      suspends.push({
        runId: run.runId,
        suspendedAt,
        toolCallId: toolCall.toolCallId,
        toolName,
        ...(toolCall.suspendPayload === undefined
          ? {}
          : { suspendPayload: toolCall.suspendPayload }),
      });
    }
  }
  const bySuspendedAt = (a: { suspendedAt: string }, b: { suspendedAt: string }): number =>
    Date.parse(a.suspendedAt) - Date.parse(b.suspendedAt);
  approvals.sort(bySuspendedAt);
  suspends.sort(bySuspendedAt);
  return { approvals, suspends };
}

/**
 * Restart-safe discovery of pending tool approvals for a thread. Rebuilds a
 * FRESH runtime (like {@link streamMastraToolApprovalAction}) and calls the
 * sanctioned `agent.listSuspendedRuns` — it holds no in-memory stream handle, so
 * it works after a process restart / renderer reload given only the thread
 * context. It is INERT: listing performs no inference and never resumes a run.
 *
 * Returns approval-gated tool calls (`requiresApproval === true`) in
 * `approvals` AND non-approval `suspend()` pauses (submitPlan/askUser) in
 * `suspends` (BST-1084) — both requiring a `toolCallId` + `toolName`, both
 * name-mapped to the original dotted form. Only a call missing its ids (e.g.
 * a delegation-thread run) is tolerated + skipped (logged at debug). Storage
 * is REQUIRED (no storage ⇒ no discovery, never a silent empty result).
 */
export async function listSuspendedMastraRuns(
  filter: { readonly threadId: string; readonly resourceId: string },
  options: MastraAgentRuntimeOptions = {}
): Promise<ListSuspendedRunsResult> {
  assertNoUnsupportedDirectStreamOptions(options);
  if (!options.storage) {
    throw createMastraAgentError('mastra_agent_runtime_init_failed', {
      detail: 'Mastra workflow storage is required to discover suspended approvals.',
    });
  }

  const runtimeResolution = resolveRuntimeConfiguration(options.runtime, options.authInput);
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

    const { approvals, suspends } = classifySuspendedToolCalls(runs, runtime.toolNameMap);

    logger.info('discovered suspended approvals', {
      approvalCount: approvals.length,
      code: 'mastra_agent_suspended_runs_discovered',
      runCount: runs.length,
      suspendCount: suspends.length,
      threadId: filter.threadId,
    });

    return { approvals, suspends };
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

/**
 * The suspend-resume transport answers a tool's OWN `suspend()` pause and
 * nothing else. Refuse when the targeted call is suspended for APPROVAL
 * (BST-1097): the two pause kinds carry different resume shapes, and a generic
 * resume payload delivered to an approval pause would reach a self-approving
 * tool as if its gates were already settled — e.g. `{action:'allow'}` answering
 * run_python's Gate A would skip the approval card entirely. Mirrors
 * `readResumedApprovalToolCall`, which enforces the symmetric direction
 * (`requiresApproval === true`) for the approval transport. A missing run or
 * tool call fails visibly here with the same typed error family — never a
 * silent fallthrough to a blind resume.
 */
async function assertResumedCallIsSuspendPause(
  runtime: MastraAgentRuntime,
  runtimeData: RuntimeData | undefined,
  action: AssistantToolResumeAction
): Promise<{ readonly toolName: string }> {
  const memoryContext = runtimeData?.memory;
  const { runs } = await runtime.agent.listSuspendedRuns(
    memoryContext
      ? { resourceId: memoryContext.resourceId, threadId: memoryContext.threadId }
      : undefined
  );
  const run = runs.find((candidate) => candidate.runId === action.runId);
  const toolCall = run?.toolCalls.find((candidate) => candidate.toolCallId === action.toolCallId);
  if (!toolCall) {
    throw createMastraAgentError('mastra_agent_stream_failure', {
      context: { runId: action.runId, toolCallId: action.toolCallId },
      detail: 'Suspended tool snapshot is missing the requested tool call.',
    });
  }
  if (toolCall.requiresApproval) {
    throw createMastraAgentError('mastra_agent_stream_failure', {
      context: { runId: action.runId, toolCallId: action.toolCallId },
      detail:
        'The requested tool call is suspended for APPROVAL; answer it through the approval transport, not the suspend-resume transport.',
    });
  }
  if (!toolCall.toolName) {
    // The rider decision below keys on the tool's ask registration; a
    // snapshot with no tool name cannot be classified — refuse rather than
    // guessing (a wrong guess either denies a valid resume or widens a
    // payload the tool's schema will reject).
    throw createMastraAgentError('mastra_agent_stream_failure', {
      context: { runId: action.runId, toolCallId: action.toolCallId },
      detail: 'Suspended tool snapshot has no tool name for the requested tool call.',
    });
  }
  return { toolName: toolCall.toolName };
}

/**
 * Suspended-tool resume. Same single-attempt reasoning as the approval leg: the
 * Mastra snapshot is consumed by `resumeStream` and cannot be replayed.
 */
async function createToolResumeIteratorFromRuntime(
  params: ToolResumeIterationParams
): Promise<StreamIterator> {
  return runTurnAttempts({
    firstAttempt: await createToolResumeTurnAttempt(params),
    // Unreachable at maxAttempts 1; present so the runner has one shape.
    makeContinuation: () => createToolResumeTurnAttempt(params),
    maxAttempts: 1,
    runtime: params.runtime,
    runtimeData: params.runtimeData,
  });
}

async function createToolResumeTurnAttempt({
  runtime,
  runtimeData,
  action,
  memory,
  sanitizedNameMap,
}: ToolResumeIterationParams): Promise<TurnAttempt> {
  const streamAbortContext = createStreamAbortContext(runtimeData?.signal);
  // Same lifetime as `delegationUsage`: written by the delegation hook, read by
  // the chunk loop when it maps the delegation's terminal run event (BST-1410).
  // Built BEFORE the lifecycle state because that state carries it.
  const delegationOutcomes =
    runtime.personasById.size > 0 ? createDelegationOutcomeCapture() : undefined;
  const lifecycleState = createTurnAttemptLifecycleState(runtimeData, delegationOutcomes);
  try {
    validateToolResumeAction(action);
    const suspendedCall = await assertResumedCallIsSuspendPause(runtime, runtimeData, action);
    const memoryOption = resolveMemoryOption(runtimeData, memory);
    // 1.56+ RIDER: Mastra re-checks an approval-gated tool's `requireApproval`
    // on EVERY leg, including the resume of a plain (Gate B-style) suspension,
    // and converts a resume without `approved: true` into its generic denial
    // BEFORE execute() runs.
    //
    // The rider states a HISTORICAL fact, and the evidence is structural, not
    // the current policy: `assertResumedCallIsSuspendPause` above proved this
    // pause is a PLAIN suspension, and a plain suspension can only be raised
    // from inside execute() — which the framework only reaches after the
    // call's pre-execution gate settled under the policy in force at
    // invocation ('ask' ⇒ an approval was collected; 'allow' ⇒ none was
    // required). A policy tightened mid-suspension does not retroactively
    // un-settle that gate, and the resume itself is an explicit user decision
    // on this very call. `askTools.has` below only answers "will the REBUILT
    // runtime re-check this tool at all" — when it will not, the payload
    // passes through untouched.
    //
    // Scope: plain-OBJECT payloads only. Spreading a string/array resume
    // (the LEGACY pre-envelope askUser answer shape — the notice now sends
    // the `{answer}` envelope, AskUserResumeData) would mangle it into an
    // index map, so a non-object payload is passed through unchanged — and if
    // the tool is ask-gated, that legacy resume may hit the framework's
    // denial. Loud, not silent: the warn below names the tool and the fix (an
    // object resume envelope). Pinned by unit tests in
    // mastra-tool-approval-chunks.spec.ts.
    const isPlainObjectResume =
      typeof action.resumeData === 'object' &&
      action.resumeData !== null &&
      !Array.isArray(action.resumeData);
    const toolIsReChecked = runtime.askTools.has(suspendedCall.toolName);
    if (toolIsReChecked && !isPlainObjectResume) {
      logger.warn(
        'Ask-gated suspending tool has a non-object resume payload; the 1.56+ approval rider cannot be attached and Mastra may deny the resume. Give the tool an object resume envelope to make it ask-compatible.',
        {
          code: 'mastra_agent_resume_rider_unattachable',
          runId: action.runId,
          toolCallId: action.toolCallId,
          toolName: suspendedCall.toolName,
        }
      );
    }
    const resumeData =
      toolIsReChecked && isPlainObjectResume
        ? { ...(action.resumeData as Record<string, unknown>), approved: true }
        : action.resumeData;
    const delegationUsage =
      runtime.personasById.size > 0
        ? createDelegationUsageCapture(runtime.personasById, runtimeData)
        : undefined;
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
      ...(delegationUsage
        ? {
            delegation: createDelegationConfig({
              ...(delegationOutcomes ? { delegationOutcomes } : {}),
              logger,
              onChildUsage: delegationUsage.onChildUsage,
              personasById: runtime.personasById,
              synthesizeChildAnswer: createChildAnswerSynthesizer(runtime),
            }),
          }
        : {}),
    };

    // resumeData is validated by Mastra against the suspended tool's resumeSchema.
    const streamResult = await runtime.agent.resumeStream(
      resumeData as Parameters<typeof runtime.agent.resumeStream>[0],
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

    // BST-1232 review (P2): same rationale as the approval-resume leg above —
    // prompt composition (instructions + tool definitions) is unchanged
    // across a suspended-tool resume, so the same baseline applies; it was
    // simply never threaded through on this leg. See the approval-resume
    // leg's comment for why `messages: []` is the honest choice here.
    const promptBreakdown = computePromptBreakdown({
      instructionBreakdown: runtime.instructionBreakdown,
      memoryBacked: Boolean(memoryOption),
      messages: [],
      toolDefinitions: runtime.tokenDiagnostics.toolDefinitionContextBreakdown(),
    });

    return {
      chunks: streamAttemptChunks({
        ...(delegationUsage ? { delegationUsage } : {}),
        lifecycleState,
        promptBreakdown,
        runtime,
        stream: fullStream,
        streamAbortContext,
        ...(runtimeData ? { runtimeData } : {}),
        ...(sanitizedNameMap ? { sanitizedNameMap } : {}),
      }),
      lifecycleState,
      // See the approval-resume leg: a resume never recovers, so `undefined`
      // is the honest answer rather than an empty continuation.
      readProducedMessages: () => undefined,
    };
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
