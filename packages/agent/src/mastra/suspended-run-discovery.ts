/**
 * Restart-safe suspended-run discovery (BST-1649 split from
 * `agent-streaming.ts`): rediscovers pending tool approvals and
 * `suspend()` pauses for a thread from durable Mastra workflow storage,
 * without any in-memory stream handle — so it works after a process
 * restart / renderer reload given only the thread context (BST-1084/D1).
 *
 * `listSuspendedMastraRuns` is the sole public entry point (re-exported from
 * `packages/agent/src/index.ts`); `resolveDiscoveredApprovalToolName` is also
 * exported because `attempt-legs.ts`'s `readResumedApprovalToolCall` needs
 * the same registered-to-original tool-name mapping.
 *
 * See docs/agents/assistant-runtime.md and docs/agents/mastra-boundary.md.
 */
import type { DelegatedToolActionIdentity } from '@brainstrike/assistant-contract';
import { denormalizeNativeToolName } from '@brainstrike/assistant-contract/tool-metadata';
import { createLogger } from '@brainstrike/logging';
import type { Agent } from '@mastra/core/agent';
import { createListingOnlyModel } from '../providers/listing-only-model';
import type { MastraAgentRuntimeOptions } from './agent-runtime';
import { initializeMastraRuntime, withRuntimeDerivedStreamOptions } from './agent-streaming';
import {
  type DelegatedSuspensionResolver,
  discoverDelegatedToolPause,
} from './delegated-suspension-discovery';
import { createMastraAgentError } from './mastra-agent-error';
import { assertNoUnsupportedDirectStreamOptions } from './runtime-assembly/stream-options';
import { resolveRuntimeConfiguration } from './runtime-configuration';

const logger = createLogger('MastraAgent');

export interface DiscoveredSuspendedApproval {
  readonly args?: unknown;
  readonly delegation?: DelegatedToolActionIdentity;
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
  readonly delegation?: DelegatedToolActionIdentity;
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
export function resolveDiscoveredApprovalToolName(
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
type ResolveDelegation = (
  runId: string,
  toolCall: SuspendedRunsForClassification[number]['toolCalls'][number]
) => ReturnType<typeof discoverDelegatedToolPause>;

async function resolveDiscoveredCall(
  run: SuspendedRunsForClassification[number],
  original: SuspendedRunsForClassification[number]['toolCalls'][number],
  resolveDelegation: ResolveDelegation | undefined
) {
  const delegated = original.toolCallId
    ? await resolveDelegation?.(run.runId, original)
    : undefined;
  const toolCall = delegated?.toolCall ?? original;
  const suspendedAt = (delegated?.suspendedAt ?? run.suspendedAt).toISOString();
  const transportToolCallId = original.toolCallId;
  const decision = delegated ? { delegation: delegated.delegation } : {};
  if (!(transportToolCallId && toolCall.toolCallId && toolCall.toolName)) {
    logger.debug('skipping suspended tool call without ids', {
      code: 'mastra_agent_suspended_run_skipped',
      requiresApproval: toolCall.requiresApproval,
      runId: run.runId,
      toolName: toolCall.toolName,
    });
    return;
  }
  return {
    decision,
    suspendedAt,
    toolCall: { ...toolCall, toolCallId: toolCall.toolCallId, toolName: toolCall.toolName },
    transportToolCallId,
  };
}

async function classifySuspendedToolCalls(
  runs: SuspendedRunsForClassification,
  toolNameMap: ReadonlyMap<string, string>,
  resolveDelegation?: ResolveDelegation
): Promise<{ approvals: DiscoveredSuspendedApproval[]; suspends: DiscoveredSuspendedPause[] }> {
  const approvals: DiscoveredSuspendedApproval[] = [];
  const suspends: DiscoveredSuspendedPause[] = [];
  const approvalToolCallIds = new Set<string>();
  for (const run of runs) {
    for (const original of run.toolCalls) {
      const resolved = await resolveDiscoveredCall(run, original, resolveDelegation);
      if (!resolved) {
        continue;
      }
      const { toolCall, suspendedAt, transportToolCallId, decision } = resolved;
      // Snapshots store the REGISTERED (sanitized) id; every client-facing
      // surface is keyed by the ORIGINAL name — map it back here so the
      // desktop route's riskByTool lookup and per-tool overrides match.
      const toolName = resolveDiscoveredApprovalToolName(toolCall.toolName, toolNameMap, run.runId);
      if (toolCall.requiresApproval) {
        approvalToolCallIds.add(JSON.stringify([run.runId, transportToolCallId]));
        approvals.push({
          ...decision,
          runId: run.runId,
          suspendedAt,
          toolCallId: transportToolCallId,
          toolName,
          ...(toolCall.args === undefined ? {} : { args: toolCall.args }),
        });
        continue;
      }
      if (approvalToolCallIds.has(JSON.stringify([run.runId, transportToolCallId]))) {
        logger.warn('suspended tool call listed as BOTH approval and suspend; approval wins', {
          code: 'mastra_agent_suspended_run_duplicate_tool_call',
          runId: run.runId,
          toolCallId: transportToolCallId,
          toolName,
        });
        continue;
      }
      // BST-1084: a tool that called suspend() — carry its durable payload
      // so the rediscovered notice renders the real plan/question.
      suspends.push({
        ...decision,
        runId: run.runId,
        suspendedAt,
        toolCallId: transportToolCallId,
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
  options: MastraAgentRuntimeOptions & {
    readonly delegatedSuspensionDiscovery?: DelegatedSuspensionResolver;
  } = {}
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

    const storage = options.storage;
    const resolver = options.delegatedSuspensionDiscovery;
    const { approvals, suspends } = await classifySuspendedToolCalls(
      runs,
      runtime.toolNameMap,
      resolver
        ? (runId, toolCall) =>
            discoverDelegatedToolPause({
              resolveInvocation: resolver,
              rootThreadId: filter.threadId,
              runId,
              storage,
              toolCall,
            })
        : undefined
    );

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
