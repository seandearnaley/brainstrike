import type { ToolRiskCategory } from '@brainstrike/assistant-contract';
import { asSchema, type ModelMessage, modelMessageSchema, type ToolContent } from 'ai';
import { validateApprovalInput } from './approval-input.js';
import {
  applyHostPermissionGrant,
  hasHostInteractionResponse,
  type PendingInteraction,
  type HostRunState as Run,
} from './core-state.js';
import { executableInputSchema } from './executable-input-schema.js';
import { jsonValue } from './json-value.js';
import type { HostPlatform } from './ports.js';
import type { HostEvent, HostLogRow, HostParams, HostPermissionGrant } from './protocol.js';
import { ensureHostRunAdmission, hostRunToolDecision, hostRunTools } from './run-admission.js';

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
type Dispatch = (action: Action, input: unknown, resumeData?: unknown) => Promise<unknown>;

/** Core supplies the original append, boundary sync and fold, in that order. */
export async function commitHostModelMessages(
  run: Run,
  messages: readonly ModelMessage[],
  append: (event: HostEvent) => Promise<HostLogRow | undefined>,
  sync: () => Promise<void>,
  fold: (row: HostLogRow) => void
): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  const row = await append({
    messages: messages.map((message) => jsonValue(modelMessageSchema.parse(message))),
    runId: run.id,
    type: 'model.messages',
  });
  if (!row) {
    throw new Error('Model context was not committed');
  }
  await sync();
  fold(row);
}

/** Core supplies its sole acceptance writer and continuation owner. */
export async function commitHostInteractionResponse(
  run: Run,
  platform: HostPlatform,
  params: HostParams<'interaction/respond'> | HostParams<'interaction/resume'>,
  accept: (events: readonly HostEvent[]) => Promise<void>,
  continueRun: () => Promise<void>
): Promise<{ accepted: true }> {
  const pending = run.approvals.get(params.interactionId);
  const approval = 'decision' in params;
  if (
    run.terminal ||
    !pending ||
    (pending.event.kind === 'approval') !== approval ||
    hasHostInteractionResponse(pending)
  ) {
    throw new Error(
      approval
        ? 'Approval decision is stale or belongs to another run'
        : 'Human interaction is stale or belongs to another run'
    );
  }
  await ensureHostRunAdmission(platform, run);
  if (approval) {
    const registered = hostRunTools(run)[pending.event.toolId];
    if (!registered || registered.identity !== pending.event.toolIdentity) {
      throw new Error('Approval tool identity changed');
    }
    const grant = 'grant' in params ? params.grant : undefined;
    if (grant) {
      assertHostGrantMatchesCall(grant, params.decision, {
        risk: registered.risk,
        toolId: registered.permissionToolId ?? pending.event.toolId,
      });
    }
    await accept([
      ...(grant ? [{ grant, runId: run.id, type: 'permission.granted' as const }] : []),
      {
        decision: params.decision,
        interactionId: params.interactionId,
        runId: run.id,
        type: 'interaction.responded',
      },
    ]);
    if (grant) {
      applyHostPermissionGrant(run, grant);
    }
    pending.decision = params.decision;
  } else {
    await validateHostInteractionResume(run, pending, params.resumeData);
    await accept([
      {
        interactionId: params.interactionId,
        resumeData: params.resumeData,
        runId: run.id,
        type: 'interaction.responded',
      },
    ]);
    pending.resumeData = params.resumeData;
  }
  run.task = (run.task ?? Promise.resolve()).then(continueRun);
  run.task.catch(() => undefined);
  return { accepted: true };
}

/** A grant names exactly the approved call's own risk category or tool, never another. */
function assertHostGrantMatchesCall(
  grant: HostPermissionGrant,
  decision: 'approve' | 'deny',
  call: { readonly risk: ToolRiskCategory; readonly toolId: string }
): void {
  const matches =
    grant.scope === 'session' ? grant.category === call.risk : grant.toolId === call.toolId;
  if (decision !== 'approve' || !matches) {
    throw new Error('Permission grant does not match the approved call');
  }
}

