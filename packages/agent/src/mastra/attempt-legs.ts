/**
 * Mastra attempt-leg factories (BST-1649, split out of `turn-attempts.ts` to
 * respect the per-file line cap): the three legs — initial, tool-approval-
 * resume, tool-suspend-resume — that each build ONE Mastra `agent.stream()` /
 * `approveToolCall()`/`declineToolCall()` / `resumeStream()` call and hand its
 * output to `streamAttemptChunks`. Each factory is a thin wrapper over the
 * shared `buildStreamOptions` (`runtime-assembly/stream-options.ts`) — see its
 * per-leg parity suite for proof the merged option object is unchanged from
 * what each leg built inline before this split.
 *
 * Depends on `turn-attempts.ts` for the attempt/turn model
 * (`runTurnAttempts`, `TurnAttempt`, lifecycle state, abort/memory plumbing)
 * and on `agent-streaming.ts` for `streamAttemptChunks` and the
 * resumed-approval types. `agent-streaming.ts` imports this module's entry
 * points (`createStreamIteratorFromRuntime`,
 * `createToolApprovalIteratorFromRuntime`, `createToolResumeIteratorFromRuntime`,
 * the validators, and `readResumedApprovalToolCall`) back — see
 * `turn-attempts.ts`'s module doc for why that mutual dependency is safe.
 *
 * See docs/agents/assistant-runtime.md and docs/agents/mastra-boundary.md.
 */
import type { AssistantToolApprovalAction } from '@brainstrike/assistant-contract/tool-approval';
import type { AssistantToolResumeAction } from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/logging';
import type { Agent, MastraDBMessage } from '@mastra/core/agent';
import type { MastraMemory } from '@mastra/core/memory';
import type { RuntimeData, StreamIterator } from '../types';
import { attachAbortedTurnMessageList } from './aborted-turn-persistence';
import { convertMessagesToMastra, type MastraAgentRuntime } from './agent-runtime';
import {
  type ResumedApprovalToolCall,
  type ResumedToolCallStart,
  streamAttemptChunks,
} from './agent-streaming';
import {
  assertDelegatedToolActionPending,
  claimDelegatedToolAction,
} from './delegated-tool-actions';
import { isApprovalExemptInternalTool } from './internal-approval-exempt-tools';
import { createMastraAgentError, isMastraAgentError, MastraAgentError } from './mastra-agent-error';
import { makeMcpDiscoverySkipChunks } from './mcp-discovery-diagnostics';
import type { PermissionAskToolMetadata } from './permission-tool-gate';
import { computePromptBreakdown } from './prompt-breakdown';
import { type ApprovalGate, buildStreamOptions } from './runtime-assembly/stream-options';
import { createDelegationOutcomeCapture } from './subagent-delegation';
import { resolveDiscoveredApprovalToolName } from './suspended-run-discovery';
import { createDelegationUsageCapture, type ToolLifecycleState } from './tool-lifecycle-processors';
import {
  type AgentStreamOptions,
  type AgentToolApprovalOptions,
  createRuntimeAbortedTurnPersistence,
  createStreamAbortContext,
  createTurnAttemptLifecycleState,
  readAttemptProducedMessages,
  resolveFullStream,
  resolveMemoryOption,
  runTurnAttempts,
  type StreamIterationParams,
  type ToolApprovalIterationParams,
  type TurnAttempt,
} from './turn-attempts';

const logger = createLogger('MastraAgent');

/**
 * The initial turn. Recovery from a stalled attempt lives HERE and only here:
 * a continuation is a plain `agent.stream` over the messages produced so far,
 * which the approval- and suspend-resume legs cannot express — their entry
 * points consume a one-shot approval/suspension that cannot be re-issued. Those
 * legs still route through {@link runTurnAttempts} with a single attempt, so
 * runtime disposal has exactly one owner across every leg.
 */
