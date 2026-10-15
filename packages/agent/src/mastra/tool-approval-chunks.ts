/**
 * BST-986: the APPROVAL / SUSPEND-PAUSE half of the Mastra stream boundary.
 *
 * A Mastra `tool-call-approval` or `tool-call-suspended` part is a PAUSE, not a
 * mapping: the run stops and the client owes an explicit approve / decline /
 * resume action. The three shapes that pause can take are decided here —
 * a well-formed approval pause, a well-formed suspend pause (with or without a
 * registered typed resume UI), and a MALFORMED pause that terminates visibly.
 *
 * Kept out of `tool-lifecycle-processors.ts` on purpose: these functions never
 * touch `ToolLifecycleState`. The dispatch flushes pending tool-output
 * run-events around them, so pause policy stays independent of lifecycle
 * bookkeeping. See docs/agents/assistant-runtime.md (PERMISSION ENGINE, tool
 * suspend/resume).
 */
import {
  denormalizeNativeToolName,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
import {
  hasRegisteredSuspendResumeUi,
  REGISTERED_SUSPEND_RESUME_TOOL_IDS,
  UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND,
} from '@brainstrike/assistant-contract/tool-suspend';
import { createLogger } from '@brainstrike/logging';
import { resolveRunPythonExecutionContext } from '../tools/run-python-approval-context';
import type { StreamChunk } from '../types';
import { type PermissionAskToolMetadata, resolveAskToolMetadata } from '../permissions/permission-tool-gate';
import {
  makeErrorFinishChunk,
  makeRunEventChunk,
  makeToolCallsFinishChunk,
} from '../tool-projection/stream-run-event-chunks';
import { readMastraStreamPartString, readMastraStreamPartValue } from '../tool-projection/tool-event-mapper';

const logger = createLogger('MastraAgent');

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
  // NAME-FORM CONTRACT: the runtime `toolNameMap` is AUTHORITATIVE (it is the only
  // layer that can bridge MCP names) and the static native reverse map is only the
  // fallback for a route whose runtime registered no natives. Order matters: a
  // mapped original may ITSELF be a sanitized native id (`sanitizeTools` records
  // an identity mapping for a tool registered as `brainstrike_executeCommand`), so
  // denormalizing a successful hit would rewrite an authoritative name.
  const toolName = sanitizedNameMap?.get(rawToolName) ?? denormalizeNativeToolName(rawToolName);
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
 * VISIBLE, NON-TERMINAL rejection notice for a well-formed suspend pause whose
 * tool has NO registered typed resume UI (`REGISTERED_SUSPEND_RESUME_TOOL_IDS`):
 * a single DURABLE {@link UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND} run event plus
 * a coded error log.
 *
 * The kind is `tool.resume.unsupported`, never `tool.failed`: no tool ran and
 * none failed. `tool.failed` is consumed as a METRIC — the Task Ledger counts it
 * as both a tool call and a failed tool call, and `collectToolDurations` /
 * the timeline's `tool.started` resolution close a call out on it. Because the
 * run deliberately stays suspended, a build that later registers the tool
 * resumes the SAME toolCallId and emits the real `tool.completed`, so reusing
 * `tool.failed` would double-count that one call forever and would close out a
 * tool that is still suspended (contradicting `runStillSuspended: true` in this
 * very event's metadata). The new kind is in `isAlwaysVisibleRunEvent`, so the
 * row shows at the DEFAULT detail level and survives a thread reload — the
 * transient `brainstrike.tool-suspend` notice does not.
 *
 * Deliberately NOT the {@link makeUnsupportedApprovalChunks} idiom (`run.failed`
 * + error finish). That idiom is right for a MALFORMED pause, which really is
 * unrecoverable — this pause is not. Mastra persists the suspended workflow
 * snapshot BEFORE this stream part is mapped, so terminating the client stream
 * removes nothing: `listSuspendedRuns()` still returns the run and a later
 * resume can still revive it. A durable `run.failed` claiming the run "was
 * stopped" would therefore be FALSE.
 *
 * Leaving the run suspended server-side is INTENTIONAL, not a leak: a user who
 * upgrades to a build that registers this tool's resume UI can still answer the
 * very same pause. What this build owes them is honesty — this run event states
 * that THIS build cannot answer the pause, and says nothing about the run's
 * server-side state. The pause itself still reaches the renderer (carrying
 * `resumeSupported: false`, which makes the mapper SETTLE the tool card so a
 * dismissed notice cannot strand a permanently Running one), where
 * `UnsupportedSuspendNotice` explains it and offers a dismiss action.
 *
 * The tool-defined `suspendPayload` is deliberately EXCLUDED from the durable
 * metadata (it is arbitrary tool content; run-event metadata is
 * allowlist-by-denial, not a content channel). It travels only on the transient
 * `tool-suspend-required` chunk, which is never persisted.
 */
function makeUnregisteredSuspendResumeNoticeChunk(input: {
  runId: string;
  toolCallId: string;
  toolName: string;
}): StreamChunk {
  logger.error('suspending tool has no registered resume UI', {
    code: 'mastra_agent_suspend_resume_schema_unregistered',
    registeredSuspendResumeTools: [...REGISTERED_SUSPEND_RESUME_TOOL_IDS],
    runId: input.runId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
  });

  return makeRunEventChunk(
    UNSUPPORTED_TOOL_RESUME_RUN_EVENT_KIND,
    'failed',
    'Tool pause cannot be answered by this build (no registered resume UI)',
    {
      resumeSupportedByClient: false,
      runId: input.runId,
      runStillSuspended: true,
      suspended: true,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      unregisteredResumeSchema: true,
    }
  );
}

export function makeApprovalRequiredChunks(
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
  // Same map-wins order as the unsupported branch (and as
  // `resolveDiscoveredApprovalToolName` / `ProjectionSafeToolCallFilter`): the
  // emitted `toolName` is the label the approval notice shows and the id
  // per-tool grant handling submits, so a mapped original is never rewritten.
  const toolName = sanitizedNameMap?.get(rawToolName) ?? denormalizeNativeToolName(rawToolName);
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

  // BST-1070: a code-execution approval carries a server-computed display
  // context (scratch location, read semantics, timeout) derived from the same
  // inputs execute() will use — the model's args cannot carry host facts, and
  // the card must not guess them. Absence is the deliberate fail-safe: the
  // card shows no fact rows and suppresses grant buttons, so the degradation
  // is visible on the surface it affects. Logged so the drop is traceable too.
  const executionContext =
    toolName === NATIVE_TOOL_ID.runPython ? resolveRunPythonExecutionContext(args) : undefined;
  if (toolName === NATIVE_TOOL_ID.runPython && executionContext === undefined) {
    logger.warn('run_python approval args did not parse; approval surfaced without context', {
      code: 'mastra_agent_run_python_approval_context_unresolved',
      runId,
      toolCallId,
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
    // BST-1402: the DURABLE record of the pause, emitted BEFORE the transient
    // `tool-approval-required` chunk so a consumer that tears the stream down
    // the instant it sees the pause still persisted the fact that this run is
    // parked on the user. It does NOT replace the notice: `tool-approval-required`
    // is `aui-data`, and a reload rebuilds the actionable notice from the Mastra
    // suspended-workflow snapshot instead (`listSuspendedMastraRuns`). This row
    // is the cheap cross-thread projection the Threads panel's "needs you"
    // column queries — one SQL read over the run-events table, where snapshot
    // rediscovery is a per-thread round trip that only sees STILL-PENDING
    // pauses. See the kind's contract note. Deliberately NOT a `tool.started`:
    // no tool ran. Resolution is derived from the next event for this same
    // `toolCallId` (approve => `tool.completed`, decline => `tool.failed`,
    // unanswerable => `tool.resume.unsupported`); the run status is NOT a
    // resolution signal, since the paused leg itself is recorded 'completed'.
    // So there is no resolution event to emit here.
    makeRunEventChunk('tool.approval.requested', 'running', 'Awaiting your approval', {
      toolCallId,
      toolName,
      // Same honesty rule as the chunk below: a riskCategory is carried only
      // when the pause really was policy-driven and attributable — never
      // fabricated (the LOUD error above already reports an unresolved one).
      ...(askMetadata ? { riskCategory: askMetadata.riskCategory } : {}),
    }),
    {
      runId,
      toolCallId,
      toolName,
      type: 'tool-approval-required',
      ...(askMetadata ? { policyDecision: 'ask', riskCategory: askMetadata.riskCategory } : {}),
      ...(args === undefined ? {} : { args }),
      ...(resumeSchema === undefined ? {} : { resumeSchema }),
      ...(executionContext === undefined ? {} : { executionContext }),
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
 * when the tool has no registered typed resume UI we prepend the NON-terminal
 * {@link makeUnregisteredSuspendResumeNoticeChunk} so the rejection is visible
 * and durable without falsely claiming the run was stopped.
 */
export function makeToolSuspendRequiredChunks(
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
  // Resolve the CLIENT-FACING (dotted) name the same way the approval side does
  // in `resolveDiscoveredApprovalToolName`: the runtime's sanitized→original map
  // first, then the STATIC native reverse map. The real stream part carries the
  // Mastra-registered id (`brainstrike_askUser`), and `sanitizedNameMap` is
  // optional — spread conditionally at every call site — so a missing map must
  // not decide whether a pause is resumable. `denormalizeNativeToolName` is a
  // no-op for already-dotted and non-native names.
  const toolName = denormalizeNativeToolName(sanitizedNameMap?.get(rawToolName) ?? rawToolName);
  const unregisteredNotice = hasRegisteredSuspendResumeUi(toolName)
    ? undefined
    : makeUnregisteredSuspendResumeNoticeChunk({ runId, toolCallId, toolName });
  const suspendPayload = readMastraStreamPartValue(part, 'suspendPayload');
  const resumeSchema = readMastraStreamPartValue(part, 'resumeSchema');

  if (!unregisteredNotice) {
    logger.info('mastra tool suspend pause surfaced for client resume', {
      code: 'mastra_agent_tool_suspend_required',
      runId,
      toolCallId,
      toolName,
    });
  }

  return [
    ...(unregisteredNotice ? [unregisteredNotice] : []),
    {
      runId,
      toolCallId,
      toolName,
      type: 'tool-suspend-required',
      ...(suspendPayload === undefined ? {} : { suspendPayload }),
      ...(resumeSchema === undefined ? {} : { resumeSchema }),
      // Only ever narrowed to false — a registered pause omits the flag so its
      // tool card stays open, which is exactly what "waiting on you" means.
      ...(unregisteredNotice ? { resumeSupported: false as const } : {}),
    },
    makeToolCallsFinishChunk(),
  ];
}