// Continuation calculations reuse Core's owned run and dispatch; no log writer lives here.
export async function validateHostInteractionResume(
  run: Run,
  pending: PendingInteraction,
  value: unknown
): Promise<unknown> {
  const tool = hostRunTools(run)[pending.event.toolId];
  if (
    !tool ||
    tool.identity !== pending.event.toolIdentity ||
    tool.interaction?.kind !== pending.event.kind
  ) {
    throw new Error('Human interaction tool identity changed');
  }
  const validator = asSchema(executableInputSchema(tool.interaction.resumeSchema)).validate;
  if (!validator) {
    throw new Error('Human interaction has no executable resume validator');
  }
  const result = await validator(value);
  if (!result.success) {
    throw result.error;
  }
  return result.value;
}

export async function resolveHostApprovalInput(run: Run, event: Interaction): Promise<unknown> {
  const approval = run.approvals.get(event.interactionId);
  if (!approval) {
    throw new Error('Unknown approval occurrence');
  }
  const registered = hostRunTools(run)[event.toolId];
  if (!registered || registered.identity !== event.toolIdentity) {
    throw new Error('Approval tool identity changed');
  }
  approval.runtimeInput ??= {
    value: await validateApprovalInput(registered, event, run.rawInputs),
  };
  return approval.runtimeInput.value;
}

async function modelResult(
  run: Run,
  toolCallId: string,
  toolId: string,
  input: unknown,
  output: unknown
): Promise<ToolContent[number]> {
  const project = hostRunTools(run)[toolId]?.toModelOutput;
  return {
    output: project
      ? await project({ input, output, toolCallId })
      : typeof output === 'string'
        ? { type: 'text', value: output }
        : { type: 'json', value: jsonValue(output) },
    toolCallId,
    toolName: toolId,
    type: 'tool-result',
  };
}

export async function resolveApprovedHostCall(
  run: Run,
  pending: PendingInteraction,
  platform: HostPlatform,
  dispatch: Dispatch
): Promise<ToolContent[number]> {
  const { event, decision } = pending;
  if (decision === 'deny' || (await hostRunToolDecision(platform, run, event.toolId)) === 'deny') {
    return {
      output: { type: 'execution-denied' },
      toolCallId: event.toolCallId,
      toolName: event.toolId,
      type: 'tool-result',
    };
  }
  const input = await resolveHostApprovalInput(run, event);
  const action: Action = {
    input: event.input,
    runId: run.id,
    toolCallId: event.toolCallId,
    toolId: event.toolId,
    toolIdentity: event.toolIdentity,
    type: 'effect.started',
  };
  run.permits.set(action.toolCallId, action);
  const resumeData =
    event.kind === 'approval'
      ? undefined
      : await validateHostInteractionResume(run, pending, pending.resumeData);
  const output = run.outputs.has(event.toolCallId)
    ? run.outputs.get(event.toolCallId)
    : await dispatch(action, input, resumeData);
  return modelResult(run, event.toolCallId, event.toolId, input, output);
}

/** Resolve already-issued calls at the existing step limit without another model request. */
export async function finishApprovedHostResults(
  run: Run,
  platform: HostPlatform,
  dispatch: Dispatch
): Promise<ModelMessage[]> {
  const results: ToolContent = [];
  for (const approval of run.approvals.values()) {
    if (!run.checkpointedResults.has(approval.event.toolCallId)) {
      results.push(await resolveApprovedHostCall(run, approval, platform, dispatch));
    }
  }
  return results.length > 0 ? [{ content: results, role: 'tool' }] : [];
}

export async function createHostApprovalResponses(
  run: Run,
  platform: HostPlatform,
  dispatch: Dispatch
): Promise<ToolContent> {
  const responses: ToolContent = [];
  for (const pending of run.approvals.values()) {
    const { event, decision } = pending;
    if (!run.responses.has(event.interactionId)) {
      responses.push({
        approvalId: event.interactionId,
        approved: event.kind !== 'approval' || decision === 'approve',
        type: 'tool-approval-response',
      });
    }
    if (
      event.kind !== 'approval' &&
      !run.outputs.has(event.toolCallId) &&
      !run.checkpointedResults.has(event.toolCallId)
    ) {
      responses.push(await resolveApprovedHostCall(run, pending, platform, dispatch));
      continue;
    }
    if (run.outputs.has(event.toolCallId) && !run.checkpointedResults.has(event.toolCallId)) {
      const output = run.outputs.get(event.toolCallId);
      responses.push(
        await modelResult(
          run,
          event.toolCallId,
          event.toolId,
          await resolveHostApprovalInput(run, event),
          output ?? null
        )
      );
    }
  }
  return responses;
}