export async function createStreamIteratorFromRuntime(
  params: StreamIterationParams
): Promise<StreamIterator> {
  const { runtime, runtimeData } = params;
  // `firstAttempt` is still awaited HERE, before the generator below is built,
  // so a construction failure rejects the promise `streamMastraAgent` returns
  // rather than throwing mid-stream (see runTurnAttempts' `firstAttempt`
  // contract and the renderer safety net in docs/agents/assistant-runtime.md).
  return runTurnAttempts({
    firstAttempt: await createInitialTurnAttempt(params, undefined),
    makeContinuation: (input) =>
      createInitialTurnAttempt(
        params,
        input.continuationMessages,
        input.carriedLifecycleState,
        false
      ),
    maxAttempts: runtime.resilienceConfig.streamStallAttempts,
    // BST-1602: a run whose MCP server contributed nothing says so. This is the
    // FRESH-TURN seam, which is exactly the scope the rows want — the resume
    // legs call `runTurnAttempts` directly, rebuild the runtime, re-run
    // discovery, and still emit nothing.
    preludeChunks: makeMcpDiscoverySkipChunks(runtime.mcpDiscoverySkips),
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
  carriedLifecycleState?: ToolLifecycleState,
  disposeRuntimeOnFailure = true
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
    runtime.toolExecutionDurations,
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
    const abortedTurnPersistence = createRuntimeAbortedTurnPersistence({
      finalizeAbortedDelegatedTurns: runtime.delegatedTurnPersistence?.finalize,
      memory,
      memoryOption,
      runtimeData,
      streamAbortContext,
    });

    const streamOptions = buildStreamOptions({
      abortSignal: streamAbortContext.signal,
      delegationOutcomes,
      delegationUsage,
      leg: 'initial',
      memoryOption,
      requireToolApproval,
      runtime,
      runtimeData,
    });
    const resolvedStreamOptions = Object.keys(streamOptions).length > 0 ? streamOptions : undefined;

    const streamResult = resolvedStreamOptions
      ? await runtime.agent.stream(streamInput, resolvedStreamOptions as AgentStreamOptions)
      : await runtime.agent.stream(streamInput);
    await attachAbortedTurnMessageList(abortedTurnPersistence, streamResult);
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
      abortedTurnPersistence,
      chunks: streamAttemptChunks({
        abortedTurnPersistence,
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
    if (!disposeRuntimeOnFailure) {
      throw err;
    }
    return await handleStreamFailure(err, runtime);
  }
}

export function validateToolApprovalAction(action: AssistantToolApprovalAction): void {
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

export async function readResumedApprovalToolCall(
  runtime: Pick<MastraAgentRuntime, 'agent' | 'conversationBinding' | 'toolNameMap'>,
  runtimeData: RuntimeData | undefined,
  action: AssistantToolApprovalAction
): Promise<ResumedApprovalToolCall> {
  const delegated = await assertDelegatedToolActionPending({
    action,
    agent: runtime.agent,
    binding: runtime.conversationBinding,
    requiresApproval: true,
  });
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
  if (delegated && !delegated.originalToolCall) {
    throw createMastraAgentError('mastra_agent_stream_failure', {
      detail:
        'The original delegation input is unavailable; this approval cannot be resumed safely.',
    });
  }
  const displayedCall = delegated?.originalToolCall ?? {
    args: toolCall.args,
    toolName: toolCall.toolName,
  };

  const siblings: ResumedToolCallStart[] = [];
  for (const candidate of run?.toolCalls ?? []) {
    // Destructured consts so the narrowing survives into the push below.
    const { args, toolCallId: siblingToolCallId, toolName: siblingToolName } = candidate;
    if (
      !siblingToolCallId ||
      siblingToolCallId === action.toolCallId ||
      !siblingToolName ||
      args === undefined
    ) {
      continue;
    }
    siblings.push({
      args,
      displayToolName: resolveDiscoveredApprovalToolName(
        siblingToolName,
        runtime.toolNameMap,
        action.runId
      ),
      registeredToolName: siblingToolName,
      toolCallId: siblingToolCallId,
    });
  }

  return {
    approvedToolName: resolveDiscoveredApprovalToolName(
      delegated?.toolName ?? toolCall.toolName,
      runtime.toolNameMap,
      action.runId
    ),
    args: displayedCall.args,
    displayToolName: resolveDiscoveredApprovalToolName(
      displayedCall.toolName,
      runtime.toolNameMap,
      action.runId
    ),
    registeredToolName: displayedCall.toolName,
    siblings,
    toolCallId: action.toolCallId,
  };
}

/**
 * Approval-resume. Routed through {@link runTurnAttempts} with a SINGLE attempt:
 * an approval is consumed by `approveToolCall`/`declineToolCall` and cannot be
 * re-issued, so this leg keeps the pre-BST-1409 terminal behavior on a stall.
 * It still shares the turn runner so `runtime.dispose()` has one owner.
 */
export async function createToolApprovalIteratorFromRuntime(
  params: ToolApprovalIterationParams
): Promise<StreamIterator> {
  return runTurnAttempts({
    firstAttempt: await createToolApprovalTurnAttempt(params),
    // Unreachable at maxAttempts 1; present so the runner has one shape.
    makeContinuation: () => createToolApprovalTurnAttempt(params),
    maxAttempts: 1,
    // No MCP discovery rows on a resume leg (BST-1602). This runtime was
    // rebuilt and re-ran discovery, but the user already saw the rows on the
    // fresh turn; re-emitting them would duplicate on every approval.
    preludeChunks: [],
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
  const lifecycleState = createTurnAttemptLifecycleState(
    runtimeData,
    delegationOutcomes,
    runtime.toolExecutionDurations
  );
  // A resume continues a turn whose model already contributed — the tool call
  // being approved/resumed IS model output — so its finish must never be
  // re-classified as an empty response, even when the resume stream itself
  // carries no further content parts.
  lifecycleState.sawModelContribution = true;
  try {
    validateToolApprovalAction(action);
    const memoryOption = resolveMemoryOption(runtimeData, memory);
    const resumedApprovalToolCall = await readResumedApprovalToolCall(runtime, runtimeData, action);
    const abortedTurnPersistence = createRuntimeAbortedTurnPersistence({
      finalizeAbortedDelegatedTurns: runtime.delegatedTurnPersistence?.finalize,
      memory,
      memoryOption,
      runtimeData,
      streamAbortContext,
    });
    const delegationUsage =
      runtime.personasById.size > 0
        ? createDelegationUsageCapture(runtime.personasById, runtimeData)
        : undefined;
    // Reapply the per-tool permission decisions instead of letting Mastra's
    // run-wide resume flag gate every subsequent tool call.
    const resolvedApprovalGate =
      requireToolApproval === undefined
        ? undefined
        : resolveResumeApprovalGate(
            requireToolApproval,
            runtime.askTools,
            runtime.permissionEnforced
          );
    const approvalOptions = buildStreamOptions({
      abortSignal: streamAbortContext.signal,
      delegationOutcomes,
      delegationUsage,
      leg: 'approval',
      memoryOption,
      requireToolApproval: resolvedApprovalGate,
      runId: action.runId,
      runtime,
      runtimeData,
      toolCallId: action.toolCallId,
    });

    await claimDelegatedToolAction(action, runtime.conversationBinding, {
      agent: runtime.agent,
      requiresApproval: true,
    });
    streamAbortContext.signal.throwIfAborted();
    const streamResult =
      action.action === 'approve'
        ? await runtime.agent.approveToolCall(approvalOptions as AgentToolApprovalOptions)
        : await runtime.agent.declineToolCall(approvalOptions as AgentToolApprovalOptions);
    await attachAbortedTurnMessageList(abortedTurnPersistence, streamResult);

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
      abortedTurnPersistence,
      chunks: streamAttemptChunks({
        abortedTurnPersistence,
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
    const cause = new AggregateError(
      [err, disposeError],
      'Assistant stream construction and runtime cleanup failed.'
    );
    if (isMastraAgentError(err)) {
      throw new MastraAgentError(err.code, `${err.message} Runtime cleanup did not complete.`, {
        cause,
        ...(err.context ? { context: err.context } : {}),
      });
    }
    throw createMastraAgentError('mastra_agent_stream_failure', {
      cause,
      detail: 'Assistant stream construction failed and runtime cleanup did not complete.',
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

export function validateToolResumeAction(action: AssistantToolResumeAction): void {
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
  const delegated = await assertDelegatedToolActionPending({
    action,
    agent: runtime.agent,
    binding: runtime.conversationBinding,
    requiresApproval: false,
  });
  const toolName = delegated?.toolName ?? toolCall.toolName;
  if (!toolName) {
    // The rider decision below keys on the tool's ask registration; a
    // snapshot with no tool name cannot be classified — refuse rather than
    // guessing (a wrong guess either denies a valid resume or widens a
    // payload the tool's schema will reject).
    throw createMastraAgentError('mastra_agent_stream_failure', {
      context: { runId: action.runId, toolCallId: action.toolCallId },
      detail: 'Suspended tool snapshot has no tool name for the requested tool call.',
    });
  }
  return { toolName };
}

/**
 * Suspended-tool resume. Same single-attempt reasoning as the approval leg: the
 * Mastra snapshot is consumed by `resumeStream` and cannot be replayed.
 */
export async function createToolResumeIteratorFromRuntime(
  params: ToolResumeIterationParams
): Promise<StreamIterator> {
  return runTurnAttempts({
    firstAttempt: await createToolResumeTurnAttempt(params),
    // Unreachable at maxAttempts 1; present so the runner has one shape.
    makeContinuation: () => createToolResumeTurnAttempt(params),
    maxAttempts: 1,
    // No MCP discovery rows on a resume leg (BST-1602). This runtime was
    // rebuilt and re-ran discovery, but the user already saw the rows on the
    // fresh turn; re-emitting them would duplicate on every approval.
    preludeChunks: [],
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
  const lifecycleState = createTurnAttemptLifecycleState(
    runtimeData,
    delegationOutcomes,
    runtime.toolExecutionDurations
  );
  // A resume continues a turn whose model already contributed — the tool call
  // being approved/resumed IS model output — so its finish must never be
  // re-classified as an empty response, even when the resume stream itself
  // carries no further content parts.
  lifecycleState.sawModelContribution = true;
  try {
    validateToolResumeAction(action);
    const suspendedCall = await assertResumedCallIsSuspendPause(runtime, runtimeData, action);
    const memoryOption = resolveMemoryOption(runtimeData, memory);
    const abortedTurnPersistence = createRuntimeAbortedTurnPersistence({
      finalizeAbortedDelegatedTurns: runtime.delegatedTurnPersistence?.finalize,
      memory,
      memoryOption,
      runtimeData,
      streamAbortContext,
    });
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
    const resumeOptions = buildStreamOptions({
      abortSignal: streamAbortContext.signal,
      delegationOutcomes,
      delegationUsage,
      leg: 'resume',
      memoryOption,
      // This leg never has a gate to carry (see ToolResumeIterationParams);
      // buildStreamOptions also suppresses it structurally for `leg: 'resume'`
      // regardless (see BuildStreamOptionsParams.requireToolApproval).
      requireToolApproval: undefined,
      runId: action.runId,
      runtime,
      runtimeData,
      toolCallId: action.toolCallId,
    });

    // resumeData is validated by Mastra against the suspended tool's resumeSchema.
    await claimDelegatedToolAction(action, runtime.conversationBinding, {
      agent: runtime.agent,
      requiresApproval: false,
    });
    streamAbortContext.signal.throwIfAborted();
    const streamResult = await runtime.agent.resumeStream(
      resumeData as Parameters<typeof runtime.agent.resumeStream>[0],
      resumeOptions as AgentResumeStreamOptions
    );
    await attachAbortedTurnMessageList(abortedTurnPersistence, streamResult);

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
      abortedTurnPersistence,
      chunks: streamAttemptChunks({
        abortedTurnPersistence,
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
