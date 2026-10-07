import { asSchema, type ToolContent } from 'ai';
import { validateApprovalInput } from './approval-input.js';
import type { PendingInteraction, HostRunState as Run } from './core-state.js';
import { executableInputSchema } from './executable-input-schema.js';
import { jsonValue } from './json-value.js';
import type { HostPlatform } from './ports.js';
import type { HostEvent } from './protocol.js';
import { hostRunToolDecision, hostRunTools } from './run-admission.js';

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
type Dispatch = (action: Action, input: unknown, resumeData?: unknown) => Promise<unknown>;

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
